"""Machine specs: describe a ready-to-work machine in one value, built from
reusable pieces.

::

    from boxd import Boxd, Machine, team, github, slack, jira, claude, secrets

    engineering = (
        Machine.spec()
        .from_(team("eng"))
        .network("eng")
        .label("team", "eng")
        .env("NODE_ENV", "development")
        .packages("apt-get install -y nginx", "npm i -g pnpm")
        .with_(github(shared="eng-bot"), claude())
    )
    mike = engineering.size("2x8").with_(
        slack(), jira(shared="jira"), secrets("NPM_TOKEN")
    )
    machine = boxd.machines.create("mike-dev", spec=mike)
    print(machine.spec)  # the resolved spec, as the machine keeps it

A piece is a plain function returning part of a spec (a dict), so you can
write your own. The SDK merges pieces and the server checks every field.

Merge rules (the server applies the same ones when a restore adds a spec to a
snapshot's): maps (``labels``, ``env``, ``connections``) merge with the later
piece winning; lists (``networks``, ``egress``, ``secrets``, ``agents``,
``packages``) combine in order without duplicates; ``version``, ``base``, ``size`` and
``assignTo`` set twice to different values raise (a size compares as the
server stores it, so ``"2X8"`` is ``"2x8"``); ``isolated`` only ever turns on.
A name can't be in both ``env`` and ``secrets``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any, Literal, Union

# Not typing.TypedDict: pydantic refuses it as a field type below Python 3.12
# (models.py uses MachineSpec), so the package wouldn't import on 3.10/3.11.
from typing_extensions import TypedDict

from ._generated import api_pb2
from .errors import BoxdError

MACHINE_SPEC_VERSION = 1
"""The spec version this SDK writes."""

MachineSize = Union[Literal["1x4", "2x8", "4x16"], str]
"""``"<vcpu>x<memory GiB>"``. Any other string is passed to the server, which
checks it against the cluster's sizes and the org's quota."""


class TeamBase(TypedDict):
    team: str


class SnapshotBase(TypedDict):
    snapshot: str


MachineSpecBase = Union[TeamBase, SnapshotBase]
"""What a machine boots from. Make one with :func:`team` or :func:`snapshot`."""


class MachineSpec(TypedDict, total=False):
    """A machine spec in the form the server stores and returns: empty fields
    are left out. ``resolve()`` on a builder returns one."""

    version: int
    """Always present in a resolved spec."""
    base: MachineSpecBase
    """Omitted: the default image."""
    size: str
    """Omitted: the org's default size (a restore keeps the snapshot's)."""
    assignTo: str
    """Create the machine for another member of the org: their user id. Org
    owners and admins only, in a create that names the org. Never inherited by
    forks, snapshots or restores."""
    labels: dict[str, str]
    networks: list[str]
    isolated: bool
    egress: list[str]
    """Egress allowlist: hosts, ``*.`` wildcards, public IPv4. ``["none"]``:
    nothing is reachable. Omitted: unrestricted."""
    env: dict[str, str]
    """The machine's own env vars. They win over org and personal vars of the same name."""
    secrets: list[str]
    """Names of secrets the machine gets: your own or the org's, usually
    ``unattached`` ones, which reach no machine otherwise. The machine keeps a
    reference, so rotating a secret reaches it. A name can't also be in ``env``."""
    connections: dict[str, str]
    """Integration name → ``"personal"`` or ``"shared:<tag>"``. Recorded on the machine."""
    agents: list[str]
    """Agent logins the machine needs (``"claude"``, ``"codex"``). Recorded on the machine."""
    packages: list[str]
    """Shell commands run once, in order, as root, after the machine's first
    boot (``DEBIAN_FRONTEND=noninteractive``, 30 minutes each, output in
    ``/var/log/boxd/packages.log``). The first failure stops the rest; the
    machine stays usable. At most 50 commands of at most 4 KiB each.
    ``machine.packages`` reports how each one went."""


MachineSpecPiece = Mapping[str, Any]
"""Part of a spec: what a piece returns and what ``with_()`` accepts."""

FIELDS = (
    "version",
    "base",
    "size",
    "assignTo",
    "labels",
    "networks",
    "isolated",
    "egress",
    "env",
    "secrets",
    "connections",
    "agents",
    "packages",
)


class MachineSpecError(BoxdError, ValueError):
    """A spec that can't be merged, or has a key a spec doesn't. The message
    names the field: ``spec.size: ...``."""

    def __init__(self, field: str, rule: str):
        super().__init__(f"spec.{field}: {rule}" if field else f"spec: {rule}")
        self.field = field


