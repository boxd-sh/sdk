"""`boxd.account` — who you are, your SSH keys, and the cluster's config."""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import Account as AccountInfo
from ..models import ClusterConfig
from . import Namespace


class Account(Namespace):
    """Identity and account-level settings."""

    def get(self) -> AccountInfo:
        """The authenticated account: id, display name, SSH fingerprints, billing."""
        return m.account(self._transport.call("Whoami", api_pb2.WhoamiRequest()))

    def link_ssh_key(
        self,
        pubkey: str,
        *,
        device_id: str | None = None,
        label: str | None = None,
    ) -> None:
        """Attach an SSH public key so `ssh <machine>.<zone>` authenticates by it.

        `pubkey` is the verbatim OpenSSH authorized_keys line (the contents of a
        `.pub` file); the comment is ignored. When `device_id` is set the server
        keeps ONE key per (user, device), so re-linking replaces that device's
        previous key instead of accumulating stale ones. Idempotent.
        """
        self._transport.call(
            "LinkSshKey",
            api_pb2.LinkSshKeyRequest(
                pubkey=pubkey, device_id=device_id or "", label=label or ""
            ),
        )

    def config(self) -> ClusterConfig:
        """Cluster-level config — the default image and the cluster zone."""
        return m.cluster_config(
            self._transport.call("GetConfig", api_pb2.GetConfigRequest())
        )


class AsyncAccount(Namespace):
    """Async twin of :class:`Account`."""

    async def get(self) -> AccountInfo:
        """The authenticated account: id, display name, SSH fingerprints, billing."""
        return m.account(await self._transport.call("Whoami", api_pb2.WhoamiRequest()))

    async def link_ssh_key(
        self,
        pubkey: str,
        *,
        device_id: str | None = None,
        label: str | None = None,
    ) -> None:
        """Attach an SSH public key so `ssh <machine>.<zone>` authenticates by it.

        `pubkey` is the verbatim OpenSSH authorized_keys line (the contents of a
        `.pub` file); the comment is ignored. When `device_id` is set the server
        keeps ONE key per (user, device), so re-linking replaces that device's
        previous key instead of accumulating stale ones. Idempotent.
        """
        await self._transport.call(
            "LinkSshKey",
            api_pb2.LinkSshKeyRequest(
                pubkey=pubkey, device_id=device_id or "", label=label or ""
            ),
        )

    async def config(self) -> ClusterConfig:
        """Cluster-level config — the default image and the cluster zone."""
        return m.cluster_config(
            await self._transport.call("GetConfig", api_pb2.GetConfigRequest())
        )
