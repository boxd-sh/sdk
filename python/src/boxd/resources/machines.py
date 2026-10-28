"""`boxd.machines` — create and control machines, plus its sub-namespaces."""

from __future__ import annotations

import asyncio
import random
import shlex
import time
import warnings
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Literal

import grpc
import httpx

from .. import _credentials as _creds
from .. import _mappers as m
from .. import _requests as req
from .. import spec as _spec
from .._generated import api_pb2
from .._streaming import AsyncExecStream, ExecStream
from ..errors import APIConnectionError, BoxdError, ConflictError
from ..models import (
    Backup,
    BackupSchedule,
    BotProtectionMode,
    Checkpoint,
    CreatedCheckpoint,
    DirListing,
    ExecResult,
    ExposedPort,
    SelfDeleteResult,
    Machine,
    MachineUsageReport,
    PauseResult,
    CreatedProxy,
    ProxyEntry,
    Proxy,
    MachineSpecUpdate,
    ResizeResult,
    ResumeResult,
    VolumeMount,
)
from ..spec import MachineSpec, MachineSpecBuilder, MachineSpecPatch
from . import Namespace
from .fs import AsyncFs, Fs

# ── delete_self ────────────────────────────────────────────

_SELF_DESTROY_PATH = "/v1/self/destroy"
_SELF_DELETE_TIMEOUT_SECS = 30.0
_NOT_INSIDE = (
    "delete_self() only works inside a boxd machine: it deletes the machine "
    "the code runs on. From anywhere else, use machines.delete(id)"
)
_ADAPTER_SILENT = (
    "delete_self() needs the machine's metadata adapter, and the one at {url} "
    "did not answer (isolated machines have none). Use machines.delete(id) "
    "with an API key instead"
)


def _with_paused_automations(
    machine: Machine, count: int, *, from_snapshot: bool = False
) -> Machine:
    """Record on a fork, or a machine created from a snapshot, how many
    automations it was born with paused, and warn.

    Both carry their source's automations but do not run them, or the same
    schedule or webhook would be handled twice. Worth saying out loud: nothing
    else about the new machine shows it.
    """
    if count <= 0:
        return machine
    subject = "1 automation is" if count == 1 else f"{count} automations are"
    if from_snapshot:
        subject = (
            "1 automation from the snapshot is"
            if count == 1
            else f"{count} automations from the snapshot are"
        )
    warnings.warn(
        f"{subject} paused in {machine.name} so nothing runs twice. Inside it, "
        "`run jobs` lists them and `run restart <id>` starts one.",
        stacklevel=3,
    )
    return machine.model_copy(update={"paused_automations": count})


def _self_delete_body(confirm: str) -> dict[str, str]:
    if not confirm or not confirm.strip():
        raise ValueError(
            "delete_self(confirm=...) needs this machine's name, to confirm you "
            "mean to delete the machine this code runs on"
        )
    return {"confirm_name": confirm}


def _json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _self_delete_result(status: int, text: str, body: Any) -> SelfDeleteResult:
    """The adapter answers 200 with the machine, or 400 ``{"error": ...}``
    with a message written for the caller (wrong name, shared, not owner)."""
    if status != 200 or not isinstance(body, dict):
        msg = body.get("error") if isinstance(body, dict) else None
        raise BoxdError(msg or f"self-delete failed: {status} {text}")
    return SelfDeleteResult(
        id=str(body.get("vm_id", "")),
        name=str(body.get("name", "")),
        deletes_in_secs=int(body.get("destroy_in_secs", 2)),
    )


# A machine that reaches one of these is never going to become ready.
_TERMINAL_STATES = {"failed", "destroyed", "stopped"}
# UploadFileStream chunk size — comfortably under the 4 MiB gRPC message cap
# that the non-streaming UploadFile is stuck with.
_UPLOAD_CHUNK_BYTES = 1 << 20


def _create_request(
    *,
    name: str | None,
    image: str | None,
    from_snapshot: str | None,
    org: str | None,
    shared: bool,
    env: Mapping[str, str] | None,
    cmd: Sequence[str] | None,
    restart_policy: str | None,
    networks: Sequence[str] | None,
    isolated: bool,
    config_kwargs: dict,
    labels: Mapping[str, str] | None = None,
    spec: MachineSpecBuilder | Mapping[str, Any] | None = None,
    sets_delete_after: bool = False,
) -> tuple[str, object]:
    """Pick the create RPC and build its request.

    `CreateVmFromSnapshot` is a separate RPC on the wire; the SDK folds it into
    `create(from_snapshot=...)`. It accepts only name/config/org, so anything
    else is rejected loudly rather than silently dropped.

    The TypeScript SDK refuses the same combination at *compile* time, via a
    union on the presence of `from_snapshot`. Python cannot express that as
    cleanly, so it stays a runtime check — same rule, same message, different
    mechanism. See `docs/sdk/design.md`.
    """
    config = req.vm_config(**config_kwargs)
    wire_spec = None
    if spec is not None:
        # The spec carries these; the server refuses them next to one too.
        covered = [
            label
            for label, value in (
                ("image", image),
                ("env", env),
                ("networks", networks or None),
                ("isolated", isolated or None),
                ("labels", labels or None),
                ("vcpu", config_kwargs.get("vcpu")),
                ("memory", config_kwargs.get("memory")),
            )
            if value
        ]
        if covered:
            raise _spec.MachineSpecError(
                "",
                "create(spec=...) does not accept "
                + ", ".join(covered)
                + ": put "
                + ("it" if len(covered) == 1 else "them")
                + " in the spec",
            )
        wire_spec = _spec.to_wire(spec)
        # A delete-after timer is a second call once the machine exists,
        # which the creator of a machine for someone else may not make: it is
        # the assignee's. Refused before anything is created.
        if wire_spec.assign_to and sets_delete_after:
            raise _spec.MachineSpecError(
                "assignTo",
                "a machine created for someone else is theirs to manage, so the create "
                "can't also set delete_after or delete_after_cron",
            )
    if from_snapshot:
        rejected = [
            label
            for label, value in (
                ("image", image),
                ("env", env),
                ("cmd", cmd),
                ("restart_policy", restart_policy),
                ("shared", shared or None),
                # Captured on the snapshot at save time and replayed from it;
                # settable afterwards with `set_networks`. (`isolated` is NOT
                # rejected — it is a one-way override the restore accepts.)
                ("networks", networks or None),
            )
            if value
        ]
        if rejected:
            raise ValueError(
                "create(from_snapshot=...) does not accept "
                + ", ".join(rejected)
                + " — restoring a snapshot replays the machine as it was "
                "captured, it does not configure a new one"
            )
        request = req.create_vm_from_snapshot(
            snapshot=from_snapshot,
            name=name,
            org=org,
            isolated=isolated,
            config=config,
            labels=labels,
        )
        if wire_spec is not None:
            request.spec.CopyFrom(wire_spec)
        return "CreateVmFromSnapshot", request
    request = req.create_vm(
        name=name,
        image=image,
        env=env,
        cmd=cmd,
        restart_policy=restart_policy,
        org=org,
        shared=shared,
        networks=networks,
        isolated=isolated,
        config=config,
        labels=labels,
    )
    if wire_spec is not None:
        request.spec.CopyFrom(wire_spec)
    return "CreateVm", request


def _exec_init(
    machine_id: str,
    command: str | Sequence[str],
    *,
    env: Mapping[str, str] | None,
    tty: bool,
    cols: int,
    rows: int,
    cwd: str | None = None,
) -> api_pb2.ExecChunk:
    """The first chunk of an `Exec` stream: command, PTY flags, geometry."""
    line = req.join_command(command)
    if env:
        # There is no env field on ExecChunk — the command runs through a
        # shell, so prefix assignments do the job.
        prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
        line = f"{prefix} {line}"
    if cwd:
        # Same reasoning as `env`: no cwd field on ExecChunk, so `cd` ahead of
        # the command through the same shell. `&&` means a `cwd` that doesn't
        # exist fails fast with `cd`'s own error instead of silently running
        # in the default directory.
        line = f"cd {shlex.quote(cwd)} && {line}"
    return req.exec_chunk(
        machine_id=machine_id, command=line, tty=tty, cols=cols, rows=rows
    )


@contextmanager
def _exec_timeout(timeout: float | None):
    """Report a `timeout=` that ran out as such, not as a generic wire error.

    The call is given up on; whatever it started inside the machine may well
    still be running.
    """
    try:
        yield
    except (BoxdError, grpc.RpcError) as err:
        code = err.code if isinstance(err, BoxdError) else None
        if isinstance(err, grpc.RpcError) and callable(getattr(err, "code", None)):
            got = err.code()
            code = got.name.lower() if got is not None else None
        if timeout is not None and code == "deadline_exceeded":
            raise BoxdError(f"exec timed out after {timeout}s") from None
        raise


# Waits before each retry of an exec whose machine agent didn't answer.
_EXEC_RETRY_BACKOFF = (1.0, 3.0)

# The server's message when it couldn't reach the machine's agent: nothing was
# sent to the machine, so the command never started and running it again is
# safe. Any other failure may come after the command started.
_AGENT_UNREACHABLE = "cannot connect to VM agent"


def _exec_retry_wait(
    err: BoxdError, attempt: int, deadline: float | None
) -> float | None:
    """Seconds to wait before running a one-shot exec again after `err`, or
    None to raise it: only a command that never started is run again, a
    bounded number of times and within the caller's `timeout`."""
    if attempt >= len(_EXEC_RETRY_BACKOFF):
        return None
    if err.code != "unavailable" or not err.message.startswith(_AGENT_UNREACHABLE):
        return None
    wait = _EXEC_RETRY_BACKOFF[attempt]
    if deadline is not None and time.monotonic() + wait >= deadline:
        return None
    return wait


def _finish_exec(
    stdout: bytes, stderr: bytes, exit_code: int, encoding: str
) -> ExecResult:
    """Build the final `ExecResult`, honoring `encoding`.

    `"buffer"` returns the raw bytes untouched — byte-exact, same as
    `stream_exec`. Anything else (default `"utf-8"`) decodes lossily: any
    invalid byte sequence is replaced with U+FFFD, so binary output should
    use `"buffer"` instead (see `ExecResult`).
    """
    if encoding == "buffer":
        return ExecResult(stdout=stdout, stderr=stderr, exit_code=exit_code)
    return ExecResult(
        stdout=stdout.decode("utf-8", errors="replace"),
        stderr=stderr.decode("utf-8", errors="replace"),
        exit_code=exit_code,
    )


