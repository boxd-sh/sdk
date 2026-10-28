"""gRPC transport: channel lifecycle, auth headers, retries, error mapping.

Two classes, one policy. Everything that decides *what* happens — the target,
the metadata, which failures are retryable, the backoff schedule — lives in
:class:`_TransportBase`; the subclasses only differ in how they wait.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable, Iterator

import grpc
import grpc.aio

from . import _version_check
from ._credentials import AsyncCredentials, SyncCredentials
from ._generated import api_pb2_grpc
from ._urls import DEFAULT_BASE_URL, console_base_url, resolve_endpoint
from .errors import APIConnectionError, BoxdError, from_grpc_error, is_retryable

# First backoff, doubled per attempt. Two retries by default ⇒ 0.5s then 1.0s.
_BACKOFF_BASE_SECS = 0.5

# grpcio defaults the receive limit to 4 MiB, which quietly caps
# ``machines.download()`` and any other large unary response. Lift both
# directions to 64 MiB — enough for realistic single-message file reads while
# still bounding memory. Larger transfers should use the streaming file path.
_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
_CHANNEL_OPTIONS = [
    ("grpc.max_receive_message_length", _MAX_MESSAGE_BYTES),
    ("grpc.max_send_message_length", _MAX_MESSAGE_BYTES),
]


class _TransportBase:
    def __init__(
        self,
        *,
        base_url: str | None,
        credentials,
        timeout: float,
        max_retries: int,
    ) -> None:
        self._explicit_base_url = base_url
        self._credentials = credentials
        self._timeout = timeout
        self._max_retries = max_retries
        self._channel = None
        self._stub: api_pb2_grpc.BoxdApiStub | None = None

    @property
    def base_url(self) -> str:
        """An explicit base URL wins; otherwise whatever the VM reported; else prod."""
        return (
            self._explicit_base_url
            or self._credentials.discovered_base_url
            or DEFAULT_BASE_URL
        )

    @property
    def console_origin(self) -> str:
        """The web console's origin for whichever cluster this client talks to.

        Derived from the same `base_url` the channel dials, so the two can
        never disagree. Note it cannot come from a machine's own
        `access.domain`: that may be the ORG's wildcard domain, and the
        console is never under it.
        """
        return console_base_url(self.base_url)

    def _build_channel(self, factory_secure, factory_insecure):
        endpoint = resolve_endpoint(self.base_url)
        if endpoint.use_tls:
            return factory_secure(
                endpoint.target,
                grpc.ssl_channel_credentials(),
                options=_CHANNEL_OPTIONS,
            )
        return factory_insecure(endpoint.target, options=_CHANNEL_OPTIONS)

    def _metadata(self, token: str) -> list[tuple[str, str]]:
        return [("authorization", f"Bearer {token}"), *_version_check.request_metadata()]

    def _backoff(self, attempt: int) -> float:
        return _BACKOFF_BASE_SECS * (2**attempt)

    def _should_retry(self, err: grpc.RpcError, attempt: int, request) -> bool:
        # `unauthenticated` is terminal: the key row is re-read on every request,
        # so a rejection means revoked, not stale. Retrying (or refreshing and
        # retrying) would spin against a dead credential.
        if attempt >= self._max_retries or not is_retryable(err):
            return False
        # Client-streaming requests arrive as a one-shot iterator — replaying
        # one would resume mid-stream, not restart it.
        return hasattr(request, "DESCRIPTOR")

    def _should_retry_credential(self, err: BoxdError, attempt: int) -> bool:
        # Getting the credential failed before the request was sent, so even a
        # streamed request is untouched. Same rule as the call: only failing to
        # reach the exchange or the metadata adapter is retried; a refused key,
        # a refusal (403) or an error answer is not.
        return attempt < self._max_retries and isinstance(err, APIConnectionError)


class SyncTransport(_TransportBase):
    """Blocking gRPC transport."""

    _credentials: SyncCredentials

    def _ensure_stub(self) -> api_pb2_grpc.BoxdApiStub:
        if self._stub is None:
            self._channel = self._build_channel(
                grpc.secure_channel, grpc.insecure_channel
            )
            self._stub = api_pb2_grpc.BoxdApiStub(self._channel)
        return self._stub

    def call(self, method: str, request):
        """Unary call with retries. Returns the response message."""
        attempt = 0
        while True:
            # Fetched per attempt so a refresh mid-backoff is picked up; the
            # token itself is cached, so this is free after the first call.
            try:
                token = self._credentials.token()
            except BoxdError as e:
                if self._should_retry_credential(e, attempt):
                    time.sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise
            stub = self._ensure_stub()
            try:
                response, call = getattr(stub, method).with_call(
                    request, timeout=self._timeout, metadata=self._metadata(token)
                )
            except grpc.RpcError as e:
                if self._should_retry(e, attempt, request):
                    time.sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise from_grpc_error(e) from e
            _version_check.note_metadata(call.initial_metadata())
            return response

    def server_stream(self, method: str, request) -> Iterator:
        """Server-streaming call. Never retried — a partial stream can't be replayed."""
        token = self._credentials.token()
        stub = self._ensure_stub()
        return _StreamCall(getattr(stub, method)(request, metadata=self._metadata(token)))

    def bidi(
        self, method: str, requests: Iterable, *, timeout: float | None = None
    ) -> Iterator:
        """Bidirectional-streaming call (`Exec`).

        `timeout` bounds the whole session, not one message, so it is left
        unset by default — an interactive shell is meant to outlive any
        per-request deadline.
        """
        token = self._credentials.token()
        stub = self._ensure_stub()
        return _StreamCall(
            getattr(stub, method)(
                requests, timeout=timeout, metadata=self._metadata(token)
            )
        )

    def close(self) -> None:
        if self._channel is not None:
            self._channel.close()
            self._channel = None
            self._stub = None


