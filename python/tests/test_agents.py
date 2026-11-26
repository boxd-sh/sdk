"""`machines.agents`: what goes on the wire, what comes back, which calls are
sent only once, the events stream (skipped kinds, no deadline on a
follow, ending cleanly), the run history (`runs`, its pages and
`iter_runs`), signing an agent in (`start_login`, `complete_login`,
`wait_for_login`, `get_login`, `logout`), and one task start to reply
(`run`: its session, its reply, Ctrl-C and cancellation, cleanup)."""

from __future__ import annotations

import asyncio
from contextlib import aclosing
from datetime import datetime, timezone
import re
from types import SimpleNamespace

import grpc
import pytest

from boxd import (
    AgentCloseResult,
    AgentInterruptResult,
    AgentLogin,
    AgentLoginResult,
    AgentLoginStart,
    AgentRun,
    AgentRunResult,
    AgentRunUsage,
    AgentRunsPage,
    AgentMessage,
    AgentMessageDelta,
    AgentPlan,
    AgentSendResult,
    AgentSession,
    AgentToolStarted,
    AgentTurnFinished,
    AgentTurnStarted,
    Harness,
)
from boxd import _mappers as m
from boxd._generated import api_pb2
from boxd._regions import AsyncRouter, SyncRouter
from boxd._transport import AsyncTransport, SyncTransport
from boxd.errors import (
    APIConnectionError,
    APIStatusError,
    BoxdError,
    NotFoundError,
    from_grpc_error,
)
from boxd.resources.machines import AsyncMachines, Machines
from fakes import (
    FakeAsyncCredentials,
    FakeAsyncTransport,
    FakeCredentials,
    FakeMulticallable,
    FakeRpcError,
    FakeStub,
    FakeTransport,
)

T0 = 1_792_000_000_000  # 2026-10-14 17:46:40 UTC, in ms
T0_DT = datetime(2026, 10, 14, 17, 46, 40, tzinfo=timezone.utc)


def a_session(**overrides):
    fields = dict(
        id="s-1",
        vm_id="vm-1",
        harness="claude-code",
        harness_version="2.1.0",
        model="",
        cwd="/home/boxd",
        state=api_pb2.AGENT_SESSION_STATE_IDLE,
        turn=0,
        queued=0,
        last_seq=0,
        created_at_ms=T0,
        error="",
    )
    fields.update(overrides)
    return api_pb2.AgentSession(**fields)


def an_event(seq=1, turn=1, **kind):
    return api_pb2.AgentEvent(seq=seq, turn=turn, time_ms=T0, **kind)


def with_unknown_kind(seq=1):
    """An event as a newer server sends it: a kind (field 30) this SDK's
    stubs don't know, so no `kind` is set when it is parsed."""
    tag = (30 << 3) | 2  # field 30, length-delimited
    raw = an_event(seq=seq).SerializeToString() + bytes([tag & 0x7F | 0x80, tag >> 7, 0])
    return api_pb2.AgentEvent.FromString(raw)


# --- mappers ---


def test_harness_without_a_version_is_not_installed():
    h = m.harness(
        api_pb2.Harness(
            id="codex",
            version="",
            mid_turn_input=True,
            models=["o3", "gpt-5"],
            efforts=["minimal", "low", "medium", "high", "xhigh"],
            api_key_env="OPENAI_API_KEY",
        )
    )
    assert h == Harness(
        id="codex",
        version=None,
        mid_turn_input=True,
        models=["o3", "gpt-5"],
        efforts=["minimal", "low", "medium", "high", "xhigh"],
        api_key_env="OPENAI_API_KEY",
    )
    # No key in the machine's env, or a server from before the field.
    assert m.harness(api_pb2.Harness(id="codex")).api_key_env is None
    assert m.harness(api_pb2.Harness(id="claude-code", version="2.1.0")).version == "2.1.0"
    assert m.harness(api_pb2.Harness(id="opencode")).models == []
    # From a server that doesn't list them.
    assert m.harness(api_pb2.Harness(id="codex")).efforts == []


def test_session_maps_every_field():
    s = m.agent_session(
        a_session(
            model="opus",
            effort="high",
            state=api_pb2.AGENT_SESSION_STATE_FAILED,
            turn=3,
            queued=2,
            last_seq=41,
            error="the agent is not logged in: run `claude` once",
        )
    )
    assert s == AgentSession(
        id="s-1",
        machine_id="vm-1",
        harness="claude-code",
        harness_version="2.1.0",
        model="opus",
        effort="high",
        cwd="/home/boxd",
        state="failed",
        turn=3,
        queued=2,
        last_seq=41,
        created_at=T0_DT,
        error="the agent is not logged in: run `claude` once",
    )


def test_session_empty_strings_are_none():
    s = m.agent_session(a_session())
    assert s.model is None
    assert s.effort is None  # the agent's own default
    assert s.error is None
    # Always set by the server, so kept as they are.
    assert s.cwd == "/home/boxd"
    assert s.harness_version == "2.1.0"


@pytest.mark.parametrize(
    "wire, state",
    [
        (api_pb2.AGENT_SESSION_STATE_IDLE, "idle"),
        (api_pb2.AGENT_SESSION_STATE_RUNNING, "running"),
        (api_pb2.AGENT_SESSION_STATE_CLOSED, "closed"),
        (api_pb2.AGENT_SESSION_STATE_FAILED, "failed"),
        (api_pb2.AGENT_SESSION_STATE_UNSPECIFIED, "unknown"),
        (99, "unknown"),  # added by a newer server
    ],
)
def test_session_state(wire, state):
    assert m.agent_session(a_session(state=wire)).state == state


@pytest.mark.parametrize(
    "enum, prefix, mapping",
    [
        (api_pb2.AgentSessionState, "AGENT_SESSION_STATE_", m._AGENT_SESSION_STATES),
        (api_pb2.AgentDelivery, "AGENT_DELIVERY_", m._AGENT_DELIVERIES),
        (api_pb2.AgentToolKind, "AGENT_TOOL_KIND_", m._AGENT_TOOL_KINDS),
        (api_pb2.AgentFinishReason, "AGENT_FINISH_REASON_", m._AGENT_FINISH_REASONS),
        (api_pb2.AgentLoginMethod, "AGENT_LOGIN_METHOD_", m._AGENT_LOGIN_METHODS),
    ],
)
def test_enum_names_are_the_protos_lowercased(enum, prefix, mapping):
    # Every value the proto has (but UNSPECIFIED) is mapped, to its own name.
    expected = {
        number: name.removeprefix(prefix).lower()
        for name, number in enum.items()
        if number != 0
    }
    assert mapping == expected


def test_send_and_interrupt_results():
    assert m.agent_send_result(
        api_pb2.SendToAgentResponse(turn=4, delivery=api_pb2.AGENT_DELIVERY_QUEUED_FALLBACK)
    ) == AgentSendResult(turn=4, delivery="queued_fallback")
    assert m.agent_send_result(api_pb2.SendToAgentResponse(turn=1, delivery=42)).delivery == (
        "unknown"
    )
    assert m.agent_interrupt_result(api_pb2.InterruptAgentResponse(turn=3)) == (
        AgentInterruptResult(turn=3)
    )
    # 0: nothing was running.
    assert m.agent_interrupt_result(api_pb2.InterruptAgentResponse()).turn is None


EVENTS = [
    (
        dict(turn_started=api_pb2.AgentTurnStarted()),
        "turn.started",
        {},
    ),
    (
        dict(
            user_message=api_pb2.AgentUserMessage(
                text="add tests", delivery=api_pb2.AGENT_DELIVERY_JOINED
            )
        ),
        "user.message",
        {"text": "add tests", "delivery": "joined"},
    ),
    (
        dict(message_delta=api_pb2.AgentMessageDelta(text="Hel")),
        "message.delta",
        {"text": "Hel"},
    ),
    (
        dict(message=api_pb2.AgentMessage(text="Hello.")),
        "message",
        {"text": "Hello."},
    ),
    (
        dict(thinking_delta=api_pb2.AgentThinkingDelta(text="hmm")),
        "thinking.delta",
        {"text": "hmm"},
    ),
    (
        dict(
            tool_started=api_pb2.AgentToolStarted(
                call_id="c1",
                kind=api_pb2.AGENT_TOOL_KIND_SHELL,
                name="Bash",
                input_json='{"command": "ls -la", "timeout": 30}',
            )
        ),
        "tool.started",
        {
            "call_id": "c1",
            "kind": "shell",
            "name": "Bash",
            "input": {"command": "ls -la", "timeout": 30},
        },
    ),
    (
        dict(tool_output=api_pb2.AgentToolOutput(call_id="c1", text="total 0\n")),
        "tool.output",
        {"call_id": "c1", "text": "total 0\n"},
    ),
    (
        dict(
            tool_finished=api_pb2.AgentToolFinished(
                call_id="c1", is_error=True, result="exit 2"
            )
        ),
        "tool.finished",
        {"call_id": "c1", "is_error": True, "result": "exit 2"},
    ),
    (
        dict(
            plan=api_pb2.AgentPlan(
                items=[
                    api_pb2.AgentPlanItem(text="read the code", status="done"),
                    api_pb2.AgentPlanItem(text="write tests", status="in_progress"),
                ]
            )
        ),
        "plan",
        {
            "items": [
                {"text": "read the code", "status": "done"},
                {"text": "write tests", "status": "in_progress"},
            ]
        },
    ),
    (
        dict(
            usage=api_pb2.AgentUsage(
                input_tokens=10,
                output_tokens=20,
                cache_read_tokens=30,
                cache_write_tokens=40,
            )
        ),
        "usage",
        {
            "input_tokens": 10,
            "output_tokens": 20,
            "cache_read_tokens": 30,
            "cache_write_tokens": 40,
        },
    ),
    (
        dict(
            turn_finished=api_pb2.AgentTurnFinished(
                reason=api_pb2.AGENT_FINISH_REASON_FAILED, error="the model is overloaded"
            )
        ),
        "turn.finished",
        {"reason": "failed", "error": "the model is overloaded"},
    ),
]


