"""Namespace wiring: the right RPC, the right fields, the right model out.

Everything runs against a fake transport, so this pins the shape of what would
go on the wire without needing a cluster.
"""

from __future__ import annotations

from datetime import datetime, timezone

import grpc
import pytest

from boxd import AsyncBoxd, Boxd
from boxd._generated import api_pb2
from boxd.errors import BoxdError, NotFoundError
from boxd.models import Machine, ProxyEntry, Secret
from boxd.resources.machines import AsyncMachines, Machines
from boxd.resources.snapshots import Snapshots
from boxd.resources.vars import AsyncEnv, AsyncSecrets, Env, Secrets
from fakes import FakeAsyncTransport, FakeRpcError, FakeTransport


def a_vm(name="alpha"):
    return api_pb2.GetVmResponse(
        vm_id="vm-1", name=name, status="running", ssh_port=10001,
        access_domain="boxd.sh", vcpu=2, memory_bytes=8 * 1024**3,
    )


# --- machines ---


def test_retrieve_calls_get_vm_and_maps_it():
    transport = FakeTransport([a_vm()])
    machine = Machines(transport).get("alpha")
    method, request = transport.calls[0]
    assert method == "GetVm"
    assert request.vm_id == "alpha"
    assert isinstance(machine, Machine)
    assert machine.id == "vm-1"




def test_create_uses_create_vm_then_re_reads():
    # The create response carries only a few fields, so create() re-reads.
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"), a_vm()]
    )
    machine = Machines(transport).create("alpha", vcpu=4)
    method, request = transport.calls[0]
    assert method == "CreateVm"
    assert request.name == "alpha"
    assert request.config.vcpu == 4
    assert transport.calls[1][0] == "GetVm"
    assert transport.calls[1][1].vm_id == "vm-1"
    # Fields only GetVm carries.
    assert machine.access.ssh_port == 10001
    assert machine.access.domain == "boxd.sh"
    assert machine.resources.vcpu == 2


def test_create_falls_back_to_the_partial_mapping_when_the_re_read_fails():
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", status="pending"),
            NotFoundError("not visible yet"),
        ]
    )
    machine = Machines(transport).create("alpha")
    assert machine.id == "vm-1"
    assert machine.status == "pending"
    assert machine.access.ssh_port is None


def test_fork_re_reads_too():
    transport = FakeTransport(
        [api_pb2.ForkVmResponse(vm_id="vm-2", name="beta"), a_vm("beta")]
    )
    machine = Machines(transport).fork("alpha", "beta")
    assert [c[0] for c in transport.calls] == ["ForkVm", "GetVm"]
    assert machine.access.domain == "boxd.sh"


def test_create_from_snapshot_switches_rpc():
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"), a_vm()]
    )
    Machines(transport).create("alpha", from_snapshot="base")
    method, request = transport.calls[0]
    assert method == "CreateVmFromSnapshot"
    assert request.snapshot == "base"
    assert request.name == "alpha"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"image": "debian:12"},
        {"env": {"A": "b"}},
        {"cmd": ["sleep", "1"]},
        {"restart_policy": "never"},
        {"shared": True},
    ],
)
def test_create_from_snapshot_rejects_incompatible_arguments(kwargs):
    transport = FakeTransport([])
    with pytest.raises(ValueError, match="does not accept"):
        Machines(transport).create("alpha", from_snapshot="base", **kwargs)
    assert transport.calls == []


def test_create_from_snapshot_accepts_the_isolated_override():
    """Unlike the rest, `isolated` is a legal one-way override on a restore."""
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"), a_vm()]
    )
    Machines(transport).create("alpha", from_snapshot="base", isolated=True)
    method, request = transport.calls[0]
    assert method == "CreateVmFromSnapshot"
    assert request.isolated is True


def test_fork_carries_the_isolated_override():
    transport = FakeTransport(
        [api_pb2.ForkVmResponse(vm_id="vm-2", name="beta"), a_vm("beta")]
    )
    Machines(transport).fork("alpha", "beta", isolated=True)
    method, request = transport.calls[0]
    assert method == "ForkVm"
    assert request.isolated is True


def test_rename_returns_the_new_name():
    transport = FakeTransport([api_pb2.RenameVmResponse(name="beta")])
    assert Machines(transport).rename("alpha", "beta") == "beta"
    assert transport.calls[0][1].new_name == "beta"


def test_delete_uses_destroy_vm():
    transport = FakeTransport([api_pb2.DestroyVmResponse()])
    Machines(transport).delete("alpha")
    assert transport.calls[0][0] == "DestroyVm"


def test_pause_and_resume_report_timings():
    transport = FakeTransport(
        [api_pb2.SuspendVmResponse(suspend_us=1234), api_pb2.ResumeVmResponse(resume_us=99)]
    )
    machines = Machines(transport)
    assert machines.pause("alpha").suspend_us == 1234
    assert machines.resume("alpha").resume_us == 99


def test_set_timeouts_send_zero_to_disable():
    transport = FakeTransport(
        [api_pb2.SetAutoSuspendTimeoutResponse(), api_pb2.SetAutoHibernateTimeoutResponse()]
    )
    machines = Machines(transport)
    machines.set_auto_suspend_timeout("alpha", 0)
    machines.set_auto_hibernate_timeout("alpha", 300)
    assert transport.calls[0][1].timeout_secs == 0
    assert transport.calls[1][1].timeout_secs == 300


def _created(name):
    return [api_pb2.CreateVmResponse(vm_id=f"vm-{name}", name=name), a_vm(name)]


def _forked(name):
    return [api_pb2.ForkVmResponse(vm_id=f"vm-{name}", name=name), a_vm(name)]


def test_create_sends_idle_ignore_outbound_only_when_asked():
    # `optional` on the wire: unset lets a new machine take its
    # org's default, so a defaulted False must never go out.
    transport = FakeTransport(
        [*_created("a"), *_created("b"), *_created("c"), *_created("d")]
    )
    machines = Machines(transport)
    machines.create("a")
    machines.create("b", vcpu=4)
    machines.create("c", idle_ignore_outbound=False)
    machines.create("d", idle_ignore_outbound=True)

    sent = [r for method, r in transport.calls if method == "CreateVm"]
    assert not sent[0].HasField("config")
    assert not sent[1].config.HasField("idle_ignore_outbound")
    # False alone is still a request, and it goes out as an explicit False.
    assert sent[2].HasField("config")
    assert sent[2].config.HasField("idle_ignore_outbound")
    assert sent[2].config.idle_ignore_outbound is False
    assert sent[3].config.idle_ignore_outbound is True


def test_fork_and_create_from_snapshot_carry_idle_ignore_outbound():
    # Unset keeps the source's value, so only an explicit True or False is sent.
    transport = FakeTransport(
        [
            *_forked("a"), *_forked("b"), *_forked("c"),
            *_created("d"), *_created("e"), *_created("f"),
        ]
    )
    machines = Machines(transport)
    machines.fork("alpha", "a")
    machines.fork("alpha", "b", idle_ignore_outbound=False)
    machines.fork("alpha", "c", idle_ignore_outbound=True)
    machines.create("d", from_snapshot="base")
    machines.create("e", from_snapshot="base", idle_ignore_outbound=False)
    machines.create("f", from_snapshot="base", idle_ignore_outbound=True)

    for rpc in ("ForkVm", "CreateVmFromSnapshot"):
        unset, off, on = [r for method, r in transport.calls if method == rpc]
        assert not unset.config.HasField("idle_ignore_outbound")
        assert off.config.HasField("idle_ignore_outbound")
        assert off.config.idle_ignore_outbound is False
        assert on.config.idle_ignore_outbound is True


def test_set_idle_ignore_outbound_sends_the_flag_either_way():
    transport = FakeTransport(
        [api_pb2.SetIdleIgnoreOutboundResponse(), api_pb2.SetIdleIgnoreOutboundResponse()]
    )
    machines = Machines(transport)
    machines.set_idle_ignore_outbound("alpha", True)
    machines.set_idle_ignore_outbound("alpha", False)
    assert [c[0] for c in transport.calls] == ["SetIdleIgnoreOutbound"] * 2
    assert [(r.vm_id, r.enabled) for _, r in transport.calls] == [
        ("alpha", True),
        ("alpha", False),
    ]


def test_create_sends_ssh_only_when_asked():
    # `optional` on the wire: unset gives a new machine SSH, so a defaulted
    # True must never go out, not even next to proxies.
    transport = FakeTransport(
        [*_created("a"), *_created("b"), *_created("c"), *_created("d")]
    )
    machines = Machines(transport)
    machines.create("a", vcpu=4)
    machines.create("b", proxies=[ProxyEntry(name="web", port=3000)])
    machines.create("c", ssh=False)
    machines.create("d", ssh=True)

    sent = [r for method, r in transport.calls if method == "CreateVm"]
    assert not sent[0].config.HasField("network")
    assert not sent[1].config.network.HasField("ssh")
    # False alone is still a request, and it goes out as an explicit False.
    assert sent[2].config.network.HasField("ssh")
    assert sent[2].config.network.ssh is False
    assert sent[3].config.network.ssh is True


