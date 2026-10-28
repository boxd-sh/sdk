"""Interactive exec streams.

The one place a handle is unavoidable: a live bidi stream is genuinely
stateful. Everything else in the SDK returns plain data.

    with boxd.machines.stream_exec(id, command="bash", tty=True) as stream:
        stream.write(b"ls\\n")
        for chunk in stream:
            ...
        stream.exit_code
"""

from __future__ import annotations

import asyncio
import queue
from typing import NamedTuple

from ._generated import api_pb2
from ._requests import exec_chunk


class OutputChunk(NamedTuple):
    """One slice of output, tagged with the stream it came from.

    PTY execs merge stderr into stdout at the kernel level, so `is_stderr` is
    only ever True for non-PTY execs.
    """

    data: bytes
    is_stderr: bool


# Sentinel pushed onto the stdin queue to close the client half.
_EOF = object()


class ExecStream:
    """A live, interactive exec session (blocking)."""

    def __init__(self, transport, init: api_pb2.ExecChunk, *, close_stdin: bool = False):
        self._machine_id = init.vm_id
        self._stdin: queue.Queue = queue.Queue()
        self._exit_code: int | None = None
        self._closed = False
        self._call = transport.bidi("Exec", self._requests(init, close_stdin))

    def _requests(self, init: api_pb2.ExecChunk, close_stdin: bool):
        yield init
        if close_stdin:
            # Half-closing immediately makes the subprocess see stdin EOF at
            # once — headless commands (`jq`, `cat`, `claude -p`) would
            # otherwise sit blocked on it.
            return
        while True:
            item = self._stdin.get()
            if item is _EOF:
                return
            yield item

    # ── stdin ────────────────────────────────────────────────────

    def write(self, data: bytes | str) -> None:
        """Send data to the process's stdin."""
        if self._closed:
            raise RuntimeError("stream is closed")
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._stdin.put(exec_chunk(machine_id="", data=data, stdin=True))

    def write_eof(self) -> None:
        """Close the stdin half; the process sees EOF."""
        if not self._closed:
            self._closed = True
            self._stdin.put(_EOF)

    def resize(self, cols: int, rows: int) -> None:
        """Update PTY geometry mid-session (wire this to SIGWINCH)."""
        if self._closed:
            return
        self._stdin.put(
            exec_chunk(machine_id="", cols=cols, rows=rows, window_change=True)
        )

    # ── stdout / stderr ──────────────────────────────────────────

    def iter_chunks(self):
        """Iterate output tagged with its source stream."""
        for chunk in self._call:
            # Every chunk carries the exit code; the last one is the real one.
            self._exit_code = chunk.exit_code
            if chunk.data:
                yield OutputChunk(chunk.data, chunk.is_stderr)

    def __iter__(self):
        """Iterate merged output — what a terminal would show."""
        for chunk in self.iter_chunks():
            yield chunk.data

    @property
    def exit_code(self) -> int | None:
        """The process's exit code, or None until the stream is exhausted."""
        return self._exit_code

    def close(self) -> None:
        """Cancel the call.

        The server kills the remote process's whole process group (SIGTERM,
        then SIGKILL after a short grace period if it hasn't exited) rather
        than leaving it running with no one listening.
        """
        self.write_eof()
        cancel = getattr(self._call, "cancel", None)
        if cancel is not None:
            cancel()

    def __enter__(self) -> ExecStream:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()


class AsyncExecStream:
    """Async twin of :class:`ExecStream`.

        async with boxd.machines.stream_exec(id, command="bash", tty=True) as s:
            await s.write(b"ls\\n")
            async for chunk in s:
                ...
    """

    def __init__(self, transport, init: api_pb2.ExecChunk, *, close_stdin: bool = False):
        self._transport = transport
        self._init = init
        self._close_stdin = close_stdin
        self._stdin: asyncio.Queue = asyncio.Queue()
        self._exit_code: int | None = None
        self._closed = False
        self._call = None

    async def _start(self) -> None:
        if self._call is None:
            self._call = await self._transport.bidi("Exec", self._requests())

    async def _requests(self):
        yield self._init
        if self._close_stdin:
            return
        while True:
            item = await self._stdin.get()
            if item is _EOF:
                return
            yield item

    async def write(self, data: bytes | str) -> None:
        if self._closed:
            raise RuntimeError("stream is closed")
        if isinstance(data, str):
            data = data.encode("utf-8")
        await self._stdin.put(exec_chunk(machine_id="", data=data, stdin=True))

    async def write_eof(self) -> None:
        if not self._closed:
            self._closed = True
            await self._stdin.put(_EOF)

    async def resize(self, cols: int, rows: int) -> None:
        if self._closed:
            return
        await self._stdin.put(
            exec_chunk(machine_id="", cols=cols, rows=rows, window_change=True)
        )

    async def iter_chunks(self):
        await self._start()
        async for chunk in self._call:
            self._exit_code = chunk.exit_code
            if chunk.data:
                yield OutputChunk(chunk.data, chunk.is_stderr)

    async def __aiter__(self):
        async for chunk in self.iter_chunks():
            yield chunk.data

    @property
    def exit_code(self) -> int | None:
        return self._exit_code

    async def close(self) -> None:
        """Cancel the call.

        The server kills the remote process's whole process group (SIGTERM,
        then SIGKILL after a short grace period if it hasn't exited) rather
        than leaving it running with no one listening.
        """
        await self.write_eof()
        cancel = getattr(self._call, "cancel", None)
        if cancel is not None:
            cancel()

    async def __aenter__(self) -> AsyncExecStream:
        await self._start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()
