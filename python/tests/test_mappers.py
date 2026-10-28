"""Mapper edge cases — mostly: which zeros mean "unset" and which mean zero."""

from __future__ import annotations

from datetime import datetime, timezone

from boxd import _mappers as m
from boxd._generated import api_pb2
from boxd.models import Secret


def a_vm(**overrides):
    fields = dict(
        vm_id="vm-1",
        name="alpha",
        image_ref="debian:12",
        status="running",
        restart_policy="always",
        disk_bytes=100,
        auto_suspend_timeout_secs=30,
        ssh_port=10001,
        org="acme",
        org_id="org-acme",
        billing_org="acme",
        billing_org_id="org-acme",
        access_domain="boxd.sh",
        auto_hibernate_timeout_secs=600,
        auto_destroy_timeout_secs=0,
        source="standalone",
        vcpu=2,
        memory_bytes=8 * 1024**3,
        created_at=1_700_000_000,
        hibernated_at_ms=0,
        boot_time_ms=0,
        last_connected_ms=0,
    )
    fields.update(overrides)
    return api_pb2.GetVmResponse(**fields)


# --- the per-field zero rule ---


def test_delete_at_zero_means_no_timer():
    assert m.machine(a_vm()).delete_at is None
    assert m.machine(a_vm()).delete_after_cron is None
    assert m.machine(a_vm(delete_at_ms=1, delete_after_cron="0 18 * * *")).delete_after_cron == "0 18 * * *"
    assert m.machine(a_vm(delete_at_ms=1_800_000_000_000)).delete_at == datetime(
        2027, 1, 15, 8, 0, tzinfo=timezone.utc
    )



def test_ssh_port_zero_means_not_allocated():
    assert m.machine(a_vm(ssh_port=0)).access.ssh_port is None


def test_ssh_port_nonzero_is_kept():
    assert m.machine(a_vm(ssh_port=10001)).access.ssh_port == 10001


def test_idle_suspend_zero_means_disabled_not_unset():
    # 0 is MEANINGFUL here — a blanket zero-to-null rule would be wrong.
    assert m.machine(a_vm(auto_suspend_timeout_secs=0)).idle.suspend_after == 0


def test_every_idle_timer_keeps_its_zero():
    off = m.machine(
        a_vm(
            auto_suspend_timeout_secs=0,
            auto_hibernate_timeout_secs=0,
            auto_destroy_timeout_secs=0,
        )
    ).idle
    assert (off.suspend_after, off.hibernate_after, off.destroy_after) == (0, 0, 0)

    on = m.machine(
        a_vm(
            auto_suspend_timeout_secs=30,
            auto_hibernate_timeout_secs=900,
            auto_destroy_timeout_secs=86_400,
        )
    ).idle
    assert (on.suspend_after, on.hibernate_after, on.destroy_after) == (30, 900, 86_400)


def test_timestamps_of_zero_are_none_because_it_never_happened():
    never = m.machine(
        a_vm(created_at=0, hibernated_at_ms=0, last_connected_ms=0, boot_time_ms=0)
    )
    assert never.created_at is None
    assert never.hibernated_at is None
    assert never.last_connected_at is None
    assert never.boot_time_ms is None


def test_created_at_is_seconds_and_the_ms_fields_are_milliseconds():
    machine = m.machine(
        a_vm(
            created_at=1_700_000_000,
            hibernated_at_ms=1_700_000_500_000,
            last_connected_ms=1_700_000_900_000,
            boot_time_ms=1_250,
        )
    )
    assert machine.created_at == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert machine.hibernated_at == datetime(
        2023, 11, 14, 22, 21, 40, tzinfo=timezone.utc
    )
    assert machine.last_connected_at == datetime(
        2023, 11, 14, 22, 28, 20, tzinfo=timezone.utc
    )
    # A boot duration, not a timestamp — it stays a number.
    assert machine.boot_time_ms == 1_250


def test_resources_are_effective_values_and_are_never_nulled():
    resources = m.machine(a_vm(vcpu=4, memory_bytes=1024, disk_bytes=2048)).resources
    assert (resources.vcpu, resources.memory_bytes, resources.disk_bytes) == (
        4,
        1024,
        2048,
    )


# --- empty string as absent ---


def test_a_personal_machine_has_no_org():
    machine = m.machine(a_vm(org="", org_id="", billing_org="", billing_org_id=""))
    assert machine.org is None
    assert machine.shared is False