@pytest.mark.parametrize("kind, type_, fields", EVENTS, ids=[e[1] for e in EVENTS])
def test_every_event_kind(kind, type_, fields):
    ev = m.agent_event(an_event(seq=7, turn=2, **kind))
    assert ev is not None
    dumped = ev.model_dump()
    assert dumped == {"seq": 7, "turn": 2, "time": T0_DT, "type": type_, **fields}


def test_every_event_kind_is_covered():
    kinds = {f.name for f in api_pb2.AgentEvent.DESCRIPTOR.oneofs_by_name["kind"].fields}
    assert kinds == {next(iter(kind)) for kind, _, _ in EVENTS}


def test_an_event_of_a_kind_this_sdk_does_not_know_is_none():
    assert m.agent_event(with_unknown_kind()) is None
    assert m.agent_event(an_event()) is None  # no kind at all


@pytest.mark.parametrize(
    "raw, parsed",
    [
        ('{"path": "a.py"}', {"path": "a.py"}),
        ("[1, 2]", [1, 2]),
        ('"just text"', "just text"),
        ("42", 42),
        ("not json {", "not json {"),  # kept as the agent sent it
        ("", None),
    ],
)
def test_tool_input(raw, parsed):
    ev = m.agent_event(
        an_event(tool_started=api_pb2.AgentToolStarted(call_id="c", input_json=raw))
    )
    assert isinstance(ev, AgentToolStarted)
    assert ev.input == parsed


def test_a_tool_kind_this_sdk_does_not_know_is_other():
    for wire in (api_pb2.AGENT_TOOL_KIND_UNSPECIFIED, 77):
        ev = m.agent_event(an_event(tool_started=api_pb2.AgentToolStarted(kind=wire)))
        assert ev.kind == "other"


def test_turn_finished_without_an_error_and_an_unknown_reason():
    ev = m.agent_event(
        an_event(turn_finished=api_pb2.AgentTurnFinished(reason=api_pb2.AGENT_FINISH_REASON_DONE))
    )
    assert isinstance(ev, AgentTurnFinished)
    assert (ev.reason, ev.error) == ("done", None)
    for wire in (api_pb2.AGENT_FINISH_REASON_UNSPECIFIED, 99):
        ev = m.agent_event(an_event(turn_finished=api_pb2.AgentTurnFinished(reason=wire)))
        assert ev.reason == "unknown"


def test_a_user_message_with_an_unknown_delivery():
    ev = m.agent_event(an_event(user_message=api_pb2.AgentUserMessage(text="x", delivery=9)))
    assert ev.delivery == "unknown"


def a_run(**overrides):
    fields = dict(
        vm_id="vm-1",
        vm_name="box",
        session_id="s-1",
        harness="claude-code",
        harness_version="2.1.0",
        model="",
        turn=1,
        started_by="message",
        reason=api_pb2.AGENT_FINISH_REASON_DONE,
        error="",
        started_at_ms=T0,
        ended_at_ms=T0 + 42_000,
        steps=3,
        usage=api_pb2.AgentUsage(
            input_tokens=10, output_tokens=20, cache_read_tokens=300, cache_write_tokens=4
        ),
    )
    fields.update(overrides)
    return api_pb2.AgentRun(**fields)


def test_run_maps_every_field():
    run = m.agent_run(
        a_run(
            model="opus",
            effort="max",
            turn=4,
            started_by="by_agent",
            reason=api_pb2.AGENT_FINISH_REASON_FAILED,
            error="the model is overloaded",
        )
    )
    assert run == AgentRun(
        machine_id="vm-1",
        machine_name="box",
        session_id="s-1",
        harness="claude-code",
        harness_version="2.1.0",
        model="opus",
        effort="max",
        turn=4,
        started_by="by_agent",
        reason="failed",
        error="the model is overloaded",
        started_at=T0_DT,
        ended_at=datetime(2026, 10, 14, 17, 47, 22, tzinfo=timezone.utc),
        steps=3,
        usage=AgentRunUsage(
            input_tokens=10, output_tokens=20, cache_read_tokens=300, cache_write_tokens=4
        ),
    )


def test_run_without_an_error_usage_or_known_values():
    run = m.agent_run(a_run(usage=None, started_by="schedule", reason=99))
    assert run.error is None
    # The agent's own default: None, as a session's model and effort.
    assert run.model is None
    assert run.effort is None
    assert m.agent_session(a_session(model="")).model is None
    assert run.started_by == "unknown"  # a newer server's
    assert run.reason == "unknown"
    assert run.usage == AgentRunUsage(
        input_tokens=0, output_tokens=0, cache_read_tokens=0, cache_write_tokens=0
    )
    assert m.agent_run(a_run(started_by="queued")).started_by == "queued"


def test_runs_page_token():
    page = m.agent_runs_page(
        api_pb2.ListAgentRunsResponse(runs=[a_run()], next_page_token="p2")
    )
    assert isinstance(page, AgentRunsPage)
    assert [r.turn for r in page.runs] == [1]
    assert page.next_page_token == "p2"
    # The last page.
    assert m.agent_runs_page(api_pb2.ListAgentRunsResponse()).next_page_token is None


# --- the namespace: what goes on the wire ---


def agents(*responses):
    t = FakeTransport(list(responses))
    return Machines(t).agents, t


def test_harnesses():
    a, t = agents(
        api_pb2.ListHarnessesResponse(
            harnesses=[api_pb2.Harness(id="claude-code", version="2.1.0", mid_turn_input=True)]
        )
    )
    harnesses = a.harnesses("box", region="nyc")
    method, request = t.calls[0]
    assert method == "ListHarnesses"
    assert request == api_pb2.ListHarnessesRequest(vm_id="box")
    assert t.regions == ["nyc"]
    assert [h.id for h in harnesses] == ["claude-code"]
    assert harnesses[0].mid_turn_input is True


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_start_sends_every_option_once():
    a, t = agents(a_session())
    session = a.start(
        "box",
        "codex",
        model="o3",
        effort="xhigh",
        cwd="/srv/app",
        instructions="Keep replies short.",
        env={"FOO": "bar"},
        request_id="deploy-42",
    )
    method, request = t.calls[0]
    assert method == "StartAgentSession"
    assert request == api_pb2.StartAgentSessionRequest(
        vm_id="box",
        harness="codex",
        model="o3",
        effort="xhigh",
        cwd="/srv/app",
        instructions="Keep replies short.",
        env={"FOO": "bar"},
        request_id="deploy-42",
    )
    # A repeat is harmless with a request id, so it's retried like a read.
    assert t.call_options == [{}]
    assert isinstance(session, AgentSession)
    assert session.machine_id == "vm-1"


def test_start_defaults_are_empty_on_the_wire_but_a_request_id():
    a, t = agents(a_session(), a_session())
    a.start("box", "claude-code")
    a.start("box", "claude-code")
    first, second = t.calls[0][1], t.calls[1][1]
    assert UUID.match(first.request_id) and UUID.match(second.request_id)
    assert first.request_id != second.request_id, "a new one for each call"
    first.ClearField("request_id")
    assert first == api_pb2.StartAgentSessionRequest(vm_id="box", harness="claude-code")


def test_send_defaults_to_next_with_a_request_id_of_its_own():
    a, t = agents(
        api_pb2.SendToAgentResponse(turn=1, delivery=api_pb2.AGENT_DELIVERY_STARTED)
    )
    result = a.send("box", "s-1", "hello")
    method, request = t.calls[0]
    assert method == "SendToAgent"
    assert UUID.match(request.request_id)
    assert request == api_pb2.SendToAgentRequest(
        vm_id="box",
        session_id="s-1",
        text="hello",
        when=api_pb2.AGENT_SEND_WHEN_NEXT,
        request_id=request.request_id,
    )
    assert t.call_options == [{}]
    assert result == AgentSendResult(turn=1, delivery="started")


