"""Credential resolution: explicit token, API-key exchange, or in-VM metadata.

The gRPC API accepts exactly one credential — ``Authorization: Bearer <JWT>``.
A ``bxd_`` key is never sent to :9443. Everything here exists to obtain a JWT
and keep it fresh.

Resolution order, first match wins:

1. explicit ``token``           — used as-is, never refreshed
2. explicit ``api_key``         — exchanged for a JWT
3. ``BOXD_TOKEN``, then ``BOXD_API_KEY`` — same handling
4. in-VM metadata adapter       — no credentials required
5. otherwise :class:`AuthenticationError` (reason ``"missing_credentials"``)

Steps 4 and 5 need I/O, so the decision lands on the first request rather than
in ``__init__``: constructing a client never blocks on a network probe.
"""

from __future__ import annotations

import asyncio
import os
import socket
import time
from typing import Any

import httpx

from .errors import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)

# The in-VM metadata adapter listens on the VM's default gateway.
METADATA_PORT = 9002
METADATA_TOKEN_PATH = "/v1/auth/token"
# Proxy-minted, HMAC-signed identity token exposed to every guest process by
# takeoff. Forwarded verbatim so the worker attributes the call to the acting
# user rather than the VM owner.

# Re-exchange an API-key JWT this long before it expires.
EXCHANGE_SKEW_SECS = 300
# In-VM tokens live ~15 min and cannot be refreshed — they are re-minted, so a
# smaller margin is enough (and avoids burning a mint every call).
VM_TOKEN_SKEW_SECS = 60

_PROBE_TIMEOUT_SECS = 0.5
_HTTP_TIMEOUT_SECS = 10.0

_NO_CREDENTIALS = (
    "no credentials: pass api_key= or token=, set BOXD_API_KEY / BOXD_TOKEN, "
    "or run inside a boxd VM"
)
# The environment says "machine" and there is a gateway, but nothing answered
# on it. An isolated machine looks exactly like this (it keeps the hints but
# has no metadata adapter), and so does an adapter outage: there is no telling
# them apart from here, so this stays terminal and says what to do instead.
_ADAPTER_SILENT = (
    "no credentials: the machine's metadata adapter at {url} did not answer "
    "(isolated machines have none); pass api_key= or token=, or set "
    "BOXD_API_KEY / BOXD_TOKEN"
)


# ── In-VM detection ──────────────────────────────────────────────────


def detect_gateway() -> str | None:
    """Read the default gateway from ``/proc/net/route``.

    Same approach as the in-VM `boxd` CLI: the gateway column of the
    default route is a hex-encoded little-endian IPv4 address.
    """
    try:
        with open("/proc/net/route") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    for line in lines[1:]:
        fields = line.split()
        # Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
        if len(fields) >= 3 and fields[1] == "00000000":
            try:
                ip = int(fields[2], 16)
            except ValueError:
                return None
            return f"{ip & 0xFF}.{(ip >> 8) & 0xFF}.{(ip >> 16) & 0xFF}.{(ip >> 24) & 0xFF}"
    return None


# Only a hint: it skips the probe in the common case of running on a laptop.
# Deliberately permissive — which of these a shell actually has depends on how
# the session was opened and on how old the machine is, so gating on any single
# one silently disables in-VM auth on machines that are otherwise fine. The
# metadata probe is the real test: nothing outside a boxd machine answers it.
_VM_HINTS = ("BOXD_VM_ID", "BOXD_VM_NAME", "BOXD_PROXY_ENDPOINT")


def looks_like_a_machine() -> bool:
    """True when the environment hints we may be inside a boxd machine."""
    return any(os.environ.get(v) for v in _VM_HINTS)




def probe(host: str, port: int, timeout: float = _PROBE_TIMEOUT_SECS) -> bool:
    """True if something accepts a TCP connection on ``host:port``."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def probe_async(host: str, port: int, timeout: float = _PROBE_TIMEOUT_SECS) -> bool:
    """Async twin of :func:`probe`."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


def _missing(message: str) -> AuthenticationError:
    return AuthenticationError(
        message, code="unauthenticated", reason="missing_credentials"
    )


