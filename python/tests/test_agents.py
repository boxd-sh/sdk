"""`machines.agents`: what goes on the wire, what comes back, which calls are
sent only once, and the events stream (skipped kinds, no deadline on a
follow, ending cleanly)."""

from __future__ import annotations

from contextlib import aclosing
from datetime import datetime, timezone

import grpc
import pytest

from boxd import (
    AgentInterruptResult,
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
from boxd.errors import APIConnectionError, NotFoundError
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
        api_pb2.Harness(id="codex", version="", mid_turn_input=True, models=["o3", "gpt-5"])
    )
    assert h == Harness(id="codex", version=None, mid_turn_input=True, models=["o3", "gpt-5"])
    assert m.harness(api_pb2.Harness(id="claude-code", version="2.1.0")).version == "2.1.0"
    assert m.harness(api_pb2.Harness(id="opencode")).models == []


def test_session_maps_every_field():
    s = m.agent_session(
        a_session(
            model="opus",
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


def test_start_sends_every_option_once():
    a, t = agents(a_session())
    session = a.start(
        "box",
        "codex",
        model="o3",
        cwd="/srv/app",
        instructions="Keep replies short.",
        env={"FOO": "bar"},
    )
    method, request = t.calls[0]
    assert method == "StartAgentSession"
    assert request == api_pb2.StartAgentSessionRequest(
        vm_id="box",
        harness="codex",
        model="o3",
        cwd="/srv/app",
        instructions="Keep replies short.",
        env={"FOO": "bar"},
    )
    assert t.call_options == [{"retry": False}]
    assert isinstance(session, AgentSession)
    assert session.machine_id == "vm-1"


def test_start_defaults_are_empty_on_the_wire():
    a, t = agents(a_session())
    a.start("box", "claude-code")
    assert t.calls[0][1] == api_pb2.StartAgentSessionRequest(vm_id="box", harness="claude-code")


def test_send_defaults_to_next_and_is_sent_once():
    a, t = agents(
        api_pb2.SendToAgentResponse(turn=1, delivery=api_pb2.AGENT_DELIVERY_STARTED)
    )
    result = a.send("box", "s-1", "hello")
    method, request = t.calls[0]
    assert method == "SendToAgent"
    assert request == api_pb2.SendToAgentRequest(
        vm_id="box", session_id="s-1", text="hello", when=api_pb2.AGENT_SEND_WHEN_NEXT
    )
    # A lost answer is not sent again: the message would arrive twice.
    assert t.call_options == [{"retry": False}]
    assert result == AgentSendResult(turn=1, delivery="started")


def test_send_now_with_limits():
    a, t = agents(api_pb2.SendToAgentResponse(turn=2, delivery=api_pb2.AGENT_DELIVERY_JOINED))
    result = a.send("box", "s-1", "also this", when="now", timeout_secs=600, max_steps=25)
    request = t.calls[0][1]
    assert request.when == api_pb2.AGENT_SEND_WHEN_NOW
    assert (request.timeout_secs, request.max_steps) == (600, 25)
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


def test_close_get_and_list():
    a, t = agents(
        api_pb2.CloseAgentSessionResponse(),
        a_session(state=api_pb2.AGENT_SESSION_STATE_RUNNING),
        api_pb2.ListAgentSessionsResponse(sessions=[a_session(), a_session(id="s-2")]),
        api_pb2.ListAgentSessionsResponse(),
    )
    assert a.close("box", "s-1") is None
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
    assert (await a.start("box", "opencode", env={"A": "1"})).id == "s-1"
    assert (await a.send("box", "s-1", "go", when="now")).delivery == "queued"
    events = [e async for e in a.events("box", "s-1", after_seq=5)]
    assert [(e.seq, e.type) for e in events] == [(1, "plan"), (3, "turn.finished")]
    assert isinstance(events[0], AgentPlan) and events[1].reason == "interrupted"
    assert (await a.interrupt("box", "s-1", clear_queue=True)).turn == 1
    assert await a.close("box", "s-1") is None
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
    assert requests[2].when == api_pb2.AGENT_SEND_WHEN_NOW
    assert requests[3] == api_pb2.AgentEventsRequest(vm_id="box", session_id="s-1", after_seq=5)
    assert requests[4].clear_queue is True
    assert requests[7].all is True
    retry = [o.get("retry", True) for o in t.call_options]
    assert retry == [True, False, False, True, False, True, True, True]


async def test_async_send_refuses_an_unknown_when():
    t = FakeAsyncTransport()
    with pytest.raises(ValueError):
        await AsyncMachines(t).agents.send("box", "s-1", "x", when="soon")
    assert t.calls == []


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


def test_send_is_not_sent_again_after_unavailable(monkeypatch):
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    send = FakeMulticallable(
        [
            FakeRpcError(grpc.StatusCode.UNAVAILABLE, "connection reset"),
            api_pb2.SendToAgentResponse(turn=1),
        ]
    )
    a, _ = real_agents(StreamCall([]), unary={"SendToAgent": send})
    with pytest.raises(APIConnectionError):
        a.send("box", "s-1", "hello")
    assert send.attempts == 1


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
