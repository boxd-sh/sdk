"""Public data models.

Every method returns one of these (or a plain `str`/`bytes`/`int`). They carry
no behaviour: a :class:`Machine` has fields, not an ``.exec()``. The wire shapes
they are built from live in `_mappers.py`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel

from .spec import MachineSpec
from .spec import spec as _spec_builder

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)




class VolumeMount(BaseModel):
    """A disk to mount into a machine at create/fork time."""

    disk_id: str
    mount_path: str
    read_only: bool = False


class ProxyEntry(BaseModel):
    """An HTTP proxy subdomain to set up at create time."""

    name: str
    port: int = 0
    """0 = auto-detect."""


# ── Machines ─────────────────────────────────────────────────────────

MachineStatus = Literal[
    "pending",
    "starting",
    "running",
    "suspended",
    "hibernated",
    "stopped",
    "failed",
    "destroyed",
    "migrating",
]


class OrgRef(BaseModel):
    """An org, by id and name. Both are set whenever this object exists."""

    id: str
    name: str


class MachineResources(BaseModel):
    """The machine's *effective* sizing. Concrete values, never a guess."""

    vcpu: int
    memory_bytes: int
    disk_bytes: int
    """The machine's fixed disk *allocation* — always the platform constant
    (100 GiB), identical on every machine. Not a usage figure: it does not grow
    as the disk fills. There is no "disk used" field on the API yet."""


class MachineAccess(BaseModel):
    ssh_port: int | None
    """SSH port for this machine; None until it has been allocated."""
    domain: str
    """The domain the machine is addressed under."""
    url: str
    """`https://<name>.<domain>` — built for you, not sent by the server."""
    desktop_url: str = ""
    """The machine's live Desktop view in the console —
    `https://app.<zone>/desktop/<name>`. Built for you, like `url`. Empty when
    the client has no endpoint to derive the console origin from. Opening it
    needs a signed-in browser; the machine is woken if it is asleep."""
    custom_domains: list[CustomDomain]
    """Per-VM custom domains bound to this machine, e.g.
    `app.example.com`. Distinct from `domain` above, which is the org's
    wildcard domain or the cluster zone. Empty if none are bound."""


class MachineIdle(BaseModel):
    """Idle timers, all in seconds. 0 means *disabled*, never "unset"."""

    suspend_after: int
    hibernate_after: int
    destroy_after: int


MachineSourceKind = Literal["fork", "snapshot"]

BotProtectionMode = Literal["on", "sleep_only", "off"]
"""A machine's bot protection mode. See ``Machine.bot_protection_mode``."""


class MachineSource(BaseModel):
    """Where a machine came from. A standalone machine has no source at all."""

    kind: MachineSourceKind | str
    name: str
    """The source machine's name (fork) or the snapshot's name (snapshot)."""
    version: int | None
    """Snapshot version. None for a fork, which has no version."""
    id: str | None
    """Id of the source machine or snapshot. PROVENANCE ONLY — it may not
    resolve: the source can have been destroyed or deleted since, and some
    older machines report a name and version with no id. Treat a lookup miss
    as normal."""


class MachineRequirement(BaseModel):
    """One thing a machine's spec needs connected (``Machine.requirements``).

    ``personal`` is the machine owner's own connection or agent login in the
    machine's org (for a machine created with ``assign_to``, the assignee's);
    ``shared`` is the org's connection shared under ``tag``.
    """

    kind: Literal["connection", "agent"]
    """A spec's ``connections`` entry, or one of its ``agents``."""
    name: str
    """The toolkit (``"slack"``, ``"github-app"``) or the agent (``"claude"``,
    ``"codex"``)."""
    scope: Literal["personal", "shared"]
    """Agents are always ``"personal"``."""
    tag: str | None = None
    """The shared connection's name; None for a personal one."""
    met: bool
    """Connected now, so the machine can use it."""
    can_fix: bool
    """You could connect it: the owner for a personal connection or an agent,
    an org owner or admin for a shared one. False once met, and when
    connecting couldn't help (``reason``)."""
    reason: str | None = None
    """Why it can't be met on this machine as it is: an isolated machine gets
    no integrations, a shared one no personal connection or agent login, a
    disabled owner's none. None otherwise."""