def test_populated_strings_survive():
    machine = m.machine(a_vm())
    assert machine.org is not None
    assert machine.org.name == "acme"
    assert machine.org.id == "org-acme"
    assert machine.access.domain == "boxd.sh"


def test_the_url_is_built_from_the_name_and_domain():
    assert m.machine(a_vm()).access.url == "https://alpha.boxd.sh"


# --- framing and prefixes ---


def test_vm_id_becomes_id():
    assert m.machine(a_vm()).id == "vm-1"


def test_status_is_carried_through_as_a_literal():
    assert m.machine(a_vm(status="hibernated")).status == "hibernated"


def test_unknown_status_does_not_fail_validation():
    # A status the server adds later must not take the SDK down.
    assert m.machine(a_vm(status="teleporting")).status == "teleporting"


# --- epoch conversion ---


def test_epoch_seconds_become_aware_datetimes():
    key = m.api_key(
        api_pb2.ApiKeyInfo(
            id="k1",
            name="ci",
            key_prefix="bxd_abcd",
            created_at=1_700_000_000,
            last_used_at=0,
            expires_at=0,
            org="acme",
            kind="member",
        )
    )
    assert key.created_at == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    # 0 = never used / no expiry, not 1970.
    assert key.last_used_at is None
    assert key.expires_at is None


def test_checkpoint_timestamps_and_flags():
    checkpoint = m.checkpoint(
        api_pb2.CheckpointInfo(
            checkpoint_id="cp-1",
            name="before-upgrade",
            status="ready",
            size_bytes=42,
            created_at=1_700_000_000,
            created_by="",
            available=True,
        )
    )
    assert checkpoint.id == "cp-1"
    assert checkpoint.created_by is None
    assert checkpoint.available is True


def test_snapshot_version_zero_means_nothing_captured_yet():
    snapshot = m.snapshot(
        api_pb2.SnapshotInfo(snapshot_id="s1", name="base", version=0, status="pending")
    )
    assert snapshot.version is None
    assert snapshot.created_at is None
    assert snapshot.updated_at is None


def test_snapshot_created_at_is_the_first_capture_updated_at_the_latest():
    # The wire values are epoch milliseconds, not seconds.
    snapshot = m.snapshot(
        api_pb2.SnapshotInfo(
            snapshot_id="s1",
            name="base",
            version=3,
            status="ready",
            created_at=1_700_000_000_000,
            updated_at=1_700_090_000_000,
        )
    )
    assert snapshot.version == 3
    assert snapshot.created_at == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert snapshot.updated_at is not None
    assert snapshot.updated_at > snapshot.created_at


def test_snapshot_says_where_it_is():
    snapshot = m.snapshot(
        api_pb2.SnapshotInfo(
            snapshot_id="s1", name="base", version=3, status="ready", archived=True, storage="archived"
        )
    )
    assert snapshot.storage == "archived"
    assert snapshot.archived is True
    # A server that predates archiving: on local disk.
    old = m.snapshot(api_pb2.SnapshotInfo(snapshot_id="s1", name="base", version=3, status="ready"))
    assert old.storage == "local"
    assert old.archived is False


# --- secrets never carry a value ---


def test_secret_model_has_no_value_field():
    item = api_pb2.VarItem(name="API_KEY", kind="secret", scope="all", value="")
    secret = m.secret(item)
    assert not hasattr(secret, "value")
    assert secret.name == "API_KEY"
    assert secret.scope == "all"


def test_env_var_keeps_its_value():
    item = api_pb2.VarItem(name="MODE", kind="env", scope="shared", value="prod")
    assert m.env_var(item).value == "prod"


# --- misc shapes ---


def test_exposed_port_renames_vm_fields_and_carries_the_machine_id():
    port = m.exposed_port(
        api_pb2.ExposePortResponse(
            vm_id="vm-1", vm_name="alpha", dns="alpha.boxd.sh", public_port=31000,
            vm_port=8080, protocol="tcp",
        )
    )
    assert port.machine_id == "vm-1"
    assert port.machine_name == "alpha"
    assert port.machine_port == 8080
    assert port.public_port == 31000