def test_fork_and_create_from_snapshot_carry_ssh():
    # Unset keeps the source's setting (a fork of a machine with SSH off
    # stays off), so only an explicit True or False is sent.
    transport = FakeTransport(
        [
            *_forked("a"), *_forked("b"), *_forked("c"),
            *_created("d"), *_created("e"), *_created("f"),
        ]
    )
    machines = Machines(transport)
    machines.fork("alpha", "a", proxies=[ProxyEntry(name="web", port=3000)])
    machines.fork("alpha", "b", ssh=False)
    machines.fork("alpha", "c", ssh=True)
    machines.create(
        "d", from_snapshot="base", proxies=[ProxyEntry(name="web", port=3000)]
    )
    machines.create("e", from_snapshot="base", ssh=False)
    machines.create("f", from_snapshot="base", ssh=True)

    for rpc in ("ForkVm", "CreateVmFromSnapshot"):
        unset, off, on = [r for method, r in transport.calls if method == rpc]
        assert not unset.config.network.HasField("ssh")
        assert off.config.network.HasField("ssh")
        assert off.config.network.ssh is False
        assert on.config.network.ssh is True


def test_set_ssh_sends_the_flag_either_way():
    transport = FakeTransport([api_pb2.SetSshResponse(), api_pb2.SetSshResponse()])
    machines = Machines(transport)
    assert machines.set_ssh("alpha", False) is None
    machines.set_ssh("alpha", True)
    assert [c[0] for c in transport.calls] == ["SetSsh"] * 2
    assert [(r.vm_id, r.enabled) for _, r in transport.calls] == [
        ("alpha", False),
        ("alpha", True),
    ]


def test_labels_go_out_on_create_fork_and_restore():
    transport = FakeTransport([*_created("a"), *_forked("b"), *_created("c"), *_created("d")])
    machines = Machines(transport)
    machines.create("a", labels={"env": "prod", "team": ""})
    machines.fork("a", "b", labels={"run": "nightly"})
    machines.create("c", from_snapshot="base", labels={"env": "staging"})
    machines.create("d")
    sent = {method: r for method, r in transport.calls if method != "GetVm"}
    creates = [r for method, r in transport.calls if method == "CreateVm"]
    assert dict(creates[0].labels) == {"env": "prod", "team": ""}
    assert dict(sent["ForkVm"].labels) == {"run": "nightly"}
    assert dict(sent["CreateVmFromSnapshot"].labels) == {"env": "staging"}
    # None sends nothing, so a fork or restore keeps exactly what it inherits.
    assert dict(creates[1].labels) == {}


def test_list_filters_by_labels_as_selectors_or_a_dict():
    transport = FakeTransport([api_pb2.ListVmsResponse()] * 4)
    machines = Machines(transport)
    machines.list()
    machines.list(labels=["env=prod", "gpu"])
    machines.list(labels={"env": "prod", "run": "nightly"})
    machines.list(labels="gpu")
    selectors = [list(r.label_selector) for _, r in transport.calls]
    assert selectors == [
        [],
        ["env=prod", "gpu"],
        ["env=prod", "run=nightly"],
        ["gpu"],
    ]


def test_list_checks_the_labels_again_on_the_client():
    # A server from before labels ignores the selector and sends every
    # machine, with no labels: none of them may come back as a match.
    prod, dev, old = a_vm("prod"), a_vm("dev"), a_vm("old")
    prod.labels.update({"env": "prod", "gpu": ""})
    dev.labels["env"] = "dev"
    everything = api_pb2.ListVmsResponse(vms=[prod, dev, old])
    transport = FakeTransport([everything] * 3)
    machines = Machines(transport)
    assert [x.name for x in machines.list(labels={"env": "prod"})] == ["prod"]
    assert [x.name for x in machines.list(labels=["gpu"])] == ["prod"]
    assert [x.name for x in machines.list()] == ["prod", "dev", "old"]


def test_update_labels_sends_the_edit_and_returns_the_result():
    transport = FakeTransport(
        [
            api_pb2.UpdateVmLabelsResponse(labels={"env": "prod"}),
            api_pb2.UpdateVmLabelsResponse(labels={"only": "this"}),
        ]
    )
    machines = Machines(transport)
    got = machines.update_labels("alpha", set={"env": "prod"}, remove=["old"])
    assert got == {"env": "prod"}
    assert machines.update_labels(
        "alpha", {"only": "this"}, replace_all=True
    ) == {"only": "this"}
    (m1, r1), (_, r2) = transport.calls
    assert m1 == "UpdateVmLabels"
    assert (r1.vm, dict(r1.set), list(r1.remove), r1.replace_all) == (
        "alpha", {"env": "prod"}, ["old"], False,
    )
    assert (dict(r2.set), list(r2.remove), r2.replace_all) == ({"only": "this"}, [], True)


def test_update_labels_refuses_remove_with_replace_all():
    transport = FakeTransport()
    with pytest.raises(ValueError, match="replace_all"):
        Machines(transport).update_labels("alpha", remove=["x"], replace_all=True)
    assert transport.calls == []


def test_get_reports_the_machines_labels():
    labelled = a_vm()
    labelled.labels["env"] = "prod"
    transport = FakeTransport([labelled, a_vm()])
    machines = Machines(transport)
    assert machines.get("alpha").labels == {"env": "prod"}
    assert machines.get("alpha").labels == {}


async def test_async_labels_match_sync():
    transport = FakeAsyncTransport(
        [
            *_created("a"),
            *_forked("b"),
            api_pb2.ListVmsResponse(),
            api_pb2.UpdateVmLabelsResponse(labels={"x": "1"}),
        ]
    )
    machines = AsyncMachines(transport)
    await machines.create("a", labels={"env": "prod"})
    await machines.fork("a", "b", labels={"run": "1"})
    await machines.list(labels={"env": "prod"})
    assert await machines.update_labels("a", set={"x": "1"}) == {"x": "1"}
    create, _, fork, _, listing, update = transport.calls
    assert dict(create[1].labels) == {"env": "prod"}
    assert dict(fork[1].labels) == {"run": "1"}
    assert list(listing[1].label_selector) == ["env=prod"]
    assert update[0] == "UpdateVmLabels"
    assert dict(update[1].set) == {"x": "1"}


def test_get_reports_the_machines_idle_ignore_outbound():
    on = a_vm()
    on.idle_ignore_outbound = True
    transport = FakeTransport([on, a_vm()])
    machines = Machines(transport)
    assert machines.get("alpha").idle_ignore_outbound is True
    assert machines.get("alpha").idle_ignore_outbound is False


def test_get_reports_the_machines_ssh():
    off = a_vm()
    off.ssh_disabled = True
    transport = FakeTransport([off, a_vm()])
    machines = Machines(transport)
    assert machines.get("alpha").ssh is False
    assert machines.get("alpha").ssh is True


def test_set_delete_after_returns_the_deadline_and_none_when_cleared():
    transport = FakeTransport(
        [
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1_800_000_000_000),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=0),
        ]
    )
    machines = Machines(transport)
    at = machines.set_delete_after("alpha", 7200)
    assert transport.calls[0][0] == "SetDeleteAfter"
    assert transport.calls[0][1].vm_id == "alpha"
    assert transport.calls[0][1].delete_after_secs == 7200
    assert at == datetime.fromtimestamp(1_800_000_000, tz=timezone.utc)
    assert machines.set_delete_after("alpha", 0) is None


def test_create_and_fork_set_delete_after_before_the_re_read():
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1),
            a_vm(),
            api_pb2.ForkVmResponse(vm_id="vm-2", name="beta"),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1),
            a_vm("beta"),
        ]
    )
    machines = Machines(transport)
    machines.create("alpha", delete_after=1800)
    machines.fork("alpha", "beta", delete_after=60)
    assert [c[0] for c in transport.calls] == [
        "CreateVm", "SetDeleteAfter", "GetVm", "ForkVm", "SetDeleteAfter", "GetVm",
    ]
    assert transport.calls[1][1].vm_id == "vm-1"
    assert transport.calls[1][1].delete_after_secs == 1800
    assert transport.calls[4][1].vm_id == "vm-2"
    assert transport.calls[4][1].delete_after_secs == 60


def test_fork_reports_the_automations_it_inherited_paused():
    transport = FakeTransport(
        [
            api_pb2.ForkVmResponse(vm_id="vm-2", name="beta", paused_automations=2),
            a_vm("beta"),
        ]
    )
    with pytest.warns(UserWarning, match="2 automations are paused in beta"):
        machine = Machines(transport).fork("alpha", "beta")
    assert machine.paused_automations == 2
    # Fields the re-read carries are still there.
    assert machine.access.ssh_port == 10001


def test_fork_of_a_machine_without_automations_says_nothing():
    # `filterwarnings = error`: a stray warning here would fail the test.
    transport = FakeTransport(
        [api_pb2.ForkVmResponse(vm_id="vm-2", name="beta"), a_vm("beta")]
    )
    machine = Machines(transport).fork("alpha", "beta")
    assert machine.paused_automations == 0