def test_send_now_with_limits():
    a, t = agents(api_pb2.SendToAgentResponse(turn=2, delivery=api_pb2.AGENT_DELIVERY_JOINED))
    result = a.send(
        "box", "s-1", "also this", when="now", timeout_secs=600, max_steps=25, request_id="step-7"
    )
    request = t.calls[0][1]
    assert request.when == api_pb2.AGENT_SEND_WHEN_NOW
    assert (request.timeout_secs, request.max_steps) == (600, 25)
    assert request.request_id == "step-7"
    assert result.delivery == "joined"


def test_send_refuses_an_unknown_when():
    a, t = agents()
    with pytest.raises(ValueError, match='"next" or "now"'):
        a.send("box", "s-1", "x", when="later")
    assert t.calls == []


def test_interrupt():
    a, t = agents(
        api_pb2.InterruptAgentResponse(turn=3), api_pb2.InterruptAgentResponse()
    )
    assert a.interrupt("box", "s-1", clear_queue=True).turn == 3
    assert a.interrupt("box", "s-1").turn is None
    assert [c[1] for c in t.calls] == [
        api_pb2.InterruptAgentRequest(vm_id="box", session_id="s-1", clear_queue=True),
        api_pb2.InterruptAgentRequest(vm_id="box", session_id="s-1"),
    ]
    # Sent again after a lost answer, it could stop the next waiting turn.
    assert t.call_options == [{"retry": False}, {"retry": False}]


def test_interrupt_one_turn():
    a, t = agents(
        api_pb2.InterruptAgentResponse(turn=4), api_pb2.InterruptAgentResponse()
    )
    # Stopped, or taken out of the queue.
    assert a.interrupt("box", "s-1", turn=4, region="nyc") == AgentInterruptResult(turn=4)
    # Neither: it had ended.
    assert a.interrupt("box", "s-1", turn=2).turn is None
    assert [c[1] for c in t.calls] == [
        api_pb2.InterruptAgentRequest(vm_id="box", session_id="s-1", turn=4),
        api_pb2.InterruptAgentRequest(vm_id="box", session_id="s-1", turn=2),
    ]
    assert t.regions == ["nyc", None]
    assert t.call_options == [{"retry": False}, {"retry": False}]


def test_interrupt_refuses_a_turn_with_clear_queue():
    a, t = agents()
    with pytest.raises(ValueError, match="pass turn or clear_queue, not both"):
        a.interrupt("box", "s-1", turn=4, clear_queue=True)
    assert t.calls == []


def test_close_when_done_says_whether_the_session_is_still_open():
    a, t = agents(
        api_pb2.CloseAgentSessionResponse(pending=True, background=2),
        api_pb2.CloseAgentSessionResponse(),
    )
    assert a.close("box", "s-1", when_done=True, region="nyc") == AgentCloseResult(
        pending=True, background=2
    )
    # Nothing left to do: closed now. A server from before `when_done`
    # answers the same, an empty message.
    assert a.close("box", "s-1", when_done=True) == AgentCloseResult(
        pending=False, background=0
    )
    closing = api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1", when_done=True)
    assert [c[1] for c in t.calls] == [closing, closing]
    assert t.regions == ["nyc", None]
    assert t.call_options == [{}, {}]


