"""Test doubles: a transport that records calls and replays canned responses."""

from __future__ import annotations

import grpc


class FakeRpcError(grpc.RpcError):
    """A gRPC error with a chosen status, for the sync and aio paths alike.

    `reason` becomes the `x-boxd-error-reason` trailer the server names a
    filesystem failure in.
    """

    def __init__(
        self, code: grpc.StatusCode, details: str = "boom", *, reason: str | None = None
    ):
        self._code = code
        self._details = details
        self._trailers = (("x-boxd-error-reason", reason),) if reason else ()

    def code(self):
        return self._code

    def details(self):
        return self._details

    def trailing_metadata(self):
        return self._trailers


class FakeTransport:
    """Records `(method, request)` and returns queued responses.

    A queued item that is an exception is raised instead of returned.
    """

    def __init__(self, responses=None):
        self.calls: list[tuple[str, object]] = []
        self._responses = list(responses or [])

    @property
    def console_origin(self) -> str:
        """What a real client derives from its endpoint; `machines` fills
        `access.desktop_url` from it."""
        return "https://app.boxd.sh"

    def _next(self, method, request):
        self.calls.append((method, request))
        if not self._responses:
            return None
        item = self._responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def call(self, method, request):
        return self._next(method, request)

    def server_stream(self, method, request):
        return iter(self._next(method, request) or [])

    def bidi(self, method, requests, *, timeout=None):
        # Drain the request iterator so tests can assert on what was sent.
        self.sent = list(requests)
        self.bidi_timeout = timeout
        return iter(self._next(method, self.sent) or [])


class FakeAsyncTransport(FakeTransport):
    """Async twin — same recording, awaited."""

    async def call(self, method, request):
        return self._next(method, request)

    async def server_stream(self, method, request):
        items = self._next(method, request) or []

        async def gen():
            for item in items:
                yield item

        return gen()

    async def bidi(self, method, requests, *, timeout=None):
        self.sent = [chunk async for chunk in requests]
        self.bidi_timeout = timeout
        items = self._next(method, self.sent) or []

        async def gen():
            for item in items:
                yield item

        return gen()


class FakeCredentials:
    """Hands out a fixed token; never does I/O."""

    discovered_base_url = None

    def __init__(self, value: str = "jwt"):
        self.value = value
        self.fetches = 0

    def token(self):
        self.fetches += 1
        return self.value


class FakeAsyncCredentials(FakeCredentials):
    async def token(self):
        self.fetches += 1
        return self.value


class FakeMulticallable:
    """Stands in for a stub method: counts attempts, raises or returns."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.attempts = 0
        self.metadata_seen: list = []

    def _take(self, metadata):
        self.attempts += 1
        self.metadata_seen.append(list(metadata or []))
        item = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(item, BaseException):
            raise item
        return item

    def with_call(self, request, timeout=None, metadata=None):
        return self._take(metadata), FakeCall()

    def __call__(self, request, timeout=None, metadata=None):
        return self._take(metadata)


class FakeCall:
    def initial_metadata(self):
        return []


class FakeStub:
    """Maps method names onto :class:`FakeMulticallable`s."""

    def __init__(self, **methods):
        for name, value in methods.items():
            setattr(self, name, value)