async def test_async_fork_reports_paused_automations_too():
    transport = FakeAsyncTransport(
        [
            api_pb2.ForkVmResponse(vm_id="vm-2", name="beta", paused_automations=1),
            a_vm("beta"),
        ]
    )
    with pytest.warns(UserWarning, match="1 automation is paused in beta"):
        machine = await AsyncMachines(transport).fork("alpha", "beta")
    assert machine.paused_automations == 1


def test_create_from_snapshot_reports_the_automations_it_came_with_paused():
    # A machine from a snapshot is born with its automations paused,
    # like a fork.
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(vm_id="vm-2", name="beta", paused_automations=2),
            a_vm("beta"),
        ]
    )
    with pytest.warns(
        UserWarning, match="2 automations from the snapshot are paused in beta"
    ):
        machine = Machines(transport).create("beta", from_snapshot="golden")
    assert transport.calls[0][0] == "CreateVmFromSnapshot"
    assert machine.paused_automations == 2


def test_plain_create_says_nothing_about_automations():
    # `filterwarnings = error`: a stray warning here would fail the test.
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-2", name="beta"), a_vm("beta")]
    )
    machine = Machines(transport).create("beta")
    assert machine.paused_automations == 0


def test_snapshot_save_reports_the_automations_it_captured():
    transport = FakeTransport(
        [
            api_pb2.CreateSnapshotResponse(
                snapshot_id="snap-1", name="golden", version=1, paused_automations=1
            )
        ]
    )
    with pytest.warns(UserWarning, match="1 automation captured"):
        snap = Snapshots(transport).create("alpha", "golden")
    assert snap.paused_automations == 1


def test_set_delete_after_with_cron_and_create_with_cron():
    transport = FakeTransport(
        [
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1_800_000_000_000),
            api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1),
            a_vm(),
        ]
    )
    machines = Machines(transport)
    machines.set_delete_after("alpha", cron="0 18 * * *")
    sent = transport.calls[0][1]
    assert (sent.delete_after_secs, sent.delete_after_cron) == (0, "0 18 * * *")
    machines.create("alpha", delete_after_cron="0 9 * * 1")
    assert [c[0] for c in transport.calls[1:]] == ["CreateVm", "SetDeleteAfter", "GetVm"]
    assert transport.calls[2][1].delete_after_cron == "0 9 * * 1"
    with pytest.raises(ValueError, match="not both"):
        machines.set_delete_after("alpha", 60, cron="0 18 * * *")


def test_create_without_delete_after_sends_no_timer():
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"), a_vm()]
    )
    Machines(transport).create("alpha")
    assert [c[0] for c in transport.calls] == ["CreateVm", "GetVm"]


def test_suggest_name():
    transport = FakeTransport([api_pb2.SuggestVmNameResponse(name="brave-otter")])
    assert Machines(transport).suggest_name() == "brave-otter"


def test_exec_folds_the_stream_into_one_result():
    transport = FakeTransport(
        [
            [
                api_pb2.ExecChunk(data=b"hello "),
                api_pb2.ExecChunk(data=b"oops", is_stderr=True),
                api_pb2.ExecChunk(data=b"world", exit_code=0),
            ]
        ]
    )
    result = Machines(transport).exec("alpha", ["echo", "hi"])
    assert result.stdout == "hello world"
    assert result.stderr == "oops"
    assert result.exit_code == 0
    assert result.success is True
    # The command is one shell line on the first chunk.
    assert transport.sent[0].command == "echo hi"
    assert transport.sent[0].vm_id == "alpha"


def test_exec_default_encoding_corrupts_invalid_utf8():
    # The default string mode is lossy — invalid bytes become U+FFFD and
    # the byte length changes. Documents that failure, alongside the encoding="buffer" escape hatch below.
    transport = FakeTransport([[api_pb2.ExecChunk(data=b"\x00\x01\xff\xfe", exit_code=0)]])
    result = Machines(transport).exec("alpha", "printf '\\000\\001\\377\\376'")
    assert result.stdout == "\x00\x01��"
    assert isinstance(result.stdout, str)


def test_exec_buffer_encoding_is_byte_exact():
    raw = bytes(range(256))
    transport = FakeTransport([[api_pb2.ExecChunk(data=raw, exit_code=0)]])
    result = Machines(transport).exec("alpha", "cat", encoding="buffer")
    assert result.stdout == raw
    assert isinstance(result.stdout, bytes)


def test_exec_prefixes_env_assignments():
    transport = FakeTransport([[api_pb2.ExecChunk(exit_code=0)]])
    Machines(transport).exec("alpha", "env", env={"MODE": "a b"})
    assert transport.sent[0].command == "MODE='a b' env"


def test_exec_cwd_prepends_a_cd():
    transport = FakeTransport([[api_pb2.ExecChunk(exit_code=0)]])
    Machines(transport).exec("alpha", "pwd", cwd="/opt/my app")
    assert transport.sent[0].command == "cd '/opt/my app' && pwd"


def test_exec_reports_a_nonzero_exit():
    transport = FakeTransport([[api_pb2.ExecChunk(exit_code=3)]])
    result = Machines(transport).exec("alpha", "false")
    assert result.exit_code == 3
    assert result.success is False


def _agent_unreachable():
    from boxd.errors import APIConnectionError

    return APIConnectionError(
        "cannot connect to VM agent: agent at 10.42.0.7:57073 did not answer "
        "within 15s (last error: transport error). The command did not start; "
        "it is safe to retry",
        code="unavailable",
        grpc_code=14,
    )


@pytest.fixture
def no_exec_backoff(monkeypatch):
    import boxd.resources.machines as machines_module

    monkeypatch.setattr(machines_module, "_EXEC_RETRY_BACKOFF", (0.0, 0.0))


def test_exec_runs_again_when_the_agent_did_not_answer(no_exec_backoff):
    transport = FakeTransport(
        [_agent_unreachable(), [api_pb2.ExecChunk(data=b"hi", exit_code=0)]]
    )
    result = Machines(transport).exec("alpha", "echo hi")
    assert result.stdout == "hi"
    assert [c[0] for c in transport.calls] == ["Exec", "Exec"]


def test_exec_gives_up_after_its_retries(no_exec_backoff):
    transport = FakeTransport([_agent_unreachable() for _ in range(4)])
    with pytest.raises(BoxdError, match="cannot connect to VM agent"):
        Machines(transport).exec("alpha", "true")
    assert len(transport.calls) == 3


def test_exec_does_not_run_again_after_any_other_failure(no_exec_backoff):
    from boxd.errors import APIConnectionError

    dropped = APIConnectionError(
        "the machine was rebooted while the command ran", code="unavailable"
    )
    transport = FakeTransport([dropped, [api_pb2.ExecChunk(exit_code=0)]])
    with pytest.raises(BoxdError, match="rebooted"):
        Machines(transport).exec("alpha", "true")
    assert len(transport.calls) == 1


def test_exec_does_not_retry_past_its_timeout():
    transport = FakeTransport([_agent_unreachable(), [api_pb2.ExecChunk(exit_code=0)]])
    with pytest.raises(BoxdError, match="cannot connect to VM agent"):
        Machines(transport).exec("alpha", "true", timeout=0.5)
    assert len(transport.calls) == 1


async def test_async_exec_runs_again_when_the_agent_did_not_answer(no_exec_backoff):
    transport = FakeAsyncTransport(
        [_agent_unreachable(), [api_pb2.ExecChunk(data=b"hi", exit_code=0)]]
    )
    result = await AsyncMachines(transport).exec("alpha", "echo hi")
    assert result.stdout == "hi"
    assert len(transport.calls) == 2


def test_logs_yields_raw_chunks():
    transport = FakeTransport(
        [[api_pb2.LogChunk(data=b"line one\n"), api_pb2.LogChunk(data=b"line two\n")]]
    )
    assert list(Machines(transport).logs("alpha", follow=True)) == [
        b"line one\n",
        b"line two\n",
    ]
    assert transport.calls[0][1].follow is True


# --- machines sub-namespaces ---


def test_files_upload_streams_and_returns_bytes_written():
    transport = FakeTransport([api_pb2.UploadFileResponse(bytes_written=5)])
    assert Machines(transport).files.upload("alpha", "/tmp/x", "hello") == 5
    method, chunks = transport.calls[0]
    assert method == "UploadFileStream"
    first = next(iter(chunks))
    assert first.path == "/tmp/x"
    assert first.total_size == 5


def test_files_download_returns_bytes():
    transport = FakeTransport(
        [
            [
                api_pb2.DownloadFileChunk(total_size=7),
                api_pb2.DownloadFileChunk(data=b"pay"),
                api_pb2.DownloadFileChunk(data=b"load"),
            ]
        ]
    )
    assert Machines(transport).files.download("alpha", "/tmp/x") == b"payload"
    assert transport.calls[0][0] == "DownloadFileStream"


def test_files_download_rejects_truncated_stream():
    transport = FakeTransport(
        [[api_pb2.DownloadFileChunk(total_size=100), api_pb2.DownloadFileChunk(data=b"short")]]
    )
    with pytest.raises(BoxdError, match="truncated"):
        Machines(transport).files.download("alpha", "/tmp/x")


def test_ports_expose():
    transport = FakeTransport(
        [api_pb2.ExposePortResponse(vm_name="alpha", vm_port=8080, public_port=31000)]
    )
    port = Machines(transport).ports.expose("alpha", 8080, protocol="both")
    assert transport.calls[0][1].protocol == "both"
    assert port.machine_port == 8080
    assert port.public_port == 31000