def _collect_exec(chunks, encoding: str = "utf-8") -> ExecResult:
    """Fold an `Exec` response stream into a one-shot result."""
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    exit_code = -1
    for chunk in chunks:
        if chunk.data:
            (stderr if chunk.is_stderr else stdout).append(chunk.data)
        exit_code = chunk.exit_code
    return _finish_exec(b"".join(stdout), b"".join(stderr), exit_code, encoding)


def _bot_protection_mode(
    enabled: bool | None, mode: BotProtectionMode | None
) -> BotProtectionMode:
    """The mode a ``set_bot_protection`` call asks for: ``mode`` as given, or
    the older ``enabled`` flag read as on/off."""
    if (enabled is None) == (mode is None):
        raise ValueError("pass either enabled or mode")
    if mode is None:
        return "on" if enabled else "off"
    if mode not in ("on", "sleep_only", "off"):
        raise ValueError(f"mode must be 'on', 'sleep_only' or 'off', not {mode!r}")
    return mode


def _spec_patch_doc(
    machine_id: str,
    current: MachineSpec | None,
    patch: MachineSpecPatch | Callable[[MachineSpecBuilder], MachineSpecBuilder],
) -> dict[str, Any]:
    """The patch ``update_spec`` sends: ``patch`` itself, or what a builder
    function adds to the current spec (``current`` is read only for one)."""
    if not callable(patch):
        _spec.check_patch(patch)
        return dict(patch)
    if current is None:
        raise _spec.MachineSpecError(
            "",
            f"machine {machine_id!r} wasn't created from a spec, so it has no spec to update",
        )
    target = patch(MachineSpecBuilder().with_(current)).resolve()
    return _spec.spec_patch(current, target)


# How many times the function form of ``update_spec`` tries again on a conflict.
_UPDATE_SPEC_RETRIES = 3


def _retry_pause(attempt: int) -> float:
    """Seconds to wait before retry ``attempt`` (1-based): updates racing each
    other would collide again in step, so longer each time, and jittered."""
    return 0.1 * attempt + random.random() * 0.2


def _spec_conflict(e: ConflictError) -> bool:
    """The spec changed during the update (aborted), not failed_precondition,
    which is a ConflictError too but would refuse again."""
    return e.code == "aborted"


def _ready_check(machine: Machine, name: str) -> bool:
    """True once the machine is running; raises if it can never get there."""
    if machine.status == "running":
        return True
    if machine.status in _TERMINAL_STATES:
        raise BoxdError(
            f"machine {name} entered terminal state {machine.status!r} while waiting"
        )
    return False


# ── Sync ─────────────────────────────────────────────────────────────


