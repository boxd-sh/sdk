"""The package imports on every Python it declares (``requires-python``,
3.10 up), whichever one runs this suite.

A source scan rather than an import, so a run on 3.12 still catches what
only breaks on 3.10 or 3.11: syntax newer than 3.10, ``typing`` names newer
than 3.10, and ``typing.TypedDict``, which pydantic refuses as a field type
below 3.12 (``boxd==0.2.19.dev901`` couldn't be imported on 3.10 or 3.11 for
that reason). Take these from ``typing_extensions`` instead.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src" / "boxd"
MODULES = sorted(SRC.rglob("*.py"))
OLDEST = (3, 10)

# `typing` names an import of which breaks somewhere in 3.10-3.11, and why.
NOT_FROM_TYPING = {
    "TypedDict": "pydantic refuses typing.TypedDict as a field type below 3.12",
    **{
        name: "new in 3.11"
        for name in (
            "Self",
            "LiteralString",
            "Never",
            "NotRequired",
            "Required",
            "TypeVarTuple",
            "Unpack",
            "assert_never",
            "assert_type",
            "reveal_type",
            "dataclass_transform",
            "get_overloads",
            "clear_overloads",
        )
    },
    **{name: "new in 3.12" for name in ("override", "TypeAliasType")},
    **{
        name: "new in 3.13"
        for name in ("ReadOnly", "TypeIs", "NoDefault", "get_protocol_members", "is_protocol")
    },
}
NEW_MODULES = {"tomllib": "new in 3.11"}


def problems(path: Path) -> list[str]:
    source = path.read_text()
    try:
        tree = ast.parse(source, filename=str(path), feature_version=OLDEST)
    except SyntaxError as e:
        return [f"line {e.lineno}: syntax Python 3.10 can't parse ({e.msg})"]
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "typing":
            for alias in node.names:
                if alias.name in NOT_FROM_TYPING:
                    found.append(
                        f"line {node.lineno}: from typing import {alias.name}: "
                        f"{NOT_FROM_TYPING[alias.name]}"
                    )
        elif (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "typing"
            and node.attr in NOT_FROM_TYPING
        ):
            found.append(f"line {node.lineno}: typing.{node.attr}: {NOT_FROM_TYPING[node.attr]}")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module]
            for name in names:
                if name and name.split(".")[0] in NEW_MODULES:
                    found.append(f"line {node.lineno}: import {name}: {NEW_MODULES[name]}")
    return found


def test_the_scan_sees_the_package():
    assert SRC / "spec.py" in MODULES and SRC / "models.py" in MODULES


@pytest.mark.parametrize("path", MODULES, ids=[str(p.relative_to(SRC)) for p in MODULES])
def test_nothing_breaks_below_python_3_12(path):
    found = problems(path)
    assert not found, (
        f"{path.relative_to(SRC.parent)} doesn't work on Python 3.10/3.11 "
        f"(take the name from typing_extensions):\n" + "\n".join(found)
    )


@pytest.mark.parametrize(
    "source",
    [
        "from typing import TypedDict\n",
        "from typing import Any, NotRequired\n",
        "import typing\nclass A(typing.TypedDict): pass\n",
        "import tomllib\n",
        "type Size = str\n",
        "try:\n    pass\nexcept* ValueError:\n    pass\n",
    ],
)
def test_the_scan_catches_what_broke(tmp_path, source):
    path = tmp_path / "m.py"
    path.write_text(source)
    assert problems(path)


def test_the_scan_lets_typing_extensions_through(tmp_path):
    path = tmp_path / "m.py"
    path.write_text("from typing import Any\nfrom typing_extensions import NotRequired, TypedDict\n")
    assert problems(path) == []