def team(name: str) -> TeamBase:
    """Boot from this team's default snapshot (name or id)."""
    return {"team": name}


def snapshot(name: str) -> SnapshotBase:
    """Boot from this snapshot (name or id): the machine is a restore of it."""
    return {"snapshot": name}


def _show_base(base: Mapping[str, str]) -> str:
    kind, name = next(iter(base.items()))
    return f"{kind}({json.dumps(name)})"


def _check_piece(piece: Any) -> None:
    if not isinstance(piece, Mapping):
        raise MachineSpecError("", "a spec is an object")
    for key in piece:
        if key not in FIELDS:
            raise MachineSpecError(key, f"unknown field; a spec has {', '.join(FIELDS)}")
    if "base" in piece:
        base = piece["base"]
        ok = (
            isinstance(base, Mapping)
            and len(base) == 1
            and next(iter(base)) in ("team", "snapshot")
            and isinstance(next(iter(base.values())), str)
        )
        if not ok:
            raise MachineSpecError(
                "base", 'set exactly one of team or snapshot, e.g. {"team": "eng"}'
            )


_SIZE = re.compile(r"([0-9]+)\s*[xX]\s*([0-9]+)")


def _normalize_size(size: Any) -> Any:
    """A size as the server stores it, so ``"2X8"`` and ``" 2x8 "`` merge with
    a stored ``"2x8"``: ``<vcpu>x<GiB>`` with a lowercase ``x``, no padding or
    leading zeros. Anything else is only trimmed, for the server to refuse."""
    if not isinstance(size, str):
        return size
    s = size.strip()
    m = _SIZE.fullmatch(s)
    return f"{int(m[1])}x{int(m[2])}" if m else s


def _union(a: list[str], b: Any) -> list[str]:
    out = list(a)
    for v in b or []:
        if v not in out:
            out.append(v)
    return out


def _merge2(a: dict[str, Any], b: Mapping[str, Any]) -> dict[str, Any]:
    version = a.get("version") or 0
    if b.get("version"):
        if version and version != b["version"]:
            raise MachineSpecError(
                "version", f"set twice to different values: {version} and {b['version']}"
            )
        version = b["version"]
    base = a.get("base")
    if b.get("base"):
        if base and _show_base(base) != _show_base(b["base"]):
            raise MachineSpecError(
                "base",
                "set twice to different values: "
                f"{_show_base(base)} and {_show_base(b['base'])}",
            )
        base = dict(b["base"])
    size = _normalize_size(a.get("size"))
    if b_size := _normalize_size(b.get("size")):
        if size and size != b_size:
            raise MachineSpecError(
                "size",
                f"set twice to different values: {json.dumps(size)} and {json.dumps(b_size)}",
            )
        size = b_size
    assign_to = a.get("assignTo")
    if b.get("assignTo"):
        if assign_to and assign_to != b["assignTo"]:
            raise MachineSpecError(
                "assignTo",
                "set twice to different values: "
                f"{json.dumps(assign_to)} and {json.dumps(b['assignTo'])}",
            )
        assign_to = b["assignTo"]
    env = {**a.get("env", {}), **(b.get("env") or {})}
    secret_names = _union(a.get("secrets", []), b.get("secrets"))
    both = next((name for name in secret_names if name in env), None)
    if both is not None:
        raise MachineSpecError(
            "secrets",
            f"{json.dumps(both)} is also in env; a name is either a plain value (env) "
            "or a secret (secrets), not both",
        )
    return {
        "version": version,
        "base": base,
        "size": size,
        "assignTo": assign_to,
        "labels": {**a.get("labels", {}), **(b.get("labels") or {})},
        "networks": _union(a.get("networks", []), b.get("networks")),
        "isolated": bool(a.get("isolated") or b.get("isolated")),
        "egress": _union(a.get("egress", []), b.get("egress")),
        "env": env,
        "secrets": secret_names,
        "connections": {**a.get("connections", {}), **(b.get("connections") or {})},
        "agents": _union(a.get("agents", []), b.get("agents")),
        "packages": _union(a.get("packages", []), b.get("packages")),
    }


def _compact(s: Mapping[str, Any]) -> MachineSpec:
    """The stored form: empty fields left out, version defaulted."""
    out: dict[str, Any] = {"version": s.get("version") or MACHINE_SPEC_VERSION}
    for key in FIELDS[1:]:
        value = _normalize_size(s.get(key)) if key == "size" else s.get(key)
        if value:
            out[key] = dict(value) if isinstance(value, Mapping) else (
                list(value) if isinstance(value, (list, tuple)) else value
            )
    return out  # type: ignore[return-value]