class Machines(Namespace):
    """Create, inspect and control machines."""

    def __init__(self, transport) -> None:
        super().__init__(transport)
        self.files = Files(transport)
        self.fs = Fs(transport)
        self.ports = Ports(transport)
        self.proxies = Proxies(transport)
        self.checkpoints = Checkpoints(transport)
        self.backups = Backups(transport)

    def create(
        self,
        name: str | None = None,
        *,
        image: str | None = None,
        from_snapshot: str | None = None,
        org: str | None = None,
        shared: bool = False,
        env: Mapping[str, str] | None = None,
        cmd: Sequence[str] | None = None,
        restart_policy: str | None = None,
        networks: Sequence[str] | None = None,
        isolated: bool = False,
        labels: Mapping[str, str] | None = None,
        spec: MachineSpecBuilder | MachineSpec | None = None,
        vcpu: int | None = None,
        memory: int | str | None = None,
        disk: int | str | None = None,
        auto_suspend_timeout: int | None = None,
        auto_destroy_timeout: int | None = None,
        idle_ignore_outbound: bool | None = None,
        delete_after: int | None = None,
        delete_after_cron: str | None = None,
        ssh: bool | None = None,
        proxies: Sequence[ProxyEntry] | None = None,
        volumes: Sequence[VolumeMount] | None = None,
    ) -> Machine:
        """Create a machine. Pass `from_snapshot` to restore one instead.

        The create call answers as soon as the machine is scheduled, and its
        response carries only a few fields, so this re-reads the machine before
        returning. It is still only *scheduled* — call :meth:`wait_until_ready`
        before doing anything that depends on it actually running.

        ``idle_ignore_outbound=True`` makes only connections opened TO the
        machine (SSH, HTTPS, another machine) reset the idle clock behind
        auto-suspend and auto-hibernate; ``False`` lets any traffic do it.
        Left as None, a new machine takes its org's default (the platform's
        setting when the org has none) and a restore keeps the snapshot's
        value. Change it later
        with :meth:`set_idle_ignore_outbound`.

        ``ssh=False`` creates the machine with SSH off: nothing answers SSH
        on its port, on the public address or the org's network. ``exec``,
        ``boxd connect`` and the console terminal don't use SSH and keep
        working. Left as None, a new machine has SSH on and a restore keeps
        the snapshot's setting. Change it later with :meth:`set_ssh`.

        ``labels`` are ``key=value`` metadata for grouping and finding
        machines (``{"env": "prod"}``); see :meth:`update_labels` for the
        rules. On a restore (``from_snapshot``) they are merged over the
        labels the snapshot captured, key by key.

        ``spec`` creates the machine from a machine spec: a builder
        (``Machine.spec()...``) or a resolved spec dict, see :mod:`boxd.spec`.
        The spec carries the base, size, labels, networks, isolation, egress
        and env, so ``image``, ``env``, ``networks``, ``isolated``, ``labels``,
        ``vcpu`` and ``memory`` can't be passed next to it. A spec whose base
        is a snapshot restores that snapshot. With ``from_snapshot``, the
        server merges the spec over the snapshot's own (maps merge with this
        one winning, lists combine, isolation only turns on); its size, if
        set, must be the snapshot's. The machine keeps the result:
        :attr:`Machine.spec`.
        """
        method, request = _create_request(
            name=name,
            image=image,
            from_snapshot=from_snapshot,
            org=org,
            shared=shared,
            env=env,
            cmd=cmd,
            restart_policy=restart_policy,
            networks=networks,
            isolated=isolated,
            labels=labels,
            spec=spec,
            sets_delete_after=delete_after is not None or delete_after_cron is not None,
            config_kwargs=dict(
                vcpu=vcpu,
                memory=memory,
                disk=disk,
                auto_suspend_timeout=auto_suspend_timeout,
                auto_destroy_timeout=auto_destroy_timeout,
                idle_ignore_outbound=idle_ignore_outbound,
                ssh=ssh,
                proxies=proxies,
                volumes=volumes,
            ),
        )
        created = self._transport.call(method, request)
        self._apply_delete_after(created.vm_id, delete_after, delete_after_cron)
        # Non-zero only for a machine made from a snapshot, a team's default
        # one included.
        return _with_paused_automations(
            self._reread(created), created.paused_automations, from_snapshot=True
        )

    def _reread(self, created) -> Machine:
        """Fill in the fields the create/fork response does not carry.

        A machine that is not readable yet falls back to the partial mapping —
        better a thin record than a failed create.
        """
        try:
            return self.get(created.vm_id)
        except BoxdError:
            return m.machine_from_created(created)

    def get(self, machine_id: str) -> Machine:
        """Fetch one machine by id or name.

        Raises `NotFoundError` for a destroyed machine's id/name, same as
        `delete()` followed by `list()` omitting it — polling `get(id)`
        after `delete(id)` returns is a reliable way to confirm teardown
        completed.
        """
        return m.machine(
            self._transport.call("GetVm", api_pb2.GetVmRequest(vm_id=machine_id)),
            self._transport.console_origin,
        )

    def usage(
        self,
        machine_id: str,
        *,
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        org: str = "",
    ) -> MachineUsageReport:
        """What a machine used and cost: seconds in each state and an
        estimated cost at the org's current rates.

        Defaults to the machine's whole life (at most a year back); `since`
        and `until` take a datetime or unix seconds. A deleted machine is
        found by its id or name in the usage history of `org` (default: your
        default org, or an API key's org), so this still answers after
        `delete()`; if several deleted machines had that name the call fails
        with their ids::

            u = boxd.machines.usage(machine.id)
            print(u.cost_micro / 1e6, u.currency)

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.machine_usage_report(
            self._transport.call(
                "GetVmUsage",
                api_pb2.GetVmUsageRequest(
                    vm_id=machine_id,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                    org=org,
                ),
            )
        )

    def list(
        self,
        *,
        org: str | None = None,
        all_contexts: bool = False,
        labels: Mapping[str, str] | Sequence[str] | None = None,
    ) -> list[Machine]:
        """List machines — personal by default, or an org's with `org`.

        `all_contexts=True` ignores `org` and returns everything the caller can
        reach across every org they belong to.

        ``labels`` keeps only the machines that match every entry: a dict
        means "equals" on each pair (``{"env": "prod"}``), a list takes
        selector strings, ``"key=value"`` (equals) or ``"key"`` (has the key),
        e.g. ``["env=prod", "gpu"]``.

        Each machine's ``packages`` come without their ``output_tail``, to
        keep the list small; :meth:`get` has it.
        """
        selector = req.label_selector(labels)
        resp = self._transport.call(
            "ListVms", req.list_vms(org=org, all_contexts=all_contexts, labels=selector)
        )
        console_origin = self._transport.console_origin
        return [
            m.machine(v, console_origin)
            for v in resp.vms
            if req.labels_match(selector, v.labels)
        ]

    def delete(self, machine_id: str) -> None:
        """Destroy a machine. Terminal."""
        self._transport.call("DestroyVm", api_pb2.DestroyVmRequest(vm_id=machine_id))

    def delete_self(self, *, confirm: str) -> SelfDeleteResult:
        """Delete **the machine this code is running on** — call it inside a
        boxd machine when its task is done.

        This is the SDK twin of ``boxd machine remove --self``, not a plain
        :meth:`delete` of your own id: the same server checks apply, and the
        call returns *before* the machine shuts down (about
        ``deletes_in_secs`` later), so your code gets the answer. Everything
        on the machine — its disk, and every process including this one —
        is then gone, so ship results out first.

        ``confirm`` must be this machine's name (``machine.name``), spelled
        out as a deliberate decision; any other value is refused before
        anything is touched. Refused, too, on a machine shared with your org,
        and for anyone but its owner. Raises :class:`AuthenticationError`
        when not running inside a boxd machine (an isolated machine has no
        metadata adapter, so it can't delete itself either)."""
        base = _creds.metadata_base(_NOT_INSIDE, _ADAPTER_SILENT)
        try:
            with httpx.Client(timeout=_SELF_DELETE_TIMEOUT_SECS) as client:
                resp = client.post(base + _SELF_DESTROY_PATH, json=_self_delete_body(confirm))
        except httpx.HTTPError as e:
            raise APIConnectionError(f"self-delete request failed: {e}") from e
        return _self_delete_result(resp.status_code, resp.text, _json(resp))

    def rename(self, machine_id: str, new_name: str) -> str:
        """Rename a machine — **this reboots it**. Returns the new name.

        Routing and DNS follow immediately; the in-VM hostname updates on the
        next boot, which is why the reboot happens.
        """
        resp = self._transport.call(
            "RenameVm", api_pb2.RenameVmRequest(vm_id=machine_id, new_name=new_name)
        )
        return resp.name

    def start(self, machine_id: str) -> None:
        self._transport.call("StartVm", api_pb2.StartVmRequest(vm_id=machine_id))

    def stop(self, machine_id: str) -> None:
        self._transport.call("StopVm", api_pb2.StopVmRequest(vm_id=machine_id))

    def reboot(self, machine_id: str) -> None:
        self._transport.call("RebootVm", api_pb2.RebootVmRequest(vm_id=machine_id))

    def pause(self, machine_id: str) -> PauseResult:
        """Suspend to RAM — fast to resume, memory stays resident."""
        resp = self._transport.call(
            "SuspendVm", api_pb2.SuspendVmRequest(vm_id=machine_id)
        )
        return PauseResult(suspend_us=resp.suspend_us)

    def resume(self, machine_id: str) -> ResumeResult:
        resp = self._transport.call(
            "ResumeVm", api_pb2.ResumeVmRequest(vm_id=machine_id)
        )
        return ResumeResult(resume_us=resp.resume_us)

    def hibernate(self, machine_id: str) -> None:
        """Suspend to disk. Cheaper than `pause`; waking takes longer."""
        self._transport.call("HibernateVm", api_pb2.HibernateVmRequest(vm_id=machine_id))

    def wake(self, machine_id: str) -> None:
        self._transport.call("WakeVm", api_pb2.WakeVmRequest(vm_id=machine_id))

    def resize(
        self,
        machine_id: str,
        *,
        vcpu: int | None = None,
        memory: int | str | None = None,
    ) -> ResizeResult:
        """Move a machine to another size class. Sizes it for good, not for now.

        Name either dimension — `vcpu=2` and `memory="8G"` are the same
        request — and the server resolves the whole class (1 vCPU/4 GiB,
        2/8 GiB, 4/16 GiB). Anything above the org quota is refused, never
        quietly clamped.

        A **running** machine is rebooted to apply the size: a cold boot, so
        the disk survives and anything in RAM does not. A **stopped** machine
        takes it at its next start. A suspended or hibernated machine is
        refused, because its saved memory image is the old size — resume or
        wake it first, then resize.
        """
        return m.resize_result(
            self._transport.call(
                "ResizeVm",
                req.resize_vm(machine_id=machine_id, vcpu=vcpu, memory=memory),
            )
        )

    def update_spec(
        self,
        machine_id: str,
        patch: MachineSpecPatch | Callable[[MachineSpecBuilder], MachineSpecBuilder],
        *,
        dry_run: bool = False,
        reboot: bool = False,
        retry_packages: bool = False,
        expected_spec: MachineSpec | None = None,
    ) -> MachineSpecUpdate:
        """Change the spec of a machine created from one, and apply what changes.
        Pass a patch, or a function that extends the current spec with a
        builder::

            # A JSON Merge Patch: maps merge (None removes a key), lists replace.
            boxd.machines.update_spec(id, {"labels": {"owner": "mike", "team": None}})

            # Additive: read the spec, add to it, send the difference.
            boxd.machines.update_spec(id, lambda s: s.network("ops").env("X", "1"))

            diff = boxd.machines.update_spec(id, {"size": "4x16"}, dry_run=True)
            if diff.reboot_required:
                boxd.machines.update_spec(id, {"size": "4x16"}, reboot=True)

            # Run the packages again from the one that failed.
            boxd.machines.update_spec(id, {}, retry_packages=True)

        The builder form uses the composition rules, so it adds: setting a
        ``size`` the spec already names differently raises, and nothing is
        removed. Use a patch to replace or remove.

        Each change says how it applies (``MachineSpecChange.apply``): labels,
        networks, egress, connections and agents live; added packages run now
        (removing one undoes nothing, and skips it if it hadn't finished, so
        the ones after it run; a running one can't be removed); env and secrets reach new shells and exec
        sessions, while running processes keep the old values until they
        restart; a new size reboots a running machine and needs
        ``reboot=True``. ``base``, ``isolated`` and ``assignTo`` can't change.
        A refused change refuses the whole patch, and nothing is applied.

        ``retry_packages=True`` runs the machine's packages again from the
        first failed one: it and every command after it that didn't finish go
        back to pending and run now (or the next time the machine runs), in
        order, before any the patch adds. It works with an empty patch
        (``{}``), is refused on a fork, and with no failed command changes
        nothing (the diff says so). Skipped commands stay skipped, and a
        failed command the patch removes is skipped, not run again.

        New egress rules are in force within about a second of the call
        returning.

        The function form sends the spec it read, so a change someone made in
        between can't be undone by it: it reads the spec again and reapplies
        the function, up to 3 times, then raises ``ConflictError``. A patch is
        sent as it is; pass ``expected_spec`` (the ``machine.spec`` you read)
        when you built it from a spec you read.

        If a resize fails after the rest of the patch applied, the call still
        returns: ``resize_error`` says why, and ``spec`` has the size the
        machine has.
        """
        def send(doc: dict[str, Any], expected: MachineSpec | None) -> MachineSpecUpdate:
            return m.spec_update(
                self._transport.call(
                    "UpdateMachineSpec",
                    req.update_machine_spec(
                        machine_id=machine_id,
                        patch=doc,
                        dry_run=dry_run,
                        reboot=reboot,
                        retry_packages=retry_packages,
                        expected_spec=expected,
                    ),
                )
            )

        if not callable(patch):
            return send(_spec_patch_doc(machine_id, None, patch), expected_spec)
        # The builder's lists are the spec it read plus its entries, so it
        # sends that spec along: a change made in between refuses it, and it
        # reads the spec again and reapplies the function.
        attempt = 0
        while True:
            current = self.get(machine_id).spec
            try:
                return send(_spec_patch_doc(machine_id, current, patch), current)
            except ConflictError as e:
                if not _spec_conflict(e) or attempt >= _UPDATE_SPEC_RETRIES:
                    raise
                attempt += 1
                time.sleep(_retry_pause(attempt))

    def fork(
        self,
        source: str,
        name: str | None = None,
        *,
        shared: bool = False,
        networks: Sequence[str] | None = None,
        isolated: bool = False,
        labels: Mapping[str, str] | None = None,
        vcpu: int | None = None,
        memory: int | str | None = None,
        disk: int | str | None = None,
        auto_suspend_timeout: int | None = None,
        auto_destroy_timeout: int | None = None,
        idle_ignore_outbound: bool | None = None,
        delete_after: int | None = None,
        delete_after_cron: str | None = None,
        ssh: bool | None = None,
        proxies: Sequence[ProxyEntry] | None = None,
        volumes: Sequence[VolumeMount] | None = None,
    ) -> Machine:
        """Clone a machine, live. Config left unset is inherited from the source.

        Call :meth:`wait_until_ready` on the source first — forking a machine
        that is not yet fully up falls back to a slower path that does not
        carry over its in-memory state.

        ``isolated`` is one-way: a fork of an isolated machine is always
        isolated, and passing ``True`` isolates a fork of a machine that
        isn't. There is no way to de-isolate.

        ``idle_ignore_outbound`` and ``ssh`` left as None keep the source's
        value; ``True`` or ``False`` overrides it either way.

        The fork inherits the source's labels; ``labels`` are merged over
        them, key by key.

        ``shared=True`` keeps the fork shared with the source's org; by
        default it is private to you. With an org API key the fork is always
        shared, so the key can reach it.
        """
        config = req.vm_config(
            vcpu=vcpu,
            memory=memory,
            disk=disk,
            auto_suspend_timeout=auto_suspend_timeout,
            auto_destroy_timeout=auto_destroy_timeout,
            idle_ignore_outbound=idle_ignore_outbound,
            ssh=ssh,
            proxies=proxies,
            volumes=volumes,
        )
        resp = self._transport.call(
            "ForkVm",
            req.fork_vm(
                source=source,
                name=name,
                shared=shared,
                networks=networks,
                isolated=isolated,
                config=config,
                labels=labels,
            ),
        )
        self._apply_delete_after(resp.vm_id, delete_after, delete_after_cron)
        return _with_paused_automations(self._reread(resp), resp.paused_automations)

    def set_networks(
        self, machine_id: str, networks: Sequence[str]
    ) -> list[str]:
        """Replace the machine's networks — the complete desired set, not an
        add/remove. Returns the set now in effect.

        Clearing it to ``[]`` does not mean "no peers": it moves the machine
        into the org's default network (its other machines that have no
        networks). On an **isolated** machine this is the only reachability
        lever there is, so clearing it does leave that machine with no peers
        at all. Reachability, internal DNS, and ``exec``/``cp`` between
        machines all follow immediately.

        See :class:`~boxd.models.MachineNetworking` for the full rule.
        """
        resp = self._transport.call(
            "SetVmNetworks",
            api_pb2.SetVmNetworksRequest(vm_id=machine_id, networks=list(networks)),
        )
        return list(resp.networks)

    def set_egress_allow(self, machine_id: str, entries: Sequence[str]) -> list[str]:
        """Replace the machine's egress allowlist: the complete set of what
        it may reach on the internet. Returns the list now in effect.

        Entries are hostnames (``api.example.com``, ``*.example.com``) or
        public IPv4 addresses and CIDRs (``1.1.1.1``, ``203.0.113.0/24``).
        HTTP and HTTPS are admitted by hostname; everything else by address,
        with the addresses of allowlisted hostnames learned as the machine
        resolves them. Nothing that is not named here is reachable; the
        hosts of any network-scoped secret the machine holds are always
        admitted. Pass ``["none"]`` to let the machine reach nothing else,
        and ``[]`` to clear the policy. Takes effect within a second; the
        machine needs no configuration.
        """
        resp = self._transport.call(
            "SetVmEgressAllow",
            api_pb2.SetVmEgressAllowRequest(vm=machine_id, entries=list(entries)),
        )
        return list(resp.entries)

    def update_labels(
        self,
        machine_id: str,
        set: Mapping[str, str] | None = None,
        remove: Sequence[str] | None = None,
        *,
        replace_all: bool = False,
    ) -> dict[str, str]:
        """Edit the machine's labels. Returns the labels now in effect.

        ``set`` adds or overwrites keys, ``remove`` deletes keys (a missing
        key is fine), in one atomic edit. ``replace_all=True`` makes ``set``
        the complete label set instead, dropping every other key; it does not
        take ``remove``. ``update_labels(id, replace_all=True)`` clears them.

        Keys are 1-63 characters of ``a-z 0-9 . _ / -``, starting and ending
        with a letter or digit; the ``boxd/`` prefix is reserved. Values are
        up to 256 characters, no control characters, and may be empty. A
        machine holds at most 64 labels.
        """
        resp = self._transport.call(
            "UpdateVmLabels",
            req.update_vm_labels(
                machine_id=machine_id, set=set, remove=remove, replace_all=replace_all
            ),
        )
        return dict(resp.labels)

    def share(self, machine_id: str) -> None:
        """Make the machine visible to every member of its org."""
        self._transport.call("ShareVm", api_pb2.ShareVmRequest(vm_id=machine_id))

    def unshare(self, machine_id: str) -> None:
        self._transport.call("UnshareVm", api_pb2.UnshareVmRequest(vm_id=machine_id))

    def set_auto_suspend_timeout(self, machine_id: str, seconds: int) -> None:
        """Seconds of idleness before suspend. 0 disables it."""
        self._transport.call(
            "SetAutoSuspendTimeout",
            api_pb2.SetAutoSuspendTimeoutRequest(
                vm_id=machine_id, timeout_secs=seconds
            ),
        )

    def set_auto_hibernate_timeout(self, machine_id: str, seconds: int) -> None:
        """Seconds of idleness before hibernation. 0 disables it."""
        self._transport.call(
            "SetAutoHibernateTimeout",
            api_pb2.SetAutoHibernateTimeoutRequest(
                vm_id=machine_id, timeout_secs=seconds
            ),
        )

    def set_delete_after(
        self, machine_id: str, seconds: int = 0, *, cron: str | None = None
    ) -> datetime | None:
        """Permanently delete the machine at a set time, whatever state it is
        in — enforced by the platform, so it fires on a suspended or
        hibernated machine too. Pass ``seconds`` (that long from now) or
        ``cron`` (the next match of a cron expression, UTC, e.g.
        ``"0 18 * * *"``), not both. Calling it again replaces the timer
        (keep extending a lease); ``0`` with no ``cron`` clears it. A fork
        inherits the timer, re-armed from the moment of the fork. Returns the
        new deadline, or None when cleared."""
        resp = self._transport.call(
            "SetDeleteAfter", req.set_delete_after(machine_id, seconds, cron)
        )
        return m._epoch_ms(resp.delete_at_ms)

    def _apply_delete_after(
        self, machine_id: str, seconds: int | None, cron: str | None
    ) -> None:
        """``delete_after`` / ``delete_after_cron`` on create/fork: not part
        of the create request, so set right after. Skipped when neither is
        passed (a fork then keeps the timer it inherited)."""
        if seconds is not None or cron is not None:
            self.set_delete_after(machine_id, seconds or 0, cron=cron)

    def set_bot_protection(
        self,
        machine_id: str,
        enabled: bool | None = None,
        *,
        mode: BotProtectionMode | None = None,
    ) -> None:
        """Set the machine's bot protection mode.

        ``mode="on"`` makes visitors pass a browser check before any HTTPS
        request reaches the machine, running or asleep, so crawlers can
        neither wake it nor keep it awake. Clients that aren't a browser
        (webhooks, API callers) are stopped too: give those a named proxy or
        a custom domain, or use ``"sleep_only"``, which checks only a request
        that would wake the machine. ``"off"`` never checks.

        ``enabled`` is the older form: ``True`` is ``"on"``, ``False`` is
        ``"off"``. Pass one or the other."""
        mode = _bot_protection_mode(enabled, mode)
        self._transport.call(
            "SetBotProtection",
            api_pb2.SetBotProtectionRequest(
                vm_id=machine_id, enabled=mode != "off", mode=mode
            ),
        )

    def set_idle_ignore_outbound(self, machine_id: str, enabled: bool) -> None:
        """Choose what counts as activity for auto-suspend and auto-hibernate.

        On: only connections opened TO the machine (SSH, HTTPS, another
        machine) reset the idle clock, so its own outbound traffic no longer
        keeps it awake. Off: any traffic does. Applies to a running machine
        at once."""
        self._transport.call(
            "SetIdleIgnoreOutbound",
            api_pb2.SetIdleIgnoreOutboundRequest(vm_id=machine_id, enabled=enabled),
        )

    def set_ssh(self, machine_id: str, enabled: bool) -> None:
        """Turn SSH on or off for the machine.

        Off: nothing answers SSH on its port, on the public address or the
        org's network, and SSH sessions already open to it are closed.
        ``exec``, ``boxd connect`` and the console terminal don't use SSH and
        keep working. The port stays allocated, so turning SSH back on keeps
        the address. Can't be called from inside the machine itself."""
        self._transport.call(
            "SetSsh",
            api_pb2.SetSshRequest(vm_id=machine_id, enabled=enabled),
        )

    def exec(
        self,
        machine_id: str,
        command: str | Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        tty: bool = False,
        cols: int = 0,
        rows: int = 0,
        timeout: float | None = None,
        encoding: Literal["utf-8", "buffer"] = "utf-8",
    ) -> ExecResult:
        """Run one command and collect its output.

        With `tty` the command runs under a PTY, which merges stderr into
        stdout — `stderr` comes back empty and everything lands in `stdout`.

        `cwd` runs the command in that directory; a `cwd` that doesn't exist
        fails fast (the remote `cd` errors and the command never runs)
        instead of silently running in the default directory.

        `stdout`/`stderr` are UTF-8-decoded by default, which silently
        replaces any invalid byte sequence with U+FFFD — pass
        `encoding="buffer"` for byte-exact `bytes` output instead (e.g.
        `head -c 4096 /dev/urandom`).

        `timeout` is in seconds and gives up on the call; the server kills
        the remote process's whole process group (SIGTERM, then SIGKILL
        after a short grace period if it hasn't exited) rather than leaving
        it running with no one listening.

        When the machine's agent doesn't answer, the command never started,
        and it is run again up to twice (within `timeout`). Any other
        failure is raised as it is: the command may have run.
        """
        init = _exec_init(
            machine_id, command, env=env, tty=tty, cols=cols, rows=rows, cwd=cwd
        )
        deadline = None if timeout is None else time.monotonic() + timeout
        attempt = 0
        while True:
            left = timeout
            if attempt > 0 and deadline is not None:
                left = deadline - time.monotonic()
            try:
                with _exec_timeout(timeout):
                    return _collect_exec(
                        self._transport.bidi("Exec", iter([init]), timeout=left),
                        encoding=encoding,
                    )
            except BoxdError as err:
                wait = _exec_retry_wait(err, attempt, deadline)
                if wait is None:
                    raise
                time.sleep(wait)
                attempt += 1

    def stream_exec(
        self,
        machine_id: str,
        *,
        command: str | Sequence[str],
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        tty: bool = False,
        cols: int = 0,
        rows: int = 0,
        close_stdin: bool = False,
    ) -> ExecStream:
        """Open an interactive exec session. Use it as a context manager."""
        if close_stdin and tty:
            raise ValueError(
                "stream_exec: close_stdin=True is incompatible with tty=True — "
                "a PTY shell needs stdin open"
            )
        init = _exec_init(
            machine_id, command, env=env, tty=tty, cols=cols, rows=rows, cwd=cwd
        )
        return ExecStream(self._transport, init, close_stdin=close_stdin)

    def logs(self, machine_id: str, *, follow: bool = False) -> Iterator[bytes]:
        """Stream console log chunks. `follow=True` keeps the stream open."""
        stream = self._transport.server_stream(
            "StreamLogs",
            api_pb2.StreamLogsRequest(vm_id=machine_id, follow=follow),
        )
        for chunk in stream:
            yield chunk.data

    def wait_until_ready(
        self, machine_id: str, *, timeout: float = 90.0, poll_interval: float = 0.5
    ) -> Machine:
        """Poll until the machine is running and `exec` round-trips.

        Not an RPC — `create` and `fork` return before the machine is usable,
        and status alone can lag the reality by a second.
        """
        deadline = time.monotonic() + timeout
        machine = self.get(machine_id)
        while not _ready_check(machine, machine_id):
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"machine {machine_id} did not reach 'running' within {timeout}s"
                )
            time.sleep(poll_interval)
            machine = self.get(machine_id)

        while True:
            try:
                self.exec(machine_id, "true")
                return machine
            except BoxdError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"machine {machine_id} is running but exec did not "
                        f"succeed within {timeout}s"
                    ) from None
                time.sleep(poll_interval)

    def suggest_name(self) -> str:
        """A fresh, available auto-generated machine name."""
        return self._transport.call(
            "SuggestVmName", api_pb2.SuggestVmNameRequest()
        ).name


