"""Wire → model mappers.

proto3 cannot express "unset" for a scalar, so the generated messages hand back
`0` and `""` for both "absent" and "genuinely zero/empty". **A blanket
zero-to-null rule is wrong**: `ssh_port: 0` means "not allocated" while
`auto_suspend_timeout_secs: 0` means "disabled". Only the proto comments tell
them apart, which is why these are hand-written per resource.

Every function here is pure — the sync and async clients share all of it.
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import spec as _spec

from .models import (
    Account,
    ApiKey,
    Backup,
    BackupSchedule,
    Billing,
    Checkpoint,
    ClusterConfig,
    CreatedApiKey,
    CreatedCheckpoint,
    CreatedDisk,
    CreatedOrg,
    CreatedProxy,
    CreatedSnapshot,
    CustomDomain,
    Disk,
    DirEntry,
    DirListing,
    DiskAttachment,
    EnvVar,
    ExposedPort,
    FsEntry,
    FsEntryType,
    BillingActivityEntry,
    BillingActivityPage,
    Machine,
    MachineAccess,
    MachineIdle,
    MachineNetworking,
    MachinePackage,
    MachineSpecChange,
    MachineSpecUpdate,
    MachineRequirement,
    MachineResources,
    MachineSource,
    MachineUsage,
    MachineUsageReport,
    Org,
    OrgBotProtectionDefault,
    OrgBotProtectionDefaultResult,
    OrgDomain,
    OrgIdleIgnoreOutboundDefault,
    OrgIdleIgnoreOutboundDefaultResult,
    OrgInvite,
    MachineLimitRequest,
    OrgMachineDefaults,
    OrgMachineLimit,
    OrgMember,
    OrgMembers,
    OrgRef,
    OrgUsage,
    Proxy,
    ResizeResult,
    Secret,
    Snapshot,
    StateSeconds,
    Team,
    TeamMember,
    UsagePeriod,
    UsageRates,
)


def _text(value: str) -> str | None:
    """Empty string as absent."""
    return value or None


def _epoch(seconds: int) -> datetime | None:
    """Epoch seconds → aware datetime. 0 = never/unset."""
    if not seconds:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _epoch_always(seconds: int) -> datetime:
    """Epoch seconds → aware datetime, for fields the server always sets."""
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _epoch_ms(millis: int) -> datetime | None:
    """Epoch MILLISECONDS → aware datetime. 0 = it never happened."""
    if not millis:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)


def _epoch_ms_always(millis: int) -> datetime:
    """Epoch MILLISECONDS → aware datetime, for fields the server always sets."""
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)


# ── Machines ─────────────────────────────────────────────────────────


def _desktop_url(name: str, console_origin: str) -> str:
    """`<console>/desktop/<name>`, or "" when the console origin is unknown."""
    return f"{console_origin}/desktop/{name}" if console_origin else ""


def _machine_url(name: str, domain: str) -> str:
    """`https://<name>.<domain>`, or "" when the domain is not known yet."""
    return f"https://{name}.{domain}" if domain else ""


def machine_source(msg) -> MachineSource | None:
    """An unset `VmSource` is how the wire says "standalone" — not a kind."""
    if not msg.HasField("source_info"):
        return None
    src = msg.source_info
    return MachineSource(
        kind=src.kind,
        name=src.name,
        # A fork has no version; the wire sends 0 for it.
        version=src.version or None,
        id=_text(src.id),
    )


def machine(msg, console_origin: str = "") -> Machine:
    # `billing_org`/`billing_org_id` name the machine's org whether or not it
    # is shared. `org`/`org_id` are the same org, blanked when it is private —
    # so they answer "is it shared", and nothing else.
    org_ref = (
        OrgRef(id=msg.billing_org_id, name=msg.billing_org)
        if (msg.billing_org or msg.billing_org_id)
        else None
    )
    return Machine(
        id=msg.vm_id,
        name=msg.name,
        status=msg.status,
        image_ref=msg.image_ref,
        restart_policy=_text(msg.restart_policy),
        created_at=_epoch(msg.created_at),
        # NOT nulled: the server's effective sizing, always concrete.
        resources=MachineResources(
            vcpu=msg.vcpu,
            memory_bytes=msg.memory_bytes,
            disk_bytes=msg.disk_bytes,
        ),
        org=org_ref,
        shared=bool(msg.org or msg.org_id),
        networking=MachineNetworking(
            networks=list(msg.networks), isolated=msg.isolated
        ),
        egress_allow=list(msg.egress_allow),
        labels=dict(msg.labels),
        access=MachineAccess(
            # 0 = not yet allocated, never a real port.
            ssh_port=msg.ssh_port or None,
            domain=msg.access_domain,
            url=_machine_url(msg.name, msg.access_domain),
            desktop_url=_desktop_url(msg.name, console_origin),
            custom_domains=[custom_domain(d) for d in msg.custom_domains],
        ),
        # 0 is MEANINGFUL here — disabled, not unset. Do not null it.
        idle=MachineIdle(
            suspend_after=msg.auto_suspend_timeout_secs,
            hibernate_after=msg.auto_hibernate_timeout_secs,
            destroy_after=msg.auto_destroy_timeout_secs,
        ),
        bot_protection=msg.bot_protection,
        # A server that predates the mode sends only the bool, whose true
        # only ever meant sleep-only.
        bot_protection_mode=msg.bot_protection_mode
        or ("sleep_only" if msg.bot_protection else "off"),
        idle_ignore_outbound=msg.idle_ignore_outbound,
        # Inverted on the wire, so a server that predates it reads as on.
        ssh=not msg.ssh_disabled,
        delete_at=_epoch_ms(msg.delete_at_ms),
        delete_after_cron=msg.delete_after_cron or None,
        source=machine_source(msg),
        hibernated_at=_epoch_ms(msg.hibernated_at_ms),
        last_connected_at=_epoch_ms(msg.last_connected_ms),
        boot_time_ms=msg.boot_time_ms or None,
        spec=_spec.from_wire(msg.spec, msg.HasField("spec")),
        created_spec=_spec.from_wire(msg.created_spec, msg.HasField("created_spec")),
        created_by=msg.created_by or None,
        created_by_name=msg.created_by_name or None,
        requirements=[machine_requirement(r) for r in msg.requirements],
        packages=[machine_package(p) for p in msg.packages],
    )


def machine_package(msg) -> MachinePackage:
    return MachinePackage(
        command=msg.command,
        state=msg.state
        if msg.state in ("pending", "running", "done", "failed", "skipped")
        else "pending",
        exit_code=msg.exit_code if msg.HasField("exit_code") else None,
        output_tail=msg.output_tail,
        reason=msg.reason or None,
        started_at=_epoch_ms(msg.started_at_ms),
        finished_at=_epoch_ms(msg.finished_at_ms),
    )


def machine_requirement(msg) -> MachineRequirement:
    return MachineRequirement(
        kind="agent" if msg.kind == "agent" else "connection",
        name=msg.name,
        scope="shared" if msg.scope == "shared" else "personal",
        tag=msg.tag or None,
        met=msg.met,
        can_fix=msg.can_fix,
        reason=msg.reason or None,
    )


def machine_from_created(msg) -> Machine:
    """`CreateVmResponse` / `ForkVmResponse` → a partial :class:`Machine`.

    These responses answer before placement finishes and carry far fewer fields
    than `GetVmResponse`. `create`/`fork` re-read the machine to fill in the
    rest; this is the fallback for when that read fails.
    """
    return Machine(
        id=msg.vm_id,
        name=msg.name,
        status=msg.status,
        image_ref=msg.image,
        restart_policy=None,
        created_at=None,
        # Zeros here mean "not reported by this response", not "sized at zero".
        resources=MachineResources(vcpu=0, memory_bytes=0, disk_bytes=0),
        org=None,
        shared=False,
        # Not reported by these responses — `create`/`fork` re-read the
        # machine, so this fallback only shows when that read failed.
        networking=MachineNetworking(networks=[], isolated=False),
        egress_allow=[],
        # Not reported by these responses; the re-read fills them in.
        labels={},
        access=MachineAccess(
            ssh_port=None, domain="", url="", desktop_url="", custom_domains=[]
        ),
        idle=MachineIdle(suspend_after=0, hibernate_after=0, destroy_after=0),
        # Not reported by these responses. A new machine starts protected;
        # which mode is the cluster's choice, so it stays unknown here.
        bot_protection=True,
        bot_protection_mode=None,
        # Not reported by these responses either. False here means "not
        # known", not "off": the org default or the fork's source may have
        # set it.
        idle_ignore_outbound=False,
        # Not reported either. True here means "not known": the fork's
        # source or the snapshot may have had SSH off.
        ssh=True,
        source=None,
        hibernated_at=None,
        last_connected_at=None,
        boot_time_ms=None,
    )


def exposed_port(msg) -> ExposedPort:
    return ExposedPort(
        machine_id=msg.vm_id,
        machine_name=msg.vm_name,
        dns=msg.dns,
        public_port=msg.public_port,
        machine_port=msg.vm_port,
        protocol=msg.protocol,
    )


def proxy(msg) -> Proxy:
    return Proxy(
        name=_text(msg.name),
        machine_id=msg.vm_id,
        machine_name=msg.vm_name,
        domain=msg.domain,
        # `effective_port` is what traffic lands on; `port` is only what is
        # stored, and reads 0 for an auto proxy that has been detected.
        port=msg.effective_port,
        port_mode=msg.port_mode,
        is_default=msg.is_default,
    )


def created_proxy(msg) -> CreatedProxy:
    """`CreateProxyResponse` confirms the subdomain and the port it points at."""
    return CreatedProxy(name=msg.name, port=msg.port)


def checkpoint(msg) -> Checkpoint:
    return Checkpoint(
        id=msg.checkpoint_id,
        name=msg.name,
        status=msg.status,
        size_bytes=msg.size_bytes,
        created_at=_epoch_ms_always(msg.created_at),
        created_by=_text(msg.created_by),
        available=msg.available,
    )


def created_checkpoint(msg) -> CreatedCheckpoint:
    return CreatedCheckpoint(id=msg.checkpoint_id, name=msg.name, status=msg.status)


# ── Backups (disaster recovery) ─────────────────────────────────────────


def backup_schedule(msg) -> BackupSchedule | None:
    """`GetBackupScheduleResponse` — `enabled=False` means no schedule (off)."""
    if not msg.enabled:
        return None
    return BackupSchedule(
        schedule_kind=msg.schedule_kind,
        schedule_value=msg.schedule_value,
        retention_secs=msg.retention_secs,
        next_backup_at=_epoch_ms_always(msg.next_backup_at),
        last_backup_at=_epoch_ms(msg.last_backup_at),
    )


def backup(msg) -> Backup:
    return Backup(
        id=msg.backup_id,
        status=msg.status,
        size_bytes=msg.size_bytes,
        checksum=_text(msg.checksum),
        points_to_backup_id=_text(msg.points_to_backup_id),
        created_at=_epoch_ms_always(msg.created_at),
        expires_at=_epoch_ms_always(msg.expires_at),
    )


# ── Snapshots ────────────────────────────────────────────────────────


def snapshot(msg) -> Snapshot:
    return Snapshot(
        id=msg.snapshot_id,
        name=msg.name,
        # 0 = nothing captured yet, which is not "version zero".
        version=msg.version or None,
        status=msg.status,
        size_bytes=msg.size_bytes,
        created_at=_epoch_ms(msg.created_at),
        updated_at=_epoch_ms(msg.updated_at),
        vcpu=msg.vcpu,
        memory_bytes=msg.memory_bytes,
        use_count=msg.use_count,
        # A server that predates archiving sends neither: on local disk.
        storage=msg.storage or "local",
        archived=msg.archived,
    )


def created_snapshot(msg) -> CreatedSnapshot:
    return CreatedSnapshot(
        id=msg.snapshot_id,
        name=msg.name,
        version=msg.version,
        status=msg.status,
        paused_automations=msg.paused_automations,
    )


# ── Disks ────────────────────────────────────────────────────────────


def disk_attachment(msg) -> DiskAttachment:
    return DiskAttachment(
        machine_id=msg.vm_id,
        machine_name=msg.vm_name,
        mount_path=msg.mount_path,
        mount_mode=msg.mount_mode,
    )


def disk(msg) -> Disk:
    return Disk(
        id=msg.disk_id,
        name=msg.name,
        size_bytes=msg.size_bytes,
        status=msg.status,
        created_at=_epoch_ms(msg.created_at),
        attachments=[disk_attachment(a) for a in msg.attachments],
    )


def created_disk(msg) -> CreatedDisk:
    return CreatedDisk(
        id=msg.disk_id, name=msg.name, size_bytes=msg.size_bytes, status=msg.status
    )


# ── Domains ──────────────────────────────────────────────────────────


def custom_domain(msg) -> CustomDomain:
    return CustomDomain(
        domain=msg.domain,
        machine_id=msg.vm_id,
        machine_name=msg.vm_name,
        status=msg.status,
        last_error=msg.last_error,
    )


def spec_update(msg) -> MachineSpecUpdate:
    return MachineSpecUpdate(
        changes=[
            MachineSpecChange(
                field=c.field,
                apply=c.apply
                if c.apply in ("live", "reboot_recommended", "reboot", "refused")
                else "refused",
                added=list(c.added),
                removed=list(c.removed),
                changed=list(c.changed),
                before=c.before or None,
                after=c.after or None,
                note=c.note,
                warnings=list(c.warnings),
                skipped=list(c.skipped),
                unskipped=list(c.unskipped),
            )
            for c in msg.changes
        ],
        reboot_required=msg.reboot_required,
        reboot_recommended=msg.reboot_recommended,
        spec=_spec.from_wire(msg.spec, True),
        applied=msg.applied,
        rebooted=msg.rebooted,
        resize_error=msg.resize_error or None,
    )


def resize_result(msg) -> ResizeResult:
    return ResizeResult(
        vcpu=msg.vcpu, memory_bytes=msg.memory_bytes, rebooted=msg.rebooted
    )


def dir_entry(msg) -> DirEntry:
    return DirEntry(
        name=msg.name,
        is_dir=msg.is_dir,
        size_bytes=msg.size_bytes,
        permissions=msg.permissions,
        modified_at=_epoch_always(msg.modified_at),
        added_at=_epoch_always(msg.added_at),
    )


def dir_listing(msg) -> DirListing:
    return DirListing(
        entries=[dir_entry(e) for e in msg.entries],
        truncated=msg.truncated,
    )


def fs_text(raw: bytes) -> str:
    """A path off the wire. Bytes that aren't UTF-8 become surrogate escapes
    (what `os.fsdecode` does on Linux), so `_requests.fs_path` turns the result
    back into the same bytes."""
    return raw.decode("utf-8", "surrogateescape")


_FS_ENTRY_TYPES: dict[int, FsEntryType] = {
    1: "file",
    2: "directory",
    3: "symlink",
    4: "other",
}


def fs_entry(msg) -> FsEntry:
    # A type this SDK doesn't know yet is still *something*: "other". Only
    # an unset target_type (a dangling or looping link) is None.
    target = msg.target_type
    return FsEntry(
        name=fs_text(msg.name),
        path=fs_text(msg.path),
        type=_FS_ENTRY_TYPES.get(msg.type, "other"),
        target_type=_FS_ENTRY_TYPES.get(target, "other") if target else None,
        size=msg.size,
        mode=msg.mode,
        mtime_ns=msg.mtime_ns,
        uid=msg.uid,
        gid=msg.gid,
        symlink_target=fs_text(msg.symlink_target) if msg.symlink_target else None,
    )


def org_domain(msg) -> OrgDomain:
    return OrgDomain(
        org_id=msg.org_id,
        domain=msg.domain,
        status=msg.status,
        last_error=msg.last_error,
    )


def env_var(msg) -> EnvVar:
    return EnvVar(name=msg.name, scope=msg.scope, value=msg.value)


def secret(msg) -> Secret:
    """`VarItem.value` is always empty for secrets — the model has no `value`."""
    return Secret(
        name=msg.name,
        scope=msg.scope,
        domains=list(msg.domains),
        bound_machines=msg.bound_machines,
    )


# ── Orgs ─────────────────────────────────────────────────────────────


def org(msg, default_org_id: str = "") -> Org:
    return Org(
        id=msg.id,
        name=msg.name,
        slug=msg.slug,
        is_admin=msg.is_admin,
        is_default=msg.id == default_org_id,
    )


def org_machine_defaults(msg) -> OrgMachineDefaults:
    return OrgMachineDefaults(
        is_set=msg.set,
        vcpu=msg.vcpu,
        memory_bytes=msg.memory_bytes,
        ceiling_vcpu=msg.ceiling_vcpu,
        ceiling_memory_bytes=msg.ceiling_memory_bytes,
    )


def machine_limit_request(requested_at: int, max_vms: int) -> MachineLimitRequest | None:
    """`requested_at` 0 = no request open; `max_vms` 0 = it named no number."""
    if requested_at <= 0:
        return None
    return MachineLimitRequest(
        requested_at=_epoch_always(requested_at), max_vms=max_vms or None
    )


def opened_machine_limit_request(msg) -> MachineLimitRequest:
    """A `RequestOrgMachineLimit` answer: the request just opened."""
    return MachineLimitRequest(
        requested_at=_epoch_always(msg.requested_at),
        max_vms=msg.requested_max_vms or None,
    )


def org_machine_limit(msg) -> OrgMachineLimit:
    return OrgMachineLimit(
        org_id=msg.org_id,
        org_name=msg.org_name,
        max_vms=msg.max_vms,
        vm_count=msg.vm_count,
        is_owner=msg.is_owner,
        request=machine_limit_request(msg.requested_at, msg.requested_max_vms),
    )


def org_idle_ignore_outbound_default(msg) -> OrgIdleIgnoreOutboundDefault:
    # `set` on the wire; `is_set` here, like `OrgMachineDefaults`.
    return OrgIdleIgnoreOutboundDefault(
        is_set=msg.set,
        enabled=msg.enabled,
        platform_enabled=msg.platform_enabled,
    )


def org_idle_ignore_outbound_default_result(
    msg,
) -> OrgIdleIgnoreOutboundDefaultResult:
    return OrgIdleIgnoreOutboundDefaultResult(
        machines_changed=msg.machines_changed,
        snapshots_changed=msg.snapshots_changed,
        machines_skipped=msg.machines_skipped,
    )


def org_bot_protection_default(msg) -> OrgBotProtectionDefault:
    return OrgBotProtectionDefault(
        is_set=msg.set, mode=msg.mode, platform_mode=msg.platform_mode or None
    )


def org_bot_protection_default_result(msg) -> OrgBotProtectionDefaultResult:
    return OrgBotProtectionDefaultResult(
        machines_changed=msg.machines_changed,
        snapshots_changed=msg.snapshots_changed,
        machines_off=msg.machines_off,
        machines_skipped=msg.machines_skipped,
    )


def created_org(msg) -> CreatedOrg:
    return CreatedOrg(id=msg.id, name=msg.name)


def org_member(msg) -> OrgMember:
    return OrgMember(
        user_id=msg.user_id,
        role=msg.role,
        display_name=msg.display_name,
        github_username=msg.github_username,
    )


def org_invite(msg) -> OrgInvite:
    return OrgInvite(
        token=msg.token,
        email=msg.email,
        accept_url=msg.accept_url,
        created_at=_epoch_always(msg.created_at),
        expires_at=_epoch_always(msg.expires_at),
        role=msg.role,
        email_status=msg.email_status,
    )


def org_members(msg) -> OrgMembers:
    return OrgMembers(
        members=[org_member(m) for m in msg.members],
        invites=[org_invite(i) for i in msg.invites],
    )


def invited_org_member(msg, email: str, role: str) -> OrgInvite:
    """`InviteOrgMemberResponse` doesn't echo `email`/`role` back (the caller
    already has them) — fold them in here so `Orgs.invite` returns the same
    `OrgInvite` shape `get_members` does."""
    return OrgInvite(
        token=msg.token,
        email=email,
        accept_url=msg.accept_url,
        created_at=_epoch_always(msg.created_at),
        expires_at=_epoch_always(msg.expires_at),
        role=role,
        email_status=msg.email_status,
    )


# ── Teams ────────────────────────────────────────────────────────────


def team_member(msg) -> TeamMember:
    return TeamMember(
        user_id=msg.user_id,
        role=msg.role,
        display_name=msg.display_name,
        github_username=msg.github_username,
        added_at=_epoch_ms_always(msg.added_at),
    )


def team(msg) -> Team:
    return Team(
        id=msg.id,
        org_id=msg.org_id,
        name=msg.name,
        created_by_user_id=msg.created_by_user_id,
        created_at=_epoch_ms_always(msg.created_at),
        is_admin=msg.is_admin,
        members=[team_member(m) for m in msg.members],
        default_snapshot_id=msg.default_snapshot_id or None,
    )



def api_key(msg) -> ApiKey:
    return ApiKey(
        id=msg.id,
        name=msg.name,
        key_prefix=msg.key_prefix,
        created_at=_epoch_always(msg.created_at),
        # 0 = never used / no expiry.
        last_used_at=_epoch(msg.last_used_at),
        expires_at=_epoch(msg.expires_at),
        org=msg.org,
        kind=msg.kind,
        created_by=msg.created_by,
        # An older server lists only the caller's own keys and
        # sends neither field.
        mine=msg.mine or not msg.created_by,
    )


def created_api_key(msg) -> CreatedApiKey:
    return CreatedApiKey(
        id=msg.id, api_key=msg.api_key, expires_at=_epoch(msg.expires_at)
    )



def billing(msg) -> Billing:
    return Billing(
        subscription_status=_text(msg.subscription_status),
        past_due_since=_epoch(msg.past_due_since),
        max_vms=msg.max_vms,
        vcpu=msg.vcpu,
        memory_bytes=msg.memory_bytes,
    )



def account(msg) -> Account:
    return Account(
        user_id=msg.user_id,
        display_name=_text(msg.display_name),
        pubkey_fingerprints=list(msg.pubkey_fingerprints),
        # An account that never upgraded still gets a BillingInfo, all zeros.
        billing=billing(msg.billing),
    )


def cluster_config(msg) -> ClusterConfig:
    return ClusterConfig(default_image=msg.default_image, zone=msg.zone)


# ── Usage & cost ─────────────────────────────────────────────────────


def _usage_rates(msg) -> UsageRates:
    return UsageRates(
        vcpu_hour_micro=msg.vcpu_hour_micro,
        ram_gib_hour_micro=msg.ram_gib_hour_micro,
        disk_gib_hour_micro=msg.disk_gib_hour_micro,
    )


def _usage_period(start: int, end: int) -> UsagePeriod:
    return UsagePeriod(start=_epoch_always(start), end=_epoch_always(end))


def _machine_usage_fields(v) -> dict:
    return {
        "machine_id": v.vm_id,
        "name": v.name,
        "owner_id": v.owner or None,
        "owner_name": v.owner_name or None,
        "shared": v.sharing == "shared",
        "status": v.status,
        "resources": MachineResources(
            vcpu=v.vcpu, memory_bytes=v.memory_bytes, disk_bytes=v.disk_bytes
        ),
        "seconds": StateSeconds(
            running=v.seconds.running,
            standby=v.seconds.standby,
            hibernated=v.seconds.hibernated,
            stopped=v.seconds.stopped,
        ),
        "vcpu_hours": v.vcpu_hours,
        "ram_gib_hours": v.ram_gib_hours,
        "disk_gib_hours": v.disk_gib_hours,
        "cost_micro": v.cost_micro,
        "complete": v.complete,
    }


def machine_usage_report(msg) -> MachineUsageReport:
    return MachineUsageReport(
        **_machine_usage_fields(msg.usage),
        period=_usage_period(msg.period_start, msg.period_end),
        currency=msg.currency,
        rates=_usage_rates(msg.rates),
    )


def org_usage(msg) -> OrgUsage:
    return OrgUsage(
        org_id=msg.org_id,
        org=msg.org,
        period=_usage_period(msg.period_start, msg.period_end),
        currency=msg.currency,
        rates=_usage_rates(msg.rates),
        total_cost_micro=msg.total_cost_micro,
        complete=msg.complete,
        machines=[MachineUsage(**_machine_usage_fields(v)) for v in msg.vms],
    )


def billing_activity_page(msg) -> BillingActivityPage:
    return BillingActivityPage(
        currency=msg.currency,
        balance_micro=msg.balance_micro,
        entries=[
            BillingActivityEntry(
                id=e.entry_id,
                kind=e.kind,
                amount_micro=e.amount_micro,
                created_at=_epoch_always(e.created_at),
            )
            for e in msg.entries
        ],
        next_page_token=msg.next_page_token or None,
    )