class MachinePackage(BaseModel):
    """One of a machine's spec ``packages`` (``Machine.packages``). The first
    failure stops the rest: the ones after it stay ``"pending"`` until a retry
    (``update_spec(id, {}, retry_packages=True)``), or until the failed command
    is removed from the spec, which skips it."""

    command: str
    """The command, as the spec lists it."""
    state: Literal["pending", "running", "done", "failed", "skipped"]
    """``"pending"``: not run yet (after a failure, not until a retry).
    ``"skipped"``: removed from the spec before it finished, so it never runs
    and doesn't stop the ones after it (``reason`` says when; a failed run
    keeps its exit code and output). Listing it again makes it pending."""
    exit_code: int | None = None
    """The exit code once it exited; None before, and for a timeout or an
    interrupted run."""
    output_tail: str = ""
    """The last 4 KiB of its output (stdout and stderr), every secret value the
    machine gets shown as ``[secret NAME]``. Empty on machines from
    ``machines.list()``, which leaves it out to stay small:
    ``machines.get()`` has it."""
    reason: str | None = None
    """Why it failed without an exit code (a timeout, interrupted too often),
    why a pending one waits (interrupted: it runs again once the machine is
    running) or won't run (a fork), why it was skipped, or that a done one ran
    before the snapshot it was restored from was taken. None otherwise."""
    started_at: datetime | None = None
    finished_at: datetime | None = None


MachineSpecApply = Literal["live", "reboot_recommended", "reboot", "refused"]
"""How a spec change reaches the machine (``MachineSpecChange.apply``):

- ``"live"``: now (labels, networks, egress; connections and agents change
  ``Machine.requirements``; added packages run now);
- ``"reboot_recommended"``: env and secrets reach new shells and exec sessions
  now, running processes keep the old values until they restart;
- ``"reboot"``: a new size for a running machine, which reboots it;
- ``"refused"``: ``base``, ``isolated`` and ``assignTo`` can't change, a fork
  runs no packages, a machine in standby or hibernated can't change size."""


class MachineSpecChange(BaseModel):
    """One changed field of a machine's spec (``MachineSpecUpdate.changes``)."""

    field: str
    """The spec field: ``"labels"``, ``"size"``, ``"packages"``, ..."""
    apply: MachineSpecApply
    added: list[str] = []
    """Map keys, list entries or commands added."""
    removed: list[str] = []
    changed: list[str] = []
    """Map keys whose value changes (values are never shown); for
    ``packages``, the commands a retry runs again."""
    before: str | None = None
    """Scalars (``size``, ``base``, ``assignTo``, ``isolated``): the value
    before, None when unset."""
    after: str | None = None
    note: str = ""
    """What happens on the machine, in one sentence."""
    warnings: list[str] = []
    """What the change won't do, e.g. a removed package isn't undone."""
    skipped: list[str] = []
    """``packages``: commands the change skips (removed from the spec before
    they finished: they never run and stop nothing)."""
    unskipped: list[str] = []
    """``packages``: skipped commands the change puts back to pending (listed
    again)."""


class MachineSpecUpdate(BaseModel):
    """What ``machines.update_spec()`` did, or (a dry run) would do."""

    changes: list[MachineSpecChange] = []
    """Every changed field, in the spec's order; empty when nothing changes."""
    reboot_required: bool = False
    """A change applies only through a reboot: pass ``reboot=True`` to allow it."""
    reboot_recommended: bool = False
    """A change reaches running processes only once they restart."""
    spec: MachineSpec
    """The machine's spec after the patch (for a dry run, what it would be)."""
    applied: bool = False
    """False for a dry run."""
    rebooted: bool = False
    """The machine was rebooted to apply it."""
    resize_error: str | None = None
    """The resize failed after the rest of the patch applied: its error, or
    None. Then ``applied`` is still True, ``rebooted`` False, and ``spec`` is
    the spec stored now, with the size the machine has."""


class MachineNetworking(BaseModel):
    """Which machines this one can reach, and be reached by, inside its org.

    Two machines are peers iff they share at least one entry in ``networks``,
    OR both have none and neither is ``isolated`` — the org's implicit
    **default network**. Naming a network therefore opts a machine OUT of the
    default network: it then reaches only machines it shares one with, and
    unnamed machines no longer reach it.

    ``isolated`` means "explicit networks only": an isolated machine is never
    in the default network and never peers with another isolated machine, so
    one with no ``networks`` has no peers at all. It also has no metadata
    endpoint, no in-VM ``boxd`` CLI, and no integrations. Inbound SSH/HTTPS
    and outbound internet are unaffected.

    The same rule governs internal DNS (``<name>.boxd``) and ``exec``/``cp``
    between machines, so what resolves is exactly what is reachable.
    """

    networks: list[str]
    isolated: bool
    """Set at creation and immutable — a fork always inherits it."""


