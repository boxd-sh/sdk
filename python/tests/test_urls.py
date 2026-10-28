"""Base-URL resolution, the derived exchange URL, and endpoint splitting."""

from __future__ import annotations

import pytest

from boxd._urls import (
    DEFAULT_BASE_URL,
    console_base_url,
    exchange_url_for,
    resolve_base_url,
    resolve_endpoint,
)


# --- resolve_base_url ---


def test_explicit_wins_over_everything(monkeypatch):
    monkeypatch.setenv("BOXD_BASE_URL", "http://env.example:9443")
    assert resolve_base_url("http://explicit:9443") == "http://explicit:9443"


def test_base_url_env(monkeypatch):
    monkeypatch.setenv("BOXD_BASE_URL", "http://env.example:9443")
    assert resolve_base_url(None) == "http://env.example:9443"


def test_deprecated_api_url_alias(monkeypatch):
    monkeypatch.setenv("BOXD_API_URL", "http://legacy.example:9443")
    assert resolve_base_url(None) == "http://legacy.example:9443"


def test_base_url_env_beats_deprecated_alias(monkeypatch):
    monkeypatch.setenv("BOXD_BASE_URL", "http://new.example:9443")
    monkeypatch.setenv("BOXD_API_URL", "http://legacy.example:9443")
    assert resolve_base_url(None) == "http://new.example:9443"


def test_unset_defers_to_caller():
    # None, not the default — the caller may still learn one from the machine
    # it is running inside.
    assert resolve_base_url(None) is None


def test_empty_string_is_not_a_choice(monkeypatch):
    monkeypatch.setenv("BOXD_BASE_URL", "")
    assert resolve_base_url("") is None


# --- console_base_url / exchange_url_for ---


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("http://boxd.sh:9443", "https://app.boxd.sh"),
        ("https://boxd.sh", "https://app.boxd.sh"),
        ("http://staging.example.com:9443", "https://app.staging.example.com"),
        ("http://boxd.sh:9443", "https://app.boxd.sh"),
        # A path is stripped along with the port.
        ("http://boxd.sh:9443/grpc", "https://app.boxd.sh"),
        # A trailing slash must not produce `app.boxd.sh//api/...`.
        ("https://boxd.sh/", "https://app.boxd.sh"),
    ],
)
def test_named_hosts_map_to_app_subdomain(base, expected):
    assert console_base_url(base) == expected


@pytest.mark.parametrize(
    "base",
    [
        # The combined dev binary serves both surfaces from one host.
        "http://localhost:8080",
        "http://localhost",
        # Raw IPs have no `app.` sibling to point at.
        "https://10.0.0.5",
        "http://10.0.0.5:9443",
        "http://127.0.0.1:9443",
        "http://192.168.1.10:9443",
        # Already a console host — don't produce `app.app.`.
        "https://app.boxd.sh",
    ],
)
def test_carve_outs_are_left_alone(base):
    assert console_base_url(base) == base.rstrip("/")


def test_schemeless_input_is_returned_verbatim():
    # Never invent a scheme.
    assert console_base_url("localhost") == "localhost"
    assert console_base_url("boxd.sh:9443") == "boxd.sh:9443"


def test_exchange_url_appends_the_path():
    assert exchange_url_for("http://boxd.sh:9443") == (
        "https://app.boxd.sh/api/v1/auth/token"
    )


def test_exchange_url_for_localhost_keeps_scheme_and_port():
    assert exchange_url_for("http://localhost:8080") == (
        "http://localhost:8080/api/v1/auth/token"
    )


def test_exchange_url_for_raw_ip_keeps_scheme_and_port():
    assert exchange_url_for("http://10.0.0.5:9443") == (
        "http://10.0.0.5:9443/api/v1/auth/token"
    )


def test_default_base_url_derives_the_production_exchange():
    assert exchange_url_for(DEFAULT_BASE_URL) == (
        "https://app.boxd.sh/api/v1/auth/token"
    )


# --- resolve_endpoint ---


@pytest.mark.parametrize(
    ("url", "target", "tls"),
    [
        ("http://boxd.sh:9443", "boxd.sh:9443", False),
        ("https://boxd.sh:9443", "boxd.sh:9443", True),
        ("http://boxd.sh:9443/", "boxd.sh:9443", False),
        # Schemeless defaults to TLS...
        ("boxd.sh:9443", "boxd.sh:9443", True),
        # ...except on the loopback.
        ("localhost:9443", "localhost:9443", False),
        ("127.0.0.1:9443", "127.0.0.1:9443", False),
    ],
)
def test_resolve_endpoint(url, target, tls):
    endpoint = resolve_endpoint(url)
    assert endpoint.target == target
    assert endpoint.use_tls is tls