def test_ports_unexpose_echoes_what_was_removed():
    transport = FakeTransport(
        [
            api_pb2.UnexposePortResponse(
                forward=api_pb2.ExposePortResponse(vm_name="alpha", vm_port=8080)
            )
        ]
    )
    assert Machines(transport).ports.unexpose("alpha", 8080).machine_port == 8080


def test_ports_list_is_account_wide():
    transport = FakeTransport(
        [api_pb2.ListExposedPortsResponse(forwards=[api_pb2.ExposePortResponse()])]
    )
    forwards = Machines(transport).ports.list()
    assert isinstance(forwards, list)
    assert len(forwards) == 1


def test_proxies_address_the_machine_by_id_or_name():
    # `vm` takes either; the server resolves it. The deprecated name-only
    # `vm_name` is left unset so it can eventually be dropped.
    for ref in ("alpha", "vm-0f3a91"):
        transport = FakeTransport([api_pb2.ListProxiesResponse()])
        Machines(transport).proxies.list(ref)
        assert transport.calls[0][1].vm == ref
        assert transport.calls[0][1].vm_name == ""


def test_ports_list_narrows_to_one_machine_or_stays_account_wide():
    transport = FakeTransport([api_pb2.ListExposedPortsResponse()])
    Machines(transport).ports.list("vm-0f3a91")
    assert transport.calls[0][1].vm == "vm-0f3a91"

    transport = FakeTransport([api_pb2.ListExposedPortsResponse()])
    Machines(transport).ports.list()
    assert transport.calls[0][1].vm == ""


def test_proxies_set_port_stringifies_the_port():
    transport = FakeTransport([api_pb2.SetProxyPortResponse()])
    Machines(transport).proxies.set_port("alpha", 3000, name="web")
    # `port` is a string on the wire.
    assert transport.calls[0][1].port == "3000"
    assert transport.calls[0][1].name == "web"


def test_proxies_set_port_accepts_auto_for_the_default_route():
    # Auto-detect is expressible: it is why `port` is a string on the wire.
    transport = FakeTransport([api_pb2.SetProxyPortResponse()])
    Machines(transport).proxies.set_port("alpha", "auto")
    assert transport.calls[0][1].port == "auto"
    # No name = the machine's default route, which is the only one auto works on.
    assert transport.calls[0][1].name == ""


def test_proxies_create_and_list():
    transport = FakeTransport(
        [
            api_pb2.CreateProxyResponse(name="web", vm_name="alpha", port=3000),
            api_pb2.ListProxiesResponse(
                proxies=[
                    api_pb2.ProxyInfo(
                        name="",
                        vm_id="vm-1",
                        vm_name="alpha",
                        is_default=True,
                        port_mode="auto",
                        effective_port=8000,
                    )
                ]
            ),
        ]
    )
    proxies = Machines(transport).proxies
    created = proxies.create("alpha", "web", 3000)
    # The create response confirms the subdomain and the port it points at,
    # and carries nothing else — `list()` is where the rest lives.
    assert created.name == "web"
    assert created.port == 3000
    assert set(created.model_dump()) == {"name", "port"}

    listed = proxies.list("alpha")[0]
    assert listed.is_default is True
    assert listed.machine_id == "vm-1"
    assert listed.port == 8000
    assert listed.port_mode == "auto"


def test_checkpoints_round_trip():
    transport = FakeTransport(
        [
            api_pb2.CreateCheckpointResponse(
                checkpoint_id="cp-1", name="pre", status="pending"
            ),
            api_pb2.ListCheckpointsResponse(
                checkpoints=[
                    api_pb2.CheckpointInfo(checkpoint_id="cp-1", name="pre", available=True)
                ]
            ),
            api_pb2.RestoreCheckpointResponse(),
        ]
    )
    checkpoints = Machines(transport).checkpoints
    assert checkpoints.create("alpha", "pre").id == "cp-1"
    assert checkpoints.list("alpha")[0].available is True
    checkpoints.restore("alpha", "pre")
    assert [c[0] for c in transport.calls] == [
        "CreateCheckpoint",
        "ListCheckpoints",
        "RestoreCheckpoint",
    ]


# --- env / secrets ---


def test_env_and_secrets_differ_only_by_kind():
    env_transport = FakeTransport([api_pb2.VarReply()])
    Env(env_transport).set("MODE", "prod")
    assert env_transport.calls[0][1].kind == "env"

    secret_transport = FakeTransport([api_pb2.VarReply()])
    Secrets(secret_transport).set("TOKEN", "s3cr3t")
    assert secret_transport.calls[0][1].kind == "secret"


def test_secrets_list_drops_the_value():
    transport = FakeTransport(
        [
            api_pb2.VarListReply(
                vars=[api_pb2.VarItem(name="TOKEN", kind="secret", scope="all", value="")]
            )
        ]
    )
    page = Secrets(transport).list()
    assert isinstance(page[0], Secret)
    assert not hasattr(page[0], "value")


def test_an_unattached_secret_is_set_with_its_scope_and_lists_its_machines():
    set_transport = FakeTransport([api_pb2.VarReply()])
    Secrets(set_transport).set("NPM_TOKEN", "v", scope="unattached", org="acme")
    request = set_transport.calls[0][1]
    assert (request.scope, request.org) == ("unattached", "acme")

    list_transport = FakeTransport(
        [
            api_pb2.VarListReply(
                vars=[
                    api_pb2.VarItem(
                        name="NPM_TOKEN", kind="secret", scope="unattached", bound_machines=3
                    ),
                    api_pb2.VarItem(name="GH_PAT", kind="secret", scope="private-unattached"),
                ]
            )
        ]
    )
    listed = Secrets(list_transport).list(org="acme")
    assert [(s.scope, s.bound_machines) for s in listed] == [
        ("unattached", 3),
        ("private-unattached", 0),
    ]


def test_env_list_keeps_the_value():
    transport = FakeTransport(
        [
            api_pb2.VarListReply(
                vars=[api_pb2.VarItem(name="MODE", kind="env", scope="all", value="prod")]
            )
        ]
    )
    assert Env(transport).list()[0].value == "prod"


def test_move_requires_both_ends():
    transport = FakeTransport([api_pb2.VarReply()])
    Secrets(transport).move("TOKEN", from_scope="private", to_scope="shared", org="acme")
    method, request = transport.calls[0]
    assert method == "SetSecretScope"
    assert getattr(request, "from") == "private"
    assert request.to == "shared"


def test_env_move_uses_the_same_rpc():
    # SetSecretScope is misnamed — it moves env vars too.
    transport = FakeTransport([api_pb2.VarReply()])
    Env(transport).move("MODE", from_scope="all", to_scope="shared")
    assert transport.calls[0][0] == "SetSecretScope"


def test_scope_and_org_default_to_empty():
    transport = FakeTransport([api_pb2.VarReply()])
    Env(transport).delete("MODE")
    assert transport.calls[0][1].scope == ""
    assert transport.calls[0][1].org == ""


# --- other namespaces ---


def test_snapshots_retrieve_unwraps_the_response():
    from boxd.resources.snapshots import Snapshots

    transport = FakeTransport(
        [
            api_pb2.GetSnapshotResponse(
                snapshot=api_pb2.SnapshotInfo(snapshot_id="s1", name="base", version=3)
            )
        ]
    )
    snapshot = Snapshots(transport).get("base")
    assert snapshot.id == "s1"
    assert snapshot.version == 3


def test_disks_create_parses_a_human_size():
    from boxd.resources.disks import Disks

    transport = FakeTransport([api_pb2.CreateDiskResponse(disk_id="d1", name="data")])
    Disks(transport).create("data", "10G")
    assert transport.calls[0][1].size_bytes == 10 * 1024**3


def test_domains_create_binds():
    from boxd.resources.domains import Domains

    transport = FakeTransport(
        [
            api_pb2.AddCustomDomainResponse(
                domain=api_pb2.CustomDomainInfo(
                    domain="app.example.com",
                    vm_id="alpha",
                    vm_name="alpha",
                    status="pending",
                )
            )
        ]
    )
    result = Domains(transport).create("app.example.com", "alpha")
    method, request = transport.calls[0]
    assert method == "AddCustomDomain"
    assert request.domain == "app.example.com"
    assert request.vm_id == "alpha"
    assert result.status == "pending"


def test_domains_dns_instructions_is_local():
    from boxd.resources.domains import dns_instructions

    text = dns_instructions(
        "app.example.com", machine_name="alpha", machine_ip="1.2.3.4", zone="boxd.sh"
    )
    assert "1.2.3.4" in text
    assert "alpha.boxd.sh" in text


def test_domains_list_and_delete():
    from boxd.resources.domains import Domains

    transport = FakeTransport(
        [
            api_pb2.ListCustomDomainsResponse(
                domains=[
                    api_pb2.CustomDomainInfo(
                        domain="app.example.com", vm_id="alpha", vm_name="alpha", status="active"
                    )
                ]
            ),
            api_pb2.RemoveCustomDomainResponse(),
        ]
    )
    ns = Domains(transport)
    domains = ns.list()
    assert domains[0].domain == "app.example.com"
    ns.delete("app.example.com")
    assert transport.calls[1][0] == "RemoveCustomDomain"
    assert transport.calls[1][1].domain == "app.example.com"