class Files(Namespace):
    """`boxd.machines.files` — move files in and out of a machine."""

    def upload(self, machine_id: str, path: str, data: bytes | str) -> int:
        """Write `data` to `path` inside the machine. Returns bytes written.

        Uploads are streamed, so there is no practical size limit. A server
        that cannot confirm the write reports 0.
        """
        if isinstance(data, str):
            data = data.encode("utf-8")
        resp = self._transport.call(
            "UploadFileStream",
            req.upload_chunks(
                machine_id=machine_id,
                path=path,
                data=data,
                chunk_size=_UPLOAD_CHUNK_BYTES,
            ),
        )
        return resp.bytes_written

    def download(self, machine_id: str, path: str) -> bytes:
        """Read a file out of the machine. Streamed, so there is no size cap."""
        chunks: list[bytes] = []
        received = 0
        total: int | None = None
        for chunk in self._transport.server_stream(
            "DownloadFileStream",
            api_pb2.DownloadFileRequest(vm_id=machine_id, path=path),
        ):
            if chunk.total_size:
                total = chunk.total_size
            if chunk.data:
                chunks.append(chunk.data)
                received += len(chunk.data)
        if total is not None and received != total:
            raise BoxdError(
                f"download truncated: expected {total} bytes, got {received}"
            )
        return b"".join(chunks)

    def list_dir(self, machine_id: str, path: str) -> DirListing:
        """Immediate (non-recursive) contents of a directory inside the machine.

        A directory bigger than the server's per-listing cap comes back with
        `truncated=True` and only the first slice of its entries (in no
        particular order); use `machines.exec` for an exhaustive listing.
        """
        resp = self._transport.call(
            "ListDir", api_pb2.ListDirRequest(vm_id=machine_id, path=path)
        )
        return m.dir_listing(resp)

    def mkdir(self, machine_id: str, path: str) -> None:
        """Create a directory. The parent must already exist."""
        self._transport.call(
            "Mkdir", api_pb2.MkdirRequest(vm_id=machine_id, path=path)
        )

    def rename(self, machine_id: str, old_path: str, new_path: str) -> None:
        """Move/rename a file or directory."""
        self._transport.call(
            "RenamePath",
            api_pb2.RenamePathRequest(
                vm_id=machine_id, old_path=old_path, new_path=new_path
            ),
        )

    def delete(self, machine_id: str, path: str) -> None:
        """Remove a file, or a directory and everything under it."""
        self._transport.call(
            "DeletePath", api_pb2.DeletePathRequest(vm_id=machine_id, path=path)
        )

    def copy(self, machine_id: str, old_path: str, new_path: str) -> None:
        """Copy a file, or a directory recursively."""
        self._transport.call(
            "CopyPath",
            api_pb2.CopyPathRequest(
                vm_id=machine_id, old_path=old_path, new_path=new_path
            ),
        )