class AsyncTransport(_TransportBase):
    """Async gRPC transport — same policy, awaited."""

    _credentials: AsyncCredentials

    async def _ensure_stub(self) -> api_pb2_grpc.BoxdApiStub:
        if self._stub is None:
            self._channel = self._build_channel(
                grpc.aio.secure_channel, grpc.aio.insecure_channel
            )
            self._stub = api_pb2_grpc.BoxdApiStub(self._channel)
        return self._stub

    async def call(self, method: str, request):
        attempt = 0
        while True:
            try:
                token = await self._credentials.token()
            except BoxdError as e:
                if self._should_retry_credential(e, attempt):
                    await asyncio.sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise
            stub = await self._ensure_stub()
            call = getattr(stub, method)(
                request, timeout=self._timeout, metadata=self._metadata(token)
            )
            try:
                response = await call
            except grpc.aio.AioRpcError as e:
                if self._should_retry(e, attempt, request):
                    await asyncio.sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise from_grpc_error(e) from e
            _version_check.note_metadata(await call.initial_metadata())
            return response

    async def server_stream(self, method: str, request):
        token = await self._credentials.token()
        stub = await self._ensure_stub()
        return _AsyncStreamCall(getattr(stub, method)(request, metadata=self._metadata(token)))

    async def bidi(self, method: str, requests, *, timeout: float | None = None):
        token = await self._credentials.token()
        stub = await self._ensure_stub()
        return _AsyncStreamCall(
            getattr(stub, method)(
                requests, timeout=timeout, metadata=self._metadata(token)
            )
        )

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None
            self._stub = None


class _StreamCall:
    """A streaming call that re-raises gRPC errors as BoxdErrors, lazily.

    A class rather than a bare generator so `cancel()` stays reachable —
    `ExecStream.close()` uses it to tear down an abandoned RPC.
    """

    def __init__(self, call):
        self._call = call
        self._iter = self._translate()

    def _translate(self):
        try:
            for item in self._call:
                yield item
        except grpc.RpcError as e:
            raise from_grpc_error(e) from e

    def __iter__(self) -> Iterator:
        return self

    def __next__(self):
        return next(self._iter)

    def cancel(self):
        return self._call.cancel()


class _AsyncStreamCall:
    """Async twin of :class:`_StreamCall`."""

    def __init__(self, call):
        self._call = call
        self._iter = self._translate()

    async def _translate(self):
        try:
            async for item in self._call:
                yield item
        except grpc.aio.AioRpcError as e:
            raise from_grpc_error(e) from e

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self._iter.__anext__()

    def cancel(self):
        return self._call.cancel()


__all__ = ["AsyncTransport", "BoxdError", "SyncTransport"]
