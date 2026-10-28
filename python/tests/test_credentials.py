"""Credential resolution order, the exchange, and in-VM detection."""

from __future__ import annotations

import time

import httpx
import pytest

from boxd._credentials import (
    _VM_HINTS,
    AsyncCredentials,
    SyncCredentials,
    detect_gateway,
    parse_exchange,
    parse_vm_token,
)
from boxd.errors import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    BoxdError,
    PermissionDeniedError,
    RateLimitError,
)

EXCHANGE = "https://app.boxd.sh/api/v1/auth/token"


def creds(**kwargs):
    kwargs.setdefault("api_key", None)
    kwargs.setdefault("token", None)
    kwargs.setdefault("exchange_url", EXCHANGE)
    return SyncCredentials(**kwargs)


@pytest.fixture(autouse=True)
def hermetic_env(monkeypatch):
    """Own the environment these tests are about.

    Credential resolution reads the ambient environment by design — that is the
    feature. So a test asserting "this signal alone is not enough" is only
    meaningful if the OTHER signals are absent, and on a developer machine they
    frequently are not: any shell that has ever run inside a boxd machine, or
    that sources the boxd profile, carries BOXD_VM_NAME.

    That is not hypothetical. `test_reachable_adapter_alone_is_not_enough` used
    to clear BOXD_VM_ID and nothing else, so wherever BOXD_VM_NAME survived,
    `looks_like_a_machine()` stayed true, the in-VM branch ran, and the test
    failed on a real connection attempt to a gateway that was never there.

    The hint list is IMPORTED rather than repeated, so adding a fourth hint to
    the library cannot silently leave these tests reading the outside world.
    """
    for var in ("BOXD_TOKEN", "BOXD_API_KEY", *_VM_HINTS):
        monkeypatch.delenv(var, raising=False)


# --- resolution order ---


def test_explicit_token_wins_over_explicit_key():
    assert creds(token="tok", api_key="bxd_key").mode == "static"


def test_explicit_key_used_when_no_token():
    assert creds(api_key="bxd_key").mode == "exchange"


def test_explicit_key_beats_env_token(monkeypatch):
    monkeypatch.setenv("BOXD_TOKEN", "env-tok")
    c = creds(api_key="bxd_key")
    assert c.mode == "exchange"


def test_env_token_beats_env_key(monkeypatch):
    monkeypatch.setenv("BOXD_TOKEN", "env-tok")
    monkeypatch.setenv("BOXD_API_KEY", "bxd_env")
    c = creds()
    assert c.mode == "static"
    assert c.token() == "env-tok"


def test_env_key_used_when_no_token(monkeypatch):
    monkeypatch.setenv("BOXD_API_KEY", "bxd_env")
    assert creds().mode == "exchange"


def test_nothing_configured_falls_through_to_auto():
    assert creds().mode == "auto"


def test_static_token_is_returned_verbatim_and_never_refreshed():
    c = creds(token="tok")
    assert c.token() == "tok"
    assert c.token() == "tok"


def test_no_credentials_and_no_machine_raises(monkeypatch):
    # No BOXD_VM_ID ⇒ not inside a machine, regardless of anything else.
    monkeypatch.delenv("BOXD_VM_ID", raising=False)
    with pytest.raises(AuthenticationError, match="no credentials") as info:
        creds().token()
    assert info.value.code == "unauthenticated"
    assert info.value.reason == "missing_credentials"
    assert info.value.http_status is None


# --- in-VM detection needs BOTH signals ---


