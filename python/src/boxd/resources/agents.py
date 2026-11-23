"""`boxd.machines.agents` — drive Claude Code or Codex inside a machine the
same way, through sessions, turns and one typed event stream.

A session is one conversation with one agent. A message sent to it starts a
turn, joins the running turn, or waits for it to end (``send(when=...)``). A
session runs one turn at a time; a machine's sessions run side by side. The
agent runs in the machine and keeps working when the caller disconnects; the
caller catches up with ``events(after_seq=...)`` from the last ``seq`` it
saw::

    session = boxd.machines.agents.start("my-box", "claude-code")
    sent = boxd.machines.agents.send("my-box", session.id, "Add a /health endpoint")
    for event in boxd.machines.agents.events("my-box", session.id, follow=True):
        if event.type == "message.delta":
            print(event.text, end="", flush=True)
        if event.type == "turn.finished" and event.turn == sent.turn:
            break

``run()`` does all of that for one task in one call: start, send, wait for
the turn to end, and return the agent's last reply and how it ended::

    result = boxd.machines.agents.run("my-box", "claude-code", "Fix the failing test")
    print(result.reply)

The machine argument is a machine's name or id, as everywhere in
``machines``.

``runs()`` reads how finished turns went, across your machines, from the
platform's run history instead: it never wakes a machine::

    page = boxd.machines.agents.runs(machine="my-box", limit=10)
    for run in page.runs:
        print(run.session_id, run.turn, run.reason, run.error or "")

Signing Claude Code or Codex in is ``boxd.integrations``: a sign-in is yours
in an organization, and every private machine of yours there uses it::

    start = boxd.integrations.connect("codex")
    print(f"Open {start.url} and enter {start.user_code}")
    login = boxd.integrations.wait("codex", start)

The machine-based ``start_login()``, ``complete_login()``,
``wait_for_login()``, ``get_login()`` and ``logout()`` still work and are
deprecated.
"""

from __future__ import annotations

import asyncio
import math
import time
import uuid
import warnings
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Callable,
    Generator,
    Iterator,
    Mapping,
)
from datetime import datetime

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..errors import BoxdError
from ..models import (
    AgentEvent,
    AgentFinishReason,
    AgentInterruptResult,
    AgentLogin,
    AgentLoginResult,
    AgentLoginStart,
    AgentMessage,
    AgentMessageDelta,
    AgentRun,
    AgentRunResult,
    AgentRunUsage,
    AgentRunsPage,
    AgentSendResult,
    AgentSendWhen,
    AgentSession,
    AgentTurnFinished,
    AgentUsage,
    Harness,
)
from . import Namespace

_SEND_WHEN = {
    "next": api_pb2.AGENT_SEND_WHEN_NEXT,
    "now": api_pb2.AGENT_SEND_WHEN_NOW,
}


# Request builders shared by both namespaces.


def _start(
    machine_id: str,
    harness: str,
    *,
    model: str | None,
    effort: str | None,
    cwd: str | None,
    instructions: str | None,
    env: Mapping[str, str] | None,
    request_id: str | None,
) -> api_pb2.StartAgentSessionRequest:
    return api_pb2.StartAgentSessionRequest(
        vm_id=machine_id,
        harness=harness,
        model=model or "",
        effort=effort or "",
        cwd=cwd or "",
        instructions=instructions or "",
        env=dict(env or {}),
        # Kept across the transport's retries: a repeat returns the session
        # the first attempt started.
        request_id=request_id or str(uuid.uuid4()),
    )


def _send(
    machine_id: str,
    session_id: str,
    text: str,
    *,
    when: AgentSendWhen,
    timeout_secs: int | None,
    max_steps: int | None,
    request_id: str | None,
) -> api_pb2.SendToAgentRequest:
    wire_when = _SEND_WHEN.get(when)
    if wire_when is None:
        raise ValueError(f'when must be "next" or "now", not {when!r}')
    return api_pb2.SendToAgentRequest(
        vm_id=machine_id,
        session_id=session_id,
        text=text,
        when=wire_when,
        timeout_secs=timeout_secs or 0,
        max_steps=max_steps or 0,
        # Kept across the transport's retries: a repeat gets the first
        # attempt's answer instead of sending the message twice.
        request_id=request_id or str(uuid.uuid4()),
    )


def _events(
    machine_id: str, session_id: str, *, after_seq: int, follow: bool
) -> api_pb2.AgentEventsRequest:
    return api_pb2.AgentEventsRequest(
        vm_id=machine_id, session_id=session_id, after_seq=after_seq, follow=follow
    )


def _runs(
    *,
    machine: str | None,
    session: str | None,
    org: str | None,
    since: datetime | int | float | None,
    limit: int | None,
    page_token: str | None,
) -> api_pb2.ListAgentRunsRequest:
    return api_pb2.ListAgentRunsRequest(
        org=org or "",
        vm_id=machine or "",
        session_id=session or "",
        since_ms=req.unix_ms(since),
        limit=limit or 0,
        page_token=page_token or "",
    )