def test_orgs_set_get_clear_domain():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.SetOrgDomainResponse(
                domain=api_pb2.OrgDomainInfo(
                    org_id="o1", domain="preview.example.com", status="pending"
                )
            ),
            api_pb2.GetOrgDomainResponse(),
            api_pb2.ClearOrgDomainResponse(),
        ]
    )
    ns = Orgs(transport)
    result = ns.set_domain("o1", "preview.example.com")
    assert result.status == "pending"
    assert transport.calls[0][1].org_id == "o1"
    assert ns.get_domain("o1") is None
    ns.clear_domain("o1")
    assert transport.calls[2][0] == "ClearOrgDomain"


def test_resize_names_a_size_class_and_reports_the_reboot():
    transport = FakeTransport(
        [api_pb2.ResizeVmResponse(vcpu=2, memory_bytes=8 * 1024**3, rebooted=True)]
    )
    result = Machines(transport).resize("alpha", memory="8G")
    method, request = transport.calls[0]
    assert method == "ResizeVm"
    assert request.vm_id == "alpha"
    # Naming memory alone leaves vcpu at 0 — the server resolves the class.
    assert (request.vcpu, request.memory_bytes) == (0, 8 * 1024**3)
    assert (result.vcpu, result.memory_bytes, result.rebooted) == (2, 8 * 1024**3, True)


def test_resize_without_a_size_is_refused_before_the_wire():
    # Both zero would leave the server nothing to resolve, so it never gets sent.
    transport = FakeTransport([])
    with pytest.raises(ValueError, match="needs vcpu or memory"):
        Machines(transport).resize("alpha")
    assert transport.calls == []


def test_orgs_set_get_clear_machine_defaults():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.SetOrgMachineDefaultsResponse(),
            api_pb2.GetOrgMachineDefaultsResponse(
                set=True,
                vcpu=2,
                memory_bytes=8 * 1024**3,
                ceiling_vcpu=4,
                ceiling_memory_bytes=16 * 1024**3,
            ),
            api_pb2.SetOrgMachineDefaultsResponse(),
        ]
    )
    ns = Orgs(transport)

    ns.set_machine_defaults("o1", vcpu=2)
    method, request = transport.calls[0]
    assert method == "SetOrgMachineDefaults"
    assert (request.org_id, request.vcpu) == ("o1", 2)
    assert not request.HasField("memory_bytes")

    defaults = ns.get_machine_defaults("o1")
    assert defaults.is_set is True
    assert (defaults.vcpu, defaults.ceiling_vcpu) == (2, 4)
    assert defaults.ceiling_memory_bytes == 16 * 1024**3

    # Clearing is the same RPC with both fields ABSENT, not zeroed.
    ns.clear_machine_defaults("o1")
    request = transport.calls[2][1]
    assert transport.calls[2][0] == "SetOrgMachineDefaults"
    assert not request.HasField("vcpu")
    assert not request.HasField("memory_bytes")


def test_set_machine_defaults_without_a_size_points_at_clear():
    # Sending both absent would silently clear the default, so `set` refuses it.
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([])
    with pytest.raises(ValueError, match="clear_machine_defaults"):
        Orgs(transport).set_machine_defaults("o1")
    assert transport.calls == []


def test_orgs_set_get_clear_bot_protection_default():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.SetOrgBotProtectionDefaultResponse(
                machines_changed=3, snapshots_changed=2, machines_off=1, machines_skipped=4
            ),
            api_pb2.SetOrgBotProtectionDefaultResponse(),
            api_pb2.GetOrgBotProtectionDefaultResponse(set=True, mode="sleep_only", platform_mode="on"),
            api_pb2.SetOrgBotProtectionDefaultResponse(),
            api_pb2.GetOrgBotProtectionDefaultResponse(set=False, mode="on"),
        ]
    )
    ns = Orgs(transport)

    # By default existing machines are changed too.
    applied = ns.set_bot_protection_default("o1", mode="sleep_only")
    method, request = transport.calls[0]
    assert method == "SetOrgBotProtectionDefault"
    assert (request.org_id, request.mode, request.new_machines_only) == (
        "o1",
        "sleep_only",
        False,
    )
    assert (
        applied.machines_changed,
        applied.snapshots_changed,
        applied.machines_off,
        applied.machines_skipped,
    ) == (3, 2, 1, 4)

    plain = ns.set_bot_protection_default("o1", mode="on", new_machines_only=True)
    _, request = transport.calls[1]
    assert (request.mode, request.new_machines_only) == ("on", True)
    assert plain.machines_changed == 0

    default = ns.get_bot_protection_default("o1")
    assert (default.is_set, default.mode, default.platform_mode) == (True, "sleep_only", "on")

    # Clearing is the same RPC with an EMPTY mode.
    ns.clear_bot_protection_default("o1")
    method, request = transport.calls[3]
    assert method == "SetOrgBotProtectionDefault"
    assert (request.org_id, request.mode) == ("o1", "")

    # Unset: `mode` is what the platform gives new machines meanwhile. A
    # server that predates `platform_mode` leaves it None.
    default = ns.get_bot_protection_default("o1")
    assert (default.is_set, default.mode, default.platform_mode) == (False, "on", None)


def test_set_bot_protection_default_refuses_what_would_clear_it():
    # An empty mode clears on the wire, so `set` never sends one.
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([])
    for bad in ("", "maybe", None):
        with pytest.raises(ValueError, match="clear_bot_protection_default"):
            Orgs(transport).set_bot_protection_default("o1", mode=bad)
    assert transport.calls == []


def test_orgs_set_get_clear_idle_ignore_outbound_default():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(
                machines_changed=3, snapshots_changed=2, machines_skipped=1
            ),
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(),
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(),
            api_pb2.GetOrgIdleIgnoreOutboundDefaultResponse(
                set=True, enabled=True, platform_enabled=False
            ),
            api_pb2.GetOrgIdleIgnoreOutboundDefaultResponse(
                enabled=True, platform_enabled=True
            ),
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(),
        ]
    )
    ns = Orgs(transport)

    # Existing machines change by default. `apply_existing` rides
    # along as the opposite of `new_machines_only`, so a server that predates
    # `new_machines_only` does the same.
    applied = ns.set_idle_ignore_outbound_default("o1", enabled=True)
    method, request = transport.calls[0]
    assert method == "SetOrgIdleIgnoreOutboundDefault"
    assert (
        request.org_id,
        request.enabled,
        request.new_machines_only,
        request.apply_existing,
    ) == ("o1", True, False, True)
    assert (
        applied.machines_changed,
        applied.snapshots_changed,
        applied.machines_skipped,
    ) == (3, 2, 1)

    # An explicit False is a default too; new_machines_only leaves existing
    # machines alone.
    plain = ns.set_idle_ignore_outbound_default(
        "o1", enabled=False, new_machines_only=True
    )
    request = transport.calls[1][1]
    assert request.HasField("enabled")
    assert (request.enabled, request.new_machines_only, request.apply_existing) == (
        False,
        True,
        False,
    )
    assert (
        plain.machines_changed,
        plain.snapshots_changed,
        plain.machines_skipped,
    ) == (0, 0, 0)

    # `apply_existing` from code written against 0.2.16 is accepted and is
    # what happens anyway.
    ns.set_idle_ignore_outbound_default("o1", enabled=True, apply_existing=True)
    request = transport.calls[2][1]
    assert (request.new_machines_only, request.apply_existing) == (False, True)

    # `set` on the wire is `is_set` here.
    default = ns.get_idle_ignore_outbound_default("o1")
    assert transport.calls[3][0] == "GetOrgIdleIgnoreOutboundDefault"
    assert transport.calls[3][1].org_id == "o1"
    assert (default.is_set, default.enabled, default.platform_enabled) == (
        True,
        True,
        False,
    )
    # No org default: `enabled` is the platform's setting.
    unset = ns.get_idle_ignore_outbound_default()
    assert transport.calls[4][1].org_id == ""
    assert (unset.is_set, unset.enabled, unset.platform_enabled) == (False, True, True)

    # Clearing is the same RPC with `enabled` ABSENT, not False, and asks for
    # nothing to be applied (an older server refuses that).
    ns.clear_idle_ignore_outbound_default("o1")
    method, request = transport.calls[5]
    assert method == "SetOrgIdleIgnoreOutboundDefault"
    assert request.org_id == "o1"
    assert not request.HasField("enabled")
    assert (request.new_machines_only, request.apply_existing) == (False, False)


def test_set_idle_ignore_outbound_default_refuses_contradicting_flags():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([])
    with pytest.raises(ValueError, match="new_machines_only"):
        Orgs(transport).set_idle_ignore_outbound_default(
            "o1", enabled=True, new_machines_only=True, apply_existing=True
        )
    assert transport.calls == []


