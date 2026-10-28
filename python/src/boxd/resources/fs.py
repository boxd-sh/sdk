"""`boxd.machines.fs` — read and write files inside a machine.

Every call runs as the machine's user and sees the same files its commands
(`machines.exec`) see. Failures raise :class:`~boxd.errors.MachineFilesystemError`
subclasses that are also the builtin ``OSError``\\ s, so ``except
FileNotFoundError`` works as it would on a local file.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterable, AsyncIterator, Iterable, Iterator
from contextlib import contextmanager
from typing import Union

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..errors import BoxdError, MachineFilesystemError
from ..models import FsEntry
from . import Namespace

FsPath = Union[str, bytes, os.PathLike[str], os.PathLike[bytes]]
"""A path inside the machine. Relative paths start in the user's home directory."""

WriteData = Union[bytes, bytearray, memoryview, str, Iterable[bytes]]
"""What `write` takes: the whole file (a ``str`` is written as UTF-8), or an
iterable of byte chunks to stream."""

AsyncWriteData = Union[WriteData, AsyncIterable[bytes]]

# Chunks stay well under gRPC's 4 MiB message cap.
_CHUNK_BYTES = 1 << 20


def _shown(path: FsPath) -> str:
    """A path as an OSError names it: text, odd bytes kept as surrogate escapes."""
    raw = os.fspath(path)
    return m.fs_text(raw) if isinstance(raw, bytes) else raw


@contextmanager
def _naming(path: FsPath, other: FsPath | None = None):
    """Set ``filename`` (and ``filename2``) on a filesystem error, as a local
    OSError carries the path it failed on."""
    try:
        yield
    except MachineFilesystemError as e:
        if e.filename is None:
            e.filename = _shown(path)
            if other is not None:
                e.filename2 = _shown(other)
        raise


class _ReadCheck:
    """A read is complete only when its last chunk says so and the byte count
    matches. A stream that just stops is an error, never a short file."""

    def __init__(self, path: FsPath):
        self._path = _shown(path)
        self._received = 0
        self._sent: int | None = None

    def take(self, chunk) -> bytes:
        self._received += len(chunk.data)
        if chunk.eof:
            self._sent = chunk.bytes_read
        return chunk.data

    def finish(self) -> None:
        if self._sent is None:
            raise BoxdError(
                f"reading {self._path} stopped after {self._received} bytes, "
                "before the end of the file"
            )
        if self._sent != self._received:
            raise BoxdError(
                f"reading {self._path} is incomplete: the machine sent "
                f"{self._sent} bytes, {self._received} arrived"
            )


def _framer(
    machine_id, path, data, mode, *, async_ok: bool
) -> tuple[req.FsWriteFramer, bytes | None]:
    """The write's framer, and the data when it's a single buffer (its size
    goes on the wire, so a cut stream can't leave a short file)."""
    whole = req.fs_one_shot(data)
    iterables = (Iterable, AsyncIterable) if async_ok else (Iterable,)
    if whole is None and not isinstance(data, iterables):
        kinds = "an iterable or async iterable" if async_ok else "an iterable"
        raise TypeError(
            f"write: data must be bytes, str or {kinds} of bytes, "
            f"not {type(data).__name__}"
        )
    framer = req.FsWriteFramer(
        machine_id=machine_id,
        path=req.fs_path(path),
        mode=mode,
        expected_size=len(whole) if whole is not None else None,
        chunk_size=_CHUNK_BYTES,
    )
    return framer, whole


def _mkdir(machine_id: str, path: FsPath, mode: int | None) -> api_pb2.FsMkdirRequest:
    request = api_pb2.FsMkdirRequest(vm_id=machine_id, path=req.fs_path(path))
    if mode is not None:
        request.mode = mode
    return request


# ── Sync ─────────────────────────────────────────────────────────────