def _complete_login(
    machine_id: str, harness: str, *, code: str | None, handle: str | None
) -> api_pb2.CompleteAgentLoginRequest:
    return api_pb2.CompleteAgentLoginRequest(
        vm_id=machine_id, harness=harness, code=code or "", handle=handle or ""
    )


def _moved(old: str, new: str) -> None:
    """Warn that `old` (a machine-based sign-in method) is now `new`."""
    warnings.warn(
        f"machines.agents.{old}() is deprecated: a sign-in is yours in an "
        f"organization, not a machine's. Use boxd.integrations.{new}() instead.",
        DeprecationWarning,
        stacklevel=3,
    )


_LOGIN_INTERVAL_SECS = 5
"""How often `wait_for_login` asks when the start doesn't say, in seconds."""


class _LoginWait:
    """A Codex sign-in's wait, shared by `wait_for_login` and
    `integrations.wait` (sync and async): the handle it asks with, how long it
    waits before asking again, and when it gives up. `start_call` and
    `complete_call` name the caller's own methods in its messages."""

    def __init__(
        self,
        harness: str,
        start: AgentLoginStart,
        timeout: float | None,
        *,
        start_call: str = "start_login()",
        complete_call: str = "complete_login(code=...)",
        wait_call: str = "wait_for_login()",
    ):
        if start.method == "paste_code":
            raise ValueError(
                "a paste_code sign-in can't be waited on: pass the code its page "
                f"shows you after you approve to {complete_call}"
            )
        if start.method != "device_code":
            raise ValueError(f"{wait_call} waits on a device_code sign-in, not {start.method!r}")
        if not start.handle:
            raise ValueError(f"the sign-in has no handle: pass what {start_call} returned")
        self.handle = start.handle
        self._start_call = start_call
        self._harness = harness
        self._timeout = timeout
        self._interval = start.interval_secs or _LOGIN_INTERVAL_SECS
        now = time.monotonic()
        self._timeout_at = math.inf if timeout is None else now + timeout
        # `expires_at` is on the wall clock; both deadlines are kept on the
        # monotonic one.
        self._expires_at = (
            math.inf
            if start.expires_at is None
            else now + start.expires_at.timestamp() - time.time()
        )

    def pause(self) -> float:
        """Seconds to wait before asking again, or TimeoutError when there is
        no time left."""
        left = min(self._timeout_at, self._expires_at) - time.monotonic()
        if left <= 0:
            if self._timeout_at < self._expires_at:
                raise TimeoutError(
                    f"the {self._harness} sign-in wasn't approved within {self._timeout}s"
                )
            raise TimeoutError(
                f"the {self._harness} sign-in code expired before it was approved: "
                f"start again with {self._start_call}"
            )
        return min(self._interval, left)

    def login(self, result: AgentLoginResult) -> AgentLogin:
        if result.login is None:
            raise BoxdError(f"the {self._harness} sign-in ended without a login")
        return result.login


_RUN_RECONNECTS = 5
"""How many times `run` follows its turn again after the event stream breaks
(a network blip, a proxy restart), from the last event it saw."""

_RUN_FINAL = frozenset(
    {
        "not_found",
        "permission_denied",
        "unauthenticated",
        "invalid_argument",
        "failed_precondition",
        "unimplemented",
        "out_of_range",
        "already_exists",
    }
)
"""The statuses (an error's ``code``) that answer `run`'s request for the
events itself (no such session, not allowed): asking again would get the same
answer, so `run` raises them instead of following again."""


def _check_run(
    session: str | None,
    *,
    model: str | None,
    effort: str | None,
    cwd: str | None,
    instructions: str | None,
    env: Mapping[str, str] | None,
) -> None:
    if session is not None and any(
        v is not None for v in (model, effort, cwd, instructions, env)
    ):
        raise ValueError(
            "model, effort, cwd, instructions and env are for a new session: "
            "leave them out with session="
        )


def _open_session(found: AgentSession, session_id: str, harness: str) -> AgentSession:
    """`run(session=...)`: the open session, checked to run `harness`."""
    if found.harness != harness:
        raise BoxdError(f"session {session_id} runs {found.harness}, not {harness}")
    if found.state in ("closed", "failed"):
        raise BoxdError(
            f"session {session_id} is {found.state}: leave out session= to start a new one"
        )
    return found


