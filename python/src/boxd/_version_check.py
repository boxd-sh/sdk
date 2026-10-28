"""SDK update notice — piggybacks on every gRPC call's metadata.

The proxy attaches `x-boxd-py-sdk-latest` to response initial metadata when
a newer SDK version is available. We send `x-boxd-py-sdk-version` outbound
so the server can log who's calling. On the first response that carries a
strictly-newer latest version, we print a one-time stderr nag.

Both clients call :func:`note_metadata` with whatever initial metadata the call
produced; the comparison and the nag are shared.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable

REQ_HEADER = "x-boxd-py-sdk-version"
RESP_HEADER = "x-boxd-py-sdk-latest"
UPGRADE_CMD = "pip install --upgrade boxd"
PRERELEASE_UPGRADE_CMD = "pip install --upgrade --pre boxd"

_notified = False


def _current_version() -> str:
    # Late import so this module is importable from inside the package
    # without circular-import drama (boxd/__init__.py imports a lot).
    from . import __version__

    return __version__


def request_metadata() -> list[tuple[str, str]]:
    """Outbound header announcing the installed SDK version."""
    return [(REQ_HEADER, _current_version())]


def note_metadata(md: Iterable[tuple[str, str]] | None) -> None:
    """Print a one-time upgrade nag if the response advertises a newer version."""
    global _notified
    if _notified or md is None:
        return
    # Only for a person at a terminal: in CI, or in an automation job whose
    # stderr is its log file, this is noise on every run and nothing acts on
    # it.
    # An explicit opt-out beats every heuristic: set BOXD_NO_UPDATE_NOTICE to
    # any non-empty value and this is never printed.
    if os.environ.get("BOXD_NO_UPDATE_NOTICE"):
        return
    if not _stderr_is_tty():
        return
    latest = None
    for key, value in md:
        if key.lower() == RESP_HEADER:
            latest = value.strip() if isinstance(value, str) else None
            break
    if not latest:
        return
    current = _current_version()
    if _compare_semver(latest, current) <= 0:
        return
    # A pre-release is opt-in (`pip install --pre`), so someone on a release
    # build is not behind on anything they asked for — and the command below
    # would not install it anyway, leaving the nag to repeat forever. Staging
    # advertises its own pre-releases, so this is the normal case there.
    if _is_prerelease(latest) and not _is_prerelease(current):
        return
    _notified = True
    print(file=sys.stderr)
    print(
        f"  A new version of boxd is available (v{latest}, you have v{current}). Update with:",
        file=sys.stderr,
    )
    cmd = PRERELEASE_UPGRADE_CMD if _is_prerelease(latest) else UPGRADE_CMD
    print(f"    {cmd}", file=sys.stderr)


def _stderr_is_tty() -> bool:
    """Is stderr a terminal? Indirected through a function so tests can say.

    (A capture fixture replaces ``sys.stderr`` wholesale, so patching the
    stream's ``isatty`` is not something a test can rely on.)
    """
    try:
        return bool(sys.stderr.isatty())
    except Exception:  # closed or exotic stream: not a terminal
        return False


def _is_prerelease(v: str) -> bool:
    """Does this version carry a pre-release suffix ("0.2.6.dev356")?"""
    m = _SEMVER_RE.match(v.strip())
    return bool(m and m.group(4))


_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(.*)$")
_SUFFIX_SEPARATORS_RE = re.compile(r"[.-]")
_SUFFIX_LETTER_DIGIT_RE = re.compile(r"(?<=\D)(?=\d)|(?<=\d)(?=\D)")


def _compare_semver(a: str, b: str) -> int:
    """Return >0 if a > b, <0 if a < b, 0 if equal/unparseable.

    Handles pre-release suffixes ("0.1.1-dev.4", "0.1.1.dev4") by
    component-wise compare, numeric where both components are all-digits.
    A release (no suffix) ranks above any pre-release of the same
    numeric prefix. Unparseable input returns 0 — never nag on garbage.
    """
    pa = _SEMVER_RE.match(a.strip())
    pb = _SEMVER_RE.match(b.strip())
    if not pa or not pb:
        return 0
    for i in range(1, 4):
        ai, bi = int(pa.group(i)), int(pb.group(i))
        if ai != bi:
            return ai - bi
    sa, sb = pa.group(4) or "", pb.group(4) or ""
    if sa == "" and sb != "":
        return 1
    if sa != "" and sb == "":
        return -1
    return _compare_suffix(sa, sb)


def _compare_suffix(a: str, b: str) -> int:
    if a == b:
        return 0
    parts_a = _parse_suffix(a)
    parts_b = _parse_suffix(b)
    for i in range(max(len(parts_a), len(parts_b))):
        pa = parts_a[i] if i < len(parts_a) else None
        pb = parts_b[i] if i < len(parts_b) else None
        if pa is None:
            return -1  # shorter prerelease ranks lower
        if pb is None:
            return 1
        na = int(pa) if pa.isdigit() else None
        nb = int(pb) if pb.isdigit() else None
        if na is not None and nb is not None:
            if na != nb:
                return na - nb
        elif na is not None:
            return -1  # numeric < alphanumeric (SemVer §11.4.3)
        elif nb is not None:
            return 1
        elif pa != pb:
            return -1 if pa < pb else 1
    return 0


def _parse_suffix(s: str) -> list[str]:
    """Decompose "-dev.6" / ".dev6" into ["dev", "6"]."""
    if not s:
        return []
    stripped = s.lstrip("-.")
    if not stripped:
        return []
    components: list[str] = []
    for piece in _SUFFIX_SEPARATORS_RE.split(stripped):
        if not piece:
            continue
        components.extend(p for p in _SUFFIX_LETTER_DIGIT_RE.split(piece) if p)
    return components