def metadata_base(
    not_inside: str = _NO_CREDENTIALS, silent: str = _ADAPTER_SILENT
) -> str:
    """The in-VM metadata adapter's base URL, or ``AuthenticationError``
    (reason ``"missing_credentials"``) when there is none to use. Detection
    needs BOTH signals, the environment hint and a live probe — neither alone
    is sufficient.

    The message is ``not_inside`` when this doesn't look like a machine, and
    ``silent`` (formatted with ``url``) when it does but the adapter didn't
    answer. Nothing is cached: the next call probes again."""
    if not looks_like_a_machine():
        raise _missing(not_inside)
    gateway = detect_gateway()
    if not gateway:
        raise _missing(not_inside)
    base = f"http://{gateway}:{METADATA_PORT}"
    if not probe(gateway, METADATA_PORT):
        raise _missing(silent.format(url=base))
    return base


async def metadata_base_async(
    not_inside: str = _NO_CREDENTIALS, silent: str = _ADAPTER_SILENT
) -> str:
    """Async twin of :func:`metadata_base`."""
    if not looks_like_a_machine():
        raise _missing(not_inside)
    gateway = detect_gateway()
    if not gateway:
        raise _missing(not_inside)
    base = f"http://{gateway}:{METADATA_PORT}"
    if not await probe_async(gateway, METADATA_PORT):
        raise _missing(silent.format(url=base))
    return base


# ── Response parsing (shared by both clients) ────────────────────────


def parse_exchange(status_code: int, body: str, json: Any) -> tuple[str, float]:
    """Validate an API-key exchange response → ``(token, expires_at)``.

    Only a 401 means the key itself was refused. An account that can't use
    the API is a 403; anything else the exchange answers is its own failure,
    not the key's.
    """
    if status_code == 401:
        raise AuthenticationError(
            "invalid or expired API key",
            code="unauthenticated",
            reason="invalid_api_key",
            http_status=status_code,
        )
    if status_code == 429:
        raise RateLimitError(
            "token exchange rate limit exceeded"
            + (f": {body}" if body else "")
            + " — a token is valid for 1 hour; reuse one across your workers",
            code="resource_exhausted",
            http_status=status_code,
        )
    if status_code == 403:
        raise PermissionDeniedError(
            f"API key refused: {body}" if body else "API key refused",
            code="permission_denied",
            http_status=status_code,
        )
    if status_code != 200:
        raise APIStatusError(
            f"exchange failed: {status_code} {body}", http_status=status_code
        )
    try:
        return str(json["token"]), float(json["expires_at"])
    except (TypeError, KeyError, ValueError) as e:
        raise APIStatusError(
            f"malformed exchange response: {body}", http_status=status_code
        ) from e


def parse_vm_token(status_code: int, body: str, json: Any) -> tuple[str, float, str | None]:
    """Validate a metadata-adapter token response → ``(token, expires_at, api_url)``.

    The adapter authenticates the machine by where the request comes from, so
    it has no "wrong credential" answer: a 403 is a refusal (e.g. a disabled
    account), anything else is the adapter's own failure.
    """
    if status_code == 403:
        raise PermissionDeniedError(
            f"in-VM token request refused: {body}",
            code="permission_denied",
            http_status=status_code,
        )
    if status_code == 429:
        raise RateLimitError(
            f"in-VM token request rate limited: {body}",
            code="resource_exhausted",
            http_status=status_code,
        )
    if status_code != 200:
        raise APIStatusError(
            f"in-VM token request failed: {status_code} {body}",
            http_status=status_code,
        )
    try:
        token = str(json["token"])
        expires_at = float(json["expires_at"])
    except (TypeError, KeyError, ValueError) as e:
        raise APIStatusError(
            f"malformed in-VM token response: {body}", http_status=status_code
        ) from e
    # The VM reports its own cluster, which is what lets an unconfigured
    # `Boxd()` work identically on dev, staging, metal and prod.
    api_url = json.get("api_url") or None
    return token, expires_at, api_url


def _expired(expires_at: float, skew: float) -> bool:
    return time.time() > expires_at - skew


def _retry_after_secs(resp: httpx.Response) -> float:
    """Seconds to wait per the ``Retry-After`` header — capped at 60, default 5."""
    try:
        secs = float(resp.headers.get("retry-after", ""))
    except ValueError:
        return 5.0
    return min(max(secs, 0.0), 60.0) or 5.0


# ── Credential stores ────────────────────────────────────────────────