def merge_specs(*pieces: MachineSpecPiece) -> MachineSpec:
    """Merge pieces in order with the rules above and return the resolved spec.

    Raises :class:`MachineSpecError` naming the field when two pieces
    disagree, or a piece has a key a spec doesn't.
    """
    out: dict[str, Any] = {}
    for piece in pieces:
        _check_piece(piece)
        out = _merge2(out, piece)
    return _compact(out)


class MachineSpecBuilder:
    """An immutable spec builder: every method returns a new builder, so a
    shared base can be extended in several directions."""

    def __init__(self, pieces: tuple[MachineSpecPiece, ...] = ()):
        # Merge now, so a conflict raises where it was written.
        merge_specs(*pieces)
        self._pieces = pieces

    def with_(self, *pieces: MachineSpecPiece | MachineSpecBuilder) -> MachineSpecBuilder:
        """Add pieces (or other builders), merged in order after this one's."""
        parts = tuple(p.resolve() if isinstance(p, MachineSpecBuilder) else p for p in pieces)
        return MachineSpecBuilder(self._pieces + parts)

    def from_(self, base: MachineSpecBase) -> MachineSpecBuilder:
        """What the machine boots from: ``team("eng")`` or ``snapshot("eng-base")``."""
        return self.with_({"base": base})

    def size(self, size: MachineSize) -> MachineSpecBuilder:
        return self.with_({"size": size})

    def assign_to(self, user_id: str) -> MachineSpecBuilder:
        """Create the machine for another member of the org (their user id): it
        is theirs from the start, private to them and billed to the org. Only
        an org owner or admin may, in a create that names the org."""
        return self.with_({"assignTo": user_id})

    def label(self, key: str | Mapping[str, str], value: str = "") -> MachineSpecBuilder:
        """One label, or a mapping of them."""
        labels = dict(key) if isinstance(key, Mapping) else {key: value}
        return self.with_({"labels": labels})

    def network(self, *networks: str) -> MachineSpecBuilder:
        """Networks the machine joins (east-west reachability inside the org)."""
        return self.with_({"networks": list(networks)})

    def env(self, key: str | Mapping[str, str], value: str = "") -> MachineSpecBuilder:
        """One env var, or a mapping of them."""
        env = dict(key) if isinstance(key, Mapping) else {key: value}
        return self.with_({"env": env})

    def egress(self, *hosts: str) -> MachineSpecBuilder:
        """Hosts the machine may reach; naming any makes everything else
        unreachable. ``egress("none")`` lets it reach nothing."""
        return self.with_({"egress": list(hosts)})

    def packages(self, *commands: str) -> MachineSpecBuilder:
        """Shell commands to run once, in order, as root, after the first boot,
        e.g. ``"apt-get install -y nginx"``. The first failure stops the rest.
        A command already listed isn't added twice."""
        return self.with_({"packages": list(commands)})

    def isolated(self) -> MachineSpecBuilder:
        """Isolate the machine. Once on, a later piece can't turn it off."""
        return self.with_({"isolated": True})

    def resolve(self) -> MachineSpec:
        """The merged spec, to print, diff or keep."""
        return merge_specs(*self._pieces)

    def __repr__(self) -> str:
        return f"MachineSpecBuilder({self.resolve()!r})"


def spec() -> MachineSpecBuilder:
    """An empty spec to build on. Also :meth:`Machine.spec`."""
    return MachineSpecBuilder()


def _connection(name: str, shared: str | None) -> MachineSpecPiece:
    return {"connections": {name: f"shared:{shared}" if shared else "personal"}}


def slack(*, shared: str | None = None) -> MachineSpecPiece:
    """The machine needs Slack: the owner's own connection, or the org one shared under ``shared``."""
    return _connection("slack", shared)


def jira(*, shared: str | None = None) -> MachineSpecPiece:
    """The machine needs Jira. See :func:`slack`."""
    return _connection("jira", shared)


def github(*, shared: str | None = None) -> MachineSpecPiece:
    """The machine needs GitHub. See :func:`slack`."""
    return _connection("github", shared)


def asana(*, shared: str | None = None) -> MachineSpecPiece:
    """The machine needs Asana. See :func:`slack`."""
    return _connection("asana", shared)


def claude() -> MachineSpecPiece:
    """The machine needs a Claude Code login."""
    return {"agents": ["claude"]}


def codex() -> MachineSpecPiece:
    """The machine needs a Codex login."""
    return {"agents": ["codex"]}


def secrets(*names: str) -> MachineSpecPiece:
    """The machine gets these secrets, by name: your own or the org's, usually
    ``unattached`` ones (``boxd.secrets.set(name, value, scope="unattached")``)."""
    return {"secrets": list(names)}


