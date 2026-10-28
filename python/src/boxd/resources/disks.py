"""`boxd.disks` — persistent disks that outlive the machines they mount into."""

from __future__ import annotations

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..models import CreatedDisk, Disk
from . import Namespace


class Disks(Namespace):
    """Create, attach and destroy persistent disks."""

    def create(self, name: str, size: int | str) -> CreatedDisk:
        """Create a disk. `size` takes bytes or a human string ("10G")."""
        return m.created_disk(
            self._transport.call(
                "CreateDisk",
                api_pb2.CreateDiskRequest(name=name, size_bytes=req.parse_size(size)),
            )
        )

    def list(self) -> list[Disk]:
        """List every disk the caller owns, with its attachments."""
        resp = self._transport.call("ListDisks", api_pb2.ListDisksRequest())
        return [m.disk(d) for d in resp.disks]

    def attach(
        self,
        disk_id: str,
        machine_id: str,
        mount_path: str,
        *,
        read_only: bool = False,
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
        )

    def detach(self, disk_id: str, machine_id: str) -> None:
        """Unmount a disk from a machine. The disk and its data survive."""
        self._transport.call(
            "DetachDisk",
            api_pb2.DetachDiskRequest(disk_id=disk_id, vm_id=machine_id),
        )

    def delete(self, disk_id: str) -> None:
        """Destroy a disk and its contents. Terminal."""
        self._transport.call("DestroyDisk", api_pb2.DestroyDiskRequest(disk_id=disk_id))


class AsyncDisks(Namespace):
    """Async twin of :class:`Disks`."""

    async def create(self, name: str, size: int | str) -> CreatedDisk:
        """Create a disk. `size` takes bytes or a human string ("10G")."""
        return m.created_disk(
            await self._transport.call(
                "CreateDisk",
                api_pb2.CreateDiskRequest(name=name, size_bytes=req.parse_size(size)),
            )
        )

    async def list(self) -> list[Disk]:
        """List every disk the caller owns, with its attachments."""
        resp = await self._transport.call("ListDisks", api_pb2.ListDisksRequest())
        return [m.disk(d) for d in resp.disks]

    async def attach(
        self,
        disk_id: str,
        machine_id: str,
        mount_path: str,
        *,
        read_only: bool = False,
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
        )

    async def detach(self, disk_id: str, machine_id: str) -> None:
        """Unmount a disk from a machine. The disk and its data survive."""
        await self._transport.call(
            "DetachDisk",
            api_pb2.DetachDiskRequest(disk_id=disk_id, vm_id=machine_id),
        )

    async def delete(self, disk_id: str) -> None:
        """Destroy a disk and its contents. Terminal."""
        await self._transport.call(
            "DestroyDisk", api_pb2.DestroyDiskRequest(disk_id=disk_id)
        )