class Ports(Namespace):
    """`boxd.machines.ports` — public TCP/UDP forwards. Max 3 per machine."""

    def expose(
        self, machine_id: str, port: int, *, protocol: str = "tcp"
    ) -> ExposedPort:
        """Expose a machine port publicly. `protocol` is "tcp" | "udp" | "both".

        Re-exposing the same port keeps its public port and updates the
        protocol set.
        """
        return m.exposed_port(
            self._transport.call(
                "ExposePort",
                api_pb2.ExposePortRequest(
                    vm=machine_id, vm_port=port, protocol=protocol
                ),
            )
        )

    def unexpose(self, machine_id: str, port: int) -> ExposedPort:
        """Remove a forward, freeing its public port. Echoes what was removed."""
        resp = self._transport.call(
            "UnexposePort",
            api_pb2.UnexposePortRequest(vm=machine_id, vm_port=port),
        )
        return m.exposed_port(resp.forward)

    def list(self, machine_id: str | None = None) -> list[ExposedPort]:
        """Forwards for one machine, or every forward the caller owns.

        Passing a machine narrows server-side; omitting it keeps the
        account-wide view.
        """
        resp = self._transport.call(
            "ListExposedPorts", api_pb2.ListExposedPortsRequest(vm=machine_id or "")
        )
        return [m.exposed_port(f) for f in resp.forwards]


class Proxies(Namespace):
    """`boxd.machines.proxies` — HTTPS subdomains onto a port inside a machine.

    `machine_name` takes an id or a name, like everything else on `machines`.
    A listed route echoes its `machine_id` back.
    """

    def create(self, machine_name: str, name: str, port: int) -> CreatedProxy:
        """Add the route `<name>.<machine>.<zone>`, pointed at `port` inside it.

        `name` is a subdomain label: lowercase letters, digits and hyphens, not
        starting or ending with one. It cannot be empty — every machine already
        has its default route, and this call only ever adds a named one beside
        it.
        """
        return m.created_proxy(
            self._transport.call(
                "CreateProxy",
                api_pb2.CreateProxyRequest(name=name, vm=machine_name, port=port),
            )
        )

    def list(self, machine_name: str) -> list[Proxy]:
        resp = self._transport.call(
            "ListProxies", api_pb2.ListProxiesRequest(vm=machine_name)
        )
        return [m.proxy(p) for p in resp.proxies]

    def delete(self, machine_name: str, name: str) -> None:
        self._transport.call(
            "DeleteProxy",
            api_pb2.DeleteProxyRequest(name=name, vm=machine_name),
        )

    def set_port(
        self, machine_name: str, port: int | Literal["auto"], *, name: str | None = None
    ) -> None:
        """Point a route at a different port, or `"auto"` to have the port
        discovered inside the machine instead.

        `"auto"` re-detects for as long as the route stays in auto mode — not
        just once at boot — by watching the guest's own `listen()` calls, so
        it follows the app if its listener moves to a different port later
        (e.g. a restart that binds a new port). Right after boot, a
        higher-priority well-known port (say `:80` over `:3000`) wins
        outright so two services racing to come up don't flap the route.
        After that, a candidate new port has to hold steady — the most
        recently observed well-known port, with no other well-known port
        contending — for a short quiet period before the route switches to
        it, so multiple services racing or a crash-looping app flapping
        between ports won't churn the route — but a real listener move is
        still picked up within a few seconds. Passing a concrete port
        switches the route out of auto mode and stops this re-detection.

        Omit `name` to address the machine's default route. `"auto"` is only
        available there — a named route must be pinned to a port.
        """
        self._transport.call(
            "SetProxyPort",
            api_pb2.SetProxyPortRequest(
                name=name or "", vm=machine_name, port=str(port)
            ),
        )


class Checkpoints(Namespace):
    """`boxd.machines.checkpoints` — per-machine captures, restored in place.

    Like a snapshot, but scoped to one machine: a checkpoint is not an
    account-level image, and it is deleted with the machine it belongs to.
    """

    def create(self, machine_id: str, name: str) -> CreatedCheckpoint:
        return m.created_checkpoint(
            self._transport.call(
                "CreateCheckpoint",
                api_pb2.CreateCheckpointRequest(vm=machine_id, name=name),
            )
        )

    def list(self, machine_id: str) -> list[Checkpoint]:
        resp = self._transport.call(
            "ListCheckpoints", api_pb2.ListCheckpointsRequest(vm=machine_id)
        )
        return [m.checkpoint(c) for c in resp.checkpoints]

    def delete(self, machine_id: str, name: str) -> None:
        self._transport.call(
            "DeleteCheckpoint",
            api_pb2.DeleteCheckpointRequest(vm=machine_id, name=name),
        )

    def restore(self, machine_id: str, name: str) -> None:
        """Warm-restore the machine from a checkpoint. It must be `available`."""
        self._transport.call(
            "RestoreCheckpoint",
            api_pb2.RestoreCheckpointRequest(vm=machine_id, name=name),
        )


class Backups(Namespace):
    """`boxd.machines.backups` — scheduled disaster-recovery disk backups.

    Off by default. Enabling copies the disk to object storage on an
    interval; restoring is a full, destructive disk rewrite (unlike a
    checkpoint restore, running/memory state is not restored — the machine
    cold-boots into the restored disk).
    """

    def schedule_get(self, machine_id: str) -> BackupSchedule | None:
        """`None` means backups are off."""
        resp = self._transport.call(
            "GetBackupSchedule", api_pb2.GetBackupScheduleRequest(vm=machine_id)
        )
        return m.backup_schedule(resp)

    def schedule_set(
        self,
        machine_id: str,
        *,
        interval_secs: int | None = None,
        cron: str | None = None,
        retention_secs: int,
    ) -> None:
        """Enable or update the schedule. Pass exactly one of `interval_secs`
        (relative to the last backup) or `cron` (wall-clock, standard 5-field
        cron syntax)."""
        if (interval_secs is None) == (cron is None):
            raise ValueError("pass exactly one of interval_secs or cron")
        kind, value = ("interval", str(interval_secs)) if interval_secs is not None else ("cron", cron)
        self._transport.call(
            "SetBackupSchedule",
            api_pb2.SetBackupScheduleRequest(
                vm=machine_id,
                schedule_kind=kind,
                schedule_value=value,
                retention_secs=retention_secs,
            ),
        )

    def schedule_clear(self, machine_id: str) -> None:
        """Disable backups for this machine."""
        self._transport.call(
            "ClearBackupSchedule", api_pb2.ClearBackupScheduleRequest(vm=machine_id)
        )

    def list(self, machine_id: str) -> list[Backup]:
        resp = self._transport.call(
            "ListBackups", api_pb2.ListBackupsRequest(vm=machine_id)
        )
        return [m.backup(b) for b in resp.backups]

    def trigger(self, machine_id: str) -> str:
        """Back up the machine's disk right now, regardless of any schedule.
        Returns the id of the queued backup."""
        resp = self._transport.call(
            "TriggerBackup", api_pb2.TriggerBackupRequest(vm=machine_id)
        )
        return resp.backup_id

    def delete(self, machine_id: str, backup_id: str) -> None:
        """Delete a single backup. Refused while it is still being captured or
        while a newer unchanged-since backup still points at it."""
        self._transport.call(
            "DeleteBackup",
            api_pb2.DeleteBackupRequest(vm=machine_id, backup_id=backup_id),
        )

    def restore(self, machine_id: str, backup_id: str) -> None:
        """Restore the machine's disk from a backup IN PLACE. Destructive:
        overwrites the machine's current disk; anything since is lost."""
        self._transport.call(
            "RestoreBackup",
            api_pb2.RestoreBackupRequest(vm=machine_id, backup_id=backup_id),
        )


# ── Async ────────────────────────────────────────────────────────────