def test_close_get_and_list():
    a, t = agents(
        api_pb2.CloseAgentSessionResponse(),
        a_session(state=api_pb2.AGENT_SESSION_STATE_RUNNING),
        api_pb2.ListAgentSessionsResponse(sessions=[a_session(), a_session(id="s-2")]),
        api_pb2.ListAgentSessionsResponse(),
    )
    assert a.close("box", "s-1") == AgentCloseResult(pending=False, background=0)
    assert a.get("box", "s-1").state == "running"
    assert [s.id for s in a.list("box", all=True)] == ["s-1", "s-2"]
    assert a.list("box") == []
    assert t.calls == [
        ("CloseAgentSession", api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1")),
        ("GetAgentSession", api_pb2.GetAgentSessionRequest(vm_id="box", session_id="s-1")),
        ("ListAgentSessions", api_pb2.ListAgentSessionsRequest(vm_id="box", all=True)),
        ("ListAgentSessions", api_pb2.ListAgentSessionsRequest(vm_id="box")),
    ]
    # Safe to send again: closing a closed session does nothing.
    assert t.call_options == [{}, {}, {}, {}]


def test_events_request_and_unknown_kinds_are_skipped():
    a, t = agents(
        [
            an_event(1, turn_started=api_pb2.AgentTurnStarted()),
            with_unknown_kind(2),
            an_event(3, message_delta=api_pb2.AgentMessageDelta(text="hi")),
        ]
    )
    events = list(a.events("box", "s-1", after_seq=12, follow=True, region="lon"))
    method, request = t.calls[0]
    assert method == "AgentEvents"
    assert request == api_pb2.AgentEventsRequest(
        vm_id="box", session_id="s-1", after_seq=12, follow=True
    )
    assert t.regions == ["lon"]
    assert [(e.seq, e.type) for e in events] == [(1, "turn.started"), (3, "message.delta")]
    assert isinstance(events[0], AgentTurnStarted)
    assert isinstance(events[1], AgentMessageDelta)


def test_events_default_reads_what_is_there():
    a, t = agents([])
    assert list(a.events("box", "s-1")) == []
    assert t.calls[0][1] == api_pb2.AgentEventsRequest(vm_id="box", session_id="s-1")


async def test_async_twin_sends_the_same():
    t = FakeAsyncTransport(
        [
            api_pb2.ListHarnessesResponse(harnesses=[api_pb2.Harness(id="opencode")]),
            a_session(),
            api_pb2.SendToAgentResponse(turn=1, delivery=api_pb2.AGENT_DELIVERY_QUEUED),
            [
                an_event(1, plan=api_pb2.AgentPlan()),
                with_unknown_kind(2),
                an_event(3, turn_finished=api_pb2.AgentTurnFinished(reason=2)),
            ],
            api_pb2.InterruptAgentResponse(turn=1),
            api_pb2.CloseAgentSessionResponse(),
            a_session(),
            api_pb2.ListAgentSessionsResponse(sessions=[a_session()]),
        ]
    )
    a = AsyncMachines(t).agents
    assert [h.id for h in await a.harnesses("box")] == ["opencode"]
    assert (await a.start("box", "opencode", effort="low", env={"A": "1"})).id == "s-1"
    assert (await a.send("box", "s-1", "go", when="now")).delivery == "queued"
    events = [e async for e in a.events("box", "s-1", after_seq=5)]
    assert [(e.seq, e.type) for e in events] == [(1, "plan"), (3, "turn.finished")]
    assert isinstance(events[0], AgentPlan) and events[1].reason == "interrupted"
    assert (await a.interrupt("box", "s-1", clear_queue=True)).turn == 1
    assert await a.close("box", "s-1") == AgentCloseResult(pending=False, background=0)
    assert (await a.get("box", "s-1")).state == "idle"
    assert len(await a.list("box", all=True)) == 1

    assert [c[0] for c in t.calls] == [
        "ListHarnesses",
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
        "CloseAgentSession",
        "GetAgentSession",
        "ListAgentSessions",
    ]
    requests = [c[1] for c in t.calls]
    assert requests[1].env == {"A": "1"}
    assert requests[1].effort == "low"
    assert requests[2].when == api_pb2.AGENT_SEND_WHEN_NOW
    assert requests[3] == api_pb2.AgentEventsRequest(vm_id="box", session_id="s-1", after_seq=5)
    assert requests[4].clear_queue is True
    assert requests[7].all is True
    assert UUID.match(requests[1].request_id) and UUID.match(requests[2].request_id)
    retry = [o.get("retry", True) for o in t.call_options]
    assert retry == [True, True, True, True, False, True, True, True]


def test_runs_defaults_are_empty_on_the_wire_and_retried_like_a_read():
    a, t = agents(api_pb2.ListAgentRunsResponse(runs=[a_run()]))
    page = a.runs()
    method, request = t.calls[0]
    assert method == "ListAgentRuns"
    assert request == api_pb2.ListAgentRunsRequest()
    assert t.call_options == [{}]
    assert t.regions == [None]
    assert [r.session_id for r in page.runs] == ["s-1"]
    assert page.next_page_token is None


def test_runs_sends_every_filter():
    a, t = agents(
        api_pb2.ListAgentRunsResponse(next_page_token="p3"),
        api_pb2.ListAgentRunsResponse(),
        api_pb2.ListAgentRunsResponse(),
    )
    page = a.runs(
        "box",
        "s-1",
        "acme",
        datetime(2026, 10, 14, 17, 46, 40, 123000, tzinfo=timezone.utc),
        10,
        "p2",
        region="nyc",
    )
    assert t.calls[0][1] == api_pb2.ListAgentRunsRequest(
        org="acme",
        vm_id="box",
        session_id="s-1",
        since_ms=T0 + 123,
        limit=10,
        page_token="p2",
    )
    assert t.regions == ["nyc"]
    assert page.next_page_token == "p3"
    # Unix seconds, and a naive datetime as UTC.
    a.runs(machine="box", since=1_792_000_000)
    a.runs(since=datetime(2026, 10, 14, 17, 46, 40))
    assert t.calls[1][1].since_ms == T0
    assert t.calls[2][1].since_ms == T0


def test_iter_runs_reads_page_after_page_and_stops_on_the_last():
    a, t = agents(
        api_pb2.ListAgentRunsResponse(runs=[a_run(turn=3), a_run(turn=2)], next_page_token="p2"),
        api_pb2.ListAgentRunsResponse(runs=[a_run(turn=1)]),
    )
    assert [r.turn for r in a.iter_runs(machine="box", limit=2)] == [3, 2, 1]
    assert [c[1] for c in t.calls] == [
        api_pb2.ListAgentRunsRequest(vm_id="box", limit=2),
        api_pb2.ListAgentRunsRequest(vm_id="box", limit=2, page_token="p2"),
    ]


def test_iter_runs_reads_no_further_than_the_caller():
    a, t = agents(
        api_pb2.ListAgentRunsResponse(runs=[a_run(turn=3), a_run(turn=2)], next_page_token="p2"),
        api_pb2.ListAgentRunsResponse(runs=[a_run(turn=1)]),
    )
    for run in a.iter_runs():
        if run.turn == 3:
            break
    assert len(t.calls) == 1


async def test_async_runs_and_iter_runs():
    t = FakeAsyncTransport(
        [
            api_pb2.ListAgentRunsResponse(runs=[a_run()], next_page_token="p2"),
            api_pb2.ListAgentRunsResponse(runs=[a_run(turn=2)], next_page_token="p2"),
            api_pb2.ListAgentRunsResponse(runs=[a_run(turn=1)]),
        ]
    )
    a = AsyncMachines(t).agents
    page = await a.runs(session="s-1", org="acme", region="lon")
    assert page.next_page_token == "p2"
    assert t.calls[0] == (
        "ListAgentRuns",
        api_pb2.ListAgentRunsRequest(org="acme", session_id="s-1"),
    )
    assert t.regions == ["lon"]
    assert [r.turn async for r in a.iter_runs(session="s-1")] == [2, 1]
    assert [c[1].page_token for c in t.calls[1:]] == ["", "p2"]
    assert t.call_options == [{}, {}, {}]


async def test_async_interrupt_one_turn_and_close_when_done():
    t = FakeAsyncTransport(
        [
            api_pb2.InterruptAgentResponse(turn=4),
            api_pb2.CloseAgentSessionResponse(pending=True, background=1),
            api_pb2.CloseAgentSessionResponse(),
        ]
    )
    a = AsyncMachines(t).agents
    assert await a.interrupt("box", "s-1", turn=4) == AgentInterruptResult(turn=4)
    assert await a.close("box", "s-1", when_done=True) == AgentCloseResult(
        pending=True, background=1
    )
    assert await a.close("box", "s-1", when_done=True) == AgentCloseResult(
        pending=False, background=0
    )
    with pytest.raises(ValueError, match="pass turn or clear_queue, not both"):
        await a.interrupt("box", "s-1", turn=4, clear_queue=True)
    closing = api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1", when_done=True)
    assert [c[1] for c in t.calls] == [
        api_pb2.InterruptAgentRequest(vm_id="box", session_id="s-1", turn=4),
        closing,
        closing,
    ]
    assert [o.get("retry", True) for o in t.call_options] == [False, True, True]


async def test_async_send_refuses_an_unknown_when():
    t = FakeAsyncTransport()
    with pytest.raises(ValueError):
        await AsyncMachines(t).agents.send("box", "s-1", "x", when="soon")
    assert t.calls == []


# --- signing an agent in ---


def a_device_start(**overrides):
    fields = dict(
        method=api_pb2.AGENT_LOGIN_METHOD_DEVICE_CODE,
        url="https://auth.openai.com/codex/device",
        user_code="ABCD-1234",
        handle="h-1",
        expires_at_ms=T0 + 900_000,
        interval_secs=5,
    )
    fields.update(overrides)
    return api_pb2.StartAgentLoginResponse(**fields)


def a_login(**overrides):
    fields = dict(
        harness="codex",
        signed_in=True,
        account="ada@example.com",
        org_id="org-1",
        updated_at_ms=T0,
    )
    fields.update(overrides)
    return api_pb2.AgentLogin(**fields)


def approved(**overrides):
    return api_pb2.CompleteAgentLoginResponse(login=a_login(**overrides))


def pending(n):
    return [api_pb2.CompleteAgentLoginResponse(pending=True) for _ in range(n)]


def test_login_start_for_claude_code_has_no_device_fields():
    start = m.agent_login_start(
        api_pb2.StartAgentLoginResponse(
            method=api_pb2.AGENT_LOGIN_METHOD_PASTE_CODE,
            url="https://claude.ai/oauth/authorize?x=1",
        )
    )
    assert start == AgentLoginStart(
        method="paste_code",
        url="https://claude.ai/oauth/authorize?x=1",
        user_code=None,
        handle=None,
        expires_at=None,
        interval_secs=None,
    )


def test_login_start_for_codex_maps_the_device_code():
    assert m.agent_login_start(a_device_start()) == AgentLoginStart(
        method="device_code",
        url="https://auth.openai.com/codex/device",
        user_code="ABCD-1234",
        handle="h-1",
        expires_at=datetime(2026, 10, 14, 18, 1, 40, tzinfo=timezone.utc),
        interval_secs=5,
    )
    # From a newer server.
    assert m.agent_login_start(a_device_start(method=99)).method == "unknown"


def test_login_maps_every_field_and_an_empty_account_is_none():
    assert m.agent_login(a_login()) == AgentLogin(
        harness="codex",
        signed_in=True,
        account="ada@example.com",
        org_id="org-1",
        updated_at=T0_DT,
    )
    assert m.agent_login(a_login(account="")).account is None
    # Signed out.
    assert m.agent_login(
        a_login(signed_in=False, account="", updated_at_ms=0)
    ) == AgentLogin(
        harness="codex", signed_in=False, account=None, org_id="org-1", updated_at=None
    )


def test_login_result_pending_or_signed_in():
    assert m.agent_login_result(api_pb2.CompleteAgentLoginResponse(pending=True)) == (
        AgentLoginResult(pending=True, login=None)
    )
    assert m.agent_login_result(approved()) == AgentLoginResult(
        pending=False, login=m.agent_login(a_login())
    )


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_start_login():
    a, t = agents(
        api_pb2.StartAgentLoginResponse(
            method=api_pb2.AGENT_LOGIN_METHOD_PASTE_CODE, url="https://claude.ai/x"
        ),
        a_device_start(),
    )
    claude = a.start_login("box", "claude-code")
    codex = a.start_login("box", "codex", region="nyc")
    assert (claude.method, claude.url, claude.handle) == ("paste_code", "https://claude.ai/x", None)
    assert (codex.method, codex.user_code, codex.handle) == ("device_code", "ABCD-1234", "h-1")
    assert t.calls == [
        ("StartAgentLogin", api_pb2.StartAgentLoginRequest(vm_id="box", harness="claude-code")),
        ("StartAgentLogin", api_pb2.StartAgentLoginRequest(vm_id="box", harness="codex")),
    ]
    assert t.regions == [None, "nyc"]


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_complete_login_sends_the_code_or_the_handle():
    a, t = agents(approved(harness="claude-code"), *pending(1))
    done = a.complete_login("box", "claude-code", code="abc#state")
    assert done.pending is False
    assert done.login is not None and done.login.harness == "claude-code"
    waiting = a.complete_login("box", "codex", handle="h-1", region="lon")
    assert waiting == AgentLoginResult(pending=True, login=None)
    assert t.calls == [
        (
            "CompleteAgentLogin",
            api_pb2.CompleteAgentLoginRequest(
                vm_id="box", harness="claude-code", code="abc#state"
            ),
        ),
        (
            "CompleteAgentLogin",
            api_pb2.CompleteAgentLoginRequest(vm_id="box", harness="codex", handle="h-1"),
        ),
    ]
    assert t.regions == [None, "lon"]


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_get_login_and_logout():
    a, t = agents(a_login(account=""), api_pb2.DeleteAgentLoginResponse())
    login = a.get_login("box", "codex", region="nyc")
    assert login.signed_in is True and login.account is None
    assert a.logout("box", "claude-code") is None
    assert t.calls == [
        ("GetAgentLogin", api_pb2.GetAgentLoginRequest(vm_id="box", harness="codex")),
        ("DeleteAgentLogin", api_pb2.DeleteAgentLoginRequest(vm_id="box", harness="claude-code")),
    ]
    assert t.regions == ["nyc", None]


class FakeClock:
    """Stands in for `time` (and `asyncio.sleep`) in the agents module:
    sleeping moves it on."""

    def __init__(self):
        self.now = T0 / 1000
        self.slept: list[float] = []

    def time(self):
        return self.now

    def monotonic(self):
        return self.now

    def sleep(self, secs):
        self.slept.append(secs)
        self.now += secs

    async def async_sleep(self, secs):
        self.sleep(secs)


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr("boxd.resources.agents.time", c)
    monkeypatch.setattr(
        "boxd.resources.agents.asyncio", SimpleNamespace(sleep=c.async_sleep)
    )
    return c


def device_start(*, expires_in=900, interval=5):
    return m.agent_login_start(
        a_device_start(expires_at_ms=T0 + expires_in * 1000, interval_secs=interval)
    )


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_wait_for_login_asks_with_the_handle_until_it_is_approved(clock):
    a, t = agents(*pending(2), approved())
    login = a.wait_for_login("box", "codex", device_start(), region="nyc")
    assert login == m.agent_login(a_login())
    asked = (
        "CompleteAgentLogin",
        api_pb2.CompleteAgentLoginRequest(vm_id="box", harness="codex", handle="h-1"),
    )
    assert t.calls == [asked] * 3
    assert t.regions == ["nyc"] * 3
    assert clock.slept == [5, 5]


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_wait_for_login_gives_up_once_the_code_expires(clock):
    a, t = agents(*pending(10))
    with pytest.raises(
        TimeoutError,
        match="the codex sign-in code expired before it was approved: start again",
    ):
        a.wait_for_login("box", "codex", device_start(expires_in=12))
    # Asked at 0, 5, 10 and, last, at 12, when it expires.
    assert clock.slept == [5, 5, 2]
    assert len(t.calls) == 4


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_wait_for_login_gives_up_after_its_timeout_when_that_comes_first(clock):
    a, t = agents(*pending(10))
    with pytest.raises(TimeoutError, match="the codex sign-in wasn't approved within 7s"):
        a.wait_for_login("box", "codex", device_start(), timeout=7)
    assert clock.slept == [5, 2]
    assert len(t.calls) == 3


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_wait_for_login_asks_every_5s_when_the_start_does_not_say(clock):
    a, _ = agents(*pending(1), approved())
    start = AgentLoginStart(method="device_code", url="https://x", handle="h-1")
    assert a.wait_for_login("box", "codex", start).signed_in is True
    assert clock.slept == [5]


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
def test_wait_for_login_refuses_a_paste_code_sign_in():
    a, t = agents()
    with pytest.raises(ValueError, match="a paste_code sign-in can't be waited on"):
        a.wait_for_login(
            "box", "claude-code", AgentLoginStart(method="paste_code", url="https://x")
        )
    with pytest.raises(ValueError, match="the sign-in has no handle"):
        a.wait_for_login(
            "box", "codex", AgentLoginStart(method="device_code", url="https://x")
        )
    with pytest.raises(ValueError, match="a device_code sign-in, not 'unknown'"):
        a.wait_for_login(
            "box", "codex", AgentLoginStart(method="unknown", url="https://x", handle="h")
        )
    assert t.calls == []


@pytest.mark.filterwarnings("ignore:machines.agents:DeprecationWarning")
async def test_async_logins(clock):
    t = FakeAsyncTransport(
        [
            a_device_start(),
            *pending(1),
            approved(),
            approved(harness="claude-code"),
            a_login(signed_in=False, account="", updated_at_ms=0),
            api_pb2.DeleteAgentLoginResponse(),
            *pending(10),
        ]
    )
    a = AsyncMachines(t).agents
    start = await a.start_login("box", "codex", region="nyc")
    login = await a.wait_for_login("box", "codex", start, region="nyc")
    assert login.org_id == "org-1" and clock.slept == [5]
    done = await a.complete_login("box", "claude-code", code="abc#state")
    assert done.login is not None and done.login.harness == "claude-code"
    signed_out = await a.get_login("box", "codex")
    assert (signed_out.signed_in, signed_out.account, signed_out.updated_at) == (
        False,
        None,
        None,
    )
    assert await a.logout("box", "codex") is None
    assert [c[0] for c in t.calls] == [
        "StartAgentLogin",
        "CompleteAgentLogin",
        "CompleteAgentLogin",
        "CompleteAgentLogin",
        "GetAgentLogin",
        "DeleteAgentLogin",
    ]
    requests = [c[1] for c in t.calls]
    assert requests[0] == api_pb2.StartAgentLoginRequest(vm_id="box", harness="codex")
    assert requests[1] == requests[2] == api_pb2.CompleteAgentLoginRequest(
        vm_id="box", harness="codex", handle="h-1"
    )
    assert requests[3].code == "abc#state"
    assert t.regions[:3] == ["nyc"] * 3

    with pytest.raises(TimeoutError, match="within 3s"):
        await a.wait_for_login("box", "codex", start, timeout=3)
    with pytest.raises(ValueError, match="can't be waited on"):
        await a.wait_for_login(
            "box", "claude-code", AgentLoginStart(method="paste_code", url="https://x")
        )


# --- the events stream through the real transport ---


class StreamCall:
    """A server-streaming call as grpc returns it: iterable, cancellable."""

    def __init__(self, items, error=None):
        self.items = list(items)
        self.error = error
        self.cancelled = False

    def __iter__(self):
        yield from self.items
        if self.error is not None:
            raise self.error

    def cancel(self):
        self.cancelled = True
        return True


class AioStreamCall(StreamCall):
    async def __aiter__(self):
        for item in self.items:
            yield item
        if self.error is not None:
            raise self.error


class StreamMethod:
    """A stub's `AgentEvents`: records how it was called."""

    def __init__(self, call):
        self.call = call
        self.kwargs: dict = {}
        self.request = None

    def __call__(self, request, **kwargs):
        self.request = request
        self.kwargs = kwargs
        return self.call


def real_agents(call, *, unary=None):
    """`machines.agents` over a real SyncTransport (and router) whose stub is
    scripted. The client's own timeout is 1s, so any deadline would show."""
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    method = StreamMethod(call)
    t._stub = FakeStub(AgentEvents=method, **(unary or {}))
    router = SyncRouter(t, region=None, connect=lambda url, **_: t)
    return Machines(router).agents, method


def real_async_agents(call):
    t = AsyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeAsyncCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    method = StreamMethod(call)
    t._stub = FakeStub(AgentEvents=method)
    router = AsyncRouter(t, region=None, connect=lambda url, **_: t)
    return AsyncMachines(router).agents, method


def test_a_follow_stream_has_no_deadline():
    call = StreamCall([an_event(1, turn_started=api_pb2.AgentTurnStarted())])
    a, method = real_agents(call)
    events = list(a.events("box", "s-1", follow=True))
    assert [e.type for e in events] == ["turn.started"]
    assert method.request.follow is True
    # The client's 1s timeout would cut a stream meant to stay open.
    assert method.kwargs.get("timeout") is None
    assert "authorization" in dict(method.kwargs["metadata"])


def test_a_stream_ends_cleanly_when_the_server_ends_it():
    call = StreamCall(
        [
            an_event(1, turn_started=api_pb2.AgentTurnStarted()),
            an_event(2, turn_finished=api_pb2.AgentTurnFinished(reason=1)),
        ]
    )
    a, _ = real_agents(call)
    stream = a.events("box", "s-1")
    assert [e.seq for e in stream] == [1, 2]
    with pytest.raises(StopIteration):
        next(stream)


def test_stopping_early_ends_the_call():
    call = StreamCall([an_event(i, turn_started=api_pb2.AgentTurnStarted()) for i in (1, 2, 3)])
    a, _ = real_agents(call)
    stream = a.events("box", "s-1", follow=True)
    assert next(stream).seq == 1
    assert call.cancelled is False
    stream.close()  # what a `break` does once the generator is dropped
    assert call.cancelled is True


def test_a_stream_error_is_a_boxd_error():
    call = StreamCall(
        [an_event(1, turn_started=api_pb2.AgentTurnStarted())],
        error=FakeRpcError(grpc.StatusCode.NOT_FOUND, "no session s-9"),
    )
    a, _ = real_agents(call)
    seen = []
    with pytest.raises(NotFoundError, match="no session s-9"):
        for event in a.events("box", "s-9", follow=True):
            seen.append(event.seq)
    assert seen == [1]


async def test_async_follow_stream_has_no_deadline_and_ends_cleanly():
    call = AioStreamCall(
        [
            an_event(1, message=api_pb2.AgentMessage(text="done")),
            with_unknown_kind(2),
        ]
    )
    a, method = real_async_agents(call)
    events = [e async for e in a.events("box", "s-1", follow=True)]
    assert [e.seq for e in events] == [1]
    assert isinstance(events[0], AgentMessage) and events[0].text == "done"
    assert method.kwargs.get("timeout") is None


async def test_async_stopping_early_ends_the_call():
    call = AioStreamCall([an_event(i, turn_started=api_pb2.AgentTurnStarted()) for i in (1, 2)])
    a, _ = real_async_agents(call)
    async with aclosing(a.events("box", "s-1", follow=True)) as stream:
        async for event in stream:
            assert event.seq == 1
            break
    assert call.cancelled is True


# --- sent once, or again, through the real transport ---


class RecordingMulticallable(FakeMulticallable):
    """A stub method that also keeps the request of every attempt."""

    def __init__(self, outcomes):
        super().__init__(outcomes)
        self.requests: list = []

    def with_call(self, request, timeout=None, metadata=None):
        self.requests.append(request)
        return super().with_call(request, timeout=timeout, metadata=metadata)

    def __call__(self, request, timeout=None, metadata=None):
        self.requests.append(request)
        return super().__call__(request, timeout=timeout, metadata=metadata)


@pytest.mark.parametrize("method", ["StartAgentSession", "SendToAgent"])
def test_start_and_send_are_sent_again_after_unavailable_with_the_same_request_id(
    monkeypatch, method
):
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    answer = (
        a_session() if method == "StartAgentSession" else api_pb2.SendToAgentResponse(turn=1)
    )
    stub = RecordingMulticallable(
        [FakeRpcError(grpc.StatusCode.UNAVAILABLE, "connection reset"), answer]
    )
    a, _ = real_agents(StreamCall([]), unary={method: stub})
    if method == "StartAgentSession":
        assert a.start("box", "claude-code").id == "s-1"
    else:
        assert a.send("box", "s-1", "hello").turn == 1
    assert stub.attempts == 2
    ids = [r.request_id for r in stub.requests]
    assert UUID.match(ids[0]) and ids[0] == ids[1], ids


def test_reads_are_sent_again_after_unavailable(monkeypatch):
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    listing = FakeMulticallable(
        [
            FakeRpcError(grpc.StatusCode.UNAVAILABLE, "connection reset"),
            api_pb2.ListAgentSessionsResponse(sessions=[a_session()]),
        ]
    )
    a, _ = real_agents(StreamCall([]), unary={"ListAgentSessions": listing})
    assert [s.id for s in a.list("box")] == ["s-1"]
    assert listing.attempts == 2


# --- run: one task, start to reply ---


def sent(turn=1, delivery=api_pb2.AGENT_DELIVERY_STARTED):
    return api_pb2.SendToAgentResponse(turn=turn, delivery=delivery)


def finished(seq, turn=1, reason=api_pb2.AGENT_FINISH_REASON_DONE, error=""):
    return an_event(
        seq, turn=turn, turn_finished=api_pb2.AgentTurnFinished(reason=reason, error=error)
    )


def message(seq, text, turn=1):
    return an_event(seq, turn=turn, message=api_pb2.AgentMessage(text=text))


def delta(seq, text, turn=1):
    return an_event(seq, turn=turn, message_delta=api_pb2.AgentMessageDelta(text=text))


def broken(*events, error):
    """A stream that carries `events`, then fails with `error`."""
    yield from events
    raise error


def status(code, details="boom"):
    """The error the transport raises for a gRPC status."""
    return from_grpc_error(FakeRpcError(code, details))


# What a stream can fail with and be followed again: the connection, a
# deadline, the server or the way to the machine breaking.
BREAKS = [
    grpc.StatusCode.UNKNOWN,
    grpc.StatusCode.INTERNAL,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.CANCELLED,
    grpc.StatusCode.ABORTED,
]
# An answer about the request itself: the same again, however often it's asked.
ANSWERS = [
    grpc.StatusCode.NOT_FOUND,
    grpc.StatusCode.PERMISSION_DENIED,
    grpc.StatusCode.UNAUTHENTICATED,
    grpc.StatusCode.INVALID_ARGUMENT,
    grpc.StatusCode.FAILED_PRECONDITION,
    grpc.StatusCode.UNIMPLEMENTED,
    grpc.StatusCode.OUT_OF_RANGE,
    grpc.StatusCode.ALREADY_EXISTS,
]


def named(codes):
    return [pytest.param(code, id=code.name.lower()) for code in codes]


CLOSED = api_pb2.CloseAgentSessionResponse()


def test_run_starts_a_session_follows_its_turn_and_closes_it():
    a, t = agents(
        a_session(harness="codex", model="gpt-5", effort="high"),
        sent(1),
        [
            an_event(1, turn_started=api_pb2.AgentTurnStarted()),
            delta(2, "Look"),
            message(3, "Looking at it."),
            an_event(4, tool_started=api_pb2.AgentToolStarted(call_id="c", name="Bash")),
            message(5, "Fixed: 2 tests."),
            an_event(
                6,
                usage=api_pb2.AgentUsage(
                    input_tokens=5, output_tokens=7, cache_read_tokens=100
                ),
            ),
            finished(7),
        ],
        CLOSED,
    )
    seen = []
    result = a.run(
        "box",
        "codex",
        "fix it",
        model="gpt-5",
        effort="high",
        cwd="/srv",
        instructions="be brief",
        env={"A": "1"},
        timeout_secs=600,
        max_steps=20,
        on_event=lambda e: seen.append(e.type),
        region="nyc",
    )
    assert result == AgentRunResult(
        session_id="s-1",
        machine_id="vm-1",
        harness="codex",
        model="gpt-5",
        effort="high",
        turn=1,
        reason="done",
        error=None,
        reply="Fixed: 2 tests.",
        usage=AgentRunUsage(
            input_tokens=5, output_tokens=7, cache_read_tokens=100, cache_write_tokens=0
        ),
        kept=False,
    )
    assert seen == [
        "turn.started",
        "message.delta",
        "message",
        "tool.started",
        "message",
        "usage",
        "turn.finished",
    ]
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "CloseAgentSession",
    ]
    start, send, events, close = (c[1] for c in t.calls)
    assert UUID.match(start.request_id) and UUID.match(send.request_id)
    assert start == api_pb2.StartAgentSessionRequest(
        vm_id="box",
        harness="codex",
        model="gpt-5",
        effort="high",
        cwd="/srv",
        instructions="be brief",
        env={"A": "1"},
        request_id=start.request_id,
    )
    assert send == api_pb2.SendToAgentRequest(
        vm_id="box",
        session_id="s-1",
        text="fix it",
        when=api_pb2.AGENT_SEND_WHEN_NEXT,
        timeout_secs=600,
        max_steps=20,
        request_id=send.request_id,
    )
    assert events == api_pb2.AgentEventsRequest(vm_id="box", session_id="s-1", follow=True)
    # Once it has nothing left to do, which here is now.
    assert close == api_pb2.CloseAgentSessionRequest(
        vm_id="box", session_id="s-1", when_done=True
    )
    assert t.regions == ["nyc"] * 4