class _TurnFollow:
    """`run`'s wait, shared by both namespaces: where to follow the session's
    events from, what its turn has come to (its last whole reply, or what an
    only-streaming agent's pieces since add up to; its tokens; how it ended),
    and whether to follow again after the stream breaks."""

    def __init__(self, session: AgentSession, turn: int):
        self.turn = turn
        self._after = session.last_seq
        self._reconnects = 0
        self._reply = ""
        self._streamed = ""
        self._usage: AgentRunUsage | None = None
        self.reason: AgentFinishReason | None = None
        self._error: str | None = None

    def connect(self) -> int:
        """A new stream: the ``seq`` to follow on from."""
        return self._after

    def take(self, event: AgentEvent) -> bool:
        """Note one event; True when it is the turn's own."""
        self._after = event.seq
        if event.turn != self.turn:
            return False
        if isinstance(event, AgentMessageDelta):
            self._streamed += event.text
        elif isinstance(event, AgentMessage):
            self._reply = event.text
            self._streamed = ""
        elif isinstance(event, AgentUsage):
            self._usage = AgentRunUsage(
                input_tokens=event.input_tokens,
                output_tokens=event.output_tokens,
                cache_read_tokens=event.cache_read_tokens,
                cache_write_tokens=event.cache_write_tokens,
            )
        elif isinstance(event, AgentTurnFinished):
            self.reason = event.reason
            self._error = event.error
        return True

    def again(self, err: BoxdError) -> float | None:
        """Seconds to wait before following again after `err`, or None to
        raise it. A stream that failed to open can't always be told from one
        that opened and broke before its first event, so the error decides:
        an answer about the request itself (`_RUN_FINAL`) is raised, and any
        other failure (a lost connection, no answer in time, the server or
        the way to the machine breaking) is followed again."""
        if self._reconnects >= _RUN_RECONNECTS or err.code in _RUN_FINAL:
            return None
        self._reconnects += 1
        return float(self._reconnects)

    def ended(self) -> BoxdError:
        return BoxdError(
            f"the session's events ended before turn {self.turn} finished: "
            "it may have been closed"
        )

    def result(self, session: AgentSession, *, kept: bool) -> AgentRunResult:
        return AgentRunResult(
            session_id=session.id,
            machine_id=session.machine_id,
            harness=session.harness,
            model=session.model,
            effort=session.effort,
            turn=self.turn,
            reason=self.reason or "unknown",
            error=self._error,
            reply=self._streamed if self._streamed.strip() else self._reply,
            usage=self._usage,
            kept=kept,
        )


def _cancel(stream) -> None:
    """End the call: a follow stream left behind would stay open on the
    server. Harmless once the stream has ended."""
    cancel = getattr(stream, "cancel", None)
    if cancel is not None:
        cancel()