class AsyncMachines(Namespace):
    """Async twin of :class:`Machines`."""

    def __init__(self, transport) -> None:
        super().__init__(transport)
        self.files = AsyncFiles(transport)
        self.fs = AsyncFs(transport)
        self.ports = AsyncPorts(transport)
        self.proxies = AsyncProxies(transport)
        self.checkpoints = AsyncCheckpoints(transport)
        self.backups = AsyncBackups(transport)

    async def create(
        self,
        name: str | None = None,
        *,
        image: str | None = None,
        from_snapshot: str | None = None,
        org: str | None = None,
        shared: bool = False,
        env: Mapping[str, str] | None = None,
        cmd: Sequence[str] | None = None,
        restart_policy: str | None = None,
        networks: Sequence[str] | None = None,
        isolated: bool = False,
        labels: Mapping[str, str] | None = None,
        spec: MachineSpecBuilder | MachineSpec | None = None,
        vcpu: int | None = None,
        memory: int | str | None = None,
        disk: int | str | None = None,
        auto_suspend_timeout: int | None = None,
        auto_destroy_timeout: int | None = None,
        idle_ignore_outbound: bool | None = None,
        delete_after: int | None = None,
        delete_after_cron: str | None = None,
        ssh: bool | None = None,
        proxies: Sequence[ProxyEntry] | None = None,
        volumes: Sequence[VolumeMount] | None = None,
    ) -> Machine:
        """Create a machine. Pass `from_snapshot` to restore one instead.

        Re-reads the machine before returning, so the result is complete. It is
        still only scheduled — call :meth:`wait_until_ready` before using it.

        ``idle_ignore_outbound``, ``ssh``, ``labels``, ``spec``: see
        :meth:`Machines.create`.
        """
        method, request = _create_request(
            name=name,
            image=image,
            from_snapshot=from_snapshot,
            org=org,
            shared=shared,
            env=env,
            cmd=cmd,
            restart_policy=restart_policy,
            networks=networks,
            isolated=isolated,
            labels=labels,
            spec=spec,
            sets_delete_after=delete_after is not None or delete_after_cron is not None,
            config_kwargs=dict(
                vcpu=vcpu,
                memory=memory,
                disk=disk,
                auto_suspend_timeout=auto_suspend_timeout,
                auto_destroy_timeout=auto_destroy_timeout,
                idle_ignore_outbound=idle_ignore_outbound,
                ssh=ssh,
                proxies=proxies,
                volumes=volumes,
            ),
        )
        created = await self._transport.call(method, request)
        await self._apply_delete_after(created.vm_id, delete_after, delete_after_cron)
        return _with_paused_automations(
            await self._reread(created), created.paused_automations, from_snapshot=True
        )

    async def _reread(self, created) -> Machine:
        """Fill in the fields the create/fork response does not carry."""
        try:
            return await self.get(created.vm_id)
        except BoxdError:
            return m.machine_from_created(created)

    async def get(self, machine_id: str) -> Machine:
        """Fetch one machine by id or name.

        Raises `NotFoundError` for a destroyed machine's id/name, same as
        `delete()` followed by `list()` omitting it — polling `get(id)`
        after `delete(id)` returns is a reliable way to confirm teardown
        completed.
        """
        return m.machine(
            await self._transport.call("GetVm", api_pb2.GetVmRequest(vm_id=machine_id)),
            self._transport.console_origin,
        )

    async def usage(
        self,
        machine_id: str,
        *,
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        org: str = "",
    ) -> MachineUsageReport:
        """What a machine used and cost: seconds in each state and an
        estimated cost at the org's current rates.

        Defaults to the machine's whole life (at most a year back); `since`
        and `until` take a datetime or unix seconds. A deleted machine is
        found by its id or name in the usage history of `org` (default: your
        default org, or an API key's org), so this still answers after
        `delete()`; if several deleted machines had that name the call fails
        with their ids::

            u = await boxd.machines.usage(machine.id)
            print(u.cost_micro / 1e6, u.currency)

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.machine_usage_report(
            await self._transport.call(
                "GetVmUsage",
                api_pb2.GetVmUsageRequest(
                    vm_id=machine_id,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                    org=org,
                ),
            )
        )

    async def list(
        self,
        *,
        org: str | None = None,
        all_contexts: bool = False,
        labels: Mapping[str, str] | Sequence[str] | None = None,
    ) -> list[Machine]:
        """List machines — personal by default, or an org's with `org`.
        ``labels`` filters: see :meth:`Machines.list`."""
        selector = req.label_selector(labels)
        resp = await self._transport.call(
            "ListVms", req.list_vms(org=org, all_contexts=all_contexts, labels=selector)
        )
        console_origin = self._transport.console_origin
        return [
            m.machine(v, console_origin)
            for v in resp.vms
            if req.labels_match(selector, v.labels)
        ]

    async def delete(self, machine_id: str) -> None:
        """Destroy a machine. Terminal."""
        await self._transport.call(
            "DestroyVm", api_pb2.DestroyVmRequest(vm_id=machine_id)
        )

    async def delete_self(self, *, confirm: str) -> SelfDeleteResult:
        """See :meth:`Machines.delete_self`."""
        base = await _creds.metadata_base_async(_NOT_INSIDE, _ADAPTER_SILENT)
        try:
            async with httpx.AsyncClient(timeout=_SELF_DELETE_TIMEOUT_SECS) as client:
                resp = await client.post(
                    base + _SELF_DESTROY_PATH, json=_self_delete_body(confirm)
                )
        except httpx.HTTPError as e:
            raise APIConnectionError(f"self-delete request failed: {e}") from e
        return _self_delete_result(resp.status_code, resp.text, _json(resp))

    async def rename(self, machine_id: str, new_name: str) -> str:
        """Rename a machine — **this reboots it**. Returns the new name."""
        resp = await self._transport.call(
            "RenameVm", api_pb2.RenameVmRequest(vm_id=machine_id, new_name=new_name)
        )
        return resp.name

    async def start(self, machine_id: str) -> None:
        await self._transport.call("StartVm", api_pb2.StartVmRequest(vm_id=machine_id))

    async def stop(self, machine_id: str) -> None:
        await self._transport.call("StopVm", api_pb2.StopVmRequest(vm_id=machine_id))

    async def reboot(self, machine_id: str) -> None:
        await self._transport.call("RebootVm", api_pb2.RebootVmRequest(vm_id=machine_id))

    async def pause(self, machine_id: str) -> PauseResult:
        """Suspend to RAM — fast to resume, memory stays resident."""
        resp = await self._transport.call(
            "SuspendVm", api_pb2.SuspendVmRequest(vm_id=machine_id)
        )
        return PauseResult(suspend_us=resp.suspend_us)

    async def resume(self, machine_id: str) -> ResumeResult:
        resp = await self._transport.call(
            "ResumeVm", api_pb2.ResumeVmRequest(vm_id=machine_id)
        )
        return ResumeResult(resume_us=resp.resume_us)

    async def hibernate(self, machine_id: str) -> None:
        """Suspend to disk. Cheaper than `pause`; waking takes longer."""
        await self._transport.call(
            "HibernateVm", api_pb2.HibernateVmRequest(vm_id=machine_id)
        )

    async def wake(self, machine_id: str) -> None:
        await self._transport.call("WakeVm", api_pb2.WakeVmRequest(vm_id=machine_id))

    async def resize(
        self,
        machine_id: str,
        *,
        vcpu: int | None = None,
        memory: int | str | None = None,
    ) -> ResizeResult:
        """Move a machine to another size class. Sizes it for good, not for now.

        Name either dimension — `vcpu=2` and `memory="8G"` are the same
        request — and the server resolves the whole class (1 vCPU/4 GiB,
        2/8 GiB, 4/16 GiB). Anything above the org quota is refused, never
        quietly clamped.

        A **running** machine is rebooted to apply the size: a cold boot, so
        the disk survives and anything in RAM does not. A **stopped** machine
        takes it at its next start. A suspended or hibernated machine is
        refused, because its saved memory image is the old size — resume or
        wake it first, then resize.
        """
        return m.resize_result(
            await self._transport.call(
                "ResizeVm",
                req.resize_vm(machine_id=machine_id, vcpu=vcpu, memory=memory),
            )
        )

    async def update_spec(
        self,
        machine_id: str,
        patch: MachineSpecPatch | Callable[[MachineSpecBuilder], MachineSpecBuilder],
        *,
        dry_run: bool = False,
        reboot: bool = False,
        retry_packages: bool = False,
        expected_spec: MachineSpec | None = None,
    ) -> MachineSpecUpdate:
        """Change the spec of a machine created from one, and apply what changes.
        Pass a patch, or a function that extends the current spec with a
        builder::

            # A JSON Merge Patch: maps merge (None removes a key), lists replace.
            boxd.machines.update_spec(id, {"labels": {"owner": "mike", "team": None}})

            # Additive: read the spec, add to it, send the difference.
            boxd.machines.update_spec(id, lambda s: s.network("ops").env("X", "1"))

            diff = boxd.machines.update_spec(id, {"size": "4x16"}, dry_run=True)
            if diff.reboot_required:
                boxd.machines.update_spec(id, {"size": "4x16"}, reboot=True)

            # Run the packages again from the one that failed.
            boxd.machines.update_spec(id, {}, retry_packages=True)

        The builder form uses the composition rules, so it adds: setting a
        ``size`` the spec already names differently raises, and nothing is
        removed. Use a patch to replace or remove.

        Each change says how it applies (``MachineSpecChange.apply``): labels,
        networks, egress, connections and agents live; added packages run now
        (removing one undoes nothing, and skips it if it hadn't finished, so
        the ones after it run; a running one can't be removed); env and secrets reach new shells and exec
        sessions, while running processes keep the old values until they
        restart; a new size reboots a running machine and needs
        ``reboot=True``. ``base``, ``isolated`` and ``assignTo`` can't change.
        A refused change refuses the whole patch, and nothing is applied.

        ``retry_packages=True`` runs the machine's packages again from the
        first failed one: it and every command after it that didn't finish go
        back to pending and run now (or the next time the machine runs), in
        order, before any the patch adds. It works with an empty patch
        (``{}``), is refused on a fork, and with no failed command changes
        nothing (the diff says so). Skipped commands stay skipped, and a
        failed command the patch removes is skipped, not run again.

        New egress rules are in force within about a second of the call
        returning.

        The function form sends the spec it read, so a change someone made in
        between can't be undone by it: it reads the spec again and reapplies
        the function, up to 3 times, then raises ``ConflictError``. A patch is
        sent as it is; pass ``expected_spec`` (the ``machine.spec`` you read)
        when you built it from a spec you read.

        If a resize fails after the rest of the patch applied, the call still
        returns: ``resize_error`` says why, and ``spec`` has the size the
        machine has.
        """
        async def send(doc: dict[str, Any], expected: MachineSpec | None) -> MachineSpecUpdate:
            return m.spec_update(
                await self._transport.call(
                    "UpdateMachineSpec",
                    req.update_machine_spec(
                        machine_id=machine_id,
                        patch=doc,
                        dry_run=dry_run,
                        reboot=reboot,
                        retry_packages=retry_packages,
                        expected_spec=expected,
                    ),
                )
            )

        if not callable(patch):
            return await send(_spec_patch_doc(machine_id, None, patch), expected_spec)
        attempt = 0
        while True:
            current = (await self.get(machine_id)).spec
            try:
                return await send(_spec_patch_doc(machine_id, current, patch), current)
            except ConflictError as e:
                if not _spec_conflict(e) or attempt >= _UPDATE_SPEC_RETRIES:
                    raise
                attempt += 1
                await asyncio.sleep(_retry_pause(attempt))

    async def fork(
        self,
        source: str,
        name: str | None = None,
        *,
        shared: bool = False,
        networks: Sequence[str] | None = None,
        isolated: bool = False,
        labels: Mapping[str, str] | None = None,
        vcpu: int | None = None,
        memory: int | str | None = None,
        disk: int | str | None = None,
        auto_suspend_timeout: int | None = None,
        auto_destroy_timeout: int | None = None,
        idle_ignore_outbound: bool | None = None,
        delete_after: int | None = None,
        delete_after_cron: str | None = None,
        ssh: bool | None = None,
        proxies: Sequence[ProxyEntry] | None = None,
        volumes: Sequence[VolumeMount] | None = None,
    ) -> Machine:
        """Clone a machine, live. Config left unset is inherited from the source.

        ``isolated`` is one-way: a fork of an isolated machine is always
        isolated, and passing ``True`` isolates a fork of a machine that
        isn't. There is no way to de-isolate.

        ``idle_ignore_outbound`` and ``ssh`` left as None keep the source's
        value; ``True`` or ``False`` overrides it either way.

        The fork inherits the source's labels; ``labels`` are merged over
        them, key by key.

        ``shared=True`` keeps the fork shared with the source's org; by
        default it is private to you. With an org API key the fork is always
        shared, so the key can reach it.
        """
        config = req.vm_config(
            vcpu=vcpu,
            memory=memory,
            disk=disk,
            auto_suspend_timeout=auto_suspend_timeout,
            auto_destroy_timeout=auto_destroy_timeout,
            idle_ignore_outbound=idle_ignore_outbound,
            ssh=ssh,
            proxies=proxies,
            volumes=volumes,
        )
        resp = await self._transport.call(
            "ForkVm",
            req.fork_vm(
                source=source,
                name=name,
                shared=shared,
                networks=networks,
                isolated=isolated,
                config=config,
                labels=labels,
            ),
        )
        await self._apply_delete_after(resp.vm_id, delete_after, delete_after_cron)
        return _with_paused_automations(
            await self._reread(resp), resp.paused_automations
        )

    async def set_networks(
        self, machine_id: str, networks: Sequence[str]
    ) -> list[str]:
        """Replace the machine's networks — the complete desired set, not an
        add/remove. Returns the set now in effect.

        Clearing it to ``[]`` does not mean "no peers": it moves the machine
        into the org's default network (its other machines that have no
        networks). On an **isolated** machine this is the only reachability
        lever there is, so clearing it does leave that machine with no peers
        at all. Reachability, internal DNS, and ``exec``/``cp`` between
        machines all follow immediately.

        See :class:`~boxd.models.MachineNetworking` for the full rule.
        """
        resp = await self._transport.call(
            "SetVmNetworks",
            api_pb2.SetVmNetworksRequest(vm_id=machine_id, networks=list(networks)),
        )
        return list(resp.networks)

    async def set_egress_allow(
        self, machine_id: str, entries: Sequence[str]
    ) -> list[str]:
        """Replace the machine's egress allowlist. See
        :meth:`Machines.set_egress_allow`."""
        resp = await self._transport.call(
            "SetVmEgressAllow",
            api_pb2.SetVmEgressAllowRequest(vm=machine_id, entries=list(entries)),
        )
        return list(resp.entries)

    async def update_labels(
        self,
        machine_id: str,
        set: Mapping[str, str] | None = None,
        remove: Sequence[str] | None = None,
        *,
        replace_all: bool = False,
    ) -> dict[str, str]:
        """Edit the machine's labels. See :meth:`Machines.update_labels`."""
        resp = await self._transport.call(
            "UpdateVmLabels",
            req.update_vm_labels(
                machine_id=machine_id, set=set, remove=remove, replace_all=replace_all
            ),
        )
        return dict(resp.labels)

    async def share(self, machine_id: str) -> None:
        """Make the machine visible to every member of its org."""
        await self._transport.call("ShareVm", api_pb2.ShareVmRequest(vm_id=machine_id))

    async def unshare(self, machine_id: str) -> None:
        await self._transport.call(
            "UnshareVm", api_pb2.UnshareVmRequest(vm_id=machine_id)
        )

    async def set_auto_suspend_timeout(self, machine_id: str, seconds: int) -> None:
        """Seconds of idleness before suspend. 0 disables it."""
        await self._transport.call(
            "SetAutoSuspendTimeout",
            api_pb2.SetAutoSuspendTimeoutRequest(
                vm_id=machine_id, timeout_secs=seconds
            ),
        )

    async def set_auto_hibernate_timeout(self, machine_id: str, seconds: int) -> None:
        """Seconds of idleness before hibernation. 0 disables it."""
        await self._transport.call(
            "SetAutoHibernateTimeout",
            api_pb2.SetAutoHibernateTimeoutRequest(
                vm_id=machine_id, timeout_secs=seconds
            ),
        )

    async def set_delete_after(
        self, machine_id: str, seconds: int = 0, *, cron: str | None = None
    ) -> datetime | None:
        """See :meth:`Machines.set_delete_after`."""
        resp = await self._transport.call(
            "SetDeleteAfter", req.set_delete_after(machine_id, seconds, cron)
        )
        return m._epoch_ms(resp.delete_at_ms)

    async def _apply_delete_after(
        self, machine_id: str, seconds: int | None, cron: str | None
    ) -> None:
        """See :meth:`Machines._apply_delete_after`."""
        if seconds is not None or cron is not None:
            await self.set_delete_after(machine_id, seconds or 0, cron=cron)

    async def set_bot_protection(
        self,
        machine_id: str,
        enabled: bool | None = None,
        *,
        mode: BotProtectionMode | None = None,
    ) -> None:
        """See :meth:`Machines.set_bot_protection`."""
        mode = _bot_protection_mode(enabled, mode)
        await self._transport.call(
            "SetBotProtection",
            api_pb2.SetBotProtectionRequest(
                vm_id=machine_id, enabled=mode != "off", mode=mode
            ),
        )

    async def set_idle_ignore_outbound(self, machine_id: str, enabled: bool) -> None:
        """See :meth:`Machines.set_idle_ignore_outbound`."""
        await self._transport.call(
            "SetIdleIgnoreOutbound",
            api_pb2.SetIdleIgnoreOutboundRequest(vm_id=machine_id, enabled=enabled),
        )

    async def set_ssh(self, machine_id: str, enabled: bool) -> None:
        """See :meth:`Machines.set_ssh`."""
        await self._transport.call(
            "SetSsh",
            api_pb2.SetSshRequest(vm_id=machine_id, enabled=enabled),
        )

    async def exec(
        self,
        machine_id: str,
        command: str | Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        tty: bool = False,
        cols: int = 0,
        rows: int = 0,
        timeout: float | None = None,
        encoding: Literal["utf-8", "buffer"] = "utf-8",
    ) -> ExecResult:
        """Run one command and collect its output.

        With `tty` the command runs under a PTY, which merges stderr into
        stdout — `stderr` comes back empty and everything lands in `stdout`.

        `cwd` runs the command in that directory; a `cwd` that doesn't exist
        fails fast (the remote `cd` errors and the command never runs)
        instead of silently running in the default directory.

        `stdout`/`stderr` are UTF-8-decoded by default, which silently
        replaces any invalid byte sequence with U+FFFD — pass
        `encoding="buffer"` for byte-exact `bytes` output instead (e.g.
        `head -c 4096 /dev/urandom`).

        `timeout` is in seconds and gives up on the call; the server kills
        the remote process's whole process group (SIGTERM, then SIGKILL
        after a short grace period if it hasn't exited) rather than leaving
        it running with no one listening.

        When the machine's agent doesn't answer, the command never started,
        and it is run again up to twice (within `timeout`). Any other
        failure is raised as it is: the command may have run.
        """
        init = _exec_init(
            machine_id, command, env=env, tty=tty, cols=cols, rows=rows, cwd=cwd
        )

        async def once():
            yield init

        deadline = None if timeout is None else time.monotonic() + timeout
        attempt = 0
        while True:
            left = timeout
            if attempt > 0 and deadline is not None:
                left = deadline - time.monotonic()
            try:
                with _exec_timeout(timeout):
                    call = await self._transport.bidi("Exec", once(), timeout=left)
                    stdout: list[bytes] = []
                    stderr: list[bytes] = []
                    exit_code = -1
                    async for chunk in call:
                        if chunk.data:
                            (stderr if chunk.is_stderr else stdout).append(chunk.data)
                        exit_code = chunk.exit_code
                return _finish_exec(
                    b"".join(stdout), b"".join(stderr), exit_code, encoding
                )
            except BoxdError as err:
                wait = _exec_retry_wait(err, attempt, deadline)
                if wait is None:
                    raise
                await asyncio.sleep(wait)
                attempt += 1

    def stream_exec(
        self,
        machine_id: str,
        *,
        command: str | Sequence[str],
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        tty: bool = False,
        cols: int = 0,
        rows: int = 0,
        close_stdin: bool = False,
    ) -> AsyncExecStream:
        """Open an interactive exec session. Use it as an async context manager."""
        if close_stdin and tty:
            raise ValueError(
                "stream_exec: close_stdin=True is incompatible with tty=True — "
                "a PTY shell needs stdin open"
            )
        init = _exec_init(
            machine_id, command, env=env, tty=tty, cols=cols, rows=rows, cwd=cwd
        )
        return AsyncExecStream(self._transport, init, close_stdin=close_stdin)

    async def logs(
        self, machine_id: str, *, follow: bool = False
    ) -> AsyncIterator[bytes]:
        """Stream console log chunks. `follow=True` keeps the stream open."""
        stream = await self._transport.server_stream(
            "StreamLogs",
            api_pb2.StreamLogsRequest(vm_id=machine_id, follow=follow),
        )
        async for chunk in stream:
            yield chunk.data

    async def wait_until_ready(
        self, machine_id: str, *, timeout: float = 90.0, poll_interval: float = 0.5
    ) -> Machine:
        """Poll until the machine is running and `exec` round-trips."""
        deadline = time.monotonic() + timeout
        machine = await self.get(machine_id)
        while not _ready_check(machine, machine_id):
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"machine {machine_id} did not reach 'running' within {timeout}s"
                )
            await asyncio.sleep(poll_interval)
            machine = await self.get(machine_id)

        while True:
            try:
                await self.exec(machine_id, "true")
                return machine
            except BoxdError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"machine {machine_id} is running but exec did not "
                        f"succeed within {timeout}s"
                    ) from None
                await asyncio.sleep(poll_interval)

    async def suggest_name(self) -> str:
        """A fresh, available auto-generated machine name."""
        resp = await self._transport.call(
            "SuggestVmName", api_pb2.SuggestVmNameRequest()
        )
        return resp.name