def test_run_leaves_what_the_agent_runs_in_the_background():
    a, t = agents(
        a_session(),
        sent(1),
        [message(1, "The build is running."), finished(2)],
        api_pb2.CloseAgentSessionResponse(pending=True, background=2),
    )
    result = a.run("box", "claude-code", "start the build")
    assert (result.reply, result.reason) == ("The build is running.", "done")
    # Still open, and closes by itself: not `kept`, which is the caller's to close.
    assert (result.kept, result.closes_when_done, result.background) == (False, True, 2)
    assert t.calls[-1] == (
        "CloseAgentSession",
        api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1", when_done=True),
    )


def test_run_keep_leaves_the_session_it_started_open():
    a, t = agents(a_session(), sent(1), [finished(1)])
    result = a.run("box", "claude-code", "hi", keep=True)
    assert (result.kept, result.closes_when_done, result.background) == (True, False, 0)
    assert [c[0] for c in t.calls] == ["StartAgentSession", "SendToAgent", "AgentEvents"]


def test_run_in_an_open_session_ignores_other_turns_and_leaves_it_open():
    a, t = agents(
        a_session(
            id="s-7",
            harness="codex",
            state=api_pb2.AGENT_SESSION_STATE_RUNNING,
            turn=3,
            last_seq=40,
        ),
        sent(4, api_pb2.AGENT_DELIVERY_QUEUED),
        [
            message(41, "the turn before", turn=3),
            finished(42, turn=3, reason=api_pb2.AGENT_FINISH_REASON_FAILED, error="not ours"),
            message(43, "ours", turn=4),
            finished(44, turn=4),
        ],
    )
    seen = []
    result = a.run(
        "box", "codex", "and then this", session="s-7", on_event=lambda e: seen.append(e.seq)
    )
    assert (result.session_id, result.turn, result.reason, result.error) == (
        "s-7",
        4,
        "done",
        None,
    )
    assert (result.reply, result.kept) == ("ours", True)
    # The session's agent and model; None: the agent's own default.
    assert (result.harness, result.model) == ("codex", None)
    assert seen == [43, 44]
    assert [c[0] for c in t.calls] == ["GetAgentSession", "SendToAgent", "AgentEvents"]
    assert t.calls[0][1] == api_pb2.GetAgentSessionRequest(vm_id="box", session_id="s-7")
    assert t.calls[2][1] == api_pb2.AgentEventsRequest(
        vm_id="box", session_id="s-7", after_seq=40, follow=True
    )


