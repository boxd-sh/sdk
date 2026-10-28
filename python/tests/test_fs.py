"""`machines.fs`: what goes on the wire, what comes back, and how failures
surface as the builtin OSErrors."""

from __future__ import annotations

import errno
import pickle
from datetime import datetime, timezone
from pathlib import PurePosixPath

import grpc
import pytest

from boxd._generated import api_pb2
from boxd.errors import (
    AuthenticationError,
    BoxdError,
    ConflictError,
    MachineAgentOutdatedError,
    MachineFileExistsError,
    MachineFileNotFoundError,
    MachineFilesystemError,
    MachineIsADirectoryError,
    MachineNotADirectoryError,
    MachinePermissionError,
    NotFoundError,
    PermissionDeniedError,
    from_grpc_error,
)
from boxd.models import FsEntry
from boxd.resources.machines import AsyncMachines, Machines
from fakes import FakeAsyncTransport, FakeRpcError, FakeTransport

MiB = 1 << 20
ODD = b"caf\xe9-\xff.txt"  # Latin-1 bytes: not valid UTF-8


def entry(name=b"data.bin", path=b"/home/boxd/data.bin", **kw):
    kw.setdefault("type", api_pb2.FS_ENTRY_TYPE_FILE)
    kw.setdefault("target_type", kw["type"])
    return api_pb2.FsEntry(name=name, path=path, **kw)


def fs_error(reason, code=grpc.StatusCode.FAILED_PRECONDITION, details="it failed"):
    return from_grpc_error(FakeRpcError(code, details, reason=reason))


def read_chunks(*parts: bytes, eof=True, bytes_read=None):
    """What the server streams for a read: the entry, the data, the end."""
    chunks = [api_pb2.FsReadChunk(entry=entry())]
    chunks += [api_pb2.FsReadChunk(data=p) for p in parts]
    if eof:
        total = sum(map(len, parts)) if bytes_read is None else bytes_read
        chunks.append(api_pb2.FsReadChunk(eof=True, bytes_read=total))
    return chunks


# --- errors ---


@pytest.mark.parametrize(
    ("reason", "code", "cls", "builtin", "number"),
    [
        ("not_found", grpc.StatusCode.NOT_FOUND, MachineFileNotFoundError, FileNotFoundError, errno.ENOENT),
        ("permission_denied", grpc.StatusCode.PERMISSION_DENIED, MachinePermissionError, PermissionError, errno.EACCES),
        ("file_exists", grpc.StatusCode.ALREADY_EXISTS, MachineFileExistsError, FileExistsError, errno.EEXIST),
        ("is_a_directory", grpc.StatusCode.FAILED_PRECONDITION, MachineIsADirectoryError, IsADirectoryError, errno.EISDIR),
        ("not_a_directory", grpc.StatusCode.FAILED_PRECONDITION, MachineNotADirectoryError, NotADirectoryError, errno.ENOTDIR),
        ("directory_not_empty", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.ENOTEMPTY),
        ("not_a_regular_file", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, None),
        ("symlink_loop", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.ELOOP),
        ("name_too_long", grpc.StatusCode.INVALID_ARGUMENT, MachineFilesystemError, OSError, errno.ENAMETOOLONG),
        ("invalid_path", grpc.StatusCode.INVALID_ARGUMENT, MachineFilesystemError, OSError, errno.EINVAL),
        ("no_space", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.ENOSPC),
        ("read_only", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.EROFS),
        ("busy", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.EBUSY),
        ("cross_device", grpc.StatusCode.FAILED_PRECONDITION, MachineFilesystemError, OSError, errno.EXDEV),
        ("size_mismatch", grpc.StatusCode.ABORTED, MachineFilesystemError, OSError, None),
        ("io_error", grpc.StatusCode.INTERNAL, MachineFilesystemError, OSError, errno.EIO),
    ],
)
def test_every_reason_maps_to_its_class_and_errno(reason, code, cls, builtin, number):
    err = fs_error(reason, code, "what happened")
    assert type(err) is cls
    assert isinstance(err, builtin)
    assert isinstance(err, OSError) and isinstance(err, BoxdError)
    assert err.errno == number
    assert err.reason == reason
    assert err.code == code.name.lower()
    assert str(err) == "what happened"


def test_filesystem_errors_stay_in_their_sdk_family():
    # Code written against NotFoundError / PermissionDeniedError keeps working.
    assert isinstance(fs_error("not_found", grpc.StatusCode.NOT_FOUND), NotFoundError)
    assert isinstance(
        fs_error("permission_denied", grpc.StatusCode.PERMISSION_DENIED),
        PermissionDeniedError,
    )
    assert isinstance(fs_error("is_a_directory"), ConflictError)


