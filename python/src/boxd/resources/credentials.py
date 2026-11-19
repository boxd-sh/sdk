"""`boxd.api_keys` and `boxd.machine_tokens` — long-lived keys, and short-lived
tokens that act on a few machines only.
"""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import ApiKey, CreatedApiKey, MachineToken
from . import Namespace


class ApiKeys(Namespace):
    """Long-lived `bxd_` keys for CI and scripts."""

    def create(
        self,
        name: str,
        *,
        expires_in: int = 0,
        org: str | None = None,
        kind: str = "member",
    ) -> CreatedApiKey:
        """Mint an API key. The raw key comes back once and is never stored.

        Every key is fenced to exactly one org (`org=None` = your own) — a key
        never grants account-wide access. `kind="member"` acts as you within
        that org; `kind="org"` is a userless service credential limited to the
        org's shared fleet, and requires org admin. `expires_in=0` = no expiry.
        """
        return m.created_api_key(
            self._transport.call(
                "CreateApiKey",
                api_pb2.CreateApiKeyRequest(
                    name=name,
                    expires_in_secs=expires_in,
                    org=org or "",
                    kind=kind,
                ),
            )
        )

    def list(self) -> list[ApiKey]:
        """The keys you made, and in each org you administer the org's "org"
        keys other people made: those keep working after their maker leaves, so
        the org's admins can see and delete them (`mine` tells them apart).
        Values are never returned, only prefixes."""
        resp = self._transport.call("ListApiKeys", api_pb2.ListApiKeysRequest())
        return [m.api_key(k) for k in resp.keys]

    def delete(self, key_id: str) -> None:
        """Revoke a key you made, or an "org" key of an org you administer.
        Takes effect immediately — the row is re-read per request."""
        self._transport.call("DeleteApiKey", api_pb2.DeleteApiKeyRequest(id=key_id))



class AsyncApiKeys(Namespace):
    """Async twin of :class:`ApiKeys`."""

    async def create(
        self,
        name: str,
        *,
        expires_in: int = 0,
        org: str | None = None,
        kind: str = "member",
    ) -> CreatedApiKey:
        """Mint an API key. The raw key comes back once and is never stored.

        Every key is fenced to exactly one org (`org=None` = your own) — a key
        never grants account-wide access. `kind="member"` acts as you within
        that org; `kind="org"` is a userless service credential limited to the
        org's shared fleet, and requires org admin. `expires_in=0` = no expiry.
        """
        return m.created_api_key(
            await self._transport.call(
                "CreateApiKey",
                api_pb2.CreateApiKeyRequest(
                    name=name,
                    expires_in_secs=expires_in,
                    org=org or "",
                    kind=kind,
                ),
            )
        )

    async def list(self) -> list[ApiKey]:
        """The keys you made, and in each org you administer the org's "org"
        keys other people made: those keep working after their maker leaves, so
        the org's admins can see and delete them (`mine` tells them apart).
        Values are never returned, only prefixes."""
        resp = await self._transport.call("ListApiKeys", api_pb2.ListApiKeysRequest())
        return [m.api_key(k) for k in resp.keys]

    async def delete(self, key_id: str) -> None:
        """Revoke a key you made, or an "org" key of an org you administer.
        Takes effect immediately — the row is re-read per request."""
        await self._transport.call(
            "DeleteApiKey", api_pb2.DeleteApiKeyRequest(id=key_id)
        )


_MACHINE_TOKEN_DOC = """Mint a token that acts on `machines` (names or ids) only.

        Hand it to code you don't fully trust, such as an eval worker or an
        agent: ``Boxd(token=t.token)`` can run commands, move files, drive the
        machines' lifecycle and change their settings, and nothing else. It
        cannot delete them, create or fork machines, change networks, egress
        or secrets, see other machines, or manage the account.

        The API enforces this. A command the token runs inside a machine has
        what any process in that machine has: on a machine that is not
        isolated, that includes the machine's own boxd access, which reaches
        the rest of the org. For code you don't trust, use isolated machines
        (``machines.create(..., isolated=True)``).

        The token is pinned to the machines' ids, so a rename keeps it.
        `expires_in` is in seconds: 0 = 1 hour, at most 24 hours. Minted with
        an API key, it never outlives that key, and deleting the key ends
        every token minted with it. A command or file transfer still running
        when the token expires is ended. Mint it in the machines' region (the
        client's `region=`).
        """


class MachineTokens(Namespace):
    """Short-lived `bxdm_` tokens fenced to a few machines."""

    def create(self, machines: list[str], *, expires_in: int = 0) -> MachineToken:
        return m.machine_token(
            self._transport.call(
                "CreateMachineToken",
                api_pb2.CreateMachineTokenRequest(
                    machines=list(machines), expires_in_secs=expires_in
                ),
            )
        )

    create.__doc__ = _MACHINE_TOKEN_DOC


class AsyncMachineTokens(Namespace):
    """Async twin of :class:`MachineTokens`."""

    async def create(
        self, machines: list[str], *, expires_in: int = 0
    ) -> MachineToken:
        return m.machine_token(
            await self._transport.call(
                "CreateMachineToken",
                api_pb2.CreateMachineTokenRequest(
                    machines=list(machines), expires_in_secs=expires_in
                ),
            )
        )

    create.__doc__ = _MACHINE_TOKEN_DOC