class AsyncFiles(Namespace):
    """Async twin of :class:`Files`."""

    async def upload(self, machine_id: str, path: str, data: bytes | str) -> int:
        """Write `data` to `path` inside the machine. Returns bytes written."""
        if isinstance(data, str):
            data = data.encode("utf-8")

        async def chunks():
            for chunk in req.upload_chunks(
                machine_id=machine_id,
                path=path,
                data=data,
                chunk_size=_UPLOAD_CHUNK_BYTES,
            ):
                yield chunk

        resp = await self._transport.call("UploadFileStream", chunks())
        return resp.bytes_written

    async def download(self, machine_id: str, path: str) -> bytes:
        """Read a file out of the machine. Streamed, so there is no size cap."""
        chunks: list[bytes] = []
        received = 0
        total: int | None = None
        stream = await self._transport.server_stream(
            "DownloadFileStream",
            api_pb2.DownloadFileRequest(vm_id=machine_id, path=path),
        )
        async for chunk in stream:
            if chunk.total_size:
                total = chunk.total_size
            if chunk.data:
                chunks.append(chunk.data)
                received += len(chunk.data)
        if total is not None and received != total:
            raise BoxdError(
                f"download truncated: expected {total} bytes, got {received}"
            )
        return b"".join(chunks)

    async def list_dir(self, machine_id: str, path: str) -> DirListing:
        """Immediate (non-recursive) contents of a directory inside the machine.

        See :meth:`Files.list_dir` for `truncated`.
        """
        resp = await self._transport.call(
            "ListDir", api_pb2.ListDirRequest(vm_id=machine_id, path=path)
        )
        return m.dir_listing(resp)

    async def mkdir(self, machine_id: str, path: str) -> None:
        """Create a directory. The parent must already exist."""
        await self._transport.call(
            "Mkdir", api_pb2.MkdirRequest(vm_id=machine_id, path=path)
        )

    async def rename(self, machine_id: str, old_path: str, new_path: str) -> None:
        """Move/rename a file or directory."""
        await self._transport.call(
            "RenamePath",
            api_pb2.RenamePathRequest(
                vm_id=machine_id, old_path=old_path, new_path=new_path
            ),
        )

    async def delete(self, machine_id: str, path: str) -> None:
        """Remove a file, or a directory and everything under it."""
        await self._transport.call(
            "DeletePath", api_pb2.DeletePathRequest(vm_id=machine_id, path=path)
        )

    async def copy(self, machine_id: str, old_path: str, new_path: str) -> None:
        """Copy a file, or a directory recursively."""
        await self._transport.call(
            "CopyPath",
            api_pb2.CopyPathRequest(
                vm_id=machine_id, old_path=old_path, new_path=new_path
            ),
        )