class Machine(BaseModel):
    """A machine (VM), as returned by `machines.get` / `machines.list`."""

    id: str
    name: str
    # Widened to `str` on purpose: MachineStatus documents every value the
    # server produces today, but a status added server-side must not fail
    # validation and take the SDK down.
    status: MachineStatus | str
    image_ref: str
    restart_policy: str | None
    created_at: datetime | None
    """None on machines created before the platform recorded a creation time."""
    resources: MachineResources
    org: OrgRef | None
    """The org this machine belongs to and is billed to. None = your personal
    quota. A machine never moves between orgs."""
    shared: bool
    """Whether the machine is shared with that org, rather than private to you."""
    networking: MachineNetworking
    """East-west reachability inside the org. See :class:`MachineNetworking`."""
    egress_allow: list[str]
    """The machine's egress allowlist: what it may reach on the internet.
    Empty = unrestricted. ``["none"]`` = nothing is reachable. Otherwise
    HTTP(S) is admitted by hostname and everything else by address, and
    nothing not named here is reachable. Set with
    :meth:`Machines.set_egress_allow`."""
    labels: dict[str, str] = {}
    """User-set ``key=value`` labels, for grouping and finding machines. Set
    them with ``labels=`` on :meth:`Machines.create`, edit them with
    :meth:`Machines.update_labels`, filter by them with
    ``machines.list(labels=...)``. A fork or restore inherits its source's.
    Anyone who can see the machine can read them."""
    access: MachineAccess
    idle: MachineIdle
    bot_protection: bool
    """Whether visitors must pass a browser check before an HTTPS request
    reaches the machine. True for both protecting modes; see
    ``bot_protection_mode`` for which. Set with
    :meth:`Machines.set_bot_protection`."""
    bot_protection_mode: BotProtectionMode | None = None
    """How far bot protection reaches. ``"on"``: every request is checked,
    running or asleep, so crawlers can neither wake the machine nor keep it
    awake. ``"sleep_only"``: only a request that would wake the machine from
    standby or hibernation. ``"off"``: never. None only when the server did
    not report it (a ``create``/``fork`` whose re-read failed). Set with
    :meth:`Machines.set_bot_protection`."""
    idle_ignore_outbound: bool = False
    """Whether the idle clock behind auto-suspend and auto-hibernate ignores
    connections the machine opened itself, so only connections opened TO it
    (SSH, HTTPS, another machine) keep it awake. Off by default, unless its
    org says otherwise. Set with :meth:`Machines.set_idle_ignore_outbound`."""
    ssh: bool = True
    """Whether SSH answers on the machine's port (``access.ssh_port``). Off:
    nothing answers SSH for it, on the public address or the org's network;
    the port stays allocated. ``exec`` and ``boxd connect`` don't use SSH.
    Set with :meth:`Machines.set_ssh`."""
    delete_at: datetime | None = None
    """When the platform will permanently delete this machine, whatever state
    it is in. None = no delete-after timer. Set, extend or clear it with
    :meth:`Machines.set_delete_after`, or pass ``delete_after`` to
    :meth:`Machines.create` / :meth:`Machines.fork`. A fork inherits the
    timer, re-armed from the moment of the fork."""
    delete_after_cron: str | None = None
    """The cron expression the timer was set with, if any: ``delete_at`` is
    its next match. None for a duration or no timer."""
    source: MachineSource | None
    """None = standalone: booted from an image, not forked or restored."""
    hibernated_at: datetime | None
    """When the machine went to disk. None = not hibernated."""
    last_connected_at: datetime | None
    """Last client connection. None = never connected."""
    boot_time_ms: int | None
    """How long the last boot took, in milliseconds. None = never booted."""
    paused_automations: int = 0
    """Set on the machine ``fork()`` returns, and on one ``create()`` made from
    a snapshot (a team's default snapshot included): how many automations it
    was born with paused. A fork or a snapshot carries its source's
    automations but the new machine does not run them, so the same schedule
    or webhook is not handled twice; ``run restart <id>`` inside it starts one
    there. 0 from every other call."""
    spec: MachineSpec | None = None
    """The machine spec as it stands: the one it was created from
    (``create(spec=...)``), or inherited from its snapshot or fork source.
    ``machines.update_spec()`` changes it, and editing labels, networks,
    egress or the size updates the matching field. None when the machine has none. (On the class, ``Machine.spec()`` starts
    a new spec instead; see :mod:`boxd.spec`.)"""
    created_spec: MachineSpec | None = None
    """The spec the machine was created with. Edits never change it."""
    created_by: str | None = None
    """Who created the machine for its owner (a spec's ``assignTo``): their
    user id. None when the owner created it."""
    created_by_name: str | None = None
    """A name to show for ``created_by`` (display name, else GitHub username);
    None when the account has none."""
    requirements: list[MachineRequirement] = []
    """What the spec's ``connections`` and ``agents`` need, and whether each
    is connected now (computed when the machine is read). Empty without a
    spec. An unmet one is only unavailable on the machine: nothing blocks
    it."""
    packages: list[MachinePackage] = []
    """How each of the spec's ``packages`` went, in order: shell commands run
    once after the first boot. Empty without any. The whole output is in
    ``/var/log/boxd/packages.log`` in the machine."""


