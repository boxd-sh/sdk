"""Retry policy, auth headers, and gRPC → BoxdError conversion."""

from __future__ import annotations

import socket
import threading
import time
from concurrent import futures

import grpc
import pytest

from boxd import _transport
from boxd._generated import api_pb2
from boxd._transport import AsyncTransport, SyncTransport
from boxd._version_check import REQ_HEADER
from boxd.errors import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    BoxdError,
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    from_grpc_error,
    is_retryable,
)
from fakes import (
    FakeAsyncCredentials,
    FakeCredentials,
    FakeMulticallable,
    FakeRpcError,
    FakeStub,
)

REQUEST = api_pb2.GetVmRequest(vm_id="vm-1")


def transport(outcomes, *, max_retries=2, monkeypatch=None):
    """A SyncTransport whose stub is a scripted fake."""
    method = FakeMulticallable(outcomes)
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=max_retries,
    )
    t._stub = FakeStub(GetVm=method)
    if monkeypatch is not None:
        monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    return t, method


# --- the retry rule ---


def test_unauthenticated_is_terminal(monkeypatch):
    # An API-key session re-reads the key on every request, so a rejection
    # means revoked. Retrying (or refreshing and retrying) would spin.
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.UNAUTHENTICATED)] * 3, monkeypatch=monkeypatch
    )
    with pytest.raises(AuthenticationError):
        t.call("GetVm", REQUEST)
    assert method.attempts == 1


def test_unauthenticated_does_not_re_fetch_the_credential(monkeypatch):
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.UNAUTHENTICATED)], monkeypatch=monkeypatch
    )
    with pytest.raises(AuthenticationError):
        t.call("GetVm", REQUEST)
    assert t._credentials.fetches == 1


def test_unavailable_is_retried_up_to_max_retries(monkeypatch):
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.UNAVAILABLE)] * 5, monkeypatch=monkeypatch
    )
    with pytest.raises(APIConnectionError):
        t.call("GetVm", REQUEST)
    assert method.attempts == 3  # 1 try + 2 retries


def test_unavailable_then_success(monkeypatch):
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.UNAVAILABLE), response], monkeypatch=monkeypatch
    )
    assert t.call("GetVm", REQUEST) is response
    assert method.attempts == 2


def test_max_retries_zero_disables_retrying(monkeypatch):
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.UNAVAILABLE)] * 3,
        max_retries=0,
        monkeypatch=monkeypatch,
    )
    with pytest.raises(APIConnectionError):
        t.call("GetVm", REQUEST)
    assert method.attempts == 1


def test_deadline_exceeded_is_never_retried(monkeypatch):
    # The server may already have applied the mutation.
    t, method = transport(
        [FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED)] * 3, monkeypatch=monkeypatch
    )
    with pytest.raises(APIStatusError):
        t.call("GetVm", REQUEST)
    assert method.attempts == 1


@pytest.mark.parametrize(
    "code",
    [
        grpc.StatusCode.NOT_FOUND,
        grpc.StatusCode.ALREADY_EXISTS,
        grpc.StatusCode.INVALID_ARGUMENT,
        grpc.StatusCode.PERMISSION_DENIED,
        grpc.StatusCode.RESOURCE_EXHAUSTED,
        grpc.StatusCode.ABORTED,
        grpc.StatusCode.INTERNAL,
    ],
)
def test_other_statuses_are_not_retried(code, monkeypatch):
    t, method = transport([FakeRpcError(code)] * 3, monkeypatch=monkeypatch)
    with pytest.raises(BoxdError):
        t.call("GetVm", REQUEST)
    assert method.attempts == 1


def test_streamed_request_is_not_replayed(monkeypatch):
    # A one-shot iterator would resume mid-stream, not restart.
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    method = FakeMulticallable([FakeRpcError(grpc.StatusCode.UNAVAILABLE)] * 3)
    t._stub = FakeStub(UploadFileStream=method)
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    with pytest.raises(APIConnectionError):
        t.call("UploadFileStream", iter([]))
    assert method.attempts == 1


def test_backoff_is_exponential():
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=3,
    )
    assert t._backoff(0) < t._backoff(1) < t._backoff(2)
    assert t._backoff(1) == 2 * t._backoff(0)


