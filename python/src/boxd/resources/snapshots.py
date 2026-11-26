"""`boxd.snapshots` — durable, account-level point-in-time captures."""

from __future__ import annotations

import warnings

from .. import _mappers as m
from ..errors import APIStatusError, NotFoundError
from .._generated import api_pb2
from .._regions import ALL, normalize
from ..models import (
    CreatedSnapshot,
    RegionalList,
    Snapshot,
    SnapshotCurrentVersion,
    SnapshotVersion,
)
from . import Namespace


def _save_method(staged: bool) -> str:
    """A staged save is a call of its own, so that a server from before staged
    saves refuses it instead of saving a version that becomes current."""
    return "CreateStagedSnapshot" if staged else "CreateSnapshot"


def older_server(err: Exception, what: str) -> Exception:
    """``err``, or for a server too old to know the call a sentence saying so."""
    if isinstance(err, APIStatusError) and err.code == "unimplemented":
        return APIStatusError(
            f"this boxd doesn't {what} yet (it runs an older version)",
            code=err.code,
            grpc_code=err.grpc_code,
        )
    return err


def _warn_paused_automations(created: CreatedSnapshot) -> CreatedSnapshot:
    """Say how many automations the snapshot captured: every machine created
    from it starts them paused, as a fork does, so nothing runs twice."""
    n = created.paused_automations
    if n > 0:
        subject = "1 automation" if n == 1 else f"{n} automations"
        warnings.warn(
            f"{subject} captured: machines created from {created.name} start them "
            "paused so nothing runs twice. Inside one, `run restart <id>` starts it.",
            stacklevel=3,
        )
    return created


def _snapshot_list(pages, unavailable, elsewhere=()) -> RegionalList[Snapshot]:
    return RegionalList(
        [m.snapshot(s, region) for region, resp in pages for s in resp.snapshots],
        elsewhere=m.region_counts(elsewhere),
        unavailable=unavailable,
    )