def test_a_not_found_without_a_reason_is_the_machine_not_the_file():
    err = from_grpc_error(FakeRpcError(grpc.StatusCode.NOT_FOUND, "VM not found"))
    assert type(err) is NotFoundError
    assert not isinstance(err, OSError)


def test_an_outdated_agent_says_to_reboot_and_is_not_an_oserror():
    err = fs_error("agent_outdated", details="this machine's agent is too old")
    assert type(err) is MachineAgentOutdatedError
    assert isinstance(err, ConflictError)
    assert not isinstance(err, OSError)
    assert "reboot" in str(err)


def test_filesystem_errors_pickle():
    err = fs_error("not_found", grpc.StatusCode.NOT_FOUND, "no such file: /x")
    err.filename = "/x"
    back = pickle.loads(pickle.dumps(err))
    assert type(back) is MachineFileNotFoundError
    assert (back.message, back.reason, back.errno, back.filename) == (
        "no such file: /x",
        "not_found",
        errno.ENOENT,
        "/x",
    )


# --- read ---


def test_read_joins_the_data_and_sends_the_range():
    transport = FakeTransport([read_chunks(b"hel", b"lo")])
    data = Machines(transport).fs.read("alpha", "/tmp/x", offset=3, length=10)
    assert data == b"hello"
    method, request = transport.calls[0]
    assert method == "FsRead"
    assert (request.vm_id, request.path, request.offset, request.length) == (
        "alpha",
        b"/tmp/x",
        3,
        10,
    )


def test_read_without_a_length_reads_to_the_end():
    transport = FakeTransport([read_chunks(b"x")])
    Machines(transport).fs.read("alpha", "x")
    assert not transport.calls[0][1].HasField("length")


def test_an_empty_file_reads_as_empty():
    transport = FakeTransport([read_chunks()])
    assert Machines(transport).fs.read("alpha", "/empty") == b""


def test_a_read_cut_before_its_last_chunk_raises():
    transport = FakeTransport([read_chunks(b"partial", eof=False)])
    with pytest.raises(BoxdError, match="before the end of the file"):
        Machines(transport).fs.read("alpha", "/tmp/x")


def test_a_read_whose_count_disagrees_raises():
    transport = FakeTransport([read_chunks(b"abc", bytes_read=5)])
    with pytest.raises(BoxdError, match="incomplete"):
        Machines(transport).fs.read("alpha", "/tmp/x")


def test_read_stream_yields_chunks():
    transport = FakeTransport([read_chunks(b"a", b"b")])
    assert list(Machines(transport).fs.read_stream("alpha", "/x")) == [b"a", b"b"]


def test_a_failed_read_names_the_path():
    transport = FakeTransport([fs_error("is_a_directory")])
    with pytest.raises(IsADirectoryError) as info:
        Machines(transport).fs.read("alpha", "/home/boxd")
    assert info.value.filename == "/home/boxd"


async def test_async_read():
    transport = FakeAsyncTransport([read_chunks(b"hel", b"lo")])
    assert await AsyncMachines(transport).fs.read("alpha", "/tmp/x") == b"hello"


async def test_async_cut_read_raises():
    transport = FakeAsyncTransport([read_chunks(b"x", eof=False)])
    with pytest.raises(BoxdError, match="before the end"):
        await AsyncMachines(transport).fs.read("alpha", "/tmp/x")


# --- write ---


def write_response():
    return api_pb2.FsWriteResponse(bytes_written=4, entry=entry(mode=0o644))


def test_write_streams_1mib_chunks_with_the_header_first():
    transport = FakeTransport([write_response()])
    data = b"x" * (2 * MiB + 5)
    result = Machines(transport).fs.write("alpha", "/tmp/big", data, mode=0o600)
    method, request = transport.calls[0]
    assert method == "FsWrite"
    chunks = list(request)
    assert [len(c.data) for c in chunks] == [MiB, MiB, 5]
    first = chunks[0]
    assert (first.vm_id, first.path, first.mode, first.expected_size) == (
        "alpha",
        b"/tmp/big",
        0o600,
        len(data),
    )
    assert all(c.vm_id == "" and c.path == b"" for c in chunks[1:])
    assert all(not c.HasField("expected_size") for c in chunks[1:])
    assert b"".join(c.data for c in chunks) == data
    assert isinstance(result, FsEntry) and result.mode == 0o644