# --- metadata ---


def test_bearer_token_and_version_header_are_sent():
    t, method = transport([api_pb2.GetVmResponse()])
    t.call("GetVm", REQUEST)
    sent = dict(method.metadata_seen[0])
    assert sent["authorization"] == "Bearer jwt"
    assert REQ_HEADER in sent


# --- base URL resolution through the transport ---


def test_explicit_base_url_wins_over_the_discovered_one():
    credentials = FakeCredentials()
    credentials.discovered_base_url = "http://staging.example.com:9443"
    t = SyncTransport(
        base_url="http://explicit:9443",
        credentials=credentials,
        timeout=1.0,
        max_retries=2,
    )
    assert t.base_url == "http://explicit:9443"


def test_discovered_base_url_is_used_when_none_was_given():
    credentials = FakeCredentials()
    credentials.discovered_base_url = "http://staging.example.com:9443"
    t = SyncTransport(
        base_url=None, credentials=credentials, timeout=1.0, max_retries=2
    )
    assert t.base_url == "http://staging.example.com:9443"


def test_production_is_the_last_resort():
    t = SyncTransport(
        base_url=None, credentials=FakeCredentials(), timeout=1.0, max_retries=2
    )
    assert t.base_url == "https://boxd.sh:9443"


# --- error mapping ---


@pytest.mark.parametrize(
    ("code", "cls"),
    [
        (grpc.StatusCode.UNAUTHENTICATED, AuthenticationError),
        (grpc.StatusCode.PERMISSION_DENIED, PermissionDeniedError),
        (grpc.StatusCode.NOT_FOUND, NotFoundError),
        (grpc.StatusCode.ALREADY_EXISTS, ConflictError),
        (grpc.StatusCode.FAILED_PRECONDITION, ConflictError),
        # e.g. update_spec when the spec changed while it was applied.
        (grpc.StatusCode.ABORTED, ConflictError),
        (grpc.StatusCode.RESOURCE_EXHAUSTED, RateLimitError),
        (grpc.StatusCode.UNAVAILABLE, APIConnectionError),
        (grpc.StatusCode.INTERNAL, APIStatusError),
        (grpc.StatusCode.INVALID_ARGUMENT, APIStatusError),
        (grpc.StatusCode.DEADLINE_EXCEEDED, APIStatusError),
    ],
)
def test_status_maps_to_exception(code, cls):
    err = from_grpc_error(FakeRpcError(code, "detail text"))
    assert isinstance(err, cls)
    assert isinstance(err, BoxdError)
    assert err.message == "detail text"
    assert err.code == code.name.lower()
    assert err.http_status is None


def test_a_refused_token_says_so_in_its_reason():
    err = from_grpc_error(FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "invalid token: x"))
    assert type(err) is AuthenticationError
    assert err.code == "unauthenticated"
    assert err.reason == "invalid_token"


def test_other_statuses_carry_no_reason_unless_the_server_sends_one():
    assert from_grpc_error(FakeRpcError(grpc.StatusCode.NOT_FOUND)).reason is None
    err = from_grpc_error(
        FakeRpcError(grpc.StatusCode.FAILED_PRECONDITION, reason="some_future_reason")
    )
    assert type(err) is ConflictError
    assert err.reason == "some_future_reason"


def test_only_unavailable_is_retryable():
    assert is_retryable(FakeRpcError(grpc.StatusCode.UNAVAILABLE))
    assert not is_retryable(FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED))
    assert not is_retryable(FakeRpcError(grpc.StatusCode.ABORTED))
    assert not is_retryable(FakeRpcError(grpc.StatusCode.UNAUTHENTICATED))


# --- async twin ---


class FakeAioCall:
    def __init__(self, outcome):
        self._outcome = outcome

    def __await__(self):
        async def run():
            if isinstance(self._outcome, BaseException):
                raise self._outcome
            return self._outcome

        return run().__await__()

    async def initial_metadata(self):
        return []


class FakeAioMulticallable:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.attempts = 0

    def __call__(self, request, timeout=None, metadata=None):
        self.attempts += 1
        return FakeAioCall(self.outcomes.pop(0) if self.outcomes else None)