def test_proxy_reports_the_effective_port_and_a_machine_readable_mode():
    # The STORED port is 0; traffic still lands on the detected 8000, and the
    # caller never has to parse "auto (8000)".
    entry = m.proxy(
        api_pb2.ProxyInfo(
            name="",
            vm_id="vm-1",
            vm_name="alpha",
            domain="alpha.boxd.sh",
            port=0,
            is_default=True,
            port_display="auto (8000)",
            port_mode="auto",
            effective_port=8000,
        )
    )
    assert entry.name is None
    assert entry.machine_id == "vm-1"
    assert entry.port == 8000
    assert entry.port_mode == "auto"
    assert entry.is_default is True
    assert not hasattr(entry, "port_display")


def test_proxy_with_a_pinned_port_reports_mode_locked():
    entry = m.proxy(
        api_pb2.ProxyInfo(
            name="api",
            vm_id="vm-1",
            vm_name="alpha",
            domain="api.alpha.boxd.sh",
            port=3000,
            is_default=False,
            port_display="3000",
            port_mode="locked",
            effective_port=3000,
        )
    )
    assert entry.name == "api"
    assert entry.port == 3000
    assert entry.port_mode == "locked"


def test_disk_attachments_status_and_created_at_are_mapped():
    # The wire value is epoch milliseconds, not seconds.
    disk = m.disk(
        api_pb2.DiskInfo(
            disk_id="d1",
            name="data",
            size_bytes=10,
            status="ready",
            created_at=1_700_000_000_000,
            attachments=[
                api_pb2.DiskAttachment(
                    vm_id="vm-1", vm_name="alpha", mount_path="/data", mount_mode="rw"
                )
            ],
        )
    )
    assert disk.status == "ready"
    assert disk.created_at == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert disk.attachments[0].machine_name == "alpha"
    assert disk.attachments[0].mount_mode == "rw"


def test_disk_created_at_zero_is_none_not_1970():
    disk = m.disk(
        api_pb2.DiskInfo(disk_id="d2", name="old", size_bytes=1, status="creating")
    )
    assert disk.created_at is None
    assert disk.status == "creating"


def test_machine_from_created_is_a_partial_machine():
    # The create/fork response carries none of the placement-time fields.
    machine = m.machine_from_created(
        api_pb2.CreateVmResponse(
            vm_id="vm-3", name="gamma", status="pending", image="debian:12", public_ip=""
        )
    )
    assert machine.id == "vm-3"
    assert machine.image_ref == "debian:12"
    assert machine.access.ssh_port is None
    assert machine.access.domain == ""
    # No domain yet, so no URL to invent.
    assert machine.access.url == ""
    assert machine.org is None
    assert machine.shared is False
    assert machine.created_at is None
    assert machine.idle.suspend_after == 0
    assert machine.source is None


def test_machine_from_created_handles_a_fork_response():
    machine = m.machine_from_created(
        api_pb2.ForkVmResponse(
            vm_id="vm-2", name="beta", status="pending", image="debian:12"
        )
    )
    assert machine.id == "vm-2"
    assert machine.name == "beta"


def test_account_maps_billing_when_present():
    account = m.account(
        api_pb2.WhoamiResponse(
            user_id="u1",
            display_name="",
            pubkey_fingerprints=["SHA256:aaa"],
            billing=api_pb2.BillingInfo(subscription_status="active", max_vms=10),
        )
    )
    assert account.display_name is None
    assert account.pubkey_fingerprints == ["SHA256:aaa"]
    assert account.billing is not None
    assert account.billing.subscription_status == "active"


def test_account_that_never_subscribed_still_reports_billing():
    # Every account has a billing record; one that never subscribed reads as
    # "no subscription", which is not the same as "no billing information".
    billing = m.account(api_pb2.WhoamiResponse(user_id="u1")).billing
    assert billing.subscription_status is None
    assert billing.max_vms == 0




# --- `org` and `shared` answer two different questions ---


def test_a_private_org_billed_machine_still_names_its_org():
    # The confusing case: the wire blanks `org`/`org_id` when a machine is not
    # shared, but the machine still belongs to — and is billed to — that org.
    # Reading the shared-gated copy as "the org" would report None here.
    private = m.machine(
        a_vm(org="", org_id="", billing_org="laurci", billing_org_id="org-73839683")
    )
    assert private.org is not None
    assert private.org.id == "org-73839683"
    assert private.org.name == "laurci"
    assert private.shared is False