def test_write_encodes_str_as_utf8_and_leaves_mode_unset():
    transport = FakeTransport([write_response()])
    Machines(transport).fs.write("alpha", "/tmp/x", "héllo")
    (chunk,) = list(transport.calls[0][1])
    assert chunk.data == "héllo".encode()
    assert chunk.expected_size == len("héllo".encode())
    assert not chunk.HasField("mode")


def test_an_empty_file_is_one_chunk_with_no_data():
    transport = FakeTransport([write_response()])
    Machines(transport).fs.write("alpha", "/tmp/empty", b"")
    (chunk,) = list(transport.calls[0][1])
    assert (chunk.vm_id, chunk.path, chunk.data) == ("alpha", b"/tmp/empty", b"")
    assert chunk.HasField("expected_size") and chunk.expected_size == 0


def test_an_iterable_streams_without_an_expected_size():
    transport = FakeTransport([write_response()])
    pieces = [b"a" * (MiB + 1), b"", b"bc"]
    Machines(transport).fs.write("alpha", "/tmp/x", iter(pieces))
    chunks = list(transport.calls[0][1])
    assert not chunks[0].HasField("expected_size")
    assert [len(c.data) for c in chunks] == [MiB, 1, 2]
    assert b"".join(c.data for c in chunks) == b"".join(pieces)


def test_an_empty_iterable_still_sends_the_header():
    transport = FakeTransport([write_response()])
    Machines(transport).fs.write("alpha", "/tmp/x", [])
    (chunk,) = list(transport.calls[0][1])
    assert chunk.path == b"/tmp/x" and chunk.data == b""


def test_write_refuses_what_it_cant_send():
    with pytest.raises(TypeError, match="bytes, str or an iterable"):
        Machines(FakeTransport()).fs.write("alpha", "/tmp/x", 42)  # type: ignore[arg-type]

    async def gen():
        yield b"x"

    with pytest.raises(TypeError):
        Machines(FakeTransport()).fs.write("alpha", "/tmp/x", gen())  # type: ignore[arg-type]


def test_a_refused_write_raises_the_builtin():
    transport = FakeTransport(
        [fs_error("permission_denied", grpc.StatusCode.PERMISSION_DENIED)]
    )
    with pytest.raises(PermissionError) as info:
        Machines(transport).fs.write("alpha", "/etc/shadow", b"x")
    assert info.value.filename == "/etc/shadow"


async def test_async_write_takes_an_async_iterable():
    transport = FakeAsyncTransport([write_response()])

    async def pieces():
        yield b"ab"
        yield b"c"

    result = await AsyncMachines(transport).fs.write("alpha", "/tmp/x", pieces())
    chunks = [c async for c in transport.calls[0][1]]
    assert [c.data for c in chunks] == [b"ab", b"c"]
    assert chunks[0].path == b"/tmp/x"
    assert not chunks[0].HasField("expected_size")
    assert result.name == "data.bin"


async def test_async_write_of_bytes_sets_the_expected_size():
    transport = FakeAsyncTransport([write_response()])
    await AsyncMachines(transport).fs.write("alpha", "/tmp/x", b"abcd")
    (chunk,) = [c async for c in transport.calls[0][1]]
    assert chunk.expected_size == 4 and chunk.data == b"abcd"


# --- stat, exists ---


def test_stat_maps_the_entry():
    msg = entry(
        name=b"link",
        path=b"/home/boxd/link",
        type=api_pb2.FS_ENTRY_TYPE_SYMLINK,
        target_type=api_pb2.FS_ENTRY_TYPE_DIRECTORY,
        size=4096,
        mode=0o755,
        mtime_ns=1_700_000_000_123_456_789,
        uid=1000,
        gid=1000,
        symlink_target=b"target",
    )
    transport = FakeTransport([api_pb2.FsStatResponse(entry=msg)])
    got = Machines(transport).fs.stat("alpha", "/home/boxd/link")
    assert transport.calls[0] == (
        "FsStat",
        api_pb2.FsStatRequest(vm_id="alpha", path=b"/home/boxd/link"),
    )
    assert (got.name, got.path, got.type, got.target_type) == (
        "link",
        "/home/boxd/link",
        "symlink",
        "directory",
    )
    assert got.is_symlink and got.is_dir and not got.is_file
    assert (got.size, got.mode, got.uid, got.gid) == (4096, 0o755, 1000, 1000)
    assert got.symlink_target == "target"
    assert got.mtime == datetime(2023, 11, 14, 22, 13, 20, 123456, tzinfo=timezone.utc)