def async_transport(outcomes, *, max_retries=2):
    method = FakeAioMulticallable(outcomes)
    t = AsyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeAsyncCredentials(),
        timeout=1.0,
        max_retries=max_retries,
    )
    t._stub = FakeStub(GetVm=method)
    return t, method


class AioError(grpc.aio.AioRpcError):
    def __init__(self, code):
        super().__init__(
            code=code,
            initial_metadata=grpc.aio.Metadata(),
            trailing_metadata=grpc.aio.Metadata(),
            details="boom",
        )


async def test_async_unauthenticated_is_terminal(monkeypatch):
    monkeypatch.setattr("boxd._transport.asyncio.sleep", _no_sleep)
    t, method = async_transport([AioError(grpc.StatusCode.UNAUTHENTICATED)] * 3)
    with pytest.raises(AuthenticationError):
        await t.call("GetVm", REQUEST)
    assert method.attempts == 1


async def test_async_unavailable_is_retried(monkeypatch):
    monkeypatch.setattr("boxd._transport.asyncio.sleep", _no_sleep)
    t, method = async_transport([AioError(grpc.StatusCode.UNAVAILABLE)] * 5)
    with pytest.raises(APIConnectionError):
        await t.call("GetVm", REQUEST)
    assert method.attempts == 3


async def _no_sleep(_seconds):
    return None


# --- stream wrapping ---


class FakeStreamCall:
    """A sync stream call that errors mid-stream and records cancel()."""

    def __init__(self, items, error=None):
        self._items = list(items)
        self._error = error
        self.cancelled = False

    def cancel(self):
        self.cancelled = True
        return True

    def __iter__(self):
        yield from self._items
        if self._error is not None:
            raise self._error


class FakeAioStreamCall(FakeStreamCall):
    async def __aiter__(self):
        for item in self._items:
            yield item
        if self._error is not None:
            raise self._error


async def test_async_bidi_stream_errors_surface_as_boxd_errors():
    # The regression: before the wrap, these escaped as raw AioRpcError and
    # blew through callers' `except BoxdError` retry loops.
    call = FakeAioStreamCall(
        [api_pb2.ExecChunk(data=b"out")], AioError(grpc.StatusCode.NOT_FOUND)
    )
    t = AsyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeAsyncCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    t._stub = FakeStub(Exec=lambda requests, timeout=None, metadata=None: call)

    async def requests():
        yield api_pb2.ExecChunk(vm_id="vm-1", command="echo hi")

    stream = await t.bidi("Exec", requests())
    got = []
    with pytest.raises(NotFoundError):
        async for chunk in stream:
            got.append(chunk.data)
    assert got == [b"out"]
    stream.cancel()
    assert call.cancelled


def test_sync_bidi_cancel_reaches_the_underlying_call():
    # ExecStream.close() cancels via getattr; the wrapper must not hide it.
    call = FakeStreamCall([api_pb2.ExecChunk(data=b"out")])
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    t._stub = FakeStub(Exec=lambda requests, timeout=None, metadata=None: call)
    stream = t.bidi("Exec", iter([api_pb2.ExecChunk(vm_id="vm-1")]))
    assert [chunk.data for chunk in stream] == [b"out"]
    stream.cancel()
    assert call.cancelled


# --- getting the credential goes through the same retry rule ---


class ScriptedCredentials(FakeCredentials):
    """Raises each scripted error in turn, then hands out a token."""

    discovered_base_url = None

    def __init__(self, errors):
        self.errors = list(errors)
        self.fetches = 0

    def token(self):
        self.fetches += 1
        if self.errors:
            raise self.errors.pop(0)
        return "jwt"


class ScriptedAsyncCredentials(ScriptedCredentials):
    async def token(self):
        return ScriptedCredentials.token(self)


def test_unreachable_credential_source_is_retried(monkeypatch):
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    t, method = transport([response], monkeypatch=monkeypatch)
    t._credentials = ScriptedCredentials([APIConnectionError("could not reach")] * 2)
    assert t.call("GetVm", REQUEST) is response
    assert t._credentials.fetches == 3
    assert method.attempts == 1