def test_a_shared_machine_reports_the_same_org_with_shared_true():
    shared = m.machine(
        a_vm(
            org="laurci",
            org_id="org-73839683",
            billing_org="laurci",
            billing_org_id="org-73839683",
        )
    )
    assert shared.org is not None
    assert shared.org.id == "org-73839683"
    assert shared.shared is True


# --- source: unset means standalone ---


def test_source_is_none_for_a_standalone_machine():
    # The wire leaves the message unset rather than naming its own absence.
    assert m.machine(a_vm()).source is None


def test_a_fork_has_no_version():
    machine = m.machine(
        a_vm(
            source_info=api_pb2.VmSource(
                kind="fork", name="parent", version=0, id="vm-parent"
            )
        )
    )
    assert machine.source is not None
    assert machine.source.kind == "fork"
    assert machine.source.name == "parent"
    assert machine.source.version is None
    assert machine.source.id == "vm-parent"


def test_a_snapshot_source_keeps_its_version():
    machine = m.machine(
        a_vm(
            source_info=api_pb2.VmSource(
                kind="snapshot", name="golden", version=3, id="sn-1"
            )
        )
    )
    assert machine.source is not None
    assert machine.source.kind == "snapshot"
    assert machine.source.version == 3


def test_an_unrecoverable_source_id_is_none_but_name_and_version_survive():
    machine = m.machine(
        a_vm(
            source_info=api_pb2.VmSource(
                kind="snapshot", name="golden", version=2, id=""
            )
        )
    )
    assert machine.source is not None
    assert machine.source.id is None
    assert machine.source.name == "golden"
    assert machine.source.version == 2


# --- networking (networks + isolated) ---


def test_no_networks_is_the_default_network_not_missing_data():
    """An empty list is a real, common state — every machine created before
    networks existed reports one, and it means "the org's default network"."""
    networking = m.machine(a_vm()).networking
    assert networking.networks == []
    assert networking.isolated is False


def test_networks_and_isolated_survive():
    networking = m.machine(
        a_vm(networks=["demo", "test"], isolated=True)
    ).networking
    assert networking.networks == ["demo", "test"]
    assert networking.isolated is True


def test_egress_allow_empty_is_no_policy_and_entries_survive():
    assert m.machine(a_vm()).egress_allow == []
    assert m.machine(a_vm(egress_allow=["api.example.com", "1.1.1.1"])).egress_allow == [
        "api.example.com",
        "1.1.1.1",
    ]
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.egress_allow == []


def test_labels_default_empty_and_survive():
    assert m.machine(a_vm()).labels == {}
    assert m.machine(a_vm(labels={"env": "prod", "team": ""})).labels == {
        "env": "prod",
        "team": "",
    }
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.labels == {}


def test_bot_protection_carries_through():
    assert m.machine(a_vm(bot_protection=True)).bot_protection is True
    assert m.machine(a_vm(bot_protection=False)).bot_protection is False
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.bot_protection is True
    # The create response doesn't say which mode: never guess it.
    assert created.bot_protection_mode is None


def test_bot_protection_mode_carries_through():
    for mode in ("on", "sleep_only", "off"):
        vm = a_vm(bot_protection=mode != "off", bot_protection_mode=mode)
        assert m.machine(vm).bot_protection_mode == mode
    # A server from before the mode sends only the bool: its "on" was
    # sleep-only.
    assert m.machine(a_vm(bot_protection=True)).bot_protection_mode == "sleep_only"
    assert m.machine(a_vm(bot_protection=False)).bot_protection_mode == "off"


def test_set_bot_protection_takes_a_mode_or_the_older_flag():
    import pytest

    from boxd.resources.machines import _bot_protection_mode

    assert _bot_protection_mode(True, None) == "on"
    assert _bot_protection_mode(False, None) == "off"
    assert _bot_protection_mode(None, "sleep_only") == "sleep_only"
    for bad in [(None, None), (True, "on"), (None, "always")]:
        with pytest.raises(ValueError):
            _bot_protection_mode(*bad)


def test_idle_ignore_outbound_carries_through():
    assert m.machine(a_vm(idle_ignore_outbound=True)).idle_ignore_outbound is True
    assert m.machine(a_vm(idle_ignore_outbound=False)).idle_ignore_outbound is False
    # Off unless the server says otherwise.
    assert m.machine(a_vm()).idle_ignore_outbound is False
    # Not known from the create response; create()/fork() re-read the machine.
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.idle_ignore_outbound is False


