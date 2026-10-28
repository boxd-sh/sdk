"""Proto request builders.

Pure functions from SDK arguments to wire messages. Both clients call these, so
argument validation and every wire quirk (the `from` keyword, `kind`-keyed vars,
"" meaning "use the default") live in exactly one place.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from ._generated import api_pb2
from .models import ProxyEntry, VolumeMount

_SIZE_RE = re.compile(r"^(\d+)\s*([KMGT]?)i?[Bb]?$", re.IGNORECASE)
_MULTIPLIERS = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}


def parse_size(value: int | str | None) -> int:
    """Bytes from an int or a human string ("8G", "512M"). None/0 = server default."""
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    m = _SIZE_RE.match(value.strip())
    if not m:
        raise ValueError(f"invalid size: {value!r}")
    return int(m.group(1)) * _MULTIPLIERS[m.group(2).upper()]


def vm_config(
    *,
    vcpu: int | None = None,
    memory: int | str | None = None,
    disk: int | str | None = None,
    auto_suspend_timeout: int | None = None,
    auto_destroy_timeout: int | None = None,
    idle_ignore_outbound: bool | None = None,
    ssh: bool | None = None,
    proxies: Sequence[ProxyEntry] | None = None,
    volumes: Sequence[VolumeMount] | None = None,
) -> api_pb2.VmConfig | None:
    """Build a `VmConfig`, or None when nothing was asked for.

    Every field uses 0/empty as "use the default", so an all-default config is
    indistinguishable from an omitted one — return None and let the server pick.
    """
    if all(
        v is None
        for v in (
            vcpu,
            memory,
            disk,
            auto_suspend_timeout,
            auto_destroy_timeout,
            idle_ignore_outbound,
            ssh,
            proxies,
            volumes,
        )
    ):
        return None

    config = api_pb2.VmConfig(
        vcpu=vcpu or 0,
        memory_bytes=parse_size(memory),
        disk_bytes=parse_size(disk),
    )
    if auto_suspend_timeout is not None or auto_destroy_timeout is not None:
        # `auto_suspend_timeout_secs` is `optional` on the wire — unset means
        # "server default", 0 means "disabled". Only touch it when asked.
        srf = api_pb2.SrfConfig(auto_destroy_timeout_secs=auto_destroy_timeout or 0)
        if auto_suspend_timeout is not None:
            srf.auto_suspend_timeout_secs = auto_suspend_timeout
        config.srf.CopyFrom(srf)
    if idle_ignore_outbound is not None:
        # `optional` on the wire: unset means "not requested", which
        # is not the same as False. A new machine then takes its org's default
        # and a fork or restore keeps the source's value. Only touch it when
        # asked, and send an explicit False as False.
        config.idle_ignore_outbound = idle_ignore_outbound
    if ssh is not None or proxies is not None:
        network = api_pb2.NetworkConfig(
            proxies=[
                api_pb2.ProxyEntry(name=p.name, port=p.port) for p in (proxies or [])
            ],
        )
        if ssh is not None:
            # `optional` on the wire: unset means "not requested", which is
            # not the same as True. A new machine then has SSH on and a fork
            # or restore keeps the source's setting. Only touch it when
            # asked, and send an explicit False as False.
            network.ssh = ssh
        config.network.CopyFrom(network)
    for volume in volumes or []:
        config.volumes.append(
            api_pb2.VolumeMount(
                disk_id=volume.disk_id,
                mount_path=volume.mount_path,
                read_only=volume.read_only,
            )
        )
    return config


# ── Machines ─────────────────────────────────────────────────────────


def create_vm(
    *,
    name: str | None,
    image: str | None,
    env: Mapping[str, str] | None,
    cmd: Sequence[str] | None,
    restart_policy: str | None,
    org: str | None,
    shared: bool,
    networks: Sequence[str] | None,
    isolated: bool,
    config: api_pb2.VmConfig | None,
    labels: Mapping[str, str] | None = None,
) -> api_pb2.CreateVmRequest:
    request = api_pb2.CreateVmRequest(
        name=name or "",
        image_ref=image or "",
        cmd=list(cmd or []),
        # "always" matches the platform default; every VM restarts on failure.
        restart_policy=restart_policy or "always",
        org=org or "",
        shared=shared,
        networks=list(networks or []),
        isolated=isolated,
        labels=dict(labels or {}),
    )
    for key, value in (env or {}).items():
        request.env.append(api_pb2.EnvVar(key=key, value=value))
    if config is not None:
        request.config.CopyFrom(config)
    return request


def create_vm_from_snapshot(
    *,
    snapshot: str,
    name: str | None,
    org: str | None,
    isolated: bool,
    config: api_pb2.VmConfig | None,
    labels: Mapping[str, str] | None = None,
) -> api_pb2.CreateVmFromSnapshotRequest:
    # `isolated` is one-way: the server ORs it with the flag captured on the
    # snapshot, so False means "inherit", never "de-isolate".
    # `labels` are merged over the ones captured on the snapshot, key by key.
    request = api_pb2.CreateVmFromSnapshotRequest(
        snapshot=snapshot,
        name=name or "",
        org=org or "",
        isolated=isolated,
        labels=dict(labels or {}),
    )
    if config is not None:
        request.config.CopyFrom(config)
    return request


def fork_vm(
    *,
    source: str,
    name: str | None,
    shared: bool,
    networks: Sequence[str] | None,
    isolated: bool,
    config: api_pb2.VmConfig | None,
    labels: Mapping[str, str] | None = None,
) -> api_pb2.ForkVmRequest:
    # `isolated` is one-way: the server ORs it with the source's flag, so False
    # means "inherit", never "de-isolate". `labels` are merged over the
    # source's, key by key.
    request = api_pb2.ForkVmRequest(
        source_vm_id=source,
        name=name or "",
        shared=shared,
        networks=list(networks or []),
        isolated=isolated,
        labels=dict(labels or {}),
    )
    if config is not None:
        request.config.CopyFrom(config)
    return request


def label_selector(
    labels: Mapping[str, str] | Sequence[str] | None,
) -> list[str]:
    """The `ListVms` label selector from a `labels=` filter.

    A mapping means "equals" on every pair (``{"env": "prod"}`` →
    ``["env=prod"]``). A sequence is passed through as selector strings:
    ``"key=value"`` (equals) or ``"key"`` (has the key). Entries are ANDed;
    the server validates them.
    """
    if labels is None:
        return []
    if isinstance(labels, str):
        # A bare string is a sequence of characters; take it as one selector.
        return [labels]
    if isinstance(labels, Mapping):
        return [f"{key}={value}" for key, value in labels.items()]
    return list(labels)


def labels_match(selector: Sequence[str], labels: Mapping[str, str]) -> bool:
    """Whether a machine's labels match a selector from :func:`label_selector`:
    every ``"key=value"`` entry equals, every ``"key"`` entry exists.

    The server filters too; ``machines.list`` checks again with this because a
    server from before labels ignores the selector and returns every machine,
    with no labels, so nothing matches rather than everything.
    """
    for term in selector:
        key, sep, value = term.partition("=")
        if sep:
            if labels.get(key) != value:
                return False
        elif key not in labels:
            return False
    return True


def list_vms(
    *,
    org: str | None,
    all_contexts: bool,
    labels: Mapping[str, str] | Sequence[str] | None = None,
) -> api_pb2.ListVmsRequest:
    return api_pb2.ListVmsRequest(
        org=org or "",
        all_contexts=all_contexts,
        label_selector=label_selector(labels),
    )


def update_vm_labels(
    *,
    machine_id: str,
    set: Mapping[str, str] | None,
    remove: Sequence[str] | None,
    replace_all: bool,
) -> api_pb2.UpdateVmLabelsRequest:
    """Build an `UpdateVmLabels` request.

    ``replace_all`` makes ``set`` the whole label set, so a ``remove`` next to
    it is meaningless; the server refuses that, and so does this, with the
    reason.
    """
    if isinstance(remove, str):
        remove = [remove]
    if replace_all and remove:
        raise ValueError(
            "update_labels(replace_all=True) does not accept remove - "
            "replace_all makes `set` the complete label set, so any key not "
            "in it is removed already"
        )
    return api_pb2.UpdateVmLabelsRequest(
        vm=machine_id,
        set=dict(set or {}),
        remove=list(remove or []),
        replace_all=replace_all,
    )


def update_machine_spec(
    *,
    machine_id: str,
    patch: dict,
    dry_run: bool,
    reboot: bool,
    retry_packages: bool = False,
    expected_spec: Mapping[str, Any] | None = None,
) -> api_pb2.UpdateMachineSpecRequest:
    """Build an `UpdateMachineSpec` request: the patch travels as JSON, so
    `None` (remove) and `[]` (an empty list) survive. `expected_spec` is the
    spec the caller read, as JSON too ('' = no check)."""
    return api_pb2.UpdateMachineSpecRequest(
        vm=machine_id,
        patch=json.dumps(patch),
        dry_run=dry_run,
        reboot=reboot,
        retry_packages=retry_packages,
        expected_spec=json.dumps(dict(expected_spec)) if expected_spec is not None else "",
    )


def resize_vm(
    *, machine_id: str, vcpu: int | None, memory: int | str | None
) -> api_pb2.ResizeVmRequest:
    """Build a `ResizeVm` request.

    Either dimension names a whole size class, so one of them is enough — the
    server resolves the other. Asking for neither is a caller mistake, not a
    "use the default": zeroes on the wire would leave the server nothing to
    resolve, so it is rejected here with a message that says what to pass.
    """
    if vcpu is None and memory is None:
        raise ValueError(
            "resize needs vcpu or memory - either one names a size class "
            "(1 vCPU/4G, 2/8G, 4/16G, 8/32G) and the other follows from it"
        )
    return api_pb2.ResizeVmRequest(
        vm_id=machine_id, vcpu=vcpu or 0, memory_bytes=parse_size(memory)
    )


def exec_chunk(
    *,
    machine_id: str,
    command: str = "",
    data: bytes = b"",
    stdin: bool = False,
    tty: bool = False,
    cols: int = 0,
    rows: int = 0,
    window_change: bool = False,
) -> api_pb2.ExecChunk:
    return api_pb2.ExecChunk(
        vm_id=machine_id,
        command=command,
        data=data,
        stdin=stdin,
        tty=tty,
        cols=cols,
        rows=rows,
        window_change=window_change,
    )


def join_command(command: str | Sequence[str]) -> str:
    """`ExecChunk.command` is one string; accept a list for convenience."""
    if isinstance(command, str):
        return command
    import shlex

    return shlex.join(command)


def upload_chunks(
    *, machine_id: str, path: str, data: bytes, chunk_size: int
) -> Iterable[api_pb2.UploadFileChunk]:
    """Stream a file as `UploadFileChunk`s.

    The first chunk carries vm_id/path/total_size; later chunks carry bytes
    only. The server reads exactly `total_size` bytes, so an empty file still
    needs its header chunk.
    """
    total = len(data)
    first = True
    offset = 0
    while first or offset < total:
        slice_ = data[offset : offset + chunk_size]
        if first:
            yield api_pb2.UploadFileChunk(
                vm_id=machine_id, path=path, total_size=total, data=slice_
            )
            first = False
        else:
            yield api_pb2.UploadFileChunk(data=slice_)
        offset += len(slice_)


# ── machines.fs ──────────────────────────────────────────────────────


def fs_path(path) -> bytes:
    """A `machines.fs` path for the wire: paths are bytes on the machine.

    A `str` is encoded as UTF-8 with surrogate escapes, which is what
    `os.fsencode` does on Linux, so a name `machines.fs` returned (decoded the
    same way) reaches the same file even if it isn't valid UTF-8. It doesn't
    depend on the local platform's filesystem encoding.
    """
    path = os.fspath(path)
    if isinstance(path, bytes):
        return path
    if isinstance(path, str):
        return path.encode("utf-8", "surrogateescape")
    raise TypeError(f"path must be str, bytes or os.PathLike, not {type(path).__name__}")


def fs_one_shot(data) -> bytes | None:
    """`data` as bytes when it's a single buffer (or a str), else None."""
    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    return None