def test_set_idle_ignore_outbound_default_without_enabled_points_at_clear():
    # Sending it absent would silently clear the default, so `set` refuses it.
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([])
    with pytest.raises(ValueError, match="clear_idle_ignore_outbound_default"):
        Orgs(transport).set_idle_ignore_outbound_default("o1", enabled=None)
    assert transport.calls == []


def test_orgs_list_marks_the_default_org():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.ListOrgsResponse(
                orgs=[
                    api_pb2.OrgSummary(id="o1", name="Acme", slug="acme", is_admin=True),
                    api_pb2.OrgSummary(id="o2", name="Other", slug="other", is_admin=False),
                ],
                default_org_id="o1",
            )
        ]
    )
    orgs = Orgs(transport).list()
    # A plain list — the default is a flag, not a wrapper field.
    assert isinstance(orgs, list)
    assert [o.is_default for o in orgs] == [True, False]


def test_api_keys_create_returns_the_raw_key_once():
    from boxd.resources.credentials import ApiKeys

    transport = FakeTransport(
        [api_pb2.CreateApiKeyResponse(id="k1", api_key="bxd_live", expires_at=0)]
    )
    created = ApiKeys(transport).create("ci", org="acme", kind="org")
    assert created.api_key == "bxd_live"
    assert created.expires_at is None
    assert transport.calls[0][1].kind == "org"



def test_account_link_ssh_key_sends_empty_strings_for_unset():
    from boxd.resources.account import Account

    transport = FakeTransport([api_pb2.LinkSshKeyResponse()])
    Account(transport).link_ssh_key("ssh-ed25519 AAAA")
    request = transport.calls[0][1]
    assert request.pubkey == "ssh-ed25519 AAAA"
    assert request.device_id == ""
    assert request.label == ""


# --- async parity ---


async def test_async_retrieve_matches_sync():
    transport = FakeAsyncTransport([a_vm()])
    machine = await AsyncMachines(transport).get("alpha")
    assert machine.id == "vm-1"
    assert transport.calls[0][0] == "GetVm"


async def test_async_set_delete_after_and_create_with_it():
    transport = FakeAsyncTransport(
        [
            api_pb2.SetDeleteAfterResponse(delete_at_ms=0),
            api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha"),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=1),
            a_vm(),
        ]
    )
    machines = AsyncMachines(transport)
    assert await machines.set_delete_after("alpha", 0) is None
    await machines.create("alpha", delete_after=90)
    assert [c[0] for c in transport.calls] == [
        "SetDeleteAfter", "CreateVm", "SetDeleteAfter", "GetVm",
    ]
    assert transport.calls[2][1].delete_after_secs == 90


async def test_async_idle_ignore_outbound_matches_sync():
    from boxd.resources.orgs import AsyncOrgs

    transport = FakeAsyncTransport(
        [
            *_created("a"),
            *_forked("b"),
            api_pb2.SetIdleIgnoreOutboundResponse(),
        ]
    )
    machines = AsyncMachines(transport)
    await machines.create("a", idle_ignore_outbound=False)
    await machines.fork("a", "b")
    await machines.set_idle_ignore_outbound("a", True)
    create, _, fork, _, setter = transport.calls
    assert create[1].config.HasField("idle_ignore_outbound")
    assert create[1].config.idle_ignore_outbound is False
    assert not fork[1].config.HasField("idle_ignore_outbound")
    assert setter[0] == "SetIdleIgnoreOutbound"
    assert (setter[1].vm_id, setter[1].enabled) == ("a", True)

    transport = FakeAsyncTransport(
        [
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(
                machines_changed=2, snapshots_changed=1, machines_skipped=1
            ),
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(),
            api_pb2.GetOrgIdleIgnoreOutboundDefaultResponse(
                set=True, enabled=True, platform_enabled=True
            ),
            api_pb2.SetOrgIdleIgnoreOutboundDefaultResponse(),
        ]
    )
    orgs = AsyncOrgs(transport)
    applied = await orgs.set_idle_ignore_outbound_default("o1", enabled=True)
    assert (
        applied.machines_changed,
        applied.snapshots_changed,
        applied.machines_skipped,
    ) == (2, 1, 1)
    request = transport.calls[0][1]
    assert (request.enabled, request.new_machines_only, request.apply_existing) == (
        True,
        False,
        True,
    )
    await orgs.set_idle_ignore_outbound_default(
        "o1", enabled=True, new_machines_only=True
    )
    request = transport.calls[1][1]
    assert (request.new_machines_only, request.apply_existing) == (True, False)
    default = await orgs.get_idle_ignore_outbound_default("o1")
    assert (default.is_set, default.enabled, default.platform_enabled) == (
        True,
        True,
        True,
    )
    await orgs.clear_idle_ignore_outbound_default("o1")
    assert transport.calls[3][0] == "SetOrgIdleIgnoreOutboundDefault"
    assert not transport.calls[3][1].HasField("enabled")
    assert transport.calls[3][1].apply_existing is False
    with pytest.raises(ValueError, match="clear_idle_ignore_outbound_default"):
        await orgs.set_idle_ignore_outbound_default("o1", enabled=None)
    with pytest.raises(ValueError, match="new_machines_only"):
        await orgs.set_idle_ignore_outbound_default(
            "o1", enabled=True, new_machines_only=True, apply_existing=True
        )


async def test_async_ssh_matches_sync():
    transport = FakeAsyncTransport(
        [
            *_created("a"),
            *_forked("b"),
            api_pb2.SetSshResponse(),
        ]
    )
    machines = AsyncMachines(transport)
    await machines.create("a", ssh=False)
    await machines.fork("a", "b", proxies=[ProxyEntry(name="web", port=3000)])
    await machines.set_ssh("a", True)
    create, _, fork, _, setter = transport.calls
    assert create[1].config.network.HasField("ssh")
    assert create[1].config.network.ssh is False
    assert not fork[1].config.network.HasField("ssh")
    assert setter[0] == "SetSsh"
    assert (setter[1].vm_id, setter[1].enabled) == ("a", True)


async def test_async_exec_folds_the_stream():
    transport = FakeAsyncTransport(
        [[api_pb2.ExecChunk(data=b"hi"), api_pb2.ExecChunk(exit_code=0)]]
    )
    result = await AsyncMachines(transport).exec("alpha", "echo hi")
    assert result.stdout == "hi"
    assert result.exit_code == 0


async def test_async_exec_buffer_encoding_is_byte_exact():
    raw = bytes(range(256))
    transport = FakeAsyncTransport([[api_pb2.ExecChunk(data=raw, exit_code=0)]])
    result = await AsyncMachines(transport).exec("alpha", "cat", encoding="buffer")
    assert result.stdout == raw
    assert isinstance(result.stdout, bytes)


async def test_async_list_returns_a_plain_list():
    transport = FakeAsyncTransport(
        [api_pb2.ListVmsResponse(vms=[a_vm("alpha"), a_vm("beta")])]
    )
    machines = await AsyncMachines(transport).list()
    assert isinstance(machines, list)
    assert [x.name for x in machines] == ["alpha", "beta"]


async def test_async_proxies_set_port_accepts_auto():
    transport = FakeAsyncTransport([api_pb2.SetProxyPortResponse()])
    await AsyncMachines(transport).proxies.set_port("alpha", "auto")
    assert transport.calls[0][1].port == "auto"
    assert transport.calls[0][1].name == ""


async def test_async_secrets_delete_returns_the_servers_confirmation():
    transport = FakeAsyncTransport([api_pb2.VarReply(message="removed TOKEN")])
    assert await AsyncSecrets(transport).delete("TOKEN") == "removed TOKEN"


async def test_async_env_and_secrets():
    transport = FakeAsyncTransport([api_pb2.VarReply(), api_pb2.VarReply()])
    await AsyncEnv(transport).set("MODE", "prod")
    await AsyncSecrets(transport).set("TOKEN", "x")
    assert transport.calls[0][1].kind == "env"
    assert transport.calls[1][1].kind == "secret"


def test_sync_and_async_clients_expose_the_same_namespaces():
    sync = Boxd(token="t")
    async_ = AsyncBoxd(token="t")
    names = {n for n in vars(sync) if not n.startswith("_")}
    assert names == {n for n in vars(async_) if not n.startswith("_")}
    assert names == {
        "machines",
        "snapshots",
        "disks",
        "env",
        "secrets",
        "domains",
        "orgs",
        "teams",
        "api_keys",
        "account",
    }


def _namespace_pairs():
    """Every sync namespace paired with its async twin."""
    from boxd.resources import account, credentials, disks, orgs, snapshots
    from boxd.resources.machines import (
        AsyncCheckpoints,
        AsyncFiles,
        AsyncPorts,
        AsyncProxies,
        Checkpoints,
        Files,
        Ports,
        Proxies,
    )

    return [
        (Machines, AsyncMachines),
        (Files, AsyncFiles),
        (Ports, AsyncPorts),
        (Proxies, AsyncProxies),
        (Checkpoints, AsyncCheckpoints),
        (Env, AsyncEnv),
        (Secrets, AsyncSecrets),
        (snapshots.Snapshots, snapshots.AsyncSnapshots),
        (disks.Disks, disks.AsyncDisks),
        (orgs.Orgs, orgs.AsyncOrgs),
        (credentials.ApiKeys, credentials.AsyncApiKeys),
        (account.Account, account.AsyncAccount),
    ]