class _CredentialsBase:
    """Shared state and mode selection for the sync/async credential stores."""

    def __init__(self, *, api_key: str | None, token: str | None, exchange_url: str):
        env_token = os.environ.get("BOXD_TOKEN") or None
        env_key = os.environ.get("BOXD_API_KEY") or None
        # Explicit args outrank the environment; within each tier a token
        # outranks a key.
        self._token = token or None
        self._api_key = api_key or None
        if not self._token and not self._api_key:
            self._token = env_token
            self._api_key = env_key if not env_token else None
        self._exchange_url = exchange_url

        self._cached: str | None = self._token if self._token else None
        self._expires_at: float = 0.0
        # Base URL learned from the metadata adapter (in-VM mode only).
        self.discovered_base_url: str | None = None

    @property
    def mode(self) -> str:
        """``"static"`` | ``"exchange"`` | ``"auto"`` (in-VM or bust)."""
        if self._token:
            return "static"
        if self._api_key:
            return "exchange"
        return "auto"



class SyncCredentials(_CredentialsBase):
    """Blocking credential store."""

    def token(self) -> str:
        mode = self.mode
        if mode == "static":
            assert self._token is not None
            return self._token
        if mode == "exchange":
            if self._cached is None or _expired(self._expires_at, EXCHANGE_SKEW_SECS):
                self._exchange()
            assert self._cached is not None
            return self._cached
        if self._cached is None or _expired(self._expires_at, VM_TOKEN_SKEW_SECS):
            self._mint_from_vm()
        assert self._cached is not None
        return self._cached

    def _exchange(self) -> None:
        for attempt in range(2):
            try:
                with httpx.Client(timeout=_HTTP_TIMEOUT_SECS) as client:
                    resp = client.post(
                        self._exchange_url, json={"api_key": self._api_key}
                    )
            except httpx.HTTPError as e:
                raise APIConnectionError(
                    f"could not reach {self._exchange_url}: {e}"
                ) from e
            # The exchange endpoint is rate-limited per source IP; a NATed fleet
            # can trip it legitimately. Wait out one Retry-After before failing.
            if resp.status_code == 429 and attempt == 0:
                time.sleep(_retry_after_secs(resp))
                continue
            self._cached, self._expires_at = parse_exchange(
                resp.status_code, resp.text, _json_or_none(resp)
            )
            return

    def _mint_from_vm(self) -> None:
        base = self._metadata_base()
        try:
            with httpx.Client(timeout=_HTTP_TIMEOUT_SECS) as client:
                resp = client.get(base + METADATA_TOKEN_PATH)
        except httpx.HTTPError as e:
            raise APIConnectionError(
                f"could not reach the in-VM metadata adapter: {e}"
            ) from e
        token, expires_at, api_url = parse_vm_token(
            resp.status_code, resp.text, _json_or_none(resp)
        )
        self._cached, self._expires_at = token, expires_at
        if api_url:
            self.discovered_base_url = api_url

    def _metadata_base(self) -> str:
        return metadata_base()


class AsyncCredentials(_CredentialsBase):
    """Async twin of :class:`SyncCredentials` — same rules, awaited I/O."""

    async def token(self) -> str:
        mode = self.mode
        if mode == "static":
            assert self._token is not None
            return self._token
        if mode == "exchange":
            if self._cached is None or _expired(self._expires_at, EXCHANGE_SKEW_SECS):
                await self._exchange()
            assert self._cached is not None
            return self._cached
        if self._cached is None or _expired(self._expires_at, VM_TOKEN_SKEW_SECS):
            await self._mint_from_vm()
        assert self._cached is not None
        return self._cached

    async def _exchange(self) -> None:
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECS) as client:
                    resp = await client.post(
                        self._exchange_url, json={"api_key": self._api_key}
                    )
            except httpx.HTTPError as e:
                raise APIConnectionError(
                    f"could not reach {self._exchange_url}: {e}"
                ) from e
            # The exchange endpoint is rate-limited per source IP; a NATed fleet
            # can trip it legitimately. Wait out one Retry-After before failing.
            if resp.status_code == 429 and attempt == 0:
                await asyncio.sleep(_retry_after_secs(resp))
                continue
            self._cached, self._expires_at = parse_exchange(
                resp.status_code, resp.text, _json_or_none(resp)
            )
            return

    async def _mint_from_vm(self) -> None:
        base = await self._metadata_base()
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECS) as client:
                resp = await client.get(
                    base + METADATA_TOKEN_PATH
                )
        except httpx.HTTPError as e:
            raise APIConnectionError(
                f"could not reach the in-VM metadata adapter: {e}"
            ) from e
        token, expires_at, api_url = parse_vm_token(
            resp.status_code, resp.text, _json_or_none(resp)
        )
        self._cached, self._expires_at = token, expires_at
        if api_url:
            self.discovered_base_url = api_url

    async def _metadata_base(self) -> str:
        return await metadata_base_async()


def _json_or_none(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None