class Fs(Namespace):
    """`boxd.machines.fs` — files inside a machine, as the machine's user.

    Paths are ``str``, ``bytes`` or ``os.PathLike``; a relative one starts in
    the user's home directory. Calls wake a sleeping machine first. A machine
    started before this API existed raises
    :class:`~boxd.errors.MachineAgentOutdatedError` until it is rebooted.
    """

    def read(
        self,
        machine_id: str,
        path: FsPath,
        *,
        offset: int = 0,
        length: int | None = None,
    ) -> bytes:
        """A file's contents (following symlinks), from ``offset`` for
        ``length`` bytes or to the end.

        Only regular files can be read: a directory raises
        ``IsADirectoryError``, a FIFO or device a
        :class:`~boxd.errors.MachineFilesystemError` with reason
        ``"not_a_regular_file"``.
        """
        return b"".join(self.read_stream(machine_id, path, offset=offset, length=length))

    def read_stream(
        self,
        machine_id: str,
        path: FsPath,
        *,
        offset: int = 0,
        length: int | None = None,
    ) -> Iterator[bytes]:
        """:meth:`read`, a chunk at a time, for files too big to hold in
        memory. Raises at the end if the stream was cut short."""
        request = req.fs_read(
            machine_id=machine_id, path=req.fs_path(path), offset=offset, length=length
        )
        check = _ReadCheck(path)
        with _naming(path):
            for chunk in self._transport.server_stream("FsRead", request):
                data = check.take(chunk)
                if data:
                    yield data
        check.finish()

    def write(
        self,
        machine_id: str,
        path: FsPath,
        data: WriteData,
        *,
        mode: int | None = None,
    ) -> FsEntry:
        """Replace a file's contents, creating it and any missing parent
        directories. Returns the file as written.

        A symlink is written through to its target. An existing file keeps its
        mode and owner unless ``mode`` is given; a new one gets ``mode`` or
        0o644. Readers see the old contents or the new ones, never a mix,
        except for a file the machine can't replace by renaming (one with
        several hard links, owned by another user, a mount point, or in a
        directory the user can't write to), which is overwritten in place.
        """
        framer, whole = _framer(machine_id, path, data, mode, async_ok=False)
        pieces: Iterable[bytes] = [whole] if whole is not None else data  # type: ignore[assignment]
        with _naming(path):
            resp = self._transport.call("FsWrite", req.fs_write_chunks(framer, pieces))
        return m.fs_entry(resp.entry)

    def stat(self, machine_id: str, path: FsPath) -> FsEntry:
        """A file's, directory's or symlink's details. A symlink is described
        by what it points to; ``is_symlink`` and ``symlink_target`` say it is
        one."""
        with _naming(path):
            resp = self._transport.call(
                "FsStat", api_pb2.FsStatRequest(vm_id=machine_id, path=req.fs_path(path))
            )
        return m.fs_entry(resp.entry)

    def exists(self, machine_id: str, path: FsPath) -> bool:
        """Whether ``path`` exists, like ``os.path.exists``: False for a
        dangling symlink and for any path the filesystem can't resolve.

        Raises when the question can't be asked: the machine doesn't exist,
        can't be reached, or is too old for this API.
        """
        try:
            entry = self.stat(machine_id, path)
        except MachineFilesystemError:
            return False
        return entry.target_type is not None

    def list(self, machine_id: str, path: FsPath) -> list[FsEntry]:
        """A directory's entries, one level, in no particular order. There is
        no cap on how many."""
        return [entry for entry in self.iter_list(machine_id, path)]

    def iter_list(self, machine_id: str, path: FsPath) -> Iterator[FsEntry]:
        """:meth:`list`, lazily: entries arrive in batches as the machine
        reads the directory."""
        request = api_pb2.FsListRequest(vm_id=machine_id, path=req.fs_path(path))
        with _naming(path):
            for chunk in self._transport.server_stream("FsList", request):
                for entry in chunk.entries:
                    yield m.fs_entry(entry)

    def mkdir(self, machine_id: str, path: FsPath, *, mode: int | None = None) -> None:
        """Create a directory and any missing parents (``mkdir -p``). An
        existing directory is fine; a file in the way raises
        ``FileExistsError``. New directories get ``mode``, or 0o755."""
        with _naming(path):
            self._transport.call("FsMkdir", _mkdir(machine_id, path, mode))

    def remove(self, machine_id: str, path: FsPath, *, recursive: bool = False) -> None:
        """Remove a file or a symlink (never what it points to). A directory
        needs ``recursive=True``, which removes everything in it; without it
        a directory raises ``IsADirectoryError``. The root directory is
        refused."""
        with _naming(path):
            self._transport.call(
                "FsRemove",
                api_pb2.FsRemoveRequest(
                    vm_id=machine_id, path=req.fs_path(path), recursive=recursive
                ),
            )

    def rename(
        self,
        machine_id: str,
        old_path: FsPath,
        new_path: FsPath,
        *,
        overwrite: bool = True,
    ) -> None:
        """Move or rename a file or directory. With ``overwrite=False`` an
        existing ``new_path`` raises ``FileExistsError`` instead of being
        replaced."""
        with _naming(old_path, new_path):
            self._transport.call(
                "FsRename",
                api_pb2.FsRenameRequest(
                    vm_id=machine_id,
                    old_path=req.fs_path(old_path),
                    new_path=req.fs_path(new_path),
                    no_replace=not overwrite,
                ),
            )

    def realpath(self, machine_id: str, path: FsPath) -> str:
        """``path`` made absolute, with symlinks, ``.`` and ``..`` resolved,
        like ``os.path.realpath``: components that don't exist are kept as
        written. A symlink loop raises an ``OSError`` with ``errno.ELOOP``."""
        with _naming(path):
            resp = self._transport.call(
                "FsRealpath",
                api_pb2.FsRealpathRequest(vm_id=machine_id, path=req.fs_path(path)),
            )
        return m.fs_text(resp.path)