def test_unreachable_credential_source_gives_up_after_max_retries(monkeypatch):
    t, method = transport([], monkeypatch=monkeypatch)
    t._credentials = ScriptedCredentials([APIConnectionError("could not reach")] * 5)
    with pytest.raises(APIConnectionError):
        t.call("GetVm", REQUEST)
    assert t._credentials.fetches == 3  # 1 try + 2 retries
    assert method.attempts == 0


@pytest.mark.parametrize(
    "err",
    [
        AuthenticationError("bad key", reason="invalid_api_key"),
        PermissionDeniedError("refused"),
        APIStatusError("exchange failed: 500"),
        RateLimitError("slow down"),
    ],
)
def test_credential_refusals_and_answers_are_not_retried(err, monkeypatch):
    t, method = transport([], monkeypatch=monkeypatch)
    t._credentials = ScriptedCredentials([err] * 3)
    with pytest.raises(type(err)):
        t.call("GetVm", REQUEST)
    assert t._credentials.fetches == 1
    assert method.attempts == 0


async def test_async_unreachable_credential_source_is_retried(monkeypatch):
    monkeypatch.setattr("boxd._transport.asyncio.sleep", _no_sleep)
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    t, method = async_transport([response])
    t._credentials = ScriptedAsyncCredentials([APIConnectionError("could not reach")])
    assert await t.call("GetVm", REQUEST) is response
    assert t._credentials.fetches == 2


async def test_async_credential_refusal_is_not_retried(monkeypatch):
    monkeypatch.setattr("boxd._transport.asyncio.sleep", _no_sleep)
    t, method = async_transport([])
    t._credentials = ScriptedAsyncCredentials(
        [AuthenticationError("bad key", reason="invalid_api_key")] * 3
    )
    with pytest.raises(AuthenticationError):
        await t.call("GetVm", REQUEST)
    assert t._credentials.fetches == 1


# --- keepalive: a path that dies without a word ---

KEEPALIVE = {
    "grpc.keepalive_time_ms": 45_000,
    "grpc.keepalive_timeout_ms": 20_000,
    "grpc.http2.ping_timeout_ms": 20_000,
    "grpc.http2.max_pings_without_data": 0,
}