class Agents(Namespace):
    """`boxd.machines.agents` — coding agents inside a machine."""

    def harnesses(self, machine_id: str, *, region: str | None = None) -> list[Harness]:
        """The agents the machine can run, with their versions and what they
        can do."""
        resp = self._transport.call(
            "ListHarnesses",
            api_pb2.ListHarnessesRequest(vm_id=machine_id),
            region=region,
        )
        return [m.harness(h) for h in resp.harnesses]

    def start(
        self,
        machine_id: str,
        harness: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        cwd: str | None = None,
        instructions: str | None = None,
        env: Mapping[str, str] | None = None,
        request_id: str | None = None,
        region: str | None = None,
    ) -> AgentSession:
        """Start a session with `harness` (``"claude-code"`` or ``"codex"``;
        :meth:`harnesses` lists what the machine has). Nothing runs until the
        first :meth:`send`.

        `model`: None is the agent's own default. `effort`: how hard the
        agent thinks, one of the harness's ``efforts`` (Claude Code
        ``"low"``, ``"medium"``, ``"high"``, ``"xhigh"`` or ``"max"``; Codex
        ``"minimal"``, ``"low"``, ``"medium"``, ``"high"`` or ``"xhigh"``);
        None is the agent's own default. `cwd`: the directory the
        agent works in; None is the home directory of the machine's user.
        `instructions` are added to the agent's own system prompt, never
        replacing it. `env`: environment variables for this session's agent,
        on top of the machine's own variables and secrets.

        `request_id` makes a retry safe: a second start with the same id on
        this machine returns the session the first one started instead of
        starting another. None: a new id for this call, which the SDK's own
        retries after a lost connection keep. Pass your own to retry across
        processes, such as an automation re-running a step.
        """
        request = _start(
            machine_id,
            harness,
            model=model,
            effort=effort,
            cwd=cwd,
            instructions=instructions,
            env=env,
            request_id=request_id,
        )
        return m.agent_session(
            self._transport.call("StartAgentSession", request, region=region)
        )

    def send(
        self,
        machine_id: str,
        session_id: str,
        text: str,
        *,
        when: AgentSendWhen = "next",
        timeout_secs: int | None = None,
        max_steps: int | None = None,
        request_id: str | None = None,
        region: str | None = None,
    ) -> AgentSendResult:
        """Send a message. Returns once it is delivered, not when the turn
        ends: read the turn's events with :meth:`events`.

        `when="next"` (the default): a turn of its own, at once when the
        session is idle, else after the running turn and any messages already
        waiting. `when="now"`: into the running turn, for the agent to take
        into account before the turn ends. An agent that can't take input
        mid-turn queues it for the next turn instead (delivery
        ``"queued_fallback"``); an idle session starts a turn with it.

        For a turn this message starts: interrupt it after `timeout_secs`
        seconds, or after `max_steps` agent steps (calls to the model for
        Claude Code, tool calls for Codex). None: no limit. They don't apply
        to a running turn the message joins.

        `request_id` makes a retry safe: a second message with the same id
        in this session isn't sent again, and gets the first one's answer.
        None: a new id for this call, which the SDK's own retries after a
        lost connection keep. Pass your own to retry across processes, such
        as an automation re-running a step.
        """
        request = _send(
            machine_id,
            session_id,
            text,
            when=when,
            timeout_secs=timeout_secs,
            max_steps=max_steps,
            request_id=request_id,
        )
        return m.agent_send_result(
            self._transport.call("SendToAgent", request, region=region)
        )

    def events(
        self,
        machine_id: str,
        session_id: str,
        *,
        after_seq: int = 0,
        follow: bool = False,
        region: str | None = None,
    ) -> Generator[AgentEvent, None, None]:
        """The session's events in order, starting after `after_seq` (0: from
        its first event). Without `follow` it ends after the latest one; with
        it, it stays open and carries new events as they happen, with no
        deadline, until you stop iterating.

        To catch up after a disconnect, pass the last ``seq`` you saw as
        `after_seq`: nothing is missed. An event of a kind this SDK doesn't
        know yet is skipped.
        """
        stream = self._transport.server_stream(
            "AgentEvents",
            _events(machine_id, session_id, after_seq=after_seq, follow=follow),
            region=region,
        )
        try:
            for raw in stream:
                event = m.agent_event(raw)
                if event is not None:
                    yield event
        finally:
            _cancel(stream)

    def interrupt(
        self,
        machine_id: str,
        session_id: str,
        *,
        clear_queue: bool = False,
        region: str | None = None,
    ) -> AgentInterruptResult:
        """Stop the session's running turn; its last event says
        ``"interrupted"``. The machine's other sessions keep going. A no-op
        when nothing is running (``turn`` None).

        `clear_queue` also drops the messages waiting for the next turns.
        Without it, the next waiting message starts its turn once the
        interrupted one has ended.
        """
        # Sent once: sent again after a lost answer, it could interrupt the
        # turn the next waiting message just started.
        return m.agent_interrupt_result(
            self._transport.call(
                "InterruptAgent",
                api_pb2.InterruptAgentRequest(
                    vm_id=machine_id, session_id=session_id, clear_queue=clear_queue
                ),
                region=region,
                retry=False,
            )
        )

    def close(self, machine_id: str, session_id: str, *, region: str | None = None) -> None:
        """End a session: interrupts its running turn, drops the messages
        waiting for it and stops its agent. Its events stay readable. Closing
        a closed session does nothing."""
        self._transport.call(
            "CloseAgentSession",
            api_pb2.CloseAgentSessionRequest(vm_id=machine_id, session_id=session_id),
            region=region,
        )

    def get(
        self, machine_id: str, session_id: str, *, region: str | None = None
    ) -> AgentSession:
        return m.agent_session(
            self._transport.call(
                "GetAgentSession",
                api_pb2.GetAgentSessionRequest(vm_id=machine_id, session_id=session_id),
                region=region,
            )
        )

    def list(
        self, machine_id: str, *, all: bool = False, region: str | None = None
    ) -> list[AgentSession]:
        """The machine's sessions. `all` includes closed and failed ones."""
        resp = self._transport.call(
            "ListAgentSessions",
            api_pb2.ListAgentSessionsRequest(vm_id=machine_id, all=all),
            region=region,
        )
        return [m.agent_session(s) for s in resp.sessions]

    def run(
        self,
        machine_id: str,
        harness: str,
        text: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        cwd: str | None = None,
        instructions: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout_secs: int | None = None,
        max_steps: int | None = None,
        session: str | None = None,
        keep: bool = False,
        on_event: Callable[[AgentEvent], object] | None = None,
        region: str | None = None,
    ) -> AgentRunResult:
        """Run one task, start to reply: start a session with `harness` (or
        use the open `session`), send it `text`, wait for that turn to end,
        and return the agent's last reply and how the turn ended. (Not
        :meth:`runs`, the history of finished turns.)::

            result = boxd.machines.agents.run(
                "my-box", "claude-code", "Fix the failing test", cwd="/home/boxd/app"
            )
            print(result.reply)
            if result.reason != "done":
                print(f"[{result.reason}] {result.error or ''}")

        `model`, `effort`, `cwd`, `instructions` and `env` are for the session
        this starts, as in :meth:`start`; `timeout_secs` and `max_steps` limit
        the turn, as in :meth:`send`. `session`: send the task to this open
        session, which must run `harness`, instead of starting one; it stays
        open. `keep`: leave the session this starts open afterwards, to
        :meth:`send` it more. `on_event` is called with each of the turn's
        events as it happens, for progress.

        A turn that ends other than ``"done"`` doesn't raise: ``reason`` (and
        ``error``) says how it ended. A session this starts is closed
        afterwards, also when following the turn fails, unless `keep`.
        Ctrl-C (:class:`KeyboardInterrupt`) interrupts the turn, closes a
        session this started (unless `keep`) and is raised again. The start
        and the send are retried as :meth:`start` and :meth:`send` are, and
        an event stream that breaks is followed again from the last event
        seen, up to 5 times.
        """
        _check_run(
            session, model=model, effort=effort, cwd=cwd, instructions=instructions, env=env
        )
        if session is None:
            s = self.start(
                machine_id,
                harness,
                model=model,
                effort=effort,
                cwd=cwd,
                instructions=instructions,
                env=env,
                region=region,
            )
        else:
            s = _open_session(self.get(machine_id, session, region=region), session, harness)
        close = session is None and not keep
        sent: AgentSendResult | None = None
        try:
            sent = self.send(
                machine_id,
                s.id,
                text,
                timeout_secs=timeout_secs,
                max_steps=max_steps,
                region=region,
            )
            follow = _TurnFollow(s, sent.turn)
            self._follow_turn(machine_id, s.id, follow, on_event, region)
        except BaseException as e:
            # Best effort: what the caller hears about is `e`. Not an
            # Exception (Ctrl-C, SystemExit): the caller is stopping.
            if sent is not None and not isinstance(e, Exception):
                try:
                    self.interrupt(machine_id, s.id, region=region)
                except Exception:
                    pass
            if close:
                try:
                    self.close(machine_id, s.id, region=region)
                except Exception:
                    pass
            raise
        kept = not close
        if close:
            try:
                self.close(machine_id, s.id, region=region)
            except BoxdError:
                # The turn's reply isn't lost to it: `kept` says it's still open.
                kept = True
        return follow.result(s, kept=kept)

    def _follow_turn(
        self,
        machine_id: str,
        session_id: str,
        follow: _TurnFollow,
        on_event: Callable[[AgentEvent], object] | None,
        region: str | None,
    ) -> None:
        """`run`'s wait: the session's events until the turn's
        ``turn.finished``, followed again after a break."""
        while True:
            pause = 0.0
            stream = self.events(
                machine_id, session_id, after_seq=follow.connect(), follow=True, region=region
            )
            try:
                while True:
                    try:
                        event = next(stream)
                    except StopIteration:
                        raise follow.ended() from None
                    except BoxdError as e:
                        again = follow.again(e)
                        if again is None:
                            raise
                        pause = again
                        break
                    if follow.take(event) and on_event is not None:
                        on_event(event)
                    if follow.reason is not None:
                        return
            finally:
                stream.close()
            time.sleep(pause)

    def runs(
        self,
        machine: str | None = None,
        session: str | None = None,
        org: str | None = None,
        since: datetime | int | float | None = None,
        limit: int | None = None,
        page_token: str | None = None,
        *,
        region: str | None = None,
    ) -> AgentRunsPage:
        """One page of finished turns, newest first, from the platform's run
        history: across the machines you can see, or only `machine`'s (name
        or id) or `session`'s. It never reaches into a machine, so it doesn't
        wake one, and a machine's runs are kept for 30 days, also after it's
        deleted. There are no prompts or output, only how each turn went:
        :meth:`events` has the transcript.

        `org`: by name or id; None is your current one (with an API key, the
        key's). `since`: only runs that ended at or after this time, a
        datetime (naive is UTC) or unix seconds; None is everything kept.
        `limit`: runs per page, 50 by default, at most 500.

        Pass the page's ``next_page_token`` as `page_token` for the next,
        older page, or iterate every run with :meth:`iter_runs`.

        A cluster that doesn't keep run history (one without an analytics
        store, such as some self-hosted ones) refuses the call with a
        :class:`~boxd.errors.ConflictError` saying so.
        """
        return m.agent_runs_page(
            self._transport.call(
                "ListAgentRuns",
                _runs(
                    machine=machine,
                    session=session,
                    org=org,
                    since=since,
                    limit=limit,
                    page_token=page_token,
                ),
                region=region,
            )
        )

    def iter_runs(
        self,
        machine: str | None = None,
        session: str | None = None,
        org: str | None = None,
        since: datetime | int | float | None = None,
        limit: int | None = None,
        *,
        region: str | None = None,
    ) -> Iterator[AgentRun]:
        """Every run :meth:`runs` would list, newest first, reading pages as
        you go (`limit` is the page size). Stop iterating to read no
        further::

            for run in boxd.machines.agents.iter_runs(since=datetime(2026, 11, 1)):
                if run.reason == "failed":
                    print(run.machine_name, run.session_id, run.error)
        """
        token: str | None = None
        while True:
            page = self.runs(
                machine,
                session,
                org,
                since,
                limit,
                token,
                region=region,
            )
            yield from page.runs
            if not page.next_page_token:
                return
            token = page.next_page_token

    def start_login(
        self, machine_id: str, harness: str, *, region: str | None = None
    ) -> AgentLoginStart:
        """Sign a coding agent in (`harness`: ``"claude-code"`` or
        ``"codex"``) for `machine_id`, one of yours: the platform's own
        sign-in, the same as the console's Integrations page. The login is
        kept for you in the machine's organization, refreshed by the
        platform, and given to every private machine of yours there; your
        agent sessions use it.

        This says where to go. Claude Code (``"paste_code"``): open ``url``,
        approve, and pass the code the page then shows you to
        :meth:`complete_login`. Codex (``"device_code"``): open ``url``,
        enter ``user_code``, and :meth:`wait_for_login`::

            start = boxd.machines.agents.start_login("my-box", "codex")
            print(f"Open {start.url} and enter {start.user_code}")
            login = boxd.machines.agents.wait_for_login("my-box", "codex", start)

        A machine that would never get the login (a shared or isolated one,
        another member's, a Windows one) is refused with a
        :class:`~boxd.errors.ConflictError` saying what to do instead.

        .. deprecated:: Use :meth:`boxd.integrations.connect
           <boxd.resources.integrations.Integrations.connect>`: a sign-in is
           kept in an organization, not for a machine.
        """
        _moved("start_login", "connect")
        return m.agent_login_start(
            self._transport.call(
                "StartAgentLogin",
                api_pb2.StartAgentLoginRequest(vm_id=machine_id, harness=harness),
                region=region,
            )
        )

    def complete_login(
        self,
        machine_id: str,
        harness: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        region: str | None = None,
    ) -> AgentLoginResult:
        """Finish a sign-in :meth:`start_login` began, in one call. Claude
        Code: `code` is the code the page showed you after you approved, and
        you're signed in. Codex: `handle` is the start's, and the result is
        ``pending`` until you've approved; :meth:`wait_for_login` asks again
        for you.

        .. deprecated:: Use :meth:`boxd.integrations.complete
           <boxd.resources.integrations.Integrations.complete>`.
        """
        _moved("complete_login", "complete")
        return self._complete_login(machine_id, harness, code=code, handle=handle, region=region)

    def _complete_login(
        self,
        machine_id: str,
        harness: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        region: str | None = None,
    ) -> AgentLoginResult:
        return m.agent_login_result(
            self._transport.call(
                "CompleteAgentLogin",
                _complete_login(machine_id, harness, code=code, handle=handle),
                region=region,
            )
        )

    def wait_for_login(
        self,
        machine_id: str,
        harness: str,
        start: AgentLoginStart,
        *,
        timeout: float | None = None,
        region: str | None = None,
    ) -> AgentLogin:
        """Wait until you've approved a Codex (``"device_code"``) sign-in:
        asks with the start's ``handle`` every ``interval_secs`` until it's
        no longer pending, and returns the login. Raises
        :class:`TimeoutError` once the code expires (``expires_at``), or after
        `timeout` seconds when that comes first (None: until it expires).

        A Claude Code (``"paste_code"``) sign-in can't be waited on
        (:class:`ValueError`): pass the code its page shows you to
        :meth:`complete_login`.

        .. deprecated:: Use :meth:`boxd.integrations.wait
           <boxd.resources.integrations.Integrations.wait>`.
        """
        _moved("wait_for_login", "wait")
        wait = _LoginWait(harness, start, timeout)
        while True:
            result = self._complete_login(
                machine_id, harness, handle=wait.handle, region=region
            )
            if not result.pending:
                return wait.login(result)
            time.sleep(wait.pause())

    def get_login(
        self, machine_id: str, harness: str, *, region: str | None = None
    ) -> AgentLogin:
        """Whether you're signed in to `harness` for `machine_id`, and as
        whom: the login kept in the machine's organization, or why the machine
        gets none.

        .. deprecated:: Use :meth:`boxd.integrations.get
           <boxd.resources.integrations.Integrations.get>`.
        """
        _moved("get_login", "get")
        return m.agent_login(
            self._transport.call(
                "GetAgentLogin",
                api_pb2.GetAgentLoginRequest(vm_id=machine_id, harness=harness),
                region=region,
            )
        )

    def logout(self, machine_id: str, harness: str, *, region: str | None = None) -> None:
        """Forget your sign-in to `harness` in the machine's organization. It
        isn't revoked at Anthropic or OpenAI; do that from your account
        there.

        .. deprecated:: Use :meth:`boxd.integrations.disconnect
           <boxd.resources.integrations.Integrations.disconnect>`.
        """
        _moved("logout", "disconnect")
        self._transport.call(
            "DeleteAgentLogin",
            api_pb2.DeleteAgentLoginRequest(vm_id=machine_id, harness=harness),
            region=region,
        )