def fs_read(
    *, machine_id: str, path: bytes, offset: int, length: int | None
) -> api_pb2.FsReadRequest:
    request = api_pb2.FsReadRequest(vm_id=machine_id, path=path, offset=offset)
    if length is not None:
        request.length = length
    return request


class FsWriteFramer:
    """Frames a write's bytes as `FsWriteChunk`s of at most `chunk_size` bytes.

    The first chunk names the machine and path and carries the options; the
    rest carry bytes only. Closing the stream ends the file, so an empty file
    is one chunk with no data. Shared by the sync and async writers, which
    differ only in how they iterate the caller's data.
    """

    def __init__(
        self,
        *,
        machine_id: str,
        path: bytes,
        mode: int | None,
        expected_size: int | None,
        chunk_size: int,
    ):
        options: dict[str, Any] = {"vm_id": machine_id, "path": path}
        if mode is not None:
            options["mode"] = mode
        if expected_size is not None:
            options["expected_size"] = expected_size
        self._header: dict[str, Any] | None = options
        self._chunk_size = chunk_size

    def feed(self, piece: bytes) -> Iterator[api_pb2.FsWriteChunk]:
        if not isinstance(piece, (bytes, bytearray, memoryview)):
            raise TypeError(
                f"write: the data iterable must yield bytes, not {type(piece).__name__}"
            )
        view = memoryview(piece).cast("B")
        for offset in range(0, len(view), self._chunk_size):
            yield self._chunk(bytes(view[offset : offset + self._chunk_size]))

    def close(self) -> Iterator[api_pb2.FsWriteChunk]:
        if self._header is not None:
            yield self._chunk(b"")

    def _chunk(self, data: bytes) -> api_pb2.FsWriteChunk:
        header, self._header = self._header, None
        if header is None:
            return api_pb2.FsWriteChunk(data=data)
        return api_pb2.FsWriteChunk(**header, data=data)


