"""`boxd.disks` — persistent disks that outlive the machines they mount into."""

from __future__ import annotations

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from .._regions import ALL, normalize
from ..models import CreatedDisk, Disk, RegionalList
from . import Namespace


def _disk_list(pages, unavailable, elsewhere=()) -> RegionalList[Disk]:
    return RegionalList(
        [m.disk(d, region) for region, resp in pages for d in resp.disks],
        elsewhere=m.region_counts(elsewhere),
        unavailable=unavailable,
    )


class Disks(Namespace):
    """Create, attach and destroy persistent disks."""

    def create(
        self, name: str, size: int | str, *, region: str | None = None
    ) -> CreatedDisk:
        """Create a disk. `size` takes bytes or a human string ("10G")."""
        return m.created_disk(
            self._transport.call(
                "CreateDisk",
                api_pb2.CreateDiskRequest(name=name, size_bytes=req.parse_size(size)),
                region=region,
            )
        )

    def list(self, *, region: str | None = None) -> RegionalList[Disk]:
        """List every disk the caller owns, with its attachments.

        The list is of one region (``region``, default the client's); its
        ``elsewhere`` counts your disks in each other region.
        ``region="all"`` lists every region your org has.
        """
        if normalize(region) == ALL:
            pages, unavailable = self._transport.each_region(
                "ListDisks", api_pb2.ListDisksRequest(), org=None
            )
            return _disk_list(pages, unavailable)
        resp = self._transport.call(
            "ListDisks", api_pb2.ListDisksRequest(with_elsewhere=True), region=region
        )
        return _disk_list([(normalize(region), resp)], [], resp.elsewhere)

    def attach(
        self,
        disk_id: str,
        machine_id: str,
        mount_path: str,
        *,
        read_only: bool = False,
        region: str | None = None,
    ) -> None:
        """Mount a disk into a machine.

        A disk can only be attached to one machine at a time, so this is
        rejected while any attachment exists. `read_only` is chosen per
        attachment; the disk itself is always created writable.
        """
        self._transport.call(
            "AttachDisk",
            api_pb2.AttachDiskRequest(
                disk_id=disk_id,
                vm_id=machine_id,
                mount_path=mount_path,
                read_only=read_only,
            ),
            region=region,
        )

    def detach(
        self, disk_id: str, machine_id: str, *, region: str | None = None
    ) -> None:
        """Unmount a disk from a machine. The disk and its data survive."""
        self._transport.call(
            "DetachDisk",
            api_pb2.DetachDiskRequest(disk_id=disk_id, vm_id=machine_id),
            region=region,
        )

    def delete(self, disk_id: str, *, region: str | None = None) -> None:
        """Destroy a disk and its contents. Terminal."""
        self._transport.call(
            "DestroyDisk", api_pb2.DestroyDiskRequest(disk_id=disk_id), region=region
        )


class AsyncDisks(Namespace):
    """Async twin of :class:`Disks`."""

    async def create(
        self, name: str, size: int | str, *, region: str | None = None
    ) -> CreatedDisk:
        """Create a disk. `size` takes bytes or a human string ("10G")."""
        return m.created_disk(
            await self._transport.call(
                "CreateDisk",
                api_pb2.CreateDiskRequest(name=name, size_bytes=req.parse_size(size)),
                region=region,
            )
        )

    async def list(self, *, region: str | None = None) -> RegionalList[Disk]:
        """List every disk the caller owns. ``region`` (``"all"`` too): see
        :meth:`Disks.list`."""
        if normalize(region) == ALL:
            pages, unavailable = await self._transport.each_region(
                "ListDisks", api_pb2.ListDisksRequest(), org=None
            )
            return _disk_list(pages, unavailable)
        resp = await self._transport.call(
            "ListDisks", api_pb2.ListDisksRequest(with_elsewhere=True), region=region
        )
        return _disk_list([(normalize(region), resp)], [], resp.elsewhere)

    async def attach(
        self,
        disk_id: str,
        machine_id: str,
        mount_path: str,
        *,
        read_only: bool = False,
        region: str | None = None,
    ) -> None:
        """Mount a disk into a machine. Only one attachment at a time."""
        await self._transport.call(
            "AttachDisk",
            api_pb2.AttachDiskRequest(
                disk_id=disk_id,
                vm_id=machine_id,
                mount_path=mount_path,
                read_only=read_only,
            ),
            region=region,
        )

    async def detach(
        self, disk_id: str, machine_id: str, *, region: str | None = None
    ) -> None:
        """Unmount a disk from a machine. The disk and its data survive."""
        await self._transport.call(
            "DetachDisk",
            api_pb2.DetachDiskRequest(disk_id=disk_id, vm_id=machine_id),
            region=region,
        )

    async def delete(self, disk_id: str, *, region: str | None = None) -> None:
        """Destroy a disk and its contents. Terminal."""
        await self._transport.call(
            "DestroyDisk", api_pb2.DestroyDiskRequest(disk_id=disk_id), region=region
        )