class _SpecEntry:
    """``Machine.spec()`` on the class starts a spec builder; ``machine.spec``
    on an instance is the machine's spec field. Set after the class is built,
    so pydantic keeps ``spec`` as an ordinary field: an instance finds the
    field's value in its own ``__dict__`` before this descriptor."""

    def __get__(self, obj: Any, owner: Any = None) -> Any:
        if obj is None:
            return _spec_builder
        return obj.__dict__.get("spec")


type.__setattr__(Machine, "spec", _SpecEntry())



class SelfDeleteResult(BaseModel):
    """What :meth:`Machines.delete_self` answers: the machine is going away."""

    id: str
    name: str
    deletes_in_secs: int
    """The machine is deleted this long after the call returns. Anything still
    running on it, including the calling process, stops then."""


class ExecResult(BaseModel):
    """A one-shot `machines.exec`.

    `stdout`/`stderr` are `str`, UTF-8-decoded, unless `encoding="buffer"`
    was passed to `exec`, in which case they're the raw `bytes` instead. The
    default decode is lossy — any invalid byte sequence is replaced with
    U+FFFD — so binary output (or output you need byte-exact) should use
    `encoding="buffer"` or `stream_exec`, which is always byte-exact.
    """

    stdout: str | bytes
    stderr: str | bytes
    exit_code: int

    @property
    def success(self) -> bool:
        return self.exit_code == 0


class ExposedPort(BaseModel):
    """A public TCP/UDP forward onto a machine port."""

    machine_id: str
    """The machine this forward belongs to — address it without a name lookup."""
    machine_name: str
    dns: str
    """Hostname the forward is reachable at — connect on `public_port`."""
    public_port: int
    machine_port: int
    protocol: str
    """"tcp" | "udp" | "both"."""


ProxyPortMode = Literal["locked", "auto"]
""""locked" = you pinned the port; "auto" = discovered inside the machine."""


class Proxy(BaseModel):
    """An HTTP proxy subdomain pointing at a port inside a machine."""

    name: str | None
    """None for the machine's default proxy."""
    machine_id: str
    """The machine this route points at — address it without a name lookup."""
    machine_name: str
    domain: str
    port: int
    """The port traffic is actually forwarded to. Always concrete."""
    port_mode: ProxyPortMode | str
    is_default: bool


class CreatedProxy(BaseModel):
    """Creating a proxy answers before the route is live, so it confirms only
    the subdomain and the port it was pointed at. The machine id, the full
    domain and the resolved port are what `list()` is for."""

    name: str
    port: int


class Checkpoint(BaseModel):
    """A per-machine capture, restored in place. Lives and dies with the machine."""

    id: str
    name: str
    status: str
    """"pending" | "ready" | "failed"."""
    size_bytes: int
    created_at: datetime
    created_by: str | None
    """Who captured it. None on checkpoints taken before this was recorded."""
    available: bool
    """Restorable right now — a read-only mirror of `status == "ready"` (also
    `False` if the machine has since migrated off the checkpoint's worker).
    Poll `status` for `"ready"` before calling `restore()`; `available` can't
    read `True` while `status` is still `"pending"`."""


class CreatedCheckpoint(BaseModel):
    id: str
    name: str
    status: str


class BackupSchedule(BaseModel):
    """A machine's disaster-recovery backup schedule. `None` from
    `backups.schedule.get()` means backups are off (no separate flag)."""

    schedule_kind: Literal["cron", "interval"] | str
    schedule_value: str
    """A cron expression, or an interval in seconds as text, per `schedule_kind`."""
    retention_secs: int
    next_backup_at: datetime
    last_backup_at: datetime | None
    """None until the first tick resolves."""