def test_a_dangling_symlink_has_no_target_type():
    msg = entry(type=api_pb2.FS_ENTRY_TYPE_SYMLINK, target_type=0, symlink_target=b"gone")
    got = Machines(FakeTransport([api_pb2.FsStatResponse(entry=msg)])).fs.stat("a", "l")
    assert got.target_type is None
    assert not got.is_dir and not got.is_file and got.is_symlink


def test_a_plain_file_has_no_symlink_target():
    got = Machines(FakeTransport([api_pb2.FsStatResponse(entry=entry())])).fs.stat("a", "f")
    assert got.symlink_target is None and got.is_file


def test_exists():
    found = api_pb2.FsStatResponse(entry=entry())
    dangling = api_pb2.FsStatResponse(
        entry=entry(type=api_pb2.FS_ENTRY_TYPE_SYMLINK, target_type=0)
    )
    transport = FakeTransport(
        [
            found,
            dangling,
            fs_error("not_found", grpc.StatusCode.NOT_FOUND),
            fs_error("not_a_directory"),
            fs_error("permission_denied", grpc.StatusCode.PERMISSION_DENIED),
        ]
    )
    fs = Machines(transport).fs
    assert fs.exists("alpha", "/file") is True
    assert fs.exists("alpha", "/dangling") is False
    assert fs.exists("alpha", "/missing") is False
    assert fs.exists("alpha", "/file/child") is False
    assert fs.exists("alpha", "/root/secret") is False


@pytest.mark.parametrize(
    ("error", "cls"),
    [
        (FakeRpcError(grpc.StatusCode.NOT_FOUND, "VM not found"), NotFoundError),
        (
            FakeRpcError(grpc.StatusCode.FAILED_PRECONDITION, "old", reason="agent_outdated"),
            MachineAgentOutdatedError,
        ),
        (FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "no"), AuthenticationError),
    ],
)
def test_exists_raises_when_it_cant_ask(error, cls):
    transport = FakeTransport([from_grpc_error(error)])
    with pytest.raises(cls):
        Machines(transport).fs.exists("gone", "/x")


async def test_async_exists():
    transport = FakeAsyncTransport(
        [api_pb2.FsStatResponse(entry=entry()), fs_error("not_found", grpc.StatusCode.NOT_FOUND)]
    )
    fs = AsyncMachines(transport).fs
    assert await fs.exists("alpha", "/file") is True
    assert await fs.exists("alpha", "/missing") is False


# --- list ---


def listing():
    return [
        api_pb2.FsListChunk(entries=[entry(name=b"a", path=b"/d/a"), entry(name=b"b", path=b"/d/b")]),
        api_pb2.FsListChunk(
            entries=[
                entry(
                    name=b"sub",
                    path=b"/d/sub",
                    type=api_pb2.FS_ENTRY_TYPE_DIRECTORY,
                )
            ]
        ),
    ]


def test_list_gathers_every_batch():
    transport = FakeTransport([listing()])
    entries = Machines(transport).fs.list("alpha", "/d")
    assert transport.calls[0] == ("FsList", api_pb2.FsListRequest(vm_id="alpha", path=b"/d"))
    assert [(e.name, e.path, e.is_dir) for e in entries] == [
        ("a", "/d/a", False),
        ("b", "/d/b", False),
        ("sub", "/d/sub", True),
    ]


def test_iter_list_is_lazy():
    transport = FakeTransport([listing()])
    it = Machines(transport).fs.iter_list("alpha", "/d")
    assert transport.calls == []
    assert next(it).name == "a"


def test_listing_a_file_raises_not_a_directory():
    transport = FakeTransport([fs_error("not_a_directory")])
    with pytest.raises(NotADirectoryError) as info:
        Machines(transport).fs.list("alpha", "/d/a")
    assert info.value.filename == "/d/a"


async def test_async_list():
    transport = FakeAsyncTransport([listing()])
    entries = await AsyncMachines(transport).fs.list("alpha", "/d")
    assert [e.name for e in entries] == ["a", "b", "sub"]


# --- mkdir, remove, rename, realpath ---


def test_mkdir_sends_the_mode_only_when_given():
    transport = FakeTransport([api_pb2.FsMkdirResponse(), api_pb2.FsMkdirResponse()])
    fs = Machines(transport).fs
    fs.mkdir("alpha", "/a/b")
    fs.mkdir("alpha", "/a/c", mode=0o700)
    first, second = (call[1] for call in transport.calls)
    assert first.path == b"/a/b" and not first.HasField("mode")
    assert second.mode == 0o700