def test_ssh_is_on_unless_the_server_says_disabled():
    assert m.machine(a_vm(ssh_disabled=True)).ssh is False
    assert m.machine(a_vm(ssh_disabled=False)).ssh is True
    # Inverted on the wire, so a server that never sends it reads as on.
    assert m.machine(a_vm()).ssh is True
    # Not known from the create response; create()/fork() re-read the machine.
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.ssh is True


def test_secret_domains_survive_and_default_empty():
    plain = m.secret(api_pb2.VarItem(name="TOKEN", kind="secret", scope="all"))
    assert plain.domains == []
    scoped = m.secret(
        api_pb2.VarItem(
            name="TOKEN",
            kind="secret",
            scope="all",
            domains=["api.example.com", "*.example.org"],
        )
    )
    assert scoped.domains == ["api.example.com", "*.example.org"]


def test_secret_bound_machines_defaults_to_zero_on_the_model():
    assert Secret(name="TOKEN", scope="all", domains=[]).bound_machines == 0


def test_secret_bound_machines_survive_and_default_zero():
    assert m.secret(api_pb2.VarItem(name="TOKEN", kind="secret", scope="all")).bound_machines == 0
    bound = m.secret(
        api_pb2.VarItem(name="NPM_TOKEN", kind="secret", scope="unattached", bound_machines=2)
    )
    assert (bound.scope, bound.bound_machines) == ("unattached", 2)


def test_the_create_response_fallback_reports_networking_as_unset():
    """`create`/`fork` re-read the machine; this partial mapping is only the
    fallback for when that read fails, so it must not claim isolation."""
    created = m.machine_from_created(
        api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending")
    )
    assert created.networking.networks == []
    assert created.networking.isolated is False


def test_backup_schedule_disabled_maps_to_none():
    assert m.backup_schedule(api_pb2.GetBackupScheduleResponse(enabled=False)) is None


def test_backup_schedule_enabled_maps_fields_and_last_backup_at_can_be_unset():
    sched = m.backup_schedule(
        api_pb2.GetBackupScheduleResponse(
            enabled=True,
            schedule_kind="interval",
            schedule_value="3600",
            retention_secs=604800,
            next_backup_at=1_700_000_000_000,
            last_backup_at=0,
        )
    )
    assert sched is not None
    assert sched.schedule_kind == "interval"
    assert sched.retention_secs == 604800
    assert sched.last_backup_at is None


def test_backup_dedup_pointer_and_checksum_are_absent_on_a_dedup_row():
    backup = m.backup(
        api_pb2.BackupInfo(
            backup_id="bkp-2",
            status="dedup",
            size_bytes=0,
            checksum="",
            points_to_backup_id="bkp-1",
            created_at=1_700_000_000_000,
            expires_at=1_700_600_000_000,
        )
    )
    assert backup.status == "dedup"
    assert backup.checksum is None
    assert backup.points_to_backup_id == "bkp-1"


def test_desktop_url_is_the_console_origin_plus_the_name():
    """Built client-side like `url`, and empty rather than half-built when the
    client has no endpoint to derive a console origin from."""
    from boxd import _mappers as m

    vm = a_vm(name="box")
    assert m.machine(vm, "https://app.boxd.sh").access.desktop_url == (
        "https://app.boxd.sh/desktop/box"
    )
    assert m.machine(vm).access.desktop_url == ""


def test_invites_carry_their_email_status():
    """`Orgs.invite` and `Orgs.get_members` both say what became of the
    email; an older server's empty field stays empty, not a guess."""
    invited = m.invited_org_member(
        api_pb2.InviteOrgMemberResponse(
            token="tok",
            accept_url="https://app.example.com/accept?token=tok",
            created_at=1_700_000_000,
            expires_at=1_700_172_800,
            email_status="failed",
        ),
        "new@example.com",
        "member",
    )
    assert invited.email_status == "failed"
    assert invited.accept_url.endswith("token=tok")

    members = m.org_members(
        api_pb2.GetOrgMembersResponse(
            invites=[
                api_pb2.OrgInviteInfo(token="a", email="a@example.com", email_status="bounced"),
                api_pb2.OrgInviteInfo(token="b", email="b@example.com"),
            ]
        )
    )
    assert [i.email_status for i in members.invites] == ["bounced", ""]