class Backup(BaseModel):
    """A single disaster-recovery backup of a machine's disk."""

    id: str
    status: str
    """"pending" | "ready" | "dedup" | "failed"."""
    size_bytes: int
    """0 for pending/dedup/failed."""
    checksum: str | None
    """sha256, hex. None for pending/dedup/failed."""
    points_to_backup_id: str | None
    """Set iff `status == "dedup"` — the backup this one is a cheap pointer to."""
    created_at: datetime
    expires_at: datetime


class PauseResult(BaseModel):
    suspend_us: int
    """How long the suspend took, in microseconds."""


class ResumeResult(BaseModel):
    resume_us: int


class ResizeResult(BaseModel):
    """The size a machine now carries, after `machines.resize`."""

    vcpu: int
    memory_bytes: int
    rebooted: bool
    """True when the machine was running and was rebooted to apply the size.
    A stopped machine picks the new size up at its next start instead."""


class DirEntry(BaseModel):
    """One entry from `machines.files.list_dir` — a file or subdirectory."""

    name: str
    """Basename only, not the full path."""
    is_dir: bool
    size_bytes: int
    """Meaningless (always 0) for a directory."""
    permissions: str
    """ls-style, e.g. "-rw-r--r--" or "drwxr-xr-x"."""
    modified_at: datetime
    added_at: datetime
    """Approximated with ctime — bumps on rename/chmod/chown, not just creation."""


class DirListing(BaseModel):
    """`machines.files.list_dir`'s result: the entries, plus whether the
    directory held more than the server's per-listing cap."""

    entries: list[DirEntry]
    truncated: bool
    """True when `entries` is only the first slice of a bigger directory (in
    no particular order) — never treat a truncated listing as the whole
    folder."""


FsEntryType = Literal["file", "directory", "symlink", "other"]
""""other" is a FIFO, socket or device."""