class AsyncPorts(Namespace):
    """Async twin of :class:`Ports`."""

    async def expose(
        self, machine_id: str, port: int, *, protocol: str = "tcp"
    ) -> ExposedPort:
        """Expose a machine port publicly. `protocol` is "tcp" | "udp" | "both"."""
        return m.exposed_port(
            await self._transport.call(
                "ExposePort",
                api_pb2.ExposePortRequest(
                    vm=machine_id, vm_port=port, protocol=protocol
                ),
            )
        )

    async def unexpose(self, machine_id: str, port: int) -> ExposedPort:
        """Remove a forward, freeing its public port. Echoes what was removed."""
        resp = await self._transport.call(
            "UnexposePort",
            api_pb2.UnexposePortRequest(vm=machine_id, vm_port=port),
        )
        return m.exposed_port(resp.forward)

    async def list(self, machine_id: str | None = None) -> list[ExposedPort]:
        """Forwards for one machine, or every forward the caller owns.

        Passing a machine narrows the result; omitting it returns them all.
        """
        resp = await self._transport.call(
            "ListExposedPorts", api_pb2.ListExposedPortsRequest(vm=machine_id or "")
        )
        return [m.exposed_port(f) for f in resp.forwards]


class AsyncProxies(Namespace):
    """Async twin of :class:`Proxies`."""

    async def create(self, machine_name: str, name: str, port: int) -> CreatedProxy:
        """Add the route `<name>.<machine>.<zone>`, pointed at `port` inside it.

        `name` is a subdomain label: lowercase letters, digits and hyphens, not
        starting or ending with one. It cannot be empty — every machine already
        has its default route, and this call only ever adds a named one beside
        it.
        """
        return m.created_proxy(
            await self._transport.call(
                "CreateProxy",
                api_pb2.CreateProxyRequest(name=name, vm=machine_name, port=port),
            )
        )

    async def list(self, machine_name: str) -> list[Proxy]:
        resp = await self._transport.call(
            "ListProxies", api_pb2.ListProxiesRequest(vm=machine_name)
        )
        return [m.proxy(p) for p in resp.proxies]

    async def delete(self, machine_name: str, name: str) -> None:
        await self._transport.call(
            "DeleteProxy",
            api_pb2.DeleteProxyRequest(name=name, vm=machine_name),
        )

    async def set_port(
        self, machine_name: str, port: int | Literal["auto"], *, name: str | None = None
    ) -> None:
        """Point a route at a different port, or `"auto"` to have the port
        discovered inside the machine instead.

        `"auto"` re-detects for as long as the route stays in auto mode — not
        just once at boot — by watching the guest's own `listen()` calls, so
        it follows the app if its listener moves to a different port later
        (e.g. a restart that binds a new port). Right after boot, a
        higher-priority well-known port (say `:80` over `:3000`) wins
        outright so two services racing to come up don't flap the route.
        After that, a candidate new port has to hold steady — the most
        recently observed well-known port, with no other well-known port
        contending — for a short quiet period before the route switches to
        it, so multiple services racing or a crash-looping app flapping
        between ports won't churn the route — but a real listener move is
        still picked up within a few seconds. Passing a concrete port
        switches the route out of auto mode and stops this re-detection.

        Omit `name` to address the machine's default route. `"auto"` is only
        available there — a named route must be pinned to a port.
        """
        await self._transport.call(
            "SetProxyPort",
            api_pb2.SetProxyPortRequest(
                name=name or "", vm=machine_name, port=str(port)
            ),
        )


class AsyncCheckpoints(Namespace):
    """Async twin of :class:`Checkpoints`."""

    async def create(self, machine_id: str, name: str) -> CreatedCheckpoint:
        return m.created_checkpoint(
            await self._transport.call(
                "CreateCheckpoint",
                api_pb2.CreateCheckpointRequest(vm=machine_id, name=name),
            )
        )

    async def list(self, machine_id: str) -> list[Checkpoint]:
        resp = await self._transport.call(
            "ListCheckpoints", api_pb2.ListCheckpointsRequest(vm=machine_id)
        )
        return [m.checkpoint(c) for c in resp.checkpoints]

    async def delete(self, machine_id: str, name: str) -> None:
        await self._transport.call(
            "DeleteCheckpoint",
            api_pb2.DeleteCheckpointRequest(vm=machine_id, name=name),
        )

    async def restore(self, machine_id: str, name: str) -> None:
        """Warm-restore the machine from a checkpoint. It must be `available`."""
        await self._transport.call(
            "RestoreCheckpoint",
            api_pb2.RestoreCheckpointRequest(vm=machine_id, name=name),
        )


class AsyncBackups(Namespace):
    """Async twin of :class:`Backups`."""

    async def schedule_get(self, machine_id: str) -> BackupSchedule | None:
        resp = await self._transport.call(
            "GetBackupSchedule", api_pb2.GetBackupScheduleRequest(vm=machine_id)
        )
        return m.backup_schedule(resp)

    async def schedule_set(
        self,
        machine_id: str,
        *,
        interval_secs: int | None = None,
        cron: str | None = None,
        retention_secs: int,
    ) -> None:
        if (interval_secs is None) == (cron is None):
            raise ValueError("pass exactly one of interval_secs or cron")
        kind, value = ("interval", str(interval_secs)) if interval_secs is not None else ("cron", cron)
        await self._transport.call(
            "SetBackupSchedule",
            api_pb2.SetBackupScheduleRequest(
                vm=machine_id,
                schedule_kind=kind,
                schedule_value=value,
                retention_secs=retention_secs,
            ),
        )

    async def schedule_clear(self, machine_id: str) -> None:
        await self._transport.call(
            "ClearBackupSchedule", api_pb2.ClearBackupScheduleRequest(vm=machine_id)
        )

    async def list(self, machine_id: str) -> list[Backup]:
        resp = await self._transport.call(
            "ListBackups", api_pb2.ListBackupsRequest(vm=machine_id)
        )
        return [m.backup(b) for b in resp.backups]

    async def trigger(self, machine_id: str) -> str:
        """Back up the machine's disk right now, regardless of any schedule.
        Returns the id of the queued backup."""
        resp = await self._transport.call(
            "TriggerBackup", api_pb2.TriggerBackupRequest(vm=machine_id)
        )
        return resp.backup_id

    async def delete(self, machine_id: str, backup_id: str) -> None:
        """Delete a single backup. Refused while it is still being captured or
        while a newer unchanged-since backup still points at it."""
        await self._transport.call(
            "DeleteBackup",
            api_pb2.DeleteBackupRequest(vm=machine_id, backup_id=backup_id),
        )

    async def restore(self, machine_id: str, backup_id: str) -> None:
        """Restore the machine's disk from a backup IN PLACE. Destructive."""
        await self._transport.call(
            "RestoreBackup",
            api_pb2.RestoreBackupRequest(vm=machine_id, backup_id=backup_id),
        )
