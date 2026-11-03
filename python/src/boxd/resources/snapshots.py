"""`boxd.snapshots` — durable, account-level point-in-time captures."""

from __future__ import annotations

import warnings

from .. import _mappers as m
from ..errors import NotFoundError
from .._generated import api_pb2
from .._regions import ALL, normalize
from ..models import CreatedSnapshot, RegionalList, Snapshot
from . import Namespace


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
        self, machine_id: str, name: str, *, region: str | None = None
    ) -> CreatedSnapshot:
        """Capture a running machine. Re-saving the same name bumps the version.

        The machine's running automations are captured with it, and every
        machine created from the snapshot starts them paused
        (``paused_automations`` says how many).
        """
        return _warn_paused_automations(
            m.created_snapshot(
                self._transport.call(
                    "CreateSnapshot",
                    api_pb2.CreateSnapshotRequest(vm=machine_id, name=name),
                    region=region,
                )
            )
        )

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

    def delete(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> None:
        """Delete a snapshot by name or id."""
        self._transport.call(
            "DeleteSnapshot",
            api_pb2.DeleteSnapshotRequest(name=name, org=org or ""),
            region=region,
        )


class AsyncSnapshots(Namespace):
    """Async twin of :class:`Snapshots`."""

    async def create(
        self, machine_id: str, name: str, *, region: str | None = None
    ) -> CreatedSnapshot:
        """Capture a running machine. Re-saving the same name bumps the version.

        Running automations are captured too; see :meth:`Snapshots.create`.
        """
        return _warn_paused_automations(
            m.created_snapshot(
                await self._transport.call(
                    "CreateSnapshot",
                    api_pb2.CreateSnapshotRequest(vm=machine_id, name=name),
                    region=region,
                )
            )
        )

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

    async def delete(
        self, name: str, *, org: str | None = None, region: str | None = None
    ) -> None:
        """Delete a snapshot by name or id."""
        await self._transport.call(
            "DeleteSnapshot",
            api_pb2.DeleteSnapshotRequest(name=name, org=org or ""),
            region=region,
        )