class FsEntry(BaseModel):
    """A file, directory or symlink inside a machine, from `machines.fs`.

    `size`, `mode`, `uid`, `gid` and `mtime_ns` describe what the entry
    resolves to, so a symlink to a file reports the file's. A dangling symlink
    reports the link itself.

    Names and paths that aren't valid UTF-8 keep their bytes as surrogate
    escapes (like `os.fsdecode`), so passing them back to `machines.fs`
    reaches the same file.
    """

    name: str
    """Base name."""
    path: str
    """The path as given to `stat`, or the listed directory joined with `name`."""
    type: FsEntryType
    """The entry itself: a symlink is "symlink"."""
    target_type: FsEntryType | None
    """What the entry resolves to after following symlinks: the same as
    `type` for anything but a symlink, None when a symlink dangles or loops."""
    size: int
    mode: int
    """Permission bits, e.g. 0o644."""
    mtime_ns: int
    """Modification time, nanoseconds since the Unix epoch."""
    uid: int
    gid: int
    symlink_target: str | None = None
    """What a symlink points to, as stored; None for anything else."""

    @property
    def is_dir(self) -> bool:
        """A directory, or a symlink to one."""
        return self.target_type == "directory"

    @property
    def is_file(self) -> bool:
        """A regular file, or a symlink to one."""
        return self.target_type == "file"

    @property
    def is_symlink(self) -> bool:
        return self.type == "symlink"

    @property
    def mtime(self) -> datetime:
        """`mtime_ns` as an aware UTC datetime (microsecond precision)."""
        return _EPOCH + timedelta(microseconds=self.mtime_ns // 1000)


# ── Snapshots ────────────────────────────────────────────────────────


class Snapshot(BaseModel):
    """A durable, account-level point-in-time capture (memory + disk)."""

    id: str
    name: str
    version: int | None
    """Latest ready version; None = nothing captured yet."""
    status: str
    """"pending" | "ready" | "failed"."""
    size_bytes: int
    created_at: datetime | None
    """First capture. Does NOT move when a new version is saved."""
    updated_at: datetime | None
    """Last capture — moves with every new version."""
    vcpu: int
    memory_bytes: int
    use_count: int
    storage: str = "local"
    """Where its bytes are: "local" (on a worker's disk), "archiving" (being
    copied to object storage), "archived" (in object storage only) or
    "unarchiving" (being restored to disk). A plain string, so a value added
    later doesn't break older clients."""
    archived: bool = False
    """True unless ``storage`` is "local": machines can't be created from it,
    nor can it be saved again, until an operator unarchives it."""


class CreatedSnapshot(BaseModel):
    id: str
    name: str
    version: int
    status: str
    paused_automations: int = 0
    """How many of the source machine's automations this version captured.
    Every machine created from it is born with them paused, as a fork is, so
    nothing runs twice; ``run restart <id>`` inside that machine starts one."""


# ── Disks ────────────────────────────────────────────────────────────


class DiskAttachment(BaseModel):
    machine_id: str
    machine_name: str
    mount_path: str
    mount_mode: str
    """"ro" or "rw"."""


DiskStatus = Literal["creating", "ready", "destroyed"]
""""creating" until the backing file is allocated and formatted, "ready" once
it can be attached, "destroyed" after deletion."""


class Disk(BaseModel):
    id: str
    name: str
    size_bytes: int
    status: DiskStatus | str
    created_at: datetime | None
    """None on disks created before the platform recorded a creation time."""
    attachments: list[DiskAttachment]


class CreatedDisk(BaseModel):
    id: str
    name: str
    size_bytes: int
    status: DiskStatus | str


# ── Domains ──────────────────────────────────────────────────────────


class CustomDomain(BaseModel):
    domain: str
    machine_id: str
    machine_name: str
    status: str
    """"pending" | "active"."""
    last_error: str
    """Empty when active / healthy."""


class OrgDomain(BaseModel):
    org_id: str
    domain: str
    status: str
    """"pending" | "active"."""
    last_error: str
    """Empty when active / healthy."""



VarScope = Literal["all", "shared", "private", "unattached", "private-unattached"]
"""Which machines a var applies to. ``unattached`` and ``private-unattached``
are for secrets only: such a secret reaches only machines whose spec lists it
in ``secrets``."""


class EnvVar(BaseModel):
    """An environment variable. Values are readable."""

    name: str
    scope: VarScope | str
    value: str


class Secret(BaseModel):
    """A secret. No `value`, by construction — the server never returns one."""

    name: str
    scope: VarScope | str
    domains: list[str]
    """Hosts the secret may be sent to. Empty = the real value is injected
    into the machine. Non-empty = the machine only ever holds a ``bxds_…``
    placeholder and the real value is substituted into requests to exactly
    these hosts on the way out. See :meth:`Secrets.set`."""
    bound_machines: int = 0
    """How many machines list this secret in their spec. Only unattached
    secrets have any; 0 for the rest."""


# ── Orgs ─────────────────────────────────────────────────────────────


class Org(BaseModel):
    id: str
    name: str
    """Display label; may be shared across orgs."""
    slug: str
    """Unique key for the org — what you pass wherever an org is named."""
    is_admin: bool
    is_default: bool
    """Your default org — where personal machines are billed."""


class OrgMachineDefaults(BaseModel):
    """The size new machines in an org are born at, and the quota above it."""

    is_set: bool
    """True when the org stores an explicit default. False means the effective
    values below are simply the quota ceiling."""
    vcpu: int
    """Effective default — what a create with no size asks for."""
    memory_bytes: int
    ceiling_vcpu: int
    """The org quota. A create or resize above it is refused, never clamped."""
    ceiling_memory_bytes: int


class MachineLimitRequest(BaseModel):
    """An open request for a higher machine limit."""

    requested_at: datetime
    max_vms: int | None
    """The machine limit asked for, in total. None for a request that named
    no number."""


class OrgMachineLimit(BaseModel):
    """How many machines an org may have at once, how many it has, and the
    open request for more."""

    org_id: str
    org_name: str
    max_vms: int
    """The machine limit."""
    vm_count: int
    """Machines that count against it now."""
    is_owner: bool
    """True when you are the org's owner, who may ask for more."""
    request: MachineLimitRequest | None
    """The open request for a higher limit, or None. The owner's message is
    never shown back."""


class OrgIdleIgnoreOutboundDefault(BaseModel):
    """Whether new machines in an org start with ``idle_ignore_outbound`` on."""

    is_set: bool
    """True when the org stores an explicit default. False means new machines
    follow the platform's setting, which is what ``enabled`` then holds."""
    enabled: bool
    """Effective default: what a create that does not say gets."""
    platform_enabled: bool = False
    """The platform's setting, whether or not the org has its own default:
    what clearing it would give. False from a server that predates the
    field."""


class OrgIdleIgnoreOutboundDefaultResult(BaseModel):
    """What `orgs.set_idle_ignore_outbound_default` did to the org's existing
    machines. All counts are 0 with ``new_machines_only=True``."""

    machines_changed: int
    """Existing machines whose value was changed."""
    snapshots_changed: int
    """Snapshots whose value was changed (a restore takes its snapshot's)."""
    machines_skipped: int
    """Other members' private machines, left as they were."""


class OrgBotProtectionDefault(BaseModel):
    """The bot protection mode new machines in an org start with."""

    is_set: bool
    """True when the org stores an explicit default. False means new machines
    follow the platform's setting, which is what ``mode`` then holds."""
    mode: BotProtectionMode
    """What a machine created in the org right now starts with."""
    platform_mode: BotProtectionMode | None = None
    """The platform's setting, whether or not the org has its own default:
    what clearing it would give. None from a server that predates the field."""


class OrgBotProtectionDefaultResult(BaseModel):
    """What `orgs.set_bot_protection_default` did to the org's existing
    machines. All counts are 0 with ``new_machines_only=True``."""

    machines_changed: int
    """Existing machines whose mode was changed."""
    snapshots_changed: int
    """Snapshots whose mode was changed (a restore takes its snapshot's)."""
    machines_off: int
    """Machines with bot protection off, left off."""
    machines_skipped: int
    """Other members' private machines, left as they were."""


class CreatedOrg(BaseModel):
    id: str
    name: str


OrgRole = Literal["owner", "admin", "member"]


class OrgMember(BaseModel):
    user_id: str
    role: OrgRole | str
    display_name: str
    """Empty when the member has none set."""
    github_username: str
    """Empty when the member isn't signed in via GitHub."""


class OrgInvite(BaseModel):
    """A pending invite. Visible to org admins only — a plain member's
    :meth:`Orgs.get_members` returns an empty invite list."""

    token: str
    email: str
    accept_url: str
    created_at: datetime
    expires_at: datetime
    role: Literal["admin", "member"] | str
    """The role the invitee lands with on accept."""
    email_status: str = ""
    """What happened to the invite email. From :meth:`Orgs.invite`:
    ``"sent"``, ``"failed"`` (the send was refused) or ``"not_configured"``
    (the cluster sends no email). From :meth:`Orgs.get_members`, also the
    mail provider's delivery reports: ``"delivered"``, ``"delivery_delayed"``,
    ``"bounced"``, ``"complained"``, ``"opened"``, ``"clicked"``. ``""`` =
    unknown (an older server or invite). ``accept_url`` works either way, so
    share it yourself when the email didn't arrive."""


class OrgMembers(BaseModel):
    members: list[OrgMember]
    invites: list[OrgInvite]


# ── Teams ────────────────────────────────────────────────────────────


class TeamMember(BaseModel):
    user_id: str
    role: Literal["admin", "member"] | str
    display_name: str
    github_username: str
    added_at: datetime


class Team(BaseModel):
    """An org-scoped sub-group of members, with an optional default snapshot
    new team machines boot from."""

    id: str
    org_id: str
    name: str
    created_by_user_id: str
    """Empty if the creating user no longer exists."""
    created_at: datetime
    is_admin: bool
    """True when the caller has team-admin authority — an inherited org
    admin/owner, or a direct team-admin membership."""
    members: list[TeamMember]
    default_snapshot_id: str | None
    """None when no default is set."""


class ApiKey(BaseModel):
    id: str
    name: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None
    """None = never used."""
    expires_at: datetime | None
    """None = no expiry."""
    org: str
    """Org the key is fenced to — every key is scoped to exactly one."""
    kind: str
    """"member" (acts as you) | "org" (userless service credential)."""
    created_by: str = ""
    """Who made it: display name, else sign-in handle. An org admin also gets
    the org's "org" keys other people made, and may delete them."""
    mine: bool = True
    """You made it."""


class CreatedApiKey(BaseModel):
    id: str
    api_key: str
    """The raw key — shown once, never stored."""
    expires_at: datetime | None




class Billing(BaseModel):
    subscription_status: str | None
    """"active" | "trialing" | "past_due" | "canceled"."""
    past_due_since: datetime | None
    max_vms: int
    """Effective quota."""
    vcpu: int
    memory_bytes: int



# ── Usage & cost ─────────────────────────────────────────────────────


class UsageRates(BaseModel):
    """Rates costs are priced at: micro-units (1e-6) of the org's currency per
    unit-hour."""

    vcpu_hour_micro: int
    """Per vCPU-hour while running."""
    ram_gib_hour_micro: int
    """Per GiB-hour of resident RAM, while running or in standby."""
    disk_gib_hour_micro: int
    """Per GiB-hour of used disk, in every state."""


class StateSeconds(BaseModel):
    """Seconds a machine spent in each state over the window."""

    running: int
    standby: int
    hibernated: int
    stopped: int


class UsagePeriod(BaseModel):
    """The window usage covers. Usage is metered in 15-minute buckets."""

    start: datetime
    end: datetime
    """Exclusive."""


class MachineUsage(BaseModel):
    """One machine's usage and cost over a window."""

    machine_id: str
    name: str
    """Current name, or the last one seen if the machine was deleted."""
    owner_id: str | None
    """Owner's user id. None for a machine no user owns."""
    owner_name: str | None
    """Owner's human label. None when nothing better than the id is known."""
    shared: bool
    status: str
    """The machine's current status, or "deleted" once it no longer exists."""
    resources: MachineResources
    """Size now (or when last seen, if deleted)."""
    seconds: StateSeconds
    vcpu_hours: float
    """vCPU-hours while running."""
    ram_gib_hours: float
    """GiB-hours of resident RAM while running or in standby."""
    disk_gib_hours: float
    """GiB-hours of used disk, in every state."""
    cost_micro: int
    """Estimated cost at current rates, micro-units of the currency
    (``cost_micro / 1e6`` is the amount). Billing activity is what was charged."""
    complete: bool
    """All of this machine's usage in the window has been metered, so the
    figures won't grow. Metering lags by up to ~25 minutes: a machine read
    right after ``delete()`` is not complete yet, and one that still exists
    never is in a window that runs to now. Store a cost once this is True."""


class MachineUsageReport(MachineUsage):
    """`machines.usage()`: one machine over a window."""

    period: UsagePeriod
    currency: str
    """Lower-case ISO 4217: "eur" or "usd"."""
    rates: UsageRates


class OrgUsage(BaseModel):
    """`orgs.usage()`: every machine in an org over a window."""

    org_id: str
    org: str
    period: UsagePeriod
    currency: str
    """Lower-case ISO 4217: "eur" or "usd"."""
    rates: UsageRates
    total_cost_micro: int
    """Sum of the machines' ``cost_micro``."""
    complete: bool
    """Every machine is complete, so the total won't grow."""
    machines: list[MachineUsage]
    """Most expensive first, including machines deleted since."""


class BillingActivityEntry(BaseModel):
    """One entry of the org's billing activity: what was actually charged or added."""

    id: str
    kind: str
    """"usage_charge" (one org-wide charge per 15 minutes), "topup", "grant",
    "signup", "promo", "adjustment", "operator_credit". New kinds may appear."""
    amount_micro: int
    """Signed micro-units of the currency: credits positive, charges negative."""
    created_at: datetime


class BillingActivityPage(BaseModel):
    """`orgs.billing_activity_page()`: one page of billing activity, newest first."""

    currency: str
    balance_micro: int
    """The org's balance now, micro-units of ``currency``."""
    entries: list[BillingActivityEntry]
    next_page_token: str | None
    """Pass as ``page_token`` for the next (older) page. None = this was the last."""


class Account(BaseModel):
    user_id: str
    display_name: str | None
    """Identity handle / display name; None falls back to `user_id`."""
    pubkey_fingerprints: list[str]
    billing: Billing


class ClusterConfig(BaseModel):
    default_image: str
    zone: str


__all__ = [
    "Account",
    "ApiKey",
    "Billing",
    "Checkpoint",
    "ClusterConfig",
    "CreatedApiKey",
    "CreatedCheckpoint",
    "CreatedDisk",
    "CreatedProxy",
    "CreatedSnapshot",
    "CustomDomain",
    "Disk",
    "DiskAttachment",
    "DiskStatus",
    "EnvVar",
    "ExecResult",
    "SelfDeleteResult",
    "ExposedPort",
    "Machine",
    "MachineAccess",
    "MachineIdle",
    "MachineResources",
    "MachineSource",
    "MachineSourceKind",
    "MachineStatus",
    "BotProtectionMode",
    "Org",
    "OrgBotProtectionDefault",
    "OrgDomain",
    "OrgRef",
    "PauseResult",
    "Proxy",
    "ProxyEntry",
    "ProxyPortMode",
    "ResumeResult",
    "Secret",
    "Snapshot",
    "VarScope",
    "VolumeMount",
]