def fs_write_chunks(
    framer: FsWriteFramer, pieces: Iterable[bytes]
) -> Iterator[api_pb2.FsWriteChunk]:
    for piece in pieces:
        yield from framer.feed(piece)
    yield from framer.close()


# ── Env & secrets ────────────────────────────────────────────────────


def set_var(
    *,
    kind: str,
    name: str,
    value: str,
    scope: str | None,
    org: str | None,
    domains: Sequence[str] | None = None,
) -> api_pb2.SetVarRequest:
    return api_pb2.SetVarRequest(
        org=org or "",
        kind=kind,
        name=name,
        value=value,
        scope=scope or "",
        domains=list(domains or []),
    )


def list_vars(*, kind: str, org: str | None) -> api_pb2.ListVarsRequest:
    return api_pb2.ListVarsRequest(org=org or "", kind=kind)


def remove_var(
    *, kind: str, name: str, scope: str | None, org: str | None
) -> api_pb2.RemoveVarRequest:
    return api_pb2.RemoveVarRequest(
        org=org or "", kind=kind, name=name, scope=scope or ""
    )


def move_var(
    *, name: str, from_scope: str, to_scope: str, org: str | None
) -> api_pb2.SetSecretScopeRequest:
    """`SetSecretScope` is misnamed — the handler never inspects `kind`, so it
    moves env vars too. `from` is a Python keyword, hence the setattr."""
    request = api_pb2.SetSecretScopeRequest(org=org or "", name=name, to=to_scope)
    setattr(request, "from", from_scope)
    return request