class RecordedChannel:
    """Takes the stub's method registrations; no call is made on it."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def recording(made):
    def factory(target, *credentials, options):
        made.append(dict(options))
        return RecordedChannel()

    return factory


CHANNELS = [
    ("http://localhost:9443", "insecure_channel"),
    ("https://boxd.example.com:9443", "secure_channel"),
]


@pytest.mark.parametrize("base_url, factory", CHANNELS)
def test_the_channel_is_made_with_keepalive(monkeypatch, base_url, factory):
    made: list = []
    monkeypatch.setattr(grpc, factory, recording(made))
    t = SyncTransport(
        base_url=base_url, credentials=FakeCredentials(), timeout=1.0, max_retries=0
    )
    t._ensure_stub()
    assert len(made) == 1
    assert KEEPALIVE.items() <= made[0].items()
    # The larger messages are still asked for.
    assert made[0]["grpc.max_receive_message_length"] == 64 * 1024 * 1024


@pytest.mark.parametrize("base_url, factory", CHANNELS)
async def test_the_async_channel_is_made_with_keepalive(monkeypatch, base_url, factory):
    made: list = []
    monkeypatch.setattr(grpc.aio, factory, recording(made))
    t = AsyncTransport(
        base_url=base_url, credentials=FakeAsyncCredentials(), timeout=1.0, max_retries=0
    )
    await t._ensure_stub()
    assert len(made) == 1
    assert KEEPALIVE.items() <= made[0].items()


class SilentRelay:
    """A TCP relay to a local port that can go silent: nothing more passes
    either way, and nothing is closed (no FIN, no RST), as when a NAT drops
    an idle connection. It counts the client's HTTP/2 PINGs and the server's
    answers to them."""

    PREFACE = len(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")

    def __init__(self, port):
        self._upstream = port
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen()
        self.port = self._listener.getsockname()[1]
        self._silent = threading.Event()
        self._sockets = [self._listener]
        self.pings = 0
        self.answered = 0
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                client, _ = self._listener.accept()
                server = socket.create_connection(("127.0.0.1", self._upstream))
            except OSError:
                return
            self._sockets += [client, server]
            for src, dst, from_client in ((client, server, True), (server, client, False)):
                threading.Thread(
                    target=self._pump, args=(src, dst, from_client), daemon=True
                ).start()

    def _pump(self, src, dst, from_client):
        buffered, skip = b"", self.PREFACE if from_client else 0
        while True:
            try:
                data = src.recv(65536)
                if not data:
                    return
                if not self._silent.is_set():
                    dst.sendall(data)
            except OSError:
                return
            # Frames: a 9-byte header (length, type, flags, stream), then the
            # payload. A PING is type 6; flag 1 marks the answer to one.
            buffered += data
            while len(buffered) >= skip + 9:
                length = int.from_bytes(buffered[skip : skip + 3], "big")
                if len(buffered) < skip + 9 + length:
                    break
                if buffered[skip + 3] == 6:
                    answer = buffered[skip + 4] & 1
                    if from_client and not answer:
                        self.pings += 1
                    elif not from_client and answer:
                        self.answered += 1
                buffered, skip = buffered[skip + 9 + length :], 0

    def silence(self):
        self._silent.set()

    def close(self):
        for sock in self._sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)  # ends a read that is waiting
            except OSError:
                pass
            sock.close()


def quiet_events_server():
    """A gRPC server on a local port whose AgentEvents carries one event and
    then nothing, until `release` is set."""
    release = threading.Event()

    def events(request, context):
        yield api_pb2.AgentEvent(seq=1, turn=1, turn_started=api_pb2.AgentTurnStarted())
        release.wait()

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=2),
        handlers=[
            grpc.method_handlers_generic_handler(
                "boxd.api.v1.BoxdApi",
                {
                    "AgentEvents": grpc.unary_stream_rpc_method_handler(
                        events,
                        request_deserializer=api_pb2.AgentEventsRequest.FromString,
                        response_serializer=api_pb2.AgentEvent.SerializeToString,
                    )
                },
            )
        ],
        # gRPC's own server refuses a client that pings every second; the
        # platform's answers every PING.
        options=[
            ("grpc.http2.min_ping_interval_without_data_ms", 100),
            ("grpc.http2.max_ping_strikes", 0),
        ],
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    return server, port, release


def test_a_quiet_stream_on_a_path_that_dies_silently_fails_instead_of_hanging(monkeypatch):
    # gRPC sends PINGs a second apart at least, so this takes about 3 s.
    options = dict(_transport._CHANNEL_OPTIONS)
    assert KEEPALIVE.items() <= options.items()
    options.update(
        {
            "grpc.keepalive_time_ms": 1000,
            "grpc.keepalive_timeout_ms": 1000,
            "grpc.http2.ping_timeout_ms": 1000,
            # Whatever proxy the environment names, 127.0.0.1 is dialled.
            "grpc.enable_http_proxy": 0,
        }
    )
    monkeypatch.setattr(_transport, "_CHANNEL_OPTIONS", list(options.items()))
    server, port, release = quiet_events_server()
    relay = SilentRelay(port)
    t = SyncTransport(
        base_url=f"http://127.0.0.1:{relay.port}",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=0,
    )
    try:
        stream = t.server_stream(
            "AgentEvents",
            api_pb2.AgentEventsRequest(vm_id="box", session_id="s-1", follow=True),
        )
        assert next(stream).seq == 1
        # Quiet from here on. The first PING belongs to the stream's start;
        # the path dies once a keepalive PING has been answered too.
        deadline = time.monotonic() + 15
        while relay.answered < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert relay.answered >= 2
        relay.silence()
        ended: list = []

        def read():
            try:
                ended.append(next(stream))
            except BaseException as e:  # noqa: BLE001 - handed to the test
                ended.append(e)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(15)
        assert not reader.is_alive(), "the stream is still waiting on the dead path"
        assert isinstance(ended[0], APIConnectionError), ended[0]
        # What ended it: a PING sent into the dead path, never answered.
        assert relay.pings > relay.answered
    finally:
        release.set()
        t.close()
        relay.close()
        server.stop(0)