def _public(cls):
    return {
        name
        for name in dir(cls)
        if not name.startswith("_") and callable(getattr(cls, name))
    }


@pytest.mark.parametrize(("sync_cls", "async_cls"), _namespace_pairs())
def test_sync_and_async_namespaces_have_the_same_methods(sync_cls, async_cls):
    assert _public(sync_cls) == _public(async_cls)


@pytest.mark.parametrize(("sync_cls", "async_cls"), _namespace_pairs())
def test_sync_and_async_twins_take_identical_arguments(sync_cls, async_cls):
    """The async twins are hand-written duplicates, so an argument added to one
    and not the other is the failure mode. Checking it here catches the drift
    without a second copy of every behavioural test.

    Parameters only: the return types are *meant* to differ, since an async
    `logs` yields an `AsyncIterator` and an async `stream_exec` hands back an
    `AsyncExecStream`.
    """
    import inspect

    for name in sorted(_public(sync_cls)):
        sync_params = inspect.signature(getattr(sync_cls, name)).parameters
        async_params = inspect.signature(getattr(async_cls, name)).parameters
        assert sync_params == async_params, (
            f"{sync_cls.__name__}.{name} and {async_cls.__name__}.{name} disagree"
        )


def test_machines_list_returns_a_plain_list():
    # Regression: this returned `list[Machine](data=..., ssh_host_key=...)`,
    # which raises `TypeError: list() takes no keyword arguments`. Nothing
    # covered the SDK's most-called method, so the suite stayed green.
    transport = FakeTransport([api_pb2.ListVmsResponse(vms=[a_vm(name="alpha"), a_vm(name="beta")])])
    machines = Machines(transport).list()
    assert isinstance(machines, list)
    assert [x.name for x in machines] == ["alpha", "beta"]
    assert machines[0].access.desktop_url == "https://app.boxd.sh/desktop/alpha"


def test_machines_list_is_empty_when_the_account_has_none():
    transport = FakeTransport([api_pb2.ListVmsResponse(vms=[])])
    assert Machines(transport).list() == []


# --- methods nothing reached before ---


def test_the_plain_lifecycle_verbs_each_hit_their_own_rpc():
    transport = FakeTransport([None] * 7)
    machines = Machines(transport)
    machines.start("alpha")
    machines.stop("alpha")
    machines.reboot("alpha")
    machines.hibernate("alpha")
    machines.wake("alpha")
    machines.share("alpha")
    machines.unshare("alpha")
    assert [c[0] for c in transport.calls] == [
        "StartVm",
        "StopVm",
        "RebootVm",
        "HibernateVm",
        "WakeVm",
        "ShareVm",
        "UnshareVm",
    ]
    assert all(c[1].vm_id == "alpha" for c in transport.calls)


def test_wait_until_ready_returns_once_running_and_exec_round_trips():
    # Status alone is not enough — it also proves an exec gets through.
    transport = FakeTransport([a_vm(), [api_pb2.ExecChunk(exit_code=0)]])
    machine = Machines(transport).wait_until_ready("alpha")
    assert machine.status == "running"
    assert [c[0] for c in transport.calls] == ["GetVm", "Exec"]


def test_wait_until_ready_gives_up_immediately_on_a_terminal_state():
    failed = a_vm()
    failed.status = "failed"
    transport = FakeTransport([failed])
    with pytest.raises(BoxdError, match="terminal state"):
        Machines(transport).wait_until_ready("alpha")


def test_exec_timeout_is_reported_as_a_timeout():
    # The deadline reaches the wire, and running out reads as a timeout rather
    # than as an opaque status error.
    transport = FakeTransport([FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED)])
    with pytest.raises(BoxdError, match="exec timed out after 0.5s"):
        Machines(transport).exec("alpha", "sleep 60", timeout=0.5)
    assert transport.bidi_timeout == 0.5


def test_exec_carries_tty_and_its_geometry():
    transport = FakeTransport([[api_pb2.ExecChunk(exit_code=0)]])
    Machines(transport).exec("alpha", "top", tty=True, cols=120, rows=40)
    assert transport.sent[0].tty is True
    assert transport.sent[0].cols == 120
    assert transport.sent[0].rows == 40


def test_proxies_delete_names_the_route():
    transport = FakeTransport([api_pb2.DeleteProxyResponse()])
    Machines(transport).proxies.delete("alpha", "web")
    assert transport.calls[0][0] == "DeleteProxy"
    assert transport.calls[0][1].name == "web"


def test_checkpoints_delete():
    transport = FakeTransport([api_pb2.DeleteCheckpointResponse()])
    Machines(transport).checkpoints.delete("alpha", "pre")
    assert transport.calls[0][0] == "DeleteCheckpoint"
    assert transport.calls[0][1].name == "pre"


def test_checkpoints_report_an_unrecorded_author_as_none():
    transport = FakeTransport(
        [
            api_pb2.ListCheckpointsResponse(
                checkpoints=[
                    api_pb2.CheckpointInfo(checkpoint_id="cp-1", created_at=1, created_by="")
                ]
            )
        ]
    )
    checkpoint = Machines(transport).checkpoints.list("alpha")[0]
    assert checkpoint.created_by is None
    assert checkpoint.created_at is not None


def test_checkpoints_created_at_is_milliseconds():
    # The server stamps `vm_checkpoints.created_at` in ms. Read as seconds, a
    # real value is year ~55,000 and `list()` raised instead of returning.
    transport = FakeTransport(
        [
            api_pb2.ListCheckpointsResponse(
                checkpoints=[
                    api_pb2.CheckpointInfo(checkpoint_id="cp-1", created_at=1_792_000_000_000)
                ]
            )
        ]
    )
    checkpoint = Machines(transport).checkpoints.list("alpha")[0]
    assert checkpoint.created_at == datetime(2026, 10, 14, 17, 46, 40, tzinfo=timezone.utc)


def test_snapshots_create_list_and_delete():
    from boxd.resources.snapshots import Snapshots

    transport = FakeTransport(
        [
            api_pb2.CreateSnapshotResponse(
                snapshot_id="s1", name="base", version=1, status="pending"
            ),
            api_pb2.ListSnapshotsResponse(snapshots=[]),
            api_pb2.DeleteSnapshotResponse(),
        ]
    )
    snapshots = Snapshots(transport)
    created = snapshots.create("alpha", "base")
    assert (created.id, created.name, created.version) == ("s1", "base", 1)
    assert snapshots.list(org="acme") == []
    snapshots.delete("base", org="acme")
    assert [c[0] for c in transport.calls] == [
        "CreateSnapshot",
        "ListSnapshots",
        "DeleteSnapshot",
    ]
    assert transport.calls[1][1].org == "acme"


def test_disks_list_reports_attachments():
    from boxd.resources.disks import Disks

    transport = FakeTransport(
        [
            api_pb2.ListDisksResponse(
                disks=[
                    api_pb2.DiskInfo(
                        disk_id="d1",
                        name="data",
                        status="ready",
                        created_at=1,
                        attachments=[
                            api_pb2.DiskAttachment(
                                vm_id="vm-1", vm_name="alpha",
                                mount_path="/data", mount_mode="rw",
                            )
                        ],
                    )
                ]
            )
        ]
    )
    disk = Disks(transport).list()[0]
    assert disk.attachments[0].mount_path == "/data"
    assert disk.created_at is not None


def test_disks_attach_detach_and_delete():
    from boxd.resources.disks import Disks

    transport = FakeTransport([None, None, None])
    disks = Disks(transport)
    disks.attach("d1", "alpha", "/data", read_only=True)
    disks.detach("d1", "alpha")
    disks.delete("d1")
    assert [c[0] for c in transport.calls] == ["AttachDisk", "DetachDisk", "DestroyDisk"]
    assert transport.calls[0][1].read_only is True
    assert transport.calls[0][1].mount_path == "/data"


def test_disks_attach_defaults_to_writable():
    from boxd.resources.disks import Disks

    transport = FakeTransport([None])
    Disks(transport).attach("d1", "alpha", "/data")
    assert transport.calls[0][1].read_only is False


def test_secrets_delete_returns_the_servers_confirmation():
    transport = FakeTransport([api_pb2.VarReply(message="removed TOKEN")])
    assert Secrets(transport).delete("TOKEN") == "removed TOKEN"
    assert transport.calls[0][0] == "RemoveVar"


def test_env_set_and_move_return_the_servers_confirmation():
    transport = FakeTransport(
        [api_pb2.VarReply(message="set MODE"), api_pb2.VarReply(message="moved MODE")]
    )
    env = Env(transport)
    assert env.set("MODE", "prod") == "set MODE"
    assert env.move("MODE", from_scope="all", to_scope="shared") == "moved MODE"


def test_api_keys_list_and_delete():
    from boxd.resources.credentials import ApiKeys

    transport = FakeTransport(
        [
            api_pb2.ListApiKeysResponse(
                keys=[api_pb2.ApiKeyInfo(id="k1", name="ci", created_at=1)]
            ),
            api_pb2.DeleteApiKeyResponse(),
        ]
    )
    keys = ApiKeys(transport)
    assert keys.list()[0].id == "k1"
    keys.delete("k1")
    assert [c[0] for c in transport.calls] == ["ListApiKeys", "DeleteApiKey"]
    assert transport.calls[1][1].id == "k1"