MachineSpecPatch = Mapping[str, Any]
"""A change to a machine's spec, for ``machines.update_spec()``: a JSON Merge
Patch (RFC 7396) on the spec. A field left out is untouched; a scalar replaces
the current value; maps (``labels``, ``env``, ``connections``) merge key by
key, a key set to ``None`` is removed; a list replaces the current list;
``None`` removes a field. ``base`` is replaced whole."""

_MAP_FIELDS = ("labels", "env", "connections")


def spec_patch(from_spec: Mapping[str, Any], to_spec: Mapping[str, Any]) -> dict[str, Any]:
    """The smallest patch that turns spec ``from_spec`` into ``to_spec``: what
    ``machines.update_spec(id, lambda s: ...)`` sends. The server computes the
    same."""
    a = _compact(from_spec)
    b = _compact(to_spec)
    out: dict[str, Any] = {}
    for key in FIELDS:
        x, y = a.get(key), b.get(key)
        if y is None:
            if x is not None:
                out[key] = None
        elif x is not None and key in _MAP_FIELDS:
            # Key by key, so the order a builder wrote them in doesn't matter.
            m: dict[str, Any] = {k: None for k in x if k not in y}
            m.update({k: v for k, v in y.items() if x.get(k) != v})
            if m:
                out[key] = dict(sorted(m.items()))
        elif x != y:
            out[key] = y
    return out


def check_patch(patch: Any) -> None:
    """Raise on what the server would refuse before reading the patch: not a
    mapping, or an unknown field."""
    if isinstance(patch, MachineSpecBuilder):
        raise MachineSpecError(
            "",
            "a patch is a JSON object, not a builder: pass builder.resolve() to set the fields "
            'it names, or a function (lambda s: s.network("ops")) to add to the '
            "machine's current spec",
        )
    if not isinstance(patch, Mapping):
        raise MachineSpecError("", 'a patch is a JSON object, e.g. {"labels": {"team": "ops"}}')
    for key in patch:
        if key not in FIELDS:
            raise MachineSpecError(key, f"unknown field; a spec has {', '.join(FIELDS)}")


def apply_patch(current: Mapping[str, Any], patch: MachineSpecPatch) -> MachineSpec:
    """Apply a patch the way the server does, before its checks (which also
    normalize, e.g. sort ``egress``). For tests and previews."""
    check_patch(patch)
    doc: dict[str, Any] = dict(_compact(current))
    for key, value in patch.items():
        if value is None:
            doc.pop(key, None)
        elif key in _MAP_FIELDS:
            m = dict(doc.get(key) or {})
            for k, v in value.items():
                if v is None:
                    m.pop(k, None)
                else:
                    m[k] = v
            doc[key] = dict(sorted(m.items()))
        else:
            doc[key] = value
    return _compact(doc)


def to_wire(value: MachineSpecBuilder | MachineSpecPiece) -> api_pb2.MachineSpec:
    """A builder or a spec, checked and as the API message."""
    s = value.resolve() if isinstance(value, MachineSpecBuilder) else merge_specs(value)
    msg = api_pb2.MachineSpec(
        version=s["version"],
        size=s.get("size", ""),
        assign_to=s.get("assignTo", ""),
        labels=s.get("labels", {}),
        networks=s.get("networks", []),
        isolated=s.get("isolated", False),
        egress=s.get("egress", []),
        env=s.get("env", {}),
        secrets=s.get("secrets", []),
        connections=s.get("connections", {}),
        agents=s.get("agents", []),
        packages=s.get("packages", []),
    )
    base = s.get("base")
    if base is not None:
        msg.base.CopyFrom(api_pb2.MachineSpecBase(**base))
    return msg


def from_wire(msg: api_pb2.MachineSpec, present: bool) -> MachineSpec | None:
    """A spec off the wire, in the stored form; None when the field is unset."""
    if not present:
        return None
    kind = msg.base.WhichOneof("kind") if msg.HasField("base") else None
    return _compact(
        {
            "version": msg.version,
            "base": {kind: getattr(msg.base, kind)} if kind else None,
            "size": msg.size,
            "assignTo": msg.assign_to,
            # Wire maps arrive in no particular order; sorted, a spec prints
            # the same every time.
            "labels": dict(sorted(msg.labels.items())),
            "networks": list(msg.networks),
            "isolated": msg.isolated,
            "egress": list(msg.egress),
            "env": dict(sorted(msg.env.items())),
            "secrets": list(msg.secrets),
            "connections": dict(sorted(msg.connections.items())),
            "agents": list(msg.agents),
            "packages": list(msg.packages),
        }
    )