def test_mkdir_over_a_file_raises_file_exists():
    transport = FakeTransport([fs_error("file_exists", grpc.StatusCode.ALREADY_EXISTS)])
    with pytest.raises(FileExistsError):
        Machines(transport).fs.mkdir("alpha", "/a/file")


def test_remove_is_not_recursive_unless_asked():
    transport = FakeTransport([api_pb2.FsRemoveResponse(), api_pb2.FsRemoveResponse()])
    fs = Machines(transport).fs
    fs.remove("alpha", "/f")
    fs.remove("alpha", "/tree", recursive=True)
    assert [call[1].recursive for call in transport.calls] == [False, True]
    assert transport.calls[0][0] == "FsRemove"


def test_rename_overwrites_by_default():
    transport = FakeTransport([api_pb2.FsRenameResponse(), api_pb2.FsRenameResponse()])
    fs = Machines(transport).fs
    fs.rename("alpha", "/a", "/b")
    fs.rename("alpha", "/a", "/c", overwrite=False)
    first, second = (call[1] for call in transport.calls)
    assert (first.old_path, first.new_path, first.no_replace) == (b"/a", b"/b", False)
    assert second.no_replace is True


def test_a_failed_rename_names_both_paths():
    transport = FakeTransport([fs_error("file_exists", grpc.StatusCode.ALREADY_EXISTS)])
    with pytest.raises(FileExistsError) as info:
        Machines(transport).fs.rename("alpha", "/a", "/b", overwrite=False)
    assert (info.value.filename, info.value.filename2) == ("/a", "/b")


def test_realpath():
    transport = FakeTransport([api_pb2.FsRealpathResponse(path=b"/home/boxd/target")])
    assert Machines(transport).fs.realpath("alpha", "link") == "/home/boxd/target"
    assert transport.calls[0] == (
        "FsRealpath",
        api_pb2.FsRealpathRequest(vm_id="alpha", path=b"link"),
    )


def test_a_symlink_loop_is_an_eloop_oserror():
    transport = FakeTransport([fs_error("symlink_loop")])
    with pytest.raises(OSError) as info:
        Machines(transport).fs.realpath("alpha", "/loop/q")
    assert info.value.errno == errno.ELOOP


async def test_async_mkdir_remove_rename_realpath():
    transport = FakeAsyncTransport(
        [
            api_pb2.FsMkdirResponse(),
            api_pb2.FsRemoveResponse(),
            api_pb2.FsRenameResponse(),
            api_pb2.FsRealpathResponse(path=b"/r"),
        ]
    )
    fs = AsyncMachines(transport).fs
    await fs.mkdir("alpha", "/d", mode=0o750)
    await fs.remove("alpha", "/d", recursive=True)
    await fs.rename("alpha", "/d", "/e", overwrite=False)
    assert await fs.realpath("alpha", "/e") == "/r"
    assert [m for m, _ in transport.calls] == ["FsMkdir", "FsRemove", "FsRename", "FsRealpath"]
    assert transport.calls[0][1].mode == 0o750
    assert transport.calls[1][1].recursive is True
    assert transport.calls[2][1].no_replace is True


# --- paths ---


def test_a_name_that_isnt_utf8_round_trips():
    msg = entry(name=ODD, path=b"/d/" + ODD)
    transport = FakeTransport([[api_pb2.FsListChunk(entries=[msg])], read_chunks(b"ok")])
    fs = Machines(transport).fs
    (listed,) = fs.list("alpha", "/d")
    # Still a str, with the odd bytes kept as surrogate escapes...
    assert isinstance(listed.name, str) and "\udce9" in listed.name
    # ...so handing it back reaches the very same bytes.
    assert fs.read("alpha", listed.path) == b"ok"
    assert transport.calls[1][1].path == b"/d/" + ODD


def test_paths_may_be_bytes_or_pathlike():
    transport = FakeTransport([api_pb2.FsStatResponse(entry=entry())] * 2)
    fs = Machines(transport).fs
    fs.stat("alpha", b"/d/" + ODD)
    fs.stat("alpha", PurePosixPath("/d/x"))
    assert [call[1].path for call in transport.calls] == [b"/d/" + ODD, b"/d/x"]


def test_a_path_must_be_a_path():
    with pytest.raises(TypeError):
        Machines(FakeTransport()).fs.stat("alpha", 7)  # type: ignore[arg-type]


def test_an_unknown_entry_type_is_other():
    got = Machines(FakeTransport([api_pb2.FsStatResponse(entry=entry(type=99, target_type=99))])).fs.stat("a", "x")
    assert (got.type, got.target_type) == ("other", "other")