class Snapshots(Namespace):
    """Create, inspect and delete snapshots.

    Creating a *machine* from a snapshot is not here — it lives on
    :meth:`boxd.machines.create` as ``create(from_snapshot=...)``.
    """

    def create(
        self,
        machine_id: str,
        name: str,
        *,
        staged: bool = False,
        region: str | None = None,
    ) -> CreatedSnapshot:
        """Capture a running machine. Re-saving the same name bumps the version.

        The machine's running automations are captured with it, and every
        machine created from the snapshot starts them paused
        (``paused_automations`` says how many).

        ``staged=True`` saves the version without making it the snapshot's
        current one: machines created from the snapshot keep getting the
        current version. Follow the save with :meth:`versions` (the version is
        ``"saving"``, then ``"ready"`` with ``staged`` set), create a machine
        from it with ``machines.create(from_snapshot=name,
        snapshot_version=...)``, and make it current with
        :meth:`set_current_version`. The snapshot must already have a version
        (:class:`~boxd.ConflictError` for the first save of a name). A snapshot
        keeps as many staged versions as the org keeps versions
        (:meth:`boxd.orgs.get_snapshot_versions_keep`): one more replaces the
        oldest staged one.
        """
        try:
            resp = self._transport.call(
                _save_method(staged),
                api_pb2.CreateSnapshotRequest(vm=machine_id, name=name),
                region=region,
            )
        except APIStatusError as err:
            raise older_server(err, "stage a save; nothing was saved") from err
        return _warn_paused_automations(m.created_snapshot(resp, staged=staged))

    def get(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> Snapshot:
        """Fetch one snapshot by name or id."""
        request = api_pb2.GetSnapshotRequest(name=name, org=org or "")
        resp = self._transport.call("GetSnapshot", request, region=region)
        if not resp.HasField("snapshot"):
            raise self._transport.find_elsewhere(
                NotFoundError(f"snapshot not found: {name}"),
                "GetSnapshot",
                request,
                region=region,
            )
        return m.snapshot(resp.snapshot)

    def list(
        self, *, org: str | None = None, region: str | None = None
    ) -> RegionalList[Snapshot]:
        """List snapshots. Snapshots never cross an org boundary.

        The list is of one region (``region``, default the client's); its
        ``elsewhere`` counts the org's snapshots in each other region.
        ``region="all"`` lists every region the org has.
        """
        if normalize(region) == ALL:
            pages, unavailable = self._transport.each_region(
                "ListSnapshots", api_pb2.ListSnapshotsRequest(org=org or ""), org=org
            )
            return _snapshot_list(pages, unavailable)
        resp = self._transport.call(
            "ListSnapshots",
            api_pb2.ListSnapshotsRequest(org=org or "", with_elsewhere=True),
            region=region,
        )
        return _snapshot_list([(normalize(region), resp)], [], resp.elsewhere)

    def versions(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> list[SnapshotVersion]:
        """The versions a snapshot keeps, newest first.

        Saving over a snapshot's name makes a new version, and the org keeps
        the newest ones (:meth:`boxd.orgs.set_snapshot_versions_keep`). Create
        a machine from one that is ``"ready"`` and ``"local"`` with
        ``machines.create(from_snapshot=name, snapshot_version=v.version)``.
        A version you may not use (saved from someone else's private machine)
        is not listed.
        """
        resp = self._transport.call(
            "ListSnapshotVersions",
            api_pb2.ListSnapshotVersionsRequest(name=name, org=org or ""),
            region=region,
        )
        return [m.snapshot_version(v) for v in resp.versions]

    def set_current_version(
        self,
        name: str,
        version: int,
        *,
        org: str | None = None,
        region: str | None = None,
    ) -> SnapshotCurrentVersion:
        """Make ``version`` the snapshot's current version: the one a machine
        created from the snapshot gets when no version is named, and the one
        the snapshot's size, saver and visibility are read from.

        Forward to a staged version (``create(..., staged=True)``), or back to
        an older one. After going back, the ready versions above the new
        current one are staged (:meth:`versions`), and can be made current
        again the same way. Nothing is copied or deleted by the call.

        For anyone who may save over the snapshot and may use that version.
        The version must be ``"ready"`` and ``"local"``, and the snapshot
        itself ``"local"`` (:class:`~boxd.ConflictError` otherwise);
        :class:`~boxd.NotFoundError` for a version the snapshot does not keep.
        Naming the version that is current already succeeds, with ``changed``
        False.
        """
        resp = self._transport.call(
            "SetSnapshotCurrentVersion",
            api_pb2.SetSnapshotCurrentVersionRequest(
                snapshot=name, org=org or "", version=version
            ),
            region=region,
        )
        return m.snapshot_current_version(resp)

    def delete(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> None:
        """Delete a snapshot by name or id."""
        self._transport.call(
            "DeleteSnapshot",
            api_pb2.DeleteSnapshotRequest(name=name, org=org or ""),
            region=region,
        )

    def unarchive(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> Snapshot:
        """Start restoring an archived snapshot (``storage == "archived"``)
        from object storage to local disk, so machines can be created from it
        again. Anyone who can create a machine from the snapshot can.

        Returns at once with the snapshot as the call left it: ``storage`` is
        ``"unarchiving"`` while the restore runs, then ``"local"``. Follow it
        with :meth:`get`. If ``storage`` goes back to ``"archived"`` the
        restore failed, and calling this again retries it.

        A snapshot that is already being restored is left as it is. One that
        is being archived stays local: the upload is cancelled. A local one is
        returned unchanged. An org can have a few restores running at once;
        past that this raises :class:`~boxd.ConflictError` until one is done.

        Creating a machine from an archived snapshot starts the same restore
        and raises :class:`~boxd.ConflictError`; create again once ``storage``
        is ``"local"``.
        """
        resp = self._transport.call(
            "UnarchiveSnapshot",
            api_pb2.UnarchiveSnapshotRequest(name=name, org=org or ""),
            region=region,
        )
        if not resp.HasField("snapshot"):
            raise NotFoundError(f"snapshot not found: {name}")
        return m.snapshot(resp.snapshot, normalize(region))


class AsyncSnapshots(Namespace):
    """Async twin of :class:`Snapshots`."""

    async def create(
        self,
        machine_id: str,
        name: str,
        *,
        staged: bool = False,
        region: str | None = None,
    ) -> CreatedSnapshot:
        """Capture a running machine. Re-saving the same name bumps the version.

        Running automations are captured too, and ``staged=True`` saves the
        version without making it current; see :meth:`Snapshots.create`.
        """
        try:
            resp = await self._transport.call(
                _save_method(staged),
                api_pb2.CreateSnapshotRequest(vm=machine_id, name=name),
                region=region,
            )
        except APIStatusError as err:
            raise older_server(err, "stage a save; nothing was saved") from err
        return _warn_paused_automations(m.created_snapshot(resp, staged=staged))

    async def get(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> Snapshot:
        """Fetch one snapshot by name or id."""
        request = api_pb2.GetSnapshotRequest(name=name, org=org or "")
        resp = await self._transport.call("GetSnapshot", request, region=region)
        if not resp.HasField("snapshot"):
            raise await self._transport.find_elsewhere(
                NotFoundError(f"snapshot not found: {name}"),
                "GetSnapshot",
                request,
                region=region,
            )
        return m.snapshot(resp.snapshot)

    async def list(
        self, *, org: str | None = None, region: str | None = None
    ) -> RegionalList[Snapshot]:
        """List snapshots. ``region`` (``"all"`` too): see :meth:`Snapshots.list`."""
        if normalize(region) == ALL:
            pages, unavailable = await self._transport.each_region(
                "ListSnapshots", api_pb2.ListSnapshotsRequest(org=org or ""), org=org
            )
            return _snapshot_list(pages, unavailable)
        resp = await self._transport.call(
            "ListSnapshots",
            api_pb2.ListSnapshotsRequest(org=org or "", with_elsewhere=True),
            region=region,
        )
        return _snapshot_list([(normalize(region), resp)], [], resp.elsewhere)

    async def versions(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> list[SnapshotVersion]:
        """See :meth:`Snapshots.versions`."""
        resp = await self._transport.call(
            "ListSnapshotVersions",
            api_pb2.ListSnapshotVersionsRequest(name=name, org=org or ""),
            region=region,
        )
        return [m.snapshot_version(v) for v in resp.versions]

    async def set_current_version(
        self,
        name: str,
        version: int,
        *,
        org: str | None = None,
        region: str | None = None,
    ) -> SnapshotCurrentVersion:
        """Make ``version`` the snapshot's current version; see
        :meth:`Snapshots.set_current_version`."""
        resp = await self._transport.call(
            "SetSnapshotCurrentVersion",
            api_pb2.SetSnapshotCurrentVersionRequest(
                snapshot=name, org=org or "", version=version
            ),
            region=region,
        )
        return m.snapshot_current_version(resp)

    async def delete(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> None:
        """Delete a snapshot by name or id."""
        await self._transport.call(
            "DeleteSnapshot",
            api_pb2.DeleteSnapshotRequest(name=name, org=org or ""),
            region=region,
        )

    async def unarchive(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> Snapshot:
        """Start restoring an archived snapshot from object storage. Returns at
        once; see :meth:`Snapshots.unarchive`."""
        resp = await self._transport.call(
            "UnarchiveSnapshot",
            api_pb2.UnarchiveSnapshotRequest(name=name, org=org or ""),
            region=region,
        )
        if not resp.HasField("snapshot"):
            raise NotFoundError(f"snapshot not found: {name}")
        return m.snapshot(resp.snapshot, normalize(region))
