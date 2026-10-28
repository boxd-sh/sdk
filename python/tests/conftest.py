"""Shared fixtures.

The suite is unit-level: nothing here talks to a cluster. Anything that would
need one is exercised through a fake transport (see `fakes.py`).
"""

from __future__ import annotations

import pytest

from boxd import _version_check


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Never let the developer's own credentials leak into a test, nor the
    hints that make the SDK talk to a real metadata adapter when the suite
    runs inside a boxd machine."""
    for name in (
        "BOXD_API_KEY",
        "BOXD_TOKEN",
        "BOXD_BASE_URL",
        "BOXD_API_URL",
        "BOXD_VM_ID",
        "BOXD_VM_NAME",
        "BOXD_VM_HOST",
        "BOXD_PROXY_ENDPOINT",
        "BOXD_IDENTITY",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def reset_version_nag():
    _version_check._notified = False
    yield
    _version_check._notified = False