def test_run_refuses_another_agents_session_a_closed_or_failed_one():
    a, t = agents(
        a_session(harness="claude-code"),
        a_session(harness="codex", state=api_pb2.AGENT_SESSION_STATE_CLOSED),
        a_session(harness="codex", state=api_pb2.AGENT_SESSION_STATE_FAILED),
    )
    with pytest.raises(BoxdError, match="session s-1 runs claude-code, not codex"):
        a.run("box", "codex", "x", session="s-1")
    with pytest.raises(
        BoxdError, match="session s-1 is closed: leave out session= to start a new one"
    ):
        a.run("box", "codex", "x", session="s-1")
    with pytest.raises(BoxdError, match="session s-1 is failed"):
        a.run("box", "codex", "x", session="s-1")
    with pytest.raises(ValueError, match="are for a new session: leave them out with session="):
        a.run("box", "codex", "x", session="s-1", env={"A": "1"})
    with pytest.raises(
        ValueError, match="model, effort, cwd, instructions and env are for a new session"
    ):
        a.run("box", "codex", "x", session="s-1", effort="high")
    assert [c[0] for c in t.calls] == ["GetAgentSession"] * 3


@pytest.mark.parametrize(
    "events, reply",
    [
        # The last whole message; only whitespace streamed since doesn't count.
        ([message(1, "first"), message(2, "last"), delta(3, "  ")], "last"),
        # An agent that only streams: what the pieces add up to.
        ([delta(1, "Hel"), delta(2, "lo")], "Hello"),
        ([message(1, "earlier"), delta(2, "and "), delta(3, "later")], "and later"),
        ([], ""),
    ],
)
def test_run_reply_is_the_last_message_or_what_the_pieces_since_add_up_to(events, reply):
    a, _ = agents(a_session(), sent(1), [*events, finished(99)], CLOSED)
    assert a.run("box", "codex", "x").reply == reply