class AsyncAgents(Namespace):
    """Async twin of :class:`Agents`."""

    async def harnesses(
        self, machine_id: str, *, region: str | None = None
    ) -> list[Harness]:
        """The agents the machine can run, with their versions and what they
        can do."""
        resp = await self._transport.call(
            "ListHarnesses",
            api_pb2.ListHarnessesRequest(vm_id=machine_id),
            region=region,
        )
        return [m.harness(h) for h in resp.harnesses]

    async def start(
        self,
        machine_id: str,
        harness: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        cwd: str | None = None,
        instructions: str | None = None,
        env: Mapping[str, str] | None = None,
        request_id: str | None = None,
        region: str | None = None,
    ) -> AgentSession:
        """Start a session. See :meth:`Agents.start`."""
        request = _start(
            machine_id,
            harness,
            model=model,
            effort=effort,
            cwd=cwd,
            instructions=instructions,
            env=env,
            request_id=request_id,
        )
        return m.agent_session(
            await self._transport.call("StartAgentSession", request, region=region)
        )

    async def send(
        self,
        machine_id: str,
        session_id: str,
        text: str,
        *,
        when: AgentSendWhen = "next",
        timeout_secs: int | None = None,
        max_steps: int | None = None,
        request_id: str | None = None,
        region: str | None = None,
    ) -> AgentSendResult:
        """Send a message. See :meth:`Agents.send`."""
        request = _send(
            machine_id,
            session_id,
            text,
            when=when,
            timeout_secs=timeout_secs,
            max_steps=max_steps,
            request_id=request_id,
        )
        return m.agent_send_result(
            await self._transport.call("SendToAgent", request, region=region)
        )

    async def events(
        self,
        machine_id: str,
        session_id: str,
        *,
        after_seq: int = 0,
        follow: bool = False,
        region: str | None = None,
    ) -> AsyncGenerator[AgentEvent, None]:
        """The session's events in order. See :meth:`Agents.events`.

        Stopping early (``break``) ends the call once the generator is closed;
        ``contextlib.aclosing`` closes it at once."""
        stream = await self._transport.server_stream(
            "AgentEvents",
            _events(machine_id, session_id, after_seq=after_seq, follow=follow),
            region=region,
        )
        try:
            async for raw in stream:
                event = m.agent_event(raw)
                if event is not None:
                    yield event
        finally:
            _cancel(stream)

    async def interrupt(
        self,
        machine_id: str,
        session_id: str,
        *,
        clear_queue: bool = False,
        region: str | None = None,
    ) -> AgentInterruptResult:
        """Stop the session's running turn. See :meth:`Agents.interrupt`."""
        return m.agent_interrupt_result(
            await self._transport.call(
                "InterruptAgent",
                api_pb2.InterruptAgentRequest(
                    vm_id=machine_id, session_id=session_id, clear_queue=clear_queue
                ),
                region=region,
                retry=False,
            )
        )

    async def close(
        self, machine_id: str, session_id: str, *, region: str | None = None
    ) -> None:
        """End a session. See :meth:`Agents.close`."""
        await self._transport.call(
            "CloseAgentSession",
            api_pb2.CloseAgentSessionRequest(vm_id=machine_id, session_id=session_id),
            region=region,
        )

    async def get(
        self, machine_id: str, session_id: str, *, region: str | None = None
    ) -> AgentSession:
        return m.agent_session(
            await self._transport.call(
                "GetAgentSession",
                api_pb2.GetAgentSessionRequest(vm_id=machine_id, session_id=session_id),
                region=region,
            )
        )

    async def list(
        self, machine_id: str, *, all: bool = False, region: str | None = None
    ) -> list[AgentSession]:
        """The machine's sessions. `all` includes closed and failed ones."""
        resp = await self._transport.call(
            "ListAgentSessions",
            api_pb2.ListAgentSessionsRequest(vm_id=machine_id, all=all),
            region=region,
        )
        return [m.agent_session(s) for s in resp.sessions]

    async def run(
        self,
        machine_id: str,
        harness: str,
        text: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        cwd: str | None = None,
        instructions: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout_secs: int | None = None,
        max_steps: int | None = None,
        session: str | None = None,
        keep: bool = False,
        on_event: Callable[[AgentEvent], object] | None = None,
        region: str | None = None,
    ) -> AgentRunResult:
        """Run one task, start to reply. See :meth:`Agents.run`.

        Cancelling the task (``task.cancel()``, ``asyncio.timeout``)
        interrupts the turn, closes a session this started (unless `keep`),
        and the :class:`asyncio.CancelledError` is raised again."""
        _check_run(
            session, model=model, effort=effort, cwd=cwd, instructions=instructions, env=env
        )
        if session is None:
            s = await self.start(
                machine_id,
                harness,
                model=model,
                effort=effort,
                cwd=cwd,
                instructions=instructions,
                env=env,
                region=region,
            )
        else:
            s = _open_session(
                await self.get(machine_id, session, region=region), session, harness
            )
        close = session is None and not keep
        sent: AgentSendResult | None = None
        try:
            sent = await self.send(
                machine_id,
                s.id,
                text,
                timeout_secs=timeout_secs,
                max_steps=max_steps,
                region=region,
            )
            follow = _TurnFollow(s, sent.turn)
            await self._follow_turn(machine_id, s.id, follow, on_event, region)
        except BaseException as e:
            # Best effort: what the caller hears about is `e`. Not an
            # Exception (cancelled, Ctrl-C): the caller is stopping.
            if sent is not None and not isinstance(e, Exception):
                try:
                    await self.interrupt(machine_id, s.id, region=region)
                except Exception:
                    pass
            if close:
                try:
                    await self.close(machine_id, s.id, region=region)
                except Exception:
                    pass
            raise
        kept = not close
        if close:
            try:
                await self.close(machine_id, s.id, region=region)
            except BoxdError:
                kept = True
        return follow.result(s, kept=kept)

    async def _follow_turn(
        self,
        machine_id: str,
        session_id: str,
        follow: _TurnFollow,
        on_event: Callable[[AgentEvent], object] | None,
        region: str | None,
    ) -> None:
        """`run`'s wait. See :meth:`Agents._follow_turn`."""
        while True:
            pause = 0.0
            stream = self.events(
                machine_id, session_id, after_seq=follow.connect(), follow=True, region=region
            )
            try:
                while True:
                    try:
                        event = await anext(stream)
                    except StopAsyncIteration:
                        raise follow.ended() from None
                    except BoxdError as e:
                        again = follow.again(e)
                        if again is None:
                            raise
                        pause = again
                        break
                    if follow.take(event) and on_event is not None:
                        on_event(event)
                    if follow.reason is not None:
                        return
            finally:
                await stream.aclose()
            await asyncio.sleep(pause)

    async def runs(
        self,
        machine: str | None = None,
        session: str | None = None,
        org: str | None = None,
        since: datetime | int | float | None = None,
        limit: int | None = None,
        page_token: str | None = None,
        *,
        region: str | None = None,
    ) -> AgentRunsPage:
        """One page of finished turns, newest first. See :meth:`Agents.runs`."""
        return m.agent_runs_page(
            await self._transport.call(
                "ListAgentRuns",
                _runs(
                    machine=machine,
                    session=session,
                    org=org,
                    since=since,
                    limit=limit,
                    page_token=page_token,
                ),
                region=region,
            )
        )

    async def iter_runs(
        self,
        machine: str | None = None,
        session: str | None = None,
        org: str | None = None,
        since: datetime | int | float | None = None,
        limit: int | None = None,
        *,
        region: str | None = None,
    ) -> AsyncIterator[AgentRun]:
        """Every run :meth:`runs` would list, newest first, reading pages as
        you go (``async for run in boxd.machines.agents.iter_runs(): ...``)."""
        token: str | None = None
        while True:
            page = await self.runs(
                machine,
                session,
                org,
                since,
                limit,
                token,
                region=region,
            )
            for run in page.runs:
                yield run
            if not page.next_page_token:
                return
            token = page.next_page_token

    async def start_login(
        self, machine_id: str, harness: str, *, region: str | None = None
    ) -> AgentLoginStart:
        """Sign a coding agent in for `machine_id`. See
        :meth:`Agents.start_login`.

        .. deprecated:: Use ``boxd.integrations.connect()``.
        """
        _moved("start_login", "connect")
        return m.agent_login_start(
            await self._transport.call(
                "StartAgentLogin",
                api_pb2.StartAgentLoginRequest(vm_id=machine_id, harness=harness),
                region=region,
            )
        )

    async def complete_login(
        self,
        machine_id: str,
        harness: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        region: str | None = None,
    ) -> AgentLoginResult:
        """Finish a sign-in, in one call. See :meth:`Agents.complete_login`.

        .. deprecated:: Use ``boxd.integrations.complete()``.
        """
        _moved("complete_login", "complete")
        return await self._complete_login(
            machine_id, harness, code=code, handle=handle, region=region
        )

    async def _complete_login(
        self,
        machine_id: str,
        harness: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        region: str | None = None,
    ) -> AgentLoginResult:
        return m.agent_login_result(
            await self._transport.call(
                "CompleteAgentLogin",
                _complete_login(machine_id, harness, code=code, handle=handle),
                region=region,
            )
        )

    async def wait_for_login(
        self,
        machine_id: str,
        harness: str,
        start: AgentLoginStart,
        *,
        timeout: float | None = None,
        region: str | None = None,
    ) -> AgentLogin:
        """Wait until you've approved a Codex sign-in. See
        :meth:`Agents.wait_for_login`.

        .. deprecated:: Use ``boxd.integrations.wait()``.
        """
        _moved("wait_for_login", "wait")
        wait = _LoginWait(harness, start, timeout)
        while True:
            result = await self._complete_login(
                machine_id, harness, handle=wait.handle, region=region
            )
            if not result.pending:
                return wait.login(result)
            await asyncio.sleep(wait.pause())

    async def get_login(
        self, machine_id: str, harness: str, *, region: str | None = None
    ) -> AgentLogin:
        """Whether you're signed in to `harness` for `machine_id`. See
        :meth:`Agents.get_login`.

        .. deprecated:: Use ``boxd.integrations.get()``.
        """
        _moved("get_login", "get")
        return m.agent_login(
            await self._transport.call(
                "GetAgentLogin",
                api_pb2.GetAgentLoginRequest(vm_id=machine_id, harness=harness),
                region=region,
            )
        )

    async def logout(
        self, machine_id: str, harness: str, *, region: str | None = None
    ) -> None:
        """Forget your sign-in to `harness`. See :meth:`Agents.logout`.

        .. deprecated:: Use ``boxd.integrations.disconnect()``.
        """
        _moved("logout", "disconnect")
        await self._transport.call(
            "DeleteAgentLogin",
            api_pb2.DeleteAgentLoginRequest(vm_id=machine_id, harness=harness),
            region=region,
        )
