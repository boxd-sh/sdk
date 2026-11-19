"""`boxd.integrations` — what your machines are signed in to.

Today: the coding agents' sign-ins, ``"claude"`` (Claude Code; ``"claude-code"``
works too) and ``"codex"``. A sign-in is yours, kept in one organization:
every private machine of yours there uses it, and the platform keeps it
fresh. It is the same sign-in as Integrations in the console and
``boxd manage integrations connect`` on the command line::

    start = boxd.integrations.connect("codex")
    print(f"Open {start.url} and enter {start.user_code}")
    login = boxd.integrations.wait("codex", start)

    start = boxd.integrations.connect("claude")
    print(f"Open {start.url}, approve, and paste the code it shows you")
    login = boxd.integrations.complete("claude", code=input("Code: "))

`org` (a name or id) picks the organization. Without it: your default
organization, or the one your API key is for. A sign-in belongs to a person,
so an organization API key can't make or read one. A shared or isolated
machine never gets anyone's sign-in: give it an API key as a secret instead.
"""

from __future__ import annotations

import asyncio
import time

from .. import _mappers as m
from .._generated import api_pb2
from ..models import AgentLogin, AgentLoginResult, AgentLoginStart
from . import Namespace
from .agents import _LoginWait


def _start(name: str, org: str | None) -> api_pb2.StartAgentLoginRequest:
    return api_pb2.StartAgentLoginRequest(harness=name, org=org or "")


def _complete(
    name: str, org: str | None, *, code: str | None, handle: str | None
) -> api_pb2.CompleteAgentLoginRequest:
    return api_pb2.CompleteAgentLoginRequest(
        harness=name, org=org or "", code=code or "", handle=handle or ""
    )


def _wait(name: str, start: AgentLoginStart, timeout: float | None) -> _LoginWait:
    return _LoginWait(
        name,
        start,
        timeout,
        start_call="connect()",
        complete_call="complete(code=...)",
        wait_call="wait()",
    )


class Integrations(Namespace):
    """Your sign-ins to the coding agents: ``"claude"`` and ``"codex"``."""

    def connect(self, name: str, *, org: str | None = None) -> AgentLoginStart:
        """Start signing `name` in (``"claude"`` or ``"codex"``): where to go.

        Claude Code (``"paste_code"``): open ``url``, approve, and pass the
        code the page then shows you to :meth:`complete`. Codex
        (``"device_code"``): open ``url``, enter ``user_code``, and
        :meth:`wait`.
        """
        return m.agent_login_start(self._transport.call("StartAgentLogin", _start(name, org)))

    def complete(
        self,
        name: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        org: str | None = None,
    ) -> AgentLoginResult:
        """Finish a sign-in :meth:`connect` began, in one call. Claude Code:
        `code` is the code the page showed you after you approved, and you're
        signed in. Codex: `handle` is the start's, and the result is
        ``pending`` until you've approved; :meth:`wait` asks again for you."""
        return m.agent_login_result(
            self._transport.call(
                "CompleteAgentLogin", _complete(name, org, code=code, handle=handle)
            )
        )

    def wait(
        self,
        name: str,
        start: AgentLoginStart,
        *,
        timeout: float | None = None,
        org: str | None = None,
    ) -> AgentLogin:
        """Wait until you've approved a Codex (``"device_code"``) sign-in:
        asks with the start's ``handle`` every ``interval_secs`` until it's no
        longer pending, and returns the login. Raises :class:`TimeoutError`
        once the code expires (``expires_at``), or after `timeout` seconds
        when that comes first (None: until it expires).

        A Claude Code (``"paste_code"``) sign-in can't be waited on
        (:class:`ValueError`): pass the code its page shows you to
        :meth:`complete`.
        """
        wait = _wait(name, start, timeout)
        while True:
            result = self.complete(name, handle=wait.handle, org=org)
            if not result.pending:
                return wait.login(result)
            time.sleep(wait.pause())

    def get(self, name: str, *, org: str | None = None) -> AgentLogin:
        """Whether you're signed in to `name`, and as whom."""
        return m.agent_login(
            self._transport.call(
                "GetAgentLogin", api_pb2.GetAgentLoginRequest(harness=name, org=org or "")
            )
        )

    def disconnect(self, name: str, *, org: str | None = None) -> None:
        """Forget your sign-in to `name`: your private machines in the
        organization stop getting it. It isn't revoked at Anthropic or
        OpenAI; do that from your account there."""
        self._transport.call(
            "DeleteAgentLogin", api_pb2.DeleteAgentLoginRequest(harness=name, org=org or "")
        )


class AsyncIntegrations(Namespace):
    """Async twin of :class:`Integrations`."""

    async def connect(self, name: str, *, org: str | None = None) -> AgentLoginStart:
        """Start signing `name` in. See :meth:`Integrations.connect`."""
        return m.agent_login_start(
            await self._transport.call("StartAgentLogin", _start(name, org))
        )

    async def complete(
        self,
        name: str,
        *,
        code: str | None = None,
        handle: str | None = None,
        org: str | None = None,
    ) -> AgentLoginResult:
        """Finish a sign-in, in one call. See :meth:`Integrations.complete`."""
        return m.agent_login_result(
            await self._transport.call(
                "CompleteAgentLogin", _complete(name, org, code=code, handle=handle)
            )
        )

    async def wait(
        self,
        name: str,
        start: AgentLoginStart,
        *,
        timeout: float | None = None,
        org: str | None = None,
    ) -> AgentLogin:
        """Wait until you've approved a Codex sign-in. See
        :meth:`Integrations.wait`."""
        wait = _wait(name, start, timeout)
        while True:
            result = await self.complete(name, handle=wait.handle, org=org)
            if not result.pending:
                return wait.login(result)
            await asyncio.sleep(wait.pause())

    async def get(self, name: str, *, org: str | None = None) -> AgentLogin:
        """Whether you're signed in to `name`. See :meth:`Integrations.get`."""
        return m.agent_login(
            await self._transport.call(
                "GetAgentLogin", api_pb2.GetAgentLoginRequest(harness=name, org=org or "")
            )
        )

    async def disconnect(self, name: str, *, org: str | None = None) -> None:
        """Forget your sign-in to `name`. See :meth:`Integrations.disconnect`."""
        await self._transport.call(
            "DeleteAgentLogin", api_pb2.DeleteAgentLoginRequest(harness=name, org=org or "")
        )