def test_account_get_and_config():
    from boxd.resources.account import Account

    transport = FakeTransport(
        [
            api_pb2.WhoamiResponse(
                user_id="u1",
                display_name="ada",
                pubkey_fingerprints=["SHA256:aaa"],
                billing=api_pb2.BillingInfo(subscription_status="active", max_vms=10),
            ),
            api_pb2.GetConfigResponse(default_image="debian:12", zone="boxd.sh"),
        ]
    )
    account = Account(transport)
    who = account.get()
    assert who.user_id == "u1"
    assert who.pubkey_fingerprints == ["SHA256:aaa"]
    assert who.billing.subscription_status == "active"
    config = account.config()
    assert (config.default_image, config.zone) == ("debian:12", "boxd.sh")


def test_account_that_never_subscribed_still_reports_billing():
    from boxd.resources.account import Account

    transport = FakeTransport([api_pb2.WhoamiResponse(user_id="u1")])
    billing = Account(transport).get().billing
    assert billing.subscription_status is None
    assert billing.max_vms == 0


def test_snapshots_get_raises_when_there_is_no_snapshot():
    # A miss used to map an empty message straight through, handing back a
    # Snapshot with blank fields. TypeScript raised; Python did not.
    from boxd.errors import NotFoundError
    from boxd.resources.snapshots import Snapshots

    transport = FakeTransport([api_pb2.GetSnapshotResponse()])
    with pytest.raises(NotFoundError):
        Snapshots(transport).get("nope")


def test_set_egress_allow_sends_the_full_set_and_returns_what_is_in_effect():
    transport = FakeTransport(
        [api_pb2.SetVmEgressAllowResponse(entries=["1.1.1.1", "api.example.com"])]
    )
    got = Machines(transport).set_egress_allow("alpha", ["api.example.com", "1.1.1.1"])
    method, request = transport.calls[0]
    assert method == "SetVmEgressAllow"
    assert request.vm == "alpha"
    assert list(request.entries) == ["api.example.com", "1.1.1.1"]
    assert got == ["1.1.1.1", "api.example.com"]


# ── Usage & cost ─────────────────────────────────────────────────────


def _vm_usage() -> api_pb2.VmUsage:
    return api_pb2.VmUsage(
        vm_id="vm-1",
        name="alpha",
        owner="usr_1",
        sharing="shared",
        status="running",
        vcpu=2,
        seconds=api_pb2.StateSeconds(running=3600, standby=60),
        vcpu_hours=2.0,
        cost_micro=1_230_000,
        complete=True,
    )


def test_machines_usage_sends_the_window_as_unix_seconds():
    from datetime import datetime, timezone

    transport = FakeTransport(
        [
            api_pb2.GetVmUsageResponse(
                period_start=1_000,
                period_end=2_000,
                currency="eur",
                rates=api_pb2.UsageRates(vcpu_hour_micro=49_000),
                usage=_vm_usage(),
            )
        ]
    )
    u = Machines(transport).usage(
        "alpha", since=datetime(2026, 9, 1, tzinfo=timezone.utc)
    )
    method, request = transport.calls[0]
    assert method == "GetVmUsage"
    assert (request.vm_id, request.since, request.until) == ("alpha", 1_788_220_800, 0)
    assert (u.machine_id, u.owner_id, u.owner_name) == ("vm-1", "usr_1", None)
    assert u.shared is True
    assert u.seconds.running == 3600
    assert u.resources.vcpu == 2
    assert u.cost_micro == 1_230_000
    assert u.complete is True
    assert u.currency == "eur"
    assert u.rates.vcpu_hour_micro == 49_000
    assert u.period.start == datetime.fromtimestamp(1_000, tz=timezone.utc)


def test_orgs_usage_maps_every_machine():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.GetOrgUsageResponse(
                org_id="o1",
                org="team",
                period_start=1_000,
                period_end=2_000,
                currency="usd",
                total_cost_micro=1_230_000,
                vms=[_vm_usage()],
            )
        ]
    )
    r = Orgs(transport).usage(org="team", since=1_000)
    method, request = transport.calls[0]
    assert method == "GetOrgUsage"
    assert (request.org, request.since, request.until) == ("team", 1_000, 0)
    assert r.total_cost_micro == 1_230_000
    assert [m.name for m in r.machines] == ["alpha"]


def _billing_activity_page(ids, token=""):
    return api_pb2.ListBillingActivityResponse(
        currency="eur",
        balance_micro=10,
        entries=[
            api_pb2.BillingActivityEntry(
                entry_id=i, kind="usage_charge", amount_micro=-5, created_at=1_000
            )
            for i in ids
        ],
        next_page_token=token,
    )


def test_orgs_billing_activity_walks_every_page():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([_billing_activity_page(["a", "b"], "tok"), _billing_activity_page(["c"])])
    ids = [e.id for e in Orgs(transport).billing_activity(page_size=2)]
    assert ids == ["a", "b", "c"]
    assert [r.page_token for _, r in transport.calls] == ["", "tok"]
    assert transport.calls[0][1].page_size == 2


async def test_async_orgs_billing_activity_walks_every_page():
    from boxd.resources.orgs import AsyncOrgs

    transport = FakeAsyncTransport([_billing_activity_page(["a"], "tok"), _billing_activity_page(["b"])])
    assert [e.id async for e in AsyncOrgs(transport).billing_activity()] == ["a", "b"]


def test_orgs_get_and_request_machine_limit():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport(
        [
            api_pb2.GetOrgMachineLimitResponse(
                org_id="org-1", org_name="acme", max_vms=50, vm_count=48, is_owner=True
            ),
            api_pb2.RequestOrgMachineLimitResponse(
                requested_at=1_790_000_000, requested_max_vms=80
            ),
            api_pb2.GetOrgMachineLimitResponse(
                org_id="org-1",
                org_name="acme",
                max_vms=50,
                vm_count=48,
                requested_at=1_790_000_000,
                requested_max_vms=80,
            ),
        ]
    )
    ns = Orgs(transport)

    limit = ns.get_machine_limit("acme")
    assert transport.calls[0] == (
        "GetOrgMachineLimit",
        api_pb2.GetOrgMachineLimitRequest(org_id="acme"),
    )
    assert (limit.org_id, limit.max_vms, limit.vm_count) == ("org-1", 50, 48)
    assert limit.is_owner is True
    assert limit.request is None

    opened = ns.request_machine_limit(80, message="CI runners")
    method, request = transport.calls[1]
    assert method == "RequestOrgMachineLimit"
    assert (request.org_id, request.max_vms, request.message) == ("", 80, "CI runners")
    assert opened.max_vms == 80
    assert opened.requested_at == datetime(2026, 9, 21, 14, 13, 20, tzinfo=timezone.utc)

    # Every member sees the open request; only the owner is told they own it.
    limit = ns.get_machine_limit()
    assert limit.is_owner is False
    assert limit.request is not None
    assert (limit.request.max_vms, limit.request.requested_at) == (80, opened.requested_at)


def test_request_machine_limit_refuses_a_non_positive_limit_locally():
    from boxd.resources.orgs import Orgs

    transport = FakeTransport([])
    for bad in (0, -5, True, 2.5, "80"):
        with pytest.raises(ValueError, match="max_vms"):
            Orgs(transport).request_machine_limit(bad)  # type: ignore[arg-type]
    assert transport.calls == []


def test_machine_limit_refusals_map_to_the_sdk_errors():
    # What the server answers a second request, a member, and a bad limit.
    from boxd.errors import BoxdError, ConflictError, PermissionDeniedError, from_grpc_error

    conflict = from_grpc_error(
        FakeRpcError(
            grpc.StatusCode.ALREADY_EXISTS,
            "You've already asked for more machines. We'll email you when your limit changes.",
        )
    )
    assert isinstance(conflict, ConflictError)
    assert "already asked" in str(conflict)
    assert isinstance(
        from_grpc_error(FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "owner only")),
        PermissionDeniedError,
    )
    invalid = from_grpc_error(FakeRpcError(grpc.StatusCode.INVALID_ARGUMENT, "at most 1000"))
    assert isinstance(invalid, BoxdError) and invalid.code == "invalid_argument"


async def test_async_machine_limit_matches_sync():
    from boxd.resources.orgs import AsyncOrgs

    transport = FakeAsyncTransport(
        [
            api_pb2.GetOrgMachineLimitResponse(org_id="org-1", max_vms=50, is_owner=True),
            api_pb2.RequestOrgMachineLimitResponse(requested_at=1_790_000_000, requested_max_vms=60),
        ]
    )
    ns = AsyncOrgs(transport)
    limit = await ns.get_machine_limit()
    assert (limit.max_vms, limit.is_owner, limit.request) == (50, True, None)
    opened = await ns.request_machine_limit(60, org="org-1")
    assert transport.calls[1][0] == "RequestOrgMachineLimit"
    assert (transport.calls[1][1].org_id, transport.calls[1][1].message) == ("org-1", "")
    assert opened.max_vms == 60