def test_run_returns_a_failed_turn_with_its_error_and_closes_the_session():
    a, t = agents(
        a_session(),
        sent(1),
        [finished(1, reason=api_pb2.AGENT_FINISH_REASON_FAILED, error="overloaded")],
        CLOSED,
    )
    result = a.run("box", "claude-code", "x")
    assert (result.reason, result.error, result.reply, result.usage, result.kept) == (
        "failed",
        "overloaded",
        "",
        None,
        False,
    )
    assert t.calls[-1][0] == "CloseAgentSession"


def test_run_keeps_the_reply_of_a_session_it_could_not_close():
    a, _ = agents(
        a_session(),
        sent(1),
        [message(1, "done"), finished(2)],
        APIConnectionError("connection reset"),
    )
    result = a.run("box", "claude-code", "x")
    assert (result.reply, result.kept, result.closes_when_done) == ("done", True, False)


@pytest.mark.parametrize("keep", [False, True])
def test_run_ctrl_c_interrupts_the_turn_and_closes_the_session_it_started(keep):
    a, t = agents(
        a_session(),
        sent(1),
        broken(an_event(1, turn_started=api_pb2.AgentTurnStarted()), error=KeyboardInterrupt()),
        api_pb2.InterruptAgentResponse(turn=1),
        CLOSED,
    )
    with pytest.raises(KeyboardInterrupt):
        a.run("box", "claude-code", "x", keep=keep)
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
        *([] if keep else ["CloseAgentSession"]),
    ]
    # Its own turn; and the session is closed at once, whatever it still runs.
    assert t.calls[3][1] == api_pb2.InterruptAgentRequest(
        vm_id="box", session_id="s-1", turn=1
    )
    if not keep:
        assert t.calls[4][1] == api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1")


def test_run_ctrl_c_while_its_message_still_waits_interrupts_only_its_own_turn():
    # The session is running turn 3, someone else's; the task waits as turn 4.
    a, t = agents(
        a_session(id="s-7", state=api_pb2.AGENT_SESSION_STATE_RUNNING, turn=3, last_seq=40),
        sent(4, api_pb2.AGENT_DELIVERY_QUEUED),
        broken(delta(41, "theirs", turn=3), error=KeyboardInterrupt()),
        api_pb2.InterruptAgentResponse(turn=4),
    )
    with pytest.raises(KeyboardInterrupt):
        a.run("box", "claude-code", "x", session="s-7")
    assert [c[0] for c in t.calls] == [
        "GetAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
    ]
    # Turn 4 is taken out of the queue; turn 3 runs on.
    assert t.calls[3][1] == api_pb2.InterruptAgentRequest(
        vm_id="box", session_id="s-7", turn=4
    )


def test_run_ctrl_c_before_the_send_returned_interrupts_nothing():
    # No turn to name: the session it started is closed, which ends any turn.
    a, t = agents(a_session(), KeyboardInterrupt(), CLOSED)
    with pytest.raises(KeyboardInterrupt):
        a.run("box", "claude-code", "x")
    assert [c[0] for c in t.calls] == ["StartAgentSession", "SendToAgent", "CloseAgentSession"]


def test_run_an_error_while_following_still_closes_the_session():
    a, t = agents(
        a_session(), sent(1), status(grpc.StatusCode.NOT_FOUND, "no session s-1"), CLOSED
    )
    with pytest.raises(NotFoundError, match="no session s-1"):
        a.run("box", "codex", "x")
    # An answer about the request, not a break: not followed again.
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "CloseAgentSession",
    ]

    def broke(_event):
        raise ValueError("callback broke")

    a, t = agents(a_session(), sent(1), [finished(1)], CLOSED)
    with pytest.raises(ValueError, match="callback broke"):
        a.run("box", "codex", "x", on_event=broke)
    assert [c[0] for c in t.calls][-2:] == ["AgentEvents", "CloseAgentSession"]


def test_run_events_that_end_before_the_turn_finished_raise_and_close():
    a, t = agents(
        a_session(), sent(1), [an_event(1, turn_started=api_pb2.AgentTurnStarted())], CLOSED
    )
    with pytest.raises(
        BoxdError,
        match="the session's events ended before turn 1 finished: it may have been closed",
    ):
        a.run("box", "codex", "x")
    assert t.calls[-1][0] == "CloseAgentSession"


def test_run_follows_a_broken_stream_again_from_the_last_event(clock):
    a, t = agents(
        a_session(last_seq=3),
        sent(2),
        broken(
            an_event(4, turn=2, turn_started=api_pb2.AgentTurnStarted()),
            delta(5, "Hel", turn=2),
            error=BoxdError("stream reset"),
        ),
        APIConnectionError("connection refused"),
        [delta(6, "lo", turn=2), finished(7, turn=2)],
        CLOSED,
    )
    result = a.run("box", "codex", "x")
    assert (result.reply, result.reason) == ("Hello", "done")
    assert [c[1].after_seq for c in t.calls if c[0] == "AgentEvents"] == [3, 5, 5]
    assert clock.slept == [1, 2]


@pytest.mark.parametrize("code", named(BREAKS))
def test_run_follows_again_a_stream_that_breaks_before_its_first_event(clock, code):
    # A quiet turn (a long command: no events for minutes). A stream that
    # fails before it carries anything may never have opened, or have opened
    # and broken: followed again either way.
    a, t = agents(
        a_session(),
        sent(1),
        status(code),
        broken(
            an_event(1, turn_started=api_pb2.AgentTurnStarted()),
            delta(2, "Hel"),
            error=status(code),
        ),
        broken(error=status(code)),
        [delta(3, "lo"), finished(4)],
        CLOSED,
    )
    seen = []
    result = a.run("box", "codex", "x", on_event=lambda e: seen.append(e.seq))
    assert (result.reply, result.reason) == ("Hello", "done")
    # Followed again from the last event seen: none reaches on_event twice.
    assert seen == [1, 2, 3, 4]
    assert [c[1].after_seq for c in t.calls if c[0] == "AgentEvents"] == [0, 0, 2, 2]
    assert clock.slept == [1, 2, 3]
    assert t.calls[-1][0] == "CloseAgentSession"