# ── Async ────────────────────────────────────────────────────────────


async def _async_chunks(
    framer: req.FsWriteFramer, pieces: Iterable[bytes] | AsyncIterable[bytes]
) -> AsyncIterator[api_pb2.FsWriteChunk]:
    if isinstance(pieces, AsyncIterable):
        async for piece in pieces:
            for chunk in framer.feed(piece):
                yield chunk
    else:
        for piece in pieces:
            for chunk in framer.feed(piece):
                yield chunk
    for chunk in framer.close():
        yield chunk


class AsyncFs(Namespace):
    """Async twin of :class:`Fs`."""

    async def read(
        self,
        machine_id: str,
        path: FsPath,
        *,
        offset: int = 0,
        length: int | None = None,
    ) -> bytes:
        """See :meth:`Fs.read`."""
        return b"".join(
            [
                chunk
                async for chunk in self.read_stream(
                    machine_id, path, offset=offset, length=length
                )
            ]
        )

    async def read_stream(
        self,
        machine_id: str,
        path: FsPath,
        *,
        offset: int = 0,
        length: int | None = None,
    ) -> AsyncIterator[bytes]:
        """See :meth:`Fs.read_stream`."""
        request = req.fs_read(
            machine_id=machine_id, path=req.fs_path(path), offset=offset, length=length
        )
        check = _ReadCheck(path)
        with _naming(path):
            stream = await self._transport.server_stream("FsRead", request)
            async for chunk in stream:
                data = check.take(chunk)
                if data:
                    yield data
        check.finish()

    async def write(
        self,
        machine_id: str,
        path: FsPath,
        data: AsyncWriteData,
        *,
        mode: int | None = None,
    ) -> FsEntry:
        """See :meth:`Fs.write`. ``data`` may also be an async iterable of
        byte chunks."""
        framer, whole = _framer(machine_id, path, data, mode, async_ok=True)
        pieces = [whole] if whole is not None else data
        with _naming(path):
            resp = await self._transport.call(
                "FsWrite",
                _async_chunks(framer, pieces),  # type: ignore[arg-type]
            )
        return m.fs_entry(resp.entry)

    async def stat(self, machine_id: str, path: FsPath) -> FsEntry:
        """See :meth:`Fs.stat`."""
        with _naming(path):
            resp = await self._transport.call(
                "FsStat", api_pb2.FsStatRequest(vm_id=machine_id, path=req.fs_path(path))
            )
        return m.fs_entry(resp.entry)

    async def exists(self, machine_id: str, path: FsPath) -> bool:
        """See :meth:`Fs.exists`."""
        try:
            entry = await self.stat(machine_id, path)
        except MachineFilesystemError:
            return False
        return entry.target_type is not None

    async def list(self, machine_id: str, path: FsPath) -> list[FsEntry]:
        """See :meth:`Fs.list`."""
        return [entry async for entry in self.iter_list(machine_id, path)]

    async def iter_list(self, machine_id: str, path: FsPath) -> AsyncIterator[FsEntry]:
        """See :meth:`Fs.iter_list`."""
        request = api_pb2.FsListRequest(vm_id=machine_id, path=req.fs_path(path))
        with _naming(path):
            stream = await self._transport.server_stream("FsList", request)
            async for chunk in stream:
                for entry in chunk.entries:
                    yield m.fs_entry(entry)

    async def mkdir(
        self, machine_id: str, path: FsPath, *, mode: int | None = None
    ) -> None:
        """See :meth:`Fs.mkdir`."""
        with _naming(path):
            await self._transport.call("FsMkdir", _mkdir(machine_id, path, mode))

    async def remove(
        self, machine_id: str, path: FsPath, *, recursive: bool = False
    ) -> None:
        """See :meth:`Fs.remove`."""
        with _naming(path):
            await self._transport.call(
                "FsRemove",
                api_pb2.FsRemoveRequest(
                    vm_id=machine_id, path=req.fs_path(path), recursive=recursive
                ),
            )

    async def rename(
        self,
        machine_id: str,
        old_path: FsPath,
        new_path: FsPath,
        *,
        overwrite: bool = True,
    ) -> None:
        """See :meth:`Fs.rename`."""
        with _naming(old_path, new_path):
            await self._transport.call(
                "FsRename",
                api_pb2.FsRenameRequest(
                    vm_id=machine_id,
                    old_path=req.fs_path(old_path),
                    new_path=req.fs_path(new_path),
                    no_replace=not overwrite,
                ),
            )

    async def realpath(self, machine_id: str, path: FsPath) -> str:
        """See :meth:`Fs.realpath`."""
        with _naming(path):
            resp = await self._transport.call(
                "FsRealpath",
                api_pb2.FsRealpathRequest(vm_id=machine_id, path=req.fs_path(path)),
            )
        return m.fs_text(resp.path)