def test_vm_id_alone_is_not_enough(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    # Gateway found, but nothing is listening.
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    monkeypatch.setattr("boxd._credentials.probe", lambda *a, **k: False)
    with pytest.raises(AuthenticationError, match="no credentials"):
        creds().token()


def test_reachable_adapter_alone_is_not_enough(monkeypatch):
    monkeypatch.delenv("BOXD_VM_ID", raising=False)
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    monkeypatch.setattr("boxd._credentials.probe", lambda *a, **k: True)
    with pytest.raises(AuthenticationError, match="no credentials"):
        creds().token()


def test_no_gateway_is_not_enough(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: None)
    with pytest.raises(AuthenticationError, match="no credentials"):
        creds().token()


def test_both_signals_mint_a_token_and_report_the_cluster(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    monkeypatch.setattr("boxd._credentials.probe", lambda *a, **k: True)

    seen = {}

    class FakeResponse:
        status_code = 200
        text = "{}"

        def json(self):
            return {
                "token": "vm-jwt",
                "expires_at": time.time() + 900,
                "api_url": "http://staging.example.com:9443",
            }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            seen["url"] = url
            seen["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr("boxd._credentials.httpx.Client", FakeClient)

    c = creds()
    assert c.token() == "vm-jwt"
    assert seen["url"] == "http://10.42.0.1:9002/v1/auth/token"
    # An unconfigured client learns its cluster from the machine.
    assert c.discovered_base_url == "http://staging.example.com:9443"



def test_detect_gateway_parses_the_default_route(monkeypatch, tmp_path):
    route = tmp_path / "route"
    route.write_text(
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"
        "eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n"
        "eth0\t00000000\t0102A80A\t0003\t0\t0\t0\t00000000\n"
    )
    real_open = open
    monkeypatch.setattr(
        "builtins.open",
        lambda p, *a, **k: real_open(route, *a, **k)
        if p == "/proc/net/route"
        else real_open(p, *a, **k),
    )
    # 0102A80A little-endian → 10.168.2.1
    assert detect_gateway() == "10.168.2.1"


def test_detect_gateway_returns_none_without_proc(monkeypatch):
    def boom(path, *a, **k):
        raise OSError("no /proc here")

    monkeypatch.setattr("builtins.open", boom)
    assert detect_gateway() is None


# --- response parsing ---


def test_parse_exchange_ok():
    assert parse_exchange(200, "", {"token": "t", "expires_at": 1800}) == ("t", 1800.0)


# Each way an exchange can fail, pinned to its class, `code`, `reason` and
# `http_status`: a caller tells "boxd refused the key" from "boxd is down"
# by class alone, with no message matching and no `__cause__` check.
@pytest.mark.parametrize(
    ("status", "cls", "code", "reason", "match"),
    [
        (401, AuthenticationError, "unauthenticated", "invalid_api_key", "invalid or expired"),
        (403, PermissionDeniedError, "permission_denied", None, "account is disabled"),
        (429, RateLimitError, "resource_exhausted", None, "rate limit"),
        (500, APIStatusError, None, None, "exchange failed: 500"),
        (503, APIStatusError, None, None, "exchange failed: 503"),
        (404, APIStatusError, None, None, "exchange failed: 404"),
    ],
)
def test_parse_exchange_errors(status, cls, code, reason, match):
    with pytest.raises(BoxdError, match=match) as info:
        parse_exchange(status, "this account is disabled", None)
    assert type(info.value) is cls
    assert info.value.code == code
    assert info.value.reason == reason
    assert info.value.http_status == status


def test_server_errors_are_not_authentication_errors():
    with pytest.raises(BoxdError) as info:
        parse_exchange(503, "down", None)
    assert not isinstance(info.value, AuthenticationError)


def test_parse_exchange_rejects_malformed_body():
    with pytest.raises(APIStatusError, match="malformed") as info:
        parse_exchange(200, "not json", None)
    assert info.value.http_status == 200
    assert info.value.code is None and info.value.reason is None


def test_parse_vm_token_ok():
    assert parse_vm_token(
        200, "", {"token": "t", "expires_at": 10, "api_url": "http://x:9443"}
    ) == ("t", 10.0, "http://x:9443")


def test_parse_vm_token_without_api_url():
    assert parse_vm_token(200, "", {"token": "t", "expires_at": 10})[2] is None


@pytest.mark.parametrize(
    ("status", "cls", "code"),
    [
        (403, PermissionDeniedError, "permission_denied"),
        (429, RateLimitError, "resource_exhausted"),
        (400, APIStatusError, None),
        (503, APIStatusError, None),
    ],
)
def test_parse_vm_token_error_status(status, cls, code):
    with pytest.raises(BoxdError, match="in-VM token request") as info:
        parse_vm_token(status, "down", None)
    assert type(info.value) is cls
    assert info.value.code == code
    assert info.value.http_status == status


def test_parse_vm_token_rejects_malformed_body():
    with pytest.raises(APIStatusError, match="malformed") as info:
        parse_vm_token(200, "not json", None)
    assert info.value.http_status == 200


# --- unreachable endpoints are connection errors, not auth errors ---


class _Unreachable:
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None):
        raise httpx.ConnectError("connection refused")

    def get(self, url, headers=None):
        raise httpx.ConnectError("connection refused")


class _AsyncUnreachable(_Unreachable):
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None):
        raise httpx.ConnectError("connection refused")

    async def get(self, url, headers=None):
        raise httpx.ConnectError("connection refused")


def test_unreachable_exchange_is_a_connection_error(monkeypatch):
    monkeypatch.setattr("boxd._credentials.httpx.Client", _Unreachable)
    with pytest.raises(APIConnectionError, match="could not reach") as info:
        creds(api_key="bxd_key").token()
    assert info.value.code is None and info.value.reason is None
    assert isinstance(info.value.__cause__, httpx.ConnectError)


async def test_async_unreachable_exchange_is_a_connection_error(monkeypatch):
    monkeypatch.setattr("boxd._credentials.httpx.AsyncClient", _AsyncUnreachable)
    c = AsyncCredentials(api_key="bxd_key", token=None, exchange_url=EXCHANGE)
    with pytest.raises(APIConnectionError, match="could not reach"):
        await c.token()


def _inside_a_machine(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    monkeypatch.setattr("boxd._credentials.probe", lambda *a, **k: True)


def test_unreachable_metadata_adapter_is_a_connection_error(monkeypatch):
    _inside_a_machine(monkeypatch)
    monkeypatch.setattr("boxd._credentials.httpx.Client", _Unreachable)
    with pytest.raises(APIConnectionError, match="metadata adapter"):
        creds().token()


async def test_async_unreachable_metadata_adapter_is_a_connection_error(monkeypatch):
    _inside_a_machine(monkeypatch)

    async def reachable(*a, **k):
        return True

    monkeypatch.setattr("boxd._credentials.probe_async", reachable)
    monkeypatch.setattr("boxd._credentials.httpx.AsyncClient", _AsyncUnreachable)
    c = AsyncCredentials(api_key=None, token=None, exchange_url=EXCHANGE)
    with pytest.raises(APIConnectionError, match="metadata adapter"):
        await c.token()


# --- exchange caching / refresh ---


def _stub_exchange(monkeypatch, expires_in: float, counter: dict):
    class FakeResponse:
        status_code = 200
        text = "{}"

        def json(self):
            counter["n"] = counter.get("n", 0) + 1
            return {
                "token": f"jwt-{counter['n']}",
                "expires_at": time.time() + expires_in,
            }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            return FakeResponse()

    monkeypatch.setattr("boxd._credentials.httpx.Client", FakeClient)


def test_exchange_caches_a_fresh_token(monkeypatch):
    counter: dict = {}
    _stub_exchange(monkeypatch, 3600, counter)
    c = creds(api_key="bxd_key")
    assert c.token() == "jwt-1"
    assert c.token() == "jwt-1"
    assert counter["n"] == 1


def test_exchange_refreshes_inside_the_skew_window(monkeypatch):
    counter: dict = {}
    # Expires in 60s — inside the 300s re-exchange margin, so every call
    # re-exchanges.
    _stub_exchange(monkeypatch, 60, counter)
    c = creds(api_key="bxd_key")
    assert c.token() == "jwt-1"
    assert c.token() == "jwt-2"


def test_exchange_retries_once_on_429(monkeypatch):
    calls = {"n": 0}

    class FakeResponse:
        def __init__(self, status: int):
            self.status_code = status
            self.text = "{}"
            self.headers = {"retry-after": "0"}

        def json(self):
            return {"token": "jwt-after-429", "expires_at": time.time() + 3600}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            calls["n"] += 1
            return FakeResponse(429 if calls["n"] == 1 else 200)

    monkeypatch.setattr("boxd._credentials.httpx.Client", FakeClient)
    c = creds(api_key="bxd_key")
    assert c.token() == "jwt-after-429"
    assert calls["n"] == 2


# --- async twin behaves identically ---


async def test_async_static_token():
    c = AsyncCredentials(api_key=None, token="tok", exchange_url=EXCHANGE)
    assert await c.token() == "tok"


async def test_async_no_credentials_raises(monkeypatch):
    monkeypatch.delenv("BOXD_VM_ID", raising=False)
    c = AsyncCredentials(api_key=None, token=None, exchange_url=EXCHANGE)
    with pytest.raises(AuthenticationError, match="no credentials") as info:
        await c.token()
    assert info.value.reason == "missing_credentials"


def test_in_vm_detection_does_not_hinge_on_one_env_var(monkeypatch):
    # A real dev machine's shell had BOXD_IDENTITY and BOXD_PROXY_ENDPOINT but
    # no BOXD_VM_ID — gating on BOXD_VM_ID alone disabled in-VM auth there.
    from boxd import _credentials as c

    for v in c._VM_HINTS:
        monkeypatch.delenv(v, raising=False)
    assert c.looks_like_a_machine() is False

    for present in c._VM_HINTS:
        for v in c._VM_HINTS:
            monkeypatch.delenv(v, raising=False)
        monkeypatch.setenv(present, "x")
        assert c.looks_like_a_machine() is True, present


# --- AuthenticationError always says it's `unauthenticated` ---


def test_authentication_error_defaults_to_a_refused_token():
    e = AuthenticationError("nope")
    assert (e.code, e.grpc_code, e.reason) == ("unauthenticated", 16, "invalid_token")
    assert e.http_status is None


def test_authentication_error_keeps_what_it_is_given():
    e = AuthenticationError("bad key", reason="invalid_api_key", http_status=401)
    assert (e.code, e.grpc_code, e.reason, e.http_status) == (
        "unauthenticated",
        16,
        "invalid_api_key",
        401,
    )


# --- a machine whose metadata adapter doesn't answer ---


class _VmTokenClient:
    """An httpx.Client stand-in whose metadata adapter hands out a token."""

    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        return httpx.Response(
            200, json={"token": "vm-jwt", "expires_at": time.time() + 900}
        )


class _AsyncVmTokenClient(_VmTokenClient):
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None):
        return _VmTokenClient.get(self, url, headers)


def test_silent_adapter_names_it_and_the_way_out_and_is_asked_again(monkeypatch):
    # An isolated machine keeps the hints but has no adapter: indistinguishable
    # from an outage, so terminal, but the message must not claim we're not in
    # a machine.
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    answers = iter([False, True])
    monkeypatch.setattr("boxd._credentials.probe", lambda *a, **k: next(answers))
    monkeypatch.setattr("boxd._credentials.httpx.Client", _VmTokenClient)

    c = creds()
    with pytest.raises(AuthenticationError) as info:
        c.token()
    e = info.value
    assert (e.code, e.reason) == ("unauthenticated", "missing_credentials")
    assert "metadata adapter at http://10.42.0.1:9002 did not answer" in e.message
    assert "isolated machines have none" in e.message
    assert "api_key=" in e.message and "BOXD_API_KEY" in e.message
    assert "BOXD_TOKEN" in e.message
    # No negative caching: the next call probes again and succeeds.
    assert c.token() == "vm-jwt"


async def test_async_silent_adapter_names_it_and_is_asked_again(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-123")
    monkeypatch.setattr("boxd._credentials.detect_gateway", lambda: "10.42.0.1")
    answers = iter([False, True])

    async def probe(*a, **k):
        return next(answers)

    monkeypatch.setattr("boxd._credentials.probe_async", probe)
    monkeypatch.setattr("boxd._credentials.httpx.AsyncClient", _AsyncVmTokenClient)

    c = AsyncCredentials(api_key=None, token=None, exchange_url=EXCHANGE)
    with pytest.raises(AuthenticationError, match="did not answer") as info:
        await c.token()
    assert info.value.reason == "missing_credentials"
    assert "http://10.42.0.1:9002" in info.value.message
    assert await c.token() == "vm-jwt"


def test_outside_a_machine_the_message_does_not_mention_an_adapter():
    with pytest.raises(AuthenticationError) as info:
        creds().token()
    assert "did not answer" not in info.value.message
