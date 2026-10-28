"""`boxd.api_keys` and `boxd.tokens` — long-lived keys and scoped JWTs.

Two parallel credential systems live side by side in the same proto. Both are
exposed for now; whether `tokens` is legacy is unresolved.
"""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import ApiKey, CreatedApiKey
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


