"""Interactive exec streams — the one stateful handle in the SDK."""

from __future__ import annotations

import pytest

from boxd._generated import api_pb2
from boxd._streaming import AsyncExecStream, ExecStream
from boxd.resources.machines import AsyncMachines, Machines
from fakes import FakeAsyncTransport, FakeTransport


class ScriptedTransport:
    """Yields canned output chunks; keeps the stdin generator reachable."""

    def __init__(self, outputs):
        self.outputs = outputs
        self.requests = None

    def bidi(self, method, requests):
        self.method = method
        self.requests = requests
        # The first chunk (the command) is consumed eagerly, as the real
        # transport would.
        self.init = next(requests)
        return iter(self.outputs)


def test_stream_yields_merged_output_and_the_exit_code():
    transport = ScriptedTransport(
        [
            api_pb2.ExecChunk(data=b"out"),
            api_pb2.ExecChunk(data=b"err", is_stderr=True),
            api_pb2.ExecChunk(exit_code=7),
        ]
    )
    stream = ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1", command="bash"))
    assert stream.exit_code is None
    assert list(stream) == [b"out", b"err"]
    assert stream.exit_code == 7


def test_iter_chunks_tags_stderr():
    transport = ScriptedTransport(
        [api_pb2.ExecChunk(data=b"out"), api_pb2.ExecChunk(data=b"err", is_stderr=True)]
    )
    stream = ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1"))
    tagged = list(stream.iter_chunks())
    assert [(c.data, c.is_stderr) for c in tagged] == [(b"out", False), (b"err", True)]


def test_write_queues_a_stdin_chunk():
    transport = ScriptedTransport([])
    stream = ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1", command="bash"))
    stream.write("ls\n")
    stream.write_eof()
    queued = list(transport.requests)
    assert queued[0].stdin is True
    assert queued[0].data == b"ls\n"


def test_resize_queues_a_window_change():
    transport = ScriptedTransport([])
    stream = ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1"))
    stream.resize(120, 40)
    stream.write_eof()
    queued = list(transport.requests)
    assert queued[0].window_change is True
    assert (queued[0].cols, queued[0].rows) == (120, 40)


def test_close_stdin_half_closes_immediately():
    transport = ScriptedTransport([])
    ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1"), close_stdin=True)
    # Nothing after the init chunk — the process sees EOF at once.
    assert list(transport.requests) == []


def test_writing_after_eof_is_refused():
    transport = ScriptedTransport([])
    stream = ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1"))
    stream.write_eof()
    with pytest.raises(RuntimeError, match="closed"):
        stream.write(b"x")


def test_context_manager_closes_the_stream():
    transport = ScriptedTransport([api_pb2.ExecChunk(data=b"x", exit_code=0)])
    with ExecStream(transport, api_pb2.ExecChunk(vm_id="vm-1")) as stream:
        assert list(stream) == [b"x"]
    assert stream._closed is True


def test_stream_exec_builds_the_init_chunk():
    transport = ScriptedTransport([])
    stream = Machines(transport).stream_exec(
        "alpha", command="bash", tty=True, cols=100, rows=30
    )
    assert isinstance(stream, ExecStream)
    assert transport.init.vm_id == "alpha"
    assert transport.init.command == "bash"
    assert transport.init.tty is True
    assert (transport.init.cols, transport.init.rows) == (100, 30)


def test_stream_exec_rejects_close_stdin_with_a_tty():
    transport = FakeTransport([])
    with pytest.raises(ValueError, match="incompatible"):
        Machines(transport).stream_exec("alpha", command="bash", tty=True, close_stdin=True)


# --- async twin ---


async def test_async_stream_yields_output_and_exit_code():
    transport = FakeAsyncTransport(
        [[api_pb2.ExecChunk(data=b"out"), api_pb2.ExecChunk(exit_code=0)]]
    )
    stream = AsyncMachines(transport).stream_exec("alpha", command="bash")
    assert isinstance(stream, AsyncExecStream)
    await stream.write_eof()
    chunks = [chunk async for chunk in stream]
    assert chunks == [b"out"]
    assert stream.exit_code == 0


async def test_async_stream_context_manager():
    transport = FakeAsyncTransport([[api_pb2.ExecChunk(exit_code=0)]])
    stream = AsyncMachines(transport).stream_exec("alpha", command="true", close_stdin=True)
    async with stream:
        assert [chunk async for chunk in stream] == []
    assert stream.exit_code == 0