# ── Orgs ─────────────────────────────────────────────────────────────


def set_org_machine_defaults(
    *, org: str | None, vcpu: int | None, memory: int | str | None
) -> api_pb2.SetOrgMachineDefaultsRequest:
    """Build a `SetOrgMachineDefaults` request.

    Both fields are `optional` on the wire, and absence is what clears the
    default — so an unset argument must stay unset rather than become 0.
    """
    request = api_pb2.SetOrgMachineDefaultsRequest(org_id=org or "")
    if vcpu is not None:
        request.vcpu = vcpu
    if memory is not None:
        request.memory_bytes = parse_size(memory)
    return request


def set_org_idle_ignore_outbound_default(
    *,
    org: str | None,
    enabled: bool | None,
    new_machines_only: bool = False,
    apply_existing: bool | None = None,
) -> api_pb2.SetOrgIdleIgnoreOutboundDefaultRequest:
    """Build a `SetOrgIdleIgnoreOutboundDefault` request.

    `enabled` is `optional` on the wire, and absence is what clears the
    default, so None must stay unset rather than become False.

    Existing machines change unless `new_machines_only`. The wire
    also carries `apply_existing` as its opposite, so an older server,
    which only reads that field, does the same. `apply_existing` is
    accepted from callers written against 0.2.16 and changes nothing, but
    asking for it together with `new_machines_only` is a contradiction.
    """
    if apply_existing and new_machines_only:
        raise ValueError(
            "apply_existing=True and new_machines_only=True contradict each other: "
            "existing machines change unless new_machines_only=True"
        )
    request = api_pb2.SetOrgIdleIgnoreOutboundDefaultRequest(
        org_id=org or "",
        new_machines_only=new_machines_only,
        # A clear has nothing to apply, and an older server refuses a
        # clear that asks for it.
        apply_existing=enabled is not None and not new_machines_only,
    )
    if enabled is not None:
        request.enabled = enabled
    return request


def unix_seconds(t: datetime | int | float | None) -> int:
    """A usage window bound as unix seconds; 0 when absent (the server default).

    A naive datetime is taken as UTC, like the rest of the API's times.
    """
    if t is None:
        return 0
    if isinstance(t, datetime):
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return math.floor(t.timestamp())
    return math.floor(t)


def set_delete_after(machine_id: str, seconds: int, cron: str | None):
    """`SetDeleteAfter` for a duration or a cron expression. The
    server rejects both at once; here we catch it before the round trip."""
    if seconds and cron:
        raise ValueError("pass seconds or cron, not both")
    return api_pb2.SetDeleteAfterRequest(
        vm_id=machine_id, delete_after_secs=seconds or 0, delete_after_cron=cron or ""
    )
