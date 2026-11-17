"""`boxd.machines.agents` — drive Claude Code, Codex or OpenCode inside a
machine the same way, through sessions, turns and one typed event stream.

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

The machine argument is a machine's name or id, as everywhere in
``machines``.

``runs()`` reads how finished turns went, across your machines, from the
platform's run history instead: it never wakes a machine::

    page = boxd.machines.agents.runs(machine="my-box", limit=10)
    for run in page.runs:
        print(run.session_id, run.turn, run.reason, run.error or "")
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Generator, Iterator, Mapping
from datetime import datetime

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..models import (
    AgentEvent,
    AgentInterruptResult,
    AgentRun,
    AgentRunsPage,
    AgentSendResult,
    AgentSendWhen,
    AgentSession,
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
    cwd: str | None,
    instructions: str | None,
    env: Mapping[str, str] | None,
    request_id: str | None,
) -> api_pb2.StartAgentSessionRequest:
    return api_pb2.StartAgentSessionRequest(
        vm_id=machine_id,
        harness=harness,
        model=model or "",
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
        cwd: str | None = None,
        instructions: str | None = None,
        env: Mapping[str, str] | None = None,
        request_id: str | None = None,
        region: str | None = None,
    ) -> AgentSession:
        """Start a session with `harness` (``"claude-code"`` or ``"codex"``;
        :meth:`harnesses` lists what the machine has). Nothing runs until the
        first :meth:`send`.

        `model`: None is the agent's own default. `cwd`: the directory the
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