def test_run_gives_on_event_each_event_once_across_a_re_follow(clock):
    # Another turn's events move the place to follow on from too.
    a, t = agents(
        a_session(id="s-7", state=api_pb2.AGENT_SESSION_STATE_RUNNING, turn=3, last_seq=40),
        sent(4, api_pb2.AGENT_DELIVERY_QUEUED),
        broken(
            delta(41, "theirs", turn=3),
            finished(42, turn=3),
            error=status(grpc.StatusCode.UNKNOWN),
        ),
        broken(delta(43, "ou", turn=4), error=status(grpc.StatusCode.INTERNAL)),
        [delta(44, "rs", turn=4), finished(45, turn=4)],
    )
    seen = []
    result = a.run("box", "claude-code", "x", session="s-7", on_event=lambda e: seen.append(e.seq))
    assert seen == [43, 44, 45]
    assert (result.reply, result.reason) == ("ours", "done")
    assert [c[1].after_seq for c in t.calls if c[0] == "AgentEvents"] == [40, 42, 43]
    assert clock.slept == [1, 2]


@pytest.mark.parametrize("code", named(ANSWERS))
def test_run_does_not_follow_again_after_an_answer_about_the_request(clock, code):
    # Whether the stream carried events before it or not.
    for stream in (status(code), broken(message(1, "half"), error=status(code))):
        a, t = agents(a_session(), sent(1), stream, CLOSED)
        with pytest.raises(BoxdError) as e:
            a.run("box", "codex", "x")
        assert e.value.code == code.name.lower()
        assert [c[0] for c in t.calls] == [
            "StartAgentSession",
            "SendToAgent",
            "AgentEvents",
            "CloseAgentSession",
        ]
    assert clock.slept == []


@pytest.mark.parametrize(
    "stream, error",
    [
        (
            lambda seq: broken(delta(seq, "x"), error=APIConnectionError("connection reset")),
            APIConnectionError,
        ),
        (lambda seq: broken(error=status(grpc.StatusCode.UNKNOWN)), APIStatusError),
    ],
    ids=["after an event", "before any event"],
)
def test_run_gives_up_after_five_breaks(clock, stream, error):
    a, t = agents(a_session(), sent(1), *(stream(seq) for seq in range(1, 7)), CLOSED)
    with pytest.raises(error):
        a.run("box", "codex", "x")
    assert clock.slept == [1, 2, 3, 4, 5]
    assert [c[0] for c in t.calls].count("AgentEvents") == 6
    assert t.calls[-1][0] == "CloseAgentSession"


async def test_async_run_is_the_same():
    t = FakeAsyncTransport(
        [
            a_session(),
            sent(1),
            [message(1, "on it"), delta(2, "do"), delta(3, "ne"), finished(4)],
            CLOSED,
        ]
    )
    seen = []
    result = await AsyncMachines(t).agents.run(
        "box", "codex", "x", cwd="/srv", effort="medium", on_event=lambda e: seen.append(e.seq)
    )
    assert (result.reply, result.reason, result.kept) == ("done", "done", False)
    assert seen == [1, 2, 3, 4]
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "CloseAgentSession",
    ]
    assert t.calls[0][1].cwd == "/srv"
    assert t.calls[0][1].effort == "medium"
    assert t.calls[3][1].when_done is True
    assert (result.closes_when_done, result.background) == (False, 0)


async def test_async_run_leaves_what_the_agent_runs_in_the_background():
    t = FakeAsyncTransport(
        [
            a_session(),
            sent(1),
            [message(1, "The build is running."), finished(2)],
            api_pb2.CloseAgentSessionResponse(pending=True, background=2),
        ]
    )
    result = await AsyncMachines(t).agents.run("box", "claude-code", "start the build")
    assert (result.kept, result.closes_when_done, result.background) == (False, True, 2)
    assert t.calls[-1] == (
        "CloseAgentSession",
        api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1", when_done=True),
    )


class QuietAsyncTransport(FakeAsyncTransport):
    """Its event stream carries `events`, then stays open with nothing more."""

    def __init__(self, responses, events):
        super().__init__(responses)
        self._events = events

    async def server_stream(self, method, request, *, region=None):
        self._next(method, request, region)
        events = self._events

        async def gen():
            for item in events:
                yield item
            await asyncio.Event().wait()

        return gen()


@pytest.mark.parametrize("keep", [False, True])
async def test_async_run_cancelled_interrupts_the_turn_and_closes_the_session(keep):
    t = QuietAsyncTransport(
        [a_session(), sent(1), [], api_pb2.InterruptAgentResponse(turn=1), CLOSED],
        [an_event(1, turn_started=api_pb2.AgentTurnStarted())],
    )
    started = asyncio.Event()
    task = asyncio.create_task(
        AsyncMachines(t).agents.run(
            "box", "claude-code", "x", keep=keep, on_event=lambda _e: started.set()
        )
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
        *([] if keep else ["CloseAgentSession"]),
    ]
    assert t.calls[3][1] == api_pb2.InterruptAgentRequest(
        vm_id="box", session_id="s-1", turn=1
    )
    if not keep:
        assert t.calls[4][1] == api_pb2.CloseAgentSessionRequest(vm_id="box", session_id="s-1")


async def test_async_run_cancelled_while_its_message_still_waits_interrupts_only_its_own_turn():
    # The session is running turn 3, someone else's; the task waits as turn 4.
    t = QuietAsyncTransport(
        [
            a_session(id="s-7", state=api_pb2.AGENT_SESSION_STATE_RUNNING, turn=3, last_seq=40),
            sent(4, api_pb2.AGENT_DELIVERY_QUEUED),
            [],
            api_pb2.InterruptAgentResponse(turn=4),
        ],
        [delta(41, "theirs", turn=3)],
    )
    task = asyncio.create_task(
        AsyncMachines(t).agents.run("box", "claude-code", "x", session="s-7")
    )
    while "AgentEvents" not in [c[0] for c in t.calls]:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [c[0] for c in t.calls] == [
        "GetAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
    ]
    assert t.calls[3][1] == api_pb2.InterruptAgentRequest(
        vm_id="box", session_id="s-7", turn=4
    )


async def test_async_run_an_error_while_following_still_closes_the_session(clock):
    t = FakeAsyncTransport(
        [
            a_session(),
            sent(1),
            broken(
                message(1, "half"), error=status(grpc.StatusCode.NOT_FOUND, "no session s-1")
            ),
            CLOSED,
        ]
    )
    with pytest.raises(NotFoundError):
        await AsyncMachines(t).agents.run("box", "codex", "x")
    # An answer about the request, also after an event: not followed again.
    assert clock.slept == []
    assert [c[0] for c in t.calls] == [
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "CloseAgentSession",
    ]


@pytest.mark.parametrize("code", named(BREAKS))
async def test_async_run_follows_again_a_stream_that_breaks_before_its_first_event(clock, code):
    t = FakeAsyncTransport(
        [
            a_session(),
            sent(1),
            status(code),
            broken(
                an_event(1, turn_started=api_pb2.AgentTurnStarted()),
                delta(2, "Hel"),
                error=status(code),
            ),
            broken(error=status(code)),
            [delta(3, "lo"), finished(4)],
            CLOSED,
        ]
    )
    seen = []
    result = await AsyncMachines(t).agents.run(
        "box", "codex", "x", on_event=lambda e: seen.append(e.seq)
    )
    assert (result.reply, result.reason) == ("Hello", "done")
    # Followed again from the last event seen: none reaches on_event twice.
    assert seen == [1, 2, 3, 4]
    assert [c[1].after_seq for c in t.calls if c[0] == "AgentEvents"] == [0, 0, 2, 2]
    assert clock.slept == [1, 2, 3]
    assert t.calls[-1][0] == "CloseAgentSession"


@pytest.mark.parametrize("code", named(ANSWERS))
async def test_async_run_does_not_follow_again_after_an_answer_about_the_request(clock, code):
    for stream in (status(code), broken(message(1, "half"), error=status(code))):
        t = FakeAsyncTransport([a_session(), sent(1), stream, CLOSED])
        with pytest.raises(BoxdError) as e:
            await AsyncMachines(t).agents.run("box", "codex", "x")
        assert e.value.code == code.name.lower()
        assert [c[0] for c in t.calls] == [
            "StartAgentSession",
            "SendToAgent",
            "AgentEvents",
            "CloseAgentSession",
        ]
    assert clock.slept == []


async def test_async_run_gives_up_after_five_breaks(clock):
    streams = [broken(error=status(grpc.StatusCode.UNKNOWN)) for _ in range(6)]
    t = FakeAsyncTransport([a_session(), sent(1), *streams, CLOSED])
    with pytest.raises(APIStatusError):
        await AsyncMachines(t).agents.run("box", "codex", "x")
    assert clock.slept == [1, 2, 3, 4, 5]
    assert [c[0] for c in t.calls].count("AgentEvents") == 6
    assert t.calls[-1][0] == "CloseAgentSession"
