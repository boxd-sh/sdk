"""The upgrade nag: semver comparison and the one-time stderr notice."""

from __future__ import annotations

import pytest

from boxd import _version_check
from boxd._version_check import (
    REQ_HEADER,
    RESP_HEADER,
    _compare_semver,
    note_metadata,
    request_metadata,
)


@pytest.fixture(autouse=True)
def _stderr_is_a_terminal(monkeypatch):
    """The nag is for a person at a terminal, and pytest is not one.

    Every test here assumes a TTY unless it says otherwise; the one that
    checks the non-terminal case overrides this.
    """
    monkeypatch.setattr(_version_check, "_stderr_is_tty", lambda: True)

# Picked to be unambiguously newer/older than any real shipped SDK so tests
# don't silently flip meaning when the package version bumps.
NEWER = "99.0.0"
OLDER = "0.0.1"
CURRENT = "0.1.1"


@pytest.fixture
def stub_current(monkeypatch):
    monkeypatch.setattr(_version_check, "_current_version", lambda: CURRENT)


# --- _compare_semver ---


def test_compare_semver_patch_greater():
    assert _compare_semver("0.1.1", "0.1.0") > 0


def test_compare_semver_patch_lesser():
    assert _compare_semver("0.1.0", "0.1.1") < 0


def test_compare_semver_equal():
    assert _compare_semver("0.1.0", "0.1.0") == 0


def test_compare_semver_major_dominates_minor():
    assert _compare_semver("1.0.0", "0.99.99") > 0


def test_compare_semver_minor_dominates_patch():
    assert _compare_semver("0.2.0", "0.1.99") > 0


def test_compare_semver_release_greater_than_prerelease():
    assert _compare_semver("0.1.1", "0.1.1-dev.4") > 0
    assert _compare_semver("0.1.1-dev.4", "0.1.1") < 0


def test_compare_semver_prerelease_order():
    assert _compare_semver("0.1.1-dev.4", "0.1.1-dev.5") < 0
    assert _compare_semver("0.1.1-dev.5", "0.1.1-dev.4") > 0


def test_compare_semver_unparseable_returns_zero():
    assert _compare_semver("garbage", "0.1.0") == 0
    assert _compare_semver("0.1.0", "garbage") == 0
    assert _compare_semver("v1.0.0", "0.1.0") == 0
    assert _compare_semver("", "0.1.0") == 0


def test_compare_semver_whitespace_tolerated():
    assert _compare_semver("  0.1.1  ", "0.1.0") > 0


# --- outbound header ---


def test_request_metadata_announces_the_installed_version(stub_current):
    assert request_metadata() == [(REQ_HEADER, CURRENT)]


# --- inbound notice ---


def test_notifies_when_a_newer_version_is_advertised(stub_current, capsys):
    note_metadata([(RESP_HEADER, NEWER)])
    err = capsys.readouterr().err
    assert NEWER in err
    assert CURRENT in err
    assert "pip install --upgrade boxd" in err


@pytest.mark.parametrize(
    "metadata",
    [
        pytest.param([(RESP_HEADER, CURRENT)], id="latest-equal"),
        pytest.param([(RESP_HEADER, OLDER)], id="latest-older"),
        pytest.param([("other-header", "value")], id="header-missing"),
        pytest.param([], id="metadata-empty"),
        pytest.param(None, id="metadata-none"),
        pytest.param([(RESP_HEADER, "   ")], id="header-whitespace-only"),
    ],
)
def test_silent_otherwise(stub_current, capsys, metadata):
    note_metadata(metadata)
    assert capsys.readouterr().err == ""
    assert _version_check._notified is False


def test_notifies_only_once(stub_current, capsys):
    note_metadata([(RESP_HEADER, NEWER)])
    assert NEWER in capsys.readouterr().err
    note_metadata([(RESP_HEADER, NEWER)])
    assert capsys.readouterr().err == ""


def test_header_lookup_is_case_insensitive(stub_current, capsys):
    note_metadata([("X-Boxd-Py-Sdk-Latest", NEWER)])
    assert NEWER in capsys.readouterr().err


def test_header_value_is_stripped(stub_current, capsys):
    note_metadata([(RESP_HEADER, f"  {NEWER}  ")])
    assert NEWER in capsys.readouterr().err


def test_silent_when_stderr_is_not_a_terminal(monkeypatch, capsys):
    """CI, or an automation job whose stderr IS its log file: noise on every run."""
    monkeypatch.setattr(_version_check, "_notified", False)
    monkeypatch.setattr(_version_check, "_stderr_is_tty", lambda: False)
    _version_check.note_metadata([(_version_check.RESP_HEADER, "99.0.0")])
    assert capsys.readouterr().err == ""


def test_silent_when_latest_is_a_prerelease_and_we_are_on_a_release(monkeypatch, capsys):
    """A pre-release is opt-in (`pip install --pre`), and `--upgrade` alone
    cannot install it — so the nag would repeat forever."""
    monkeypatch.setattr(_version_check, "_notified", False)
    monkeypatch.setattr(_version_check, "_current_version", lambda: "0.2.4")
    _version_check.note_metadata([(_version_check.RESP_HEADER, "0.2.6.dev356")])
    assert capsys.readouterr().err == ""


def test_prerelease_user_is_told_the_prerelease_command(monkeypatch, capsys):
    monkeypatch.setattr(_version_check, "_notified", False)
    monkeypatch.setattr(_version_check, "_current_version", lambda: "0.2.6.dev1")
    _version_check.note_metadata([(_version_check.RESP_HEADER, "0.2.6.dev356")])
    assert "--pre" in capsys.readouterr().err


def test_is_prerelease():
    assert _version_check._is_prerelease("0.2.6.dev356")
    assert _version_check._is_prerelease("0.2.6-dev.356")
    assert not _version_check._is_prerelease("0.2.6")


def test_silent_when_the_opt_out_env_var_is_set(monkeypatch, capsys):
    monkeypatch.setattr(_version_check, "_notified", False)
    monkeypatch.setenv("BOXD_NO_UPDATE_NOTICE", "1")
    _version_check.note_metadata([(_version_check.RESP_HEADER, "99.0.0")])
    assert capsys.readouterr().err == ""
