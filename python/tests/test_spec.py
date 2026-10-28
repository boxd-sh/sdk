"""Machine specs: the builder, the pieces, the merge rules (against the
fixtures the server and the TypeScript SDK share, when this checkout has
them) and how ``machines.create()`` sends a spec."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from boxd import (
    ConflictError,
    Machine,
    MachineSpecBuilder,
    MachineSpecError,
    asana,
    claude,
    codex,
    github,
    jira,
    merge_specs,
    secrets,
    slack,
    snapshot,
    spec_patch,
    team,
)
from boxd import spec as spec_module
from boxd._generated import api_pb2
from boxd.resources.machines import AsyncMachines, Machines
from fakes import FakeAsyncTransport, FakeTransport

# The merge cases the server and both SDKs run. This is a copy of the
# server's file, kept identical to it by a test on the server side.
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "machine_spec_merge.json"
CASES = json.loads(FIXTURES.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_merge_fixtures(case):
    if "error" in case:
        with pytest.raises(MachineSpecError) as e:
            merge_specs(*case["pieces"])
        assert str(e.value) == case["error"]
        # And through the builder, which checks as it goes.
        with pytest.raises(MachineSpecError) as e:
            Machine.spec().with_(*case["pieces"]).resolve()
        assert str(e.value) == case["error"]
    else:
        assert merge_specs(*case["pieces"]) == case["expect"]
        assert Machine.spec().with_(*case["pieces"]).resolve() == case["expect"]


def test_builds_the_plans_example():
    engineering = (
        Machine.spec()
        .from_(team("eng"))
        .network("eng")
        .label("team", "eng")
        .env("NODE_ENV", "development")
        .with_(github(shared="eng-bot"), claude())
    )
    mike = engineering.size("2x8").with_(slack(), jira(shared="jira"), asana(), codex())
    assert mike.resolve() == {
        "version": 1,
        "base": {"team": "eng"},
        "size": "2x8",
        "labels": {"team": "eng"},
        "networks": ["eng"],
        "env": {"NODE_ENV": "development"},
        "connections": {
            "github": "shared:eng-bot",
            "slack": "personal",
            "jira": "shared:jira",
            "asana": "personal",
        },
        "agents": ["claude", "codex"],
    }
    # Builders are immutable: the shared base is untouched.
    assert "size" not in engineering.resolve()


def test_maps_egress_isolation_and_other_builders():
    tools = MachineSpecBuilder().egress("github.com", "*.atlassian.net")
    s = (
        Machine.spec()
        .from_(snapshot("eng-base"))
        .label({"a": "1", "b": "2"})
        .env({"A": "1"})
        .isolated()
        .with_(tools)
        .resolve()
    )
    assert s == {
        "version": 1,
        "base": {"snapshot": "eng-base"},
        "labels": {"a": "1", "b": "2"},
        "isolated": True,
        "egress": ["github.com", "*.atlassian.net"],
        "env": {"A": "1"},
    }


def test_raises_where_a_conflict_is_written_naming_the_field():
    base = Machine.spec().from_(team("eng"))
    with pytest.raises(MachineSpecError, match=r'spec\.base: set twice'):
        base.from_(snapshot("x"))
    with pytest.raises(ValueError, match=r"spec\.size"):
        base.size("2x8").size("4x16")


def test_refuses_unknown_keys():
    with pytest.raises(MachineSpecError, match=r"spec\.sise: unknown field"):
        Machine.spec().with_({"sise": "2x8"})


def test_the_model_keeps_its_spec_fields():
    m = Machine.model_validate(
        {
            "id": "v",
            "name": "n",
            "status": "running",
            "image_ref": "",
            "restart_policy": None,
            "created_at": None,
            "resources": {"vcpu": 1, "memory_bytes": 1, "disk_bytes": 1},
            "org": None,
            "shared": False,
            "networking": {"networks": [], "isolated": False},
            "egress_allow": [],
            "access": {"ssh_port": None, "domain": "", "url": "", "desktop_url": "", "custom_domains": []},
            "idle": {"suspend_after": 0, "hibernate_after": 0, "destroy_after": 0},
            "bot_protection": True,
            "source": None,
            "hibernated_at": None,
            "last_connected_at": None,
            "boot_time_ms": None,
            "spec": {"version": 1, "env": {"A": "1"}},
        }
    )
    assert m.spec == {"version": 1, "env": {"A": "1"}}
    assert m.created_spec is None
    assert m.model_dump()["spec"] == {"version": 1, "env": {"A": "1"}}
    # On the class, `spec` starts a builder.
    assert isinstance(Machine.spec(), MachineSpecBuilder)


def _vm_with_spec():
    vm = api_pb2.GetVmResponse(vm_id="vm-1", name="mike-dev", status="running")
    wire = api_pb2.MachineSpec(
        version=1, labels={"team": "eng"}, connections={"slack": "personal"}
    )
    wire.base.team = "eng"
    vm.spec.CopyFrom(wire)
    vm.created_spec.CopyFrom(wire)
    return vm


def test_create_sends_the_resolved_spec_and_reads_it_back():
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="mike-dev"), _vm_with_spec()]
    )
    m = Machines(transport).create(
        "mike-dev",
        org="acme",
        spec=Machine.spec().from_(team("eng")).label("team", "eng").with_(slack()),
    )
    method, request = transport.calls[0]
    assert method == "CreateVm"
    assert request.HasField("spec")
    assert request.spec.version == 1
    assert request.spec.base.team == "eng"
    assert dict(request.spec.labels) == {"team": "eng"}
    assert dict(request.spec.connections) == {"slack": "personal"}
    # Nothing the spec covers goes out beside it.
    assert (request.team, dict(request.labels), list(request.networks)) == ("", {}, [])
    assert m.spec == {
        "version": 1,
        "base": {"team": "eng"},
        "labels": {"team": "eng"},
        "connections": {"slack": "personal"},
    }
    assert m.created_spec == m.spec


def test_a_machine_without_a_spec_reads_as_none():
    transport = FakeTransport([api_pb2.GetVmResponse(vm_id="v", name="n", status="running")])
    assert Machines(transport).get("n").spec is None


def test_restore_sends_the_spec_on_top():
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="r"), _vm_with_spec()]
    )
    Machines(transport).create(
        "r", from_snapshot="eng-base", spec={"version": 1, "env": {"A": "1"}}
    )
    method, request = transport.calls[0]
    assert method == "CreateVmFromSnapshot"
    assert request.snapshot == "eng-base"
    assert dict(request.spec.env) == {"A": "1"}


@pytest.mark.parametrize(
    "kwargs", [{"labels": {"a": "b"}}, {"networks": ["eng"]}, {"vcpu": 2}, {"isolated": True}]
)
def test_create_refuses_what_the_spec_covers(kwargs):
    transport = FakeTransport()
    with pytest.raises(MachineSpecError, match="put it in the spec"):
        Machines(transport).create("x", spec=Machine.spec(), **kwargs)
    assert transport.calls == []


def test_create_names_every_field_the_spec_covers():
    with pytest.raises(MachineSpecError) as e:
        Machines(FakeTransport()).create(
            "x", spec=Machine.spec(), image="ubuntu", labels={"a": "b"}, memory="8G"
        )
    assert str(e.value) == (
        "spec: create(spec=...) does not accept image, labels, memory: put them in the spec"
    )
    # Still a ValueError, for code that caught one before.
    assert isinstance(e.value, ValueError)
    with pytest.raises(MachineSpecError, match="does not accept labels"):
        Machines(FakeTransport()).create(
            "x", from_snapshot="eng-base", spec=Machine.spec(), labels={"a": "b"}
        )


@pytest.mark.parametrize("size", ["2X8", " 2x8 ", "2 x 8", "02x08"])
def test_a_size_compares_as_the_server_stores_it(size):
    assert Machine.spec().size(size).resolve() == {"version": 1, "size": "2x8"}
    assert Machine.spec().with_({"size": "2x8"}).size(size).resolve()["size"] == "2x8"
    assert spec_patch({"version": 1, "size": "2x8"}, {"version": 1, "size": size}) == {}
    assert spec_patch({"version": 1, "size": size}, {"version": 1, "size": "4X16"}) == {
        "size": "4x16"
    }


def test_create_refuses_an_unknown_key_before_calling_the_server():
    transport = FakeTransport()
    with pytest.raises(MachineSpecError, match=r"spec\.ports: unknown field"):
        Machines(transport).create("x", spec={"version": 1, "ports": [8080]})
    assert transport.calls == []


def test_assign_to_is_set_once_by_the_builder():
    base = Machine.spec().from_(team("eng"))
    assert base.assign_to("usr_mike").resolve() == {
        "version": 1,
        "base": {"team": "eng"},
        "assignTo": "usr_mike",
    }
    assert base.assign_to("usr_mike").assign_to("usr_mike").resolve()["assignTo"] == "usr_mike"
    with pytest.raises(
        MachineSpecError,
        match=r'spec\.assignTo: set twice to different values: "usr_mike" and "usr_ana"',
    ):
        base.assign_to("usr_mike").assign_to("usr_ana")


def test_create_sends_assign_to_and_reads_who_created_the_machine():
    vm = api_pb2.GetVmResponse(
        vm_id="vm-1",
        name="mike-dev",
        status="running",
        created_by="usr_admin",
        created_by_name="Ana Admin",
    )
    transport = FakeTransport([api_pb2.CreateVmResponse(vm_id="vm-1", name="mike-dev"), vm])
    m = Machines(transport).create(
        "mike-dev", org="acme", spec=Machine.spec().size("2x8").assign_to("usr_mike")
    )
    assert transport.calls[0][1].spec.assign_to == "usr_mike"
    assert (m.created_by, m.created_by_name) == ("usr_admin", "Ana Admin")
    plain = FakeTransport([api_pb2.GetVmResponse(vm_id="v", name="n", status="running")])
    assert Machines(plain).get("n").created_by is None


def test_get_reads_the_requirements_the_server_computed():
    isolated = "an isolated machine gets no integrations or agent logins"
    vm = api_pb2.GetVmResponse(
        vm_id="vm-1",
        name="eng",
        status="running",
        requirements=[
            api_pb2.MachineRequirement(
                kind="connection", name="jira", scope="shared", tag="jira", can_fix=True
            ),
            api_pb2.MachineRequirement(
                kind="connection", name="slack", scope="personal", met=True
            ),
            api_pb2.MachineRequirement(
                kind="agent", name="claude", scope="personal", reason=isolated
            ),
        ],
    )
    m = Machines(FakeTransport([vm])).get("eng")
    assert [r.model_dump() for r in m.requirements] == [
        {"kind": "connection", "name": "jira", "scope": "shared", "tag": "jira",
         "met": False, "can_fix": True, "reason": None},
        {"kind": "connection", "name": "slack", "scope": "personal", "tag": None,
         "met": True, "can_fix": False, "reason": None},
        {"kind": "agent", "name": "claude", "scope": "personal", "tag": None,
         "met": False, "can_fix": False, "reason": isolated},
    ]
    plain = FakeTransport([api_pb2.GetVmResponse(vm_id="v", name="n", status="running")])
    assert Machines(plain).get("n").requirements == []


def test_packages_combine_in_order_and_go_out_on_create():
    base = Machine.spec().packages("apt-get update", "apt-get install -y nginx")
    transport = FakeTransport([api_pb2.CreateVmResponse(vm_id="vm-1", name="p"), _vm_with_spec()])
    Machines(transport).create("p", spec=base.packages("echo ok", "apt-get update"))
    _, request = transport.calls[0]
    assert list(request.spec.packages) == ["apt-get update", "apt-get install -y nginx", "echo ok"]
    assert base.resolve()["packages"] == ["apt-get update", "apt-get install -y nginx"]


def test_get_reads_how_each_package_went():
    vm = api_pb2.GetVmResponse(
        vm_id="vm-1",
        name="eng",
        status="running",
        packages=[
            api_pb2.MachinePackage(
                command="apt-get update", state="done", exit_code=0, output_tail="ok",
                started_at_ms=1000, finished_at_ms=2000,
            ),
            api_pb2.MachinePackage(
                command="sleep 9999", state="failed", reason="timed out after 30 minutes and was killed",
                started_at_ms=2000, finished_at_ms=3000,
            ),
            api_pb2.MachinePackage(command="echo after", state="pending"),
        ],
    )
    m = Machines(FakeTransport([vm])).get("eng")
    done, failed, pending = m.packages
    assert (done.state, done.exit_code, done.output_tail, done.reason) == ("done", 0, "ok", None)
    assert done.started_at is not None and done.started_at.timestamp() == 1.0
    assert (failed.state, failed.exit_code) == ("failed", None)
    assert failed.reason == "timed out after 30 minutes and was killed"
    assert (pending.state, pending.exit_code, pending.started_at) == ("pending", None, None)
    plain = FakeTransport([api_pb2.GetVmResponse(vm_id="v", name="n", status="running")])
    assert Machines(plain).get("n").packages == []


def test_reads_a_skipped_command_and_what_an_update_skips():
    vm = api_pb2.GetVmResponse(
        vm_id="vm-1",
        name="eng",
        status="running",
        packages=[
            api_pb2.MachinePackage(
                command="exit 3", state="skipped", exit_code=3, output_tail="boom",
                reason="removed from the spec after it failed",
            ),
        ],
    )
    (skipped,) = Machines(FakeTransport([vm])).get("eng").packages
    assert (skipped.state, skipped.exit_code, skipped.output_tail) == ("skipped", 3, "boom")
    assert skipped.reason == "removed from the spec after it failed"
    reply = api_pb2.UpdateMachineSpecResponse(
        changes=[
            api_pb2.MachineSpecChange(
                field="packages", apply="live", added=["echo fixed", "echo back"],
                removed=["exit 3"], skipped=["exit 3"], unskipped=["echo back"],
            )
        ],
        spec=api_pb2.MachineSpec(version=1),
        applied=True,
    )
    from boxd._mappers import spec_update

    (change,) = spec_update(reply).changes
    assert (change.skipped, change.unskipped) == (["exit 3"], ["echo back"])


def test_secrets_is_a_piece_combined_in_order_without_duplicates():
    assert secrets("NPM_TOKEN", "SENTRY_DSN") == {"secrets": ["NPM_TOKEN", "SENTRY_DSN"]}
    s = Machine.spec().with_(secrets("NPM_TOKEN")).with_(secrets("GH_PAT", "NPM_TOKEN"))
    assert s.resolve() == {"version": 1, "secrets": ["NPM_TOKEN", "GH_PAT"]}


def test_a_name_in_env_and_secrets_raises_wherever_it_was_written():
    message = (
        'spec.secrets: "NPM_TOKEN" is also in env; a name is either a plain value (env) '
        "or a secret (secrets), not both"
    )
    with pytest.raises(MachineSpecError) as e:
        Machine.spec().with_(secrets("NPM_TOKEN")).env("NPM_TOKEN", "x")
    assert str(e.value) == message
    with pytest.raises(MachineSpecError) as e:
        merge_specs({"env": {"NPM_TOKEN": "x"}, "secrets": ["NPM_TOKEN"]})
    assert str(e.value) == message


def test_secrets_go_over_the_wire_and_come_back():
    vm = api_pb2.GetVmResponse(vm_id="vm-1", name="mike-dev", status="running")
    vm.spec.CopyFrom(api_pb2.MachineSpec(version=1, secrets=["NPM_TOKEN", "GH_PAT"]))
    transport = FakeTransport([api_pb2.CreateVmResponse(vm_id="vm-1", name="mike-dev"), vm])
    m = Machines(transport).create(
        "mike-dev", org="acme", spec=Machine.spec().with_(secrets("NPM_TOKEN", "GH_PAT"))
    )
    assert list(transport.calls[0][1].spec.secrets) == ["NPM_TOKEN", "GH_PAT"]
    assert m.spec == {"version": 1, "secrets": ["NPM_TOKEN", "GH_PAT"]}


def test_create_refuses_delete_after_on_a_machine_for_someone_else():
    transport = FakeTransport()
    with pytest.raises(MachineSpecError, match=r"spec\.assignTo: a machine created for someone"):
        Machines(transport).create(
            "x", org="acme", spec=Machine.spec().assign_to("usr_mike"), delete_after=3600
        )
    assert transport.calls == []


def test_async_create_sends_the_spec():
    transport = FakeAsyncTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="mike-dev"), _vm_with_spec()]
    )
    m = asyncio.run(
        AsyncMachines(transport).create("mike-dev", spec=Machine.spec().from_(team("eng")))
    )
    assert transport.calls[0][1].spec.base.team == "eng"
    assert m.spec is not None and m.spec["base"] == {"team": "eng"}


# The updateSpec patch cases the server and both SDKs run (a copy of the
# server's file, kept identical to it by a test on the server side).
PATCH_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "machine_spec_patch.json"
PATCH_CASES = [
    c
    for c in json.loads(PATCH_FIXTURES.read_text())["cases"]
    if c.get("minimal") or c.get("sdk")
]


@pytest.mark.parametrize("case", PATCH_CASES, ids=[c["name"] for c in PATCH_CASES])
def test_shared_patch_fixtures(case):
    if "error" in case:
        with pytest.raises(MachineSpecError) as e:
            spec_module.check_patch(case["patch"])
        assert str(e.value) == case["error"]
        return
    # What the SDK sends for a builder is what the server would compute, and
    # applying it gives the result.
    assert spec_patch(case["current"], case["result"]) == case["patch"]
    assert spec_module.apply_patch(case["current"], case["patch"]) == case["result"]


def _update_reply():
    return api_pb2.UpdateMachineSpecResponse(
        changes=[
            api_pb2.MachineSpecChange(
                field="networks", apply="live", added=["ops"], note="the machine's peers change now"
            ),
            api_pb2.MachineSpecChange(field="env", apply="reboot_recommended", added=["X"]),
        ],
        reboot_recommended=True,
        spec=api_pb2.MachineSpec(version=1, networks=["eng", "ops"], env={"A": "1", "X": "1"}),
        applied=True,
    )


def _vm_spec(**extra):
    vm = api_pb2.GetVmResponse(vm_id="vm-1", name="n", status="running")
    vm.spec.CopyFrom(
        api_pb2.MachineSpec(
            version=1, labels={"team": "eng"}, networks=["eng"], env={"A": "1"}, **extra
        )
    )
    return vm


def test_update_spec_sends_a_patch_as_json_with_the_options():
    transport = FakeTransport([_update_reply()])
    res = Machines(transport).update_spec(
        "vm-1", {"labels": {"team": None, "owner": "mike"}, "size": "4x16"},
        dry_run=True, reboot=True,
    )
    method, request = transport.calls[0]
    assert method == "UpdateMachineSpec"
    assert request.vm == "vm-1"
    assert json.loads(request.patch) == {"labels": {"team": None, "owner": "mike"}, "size": "4x16"}
    assert (request.dry_run, request.reboot) == (True, True)
    assert [(c.field, c.apply) for c in res.changes] == [
        ("networks", "live"),
        ("env", "reboot_recommended"),
    ]
    assert res.changes[0].before is None
    assert res.reboot_recommended and res.applied and not res.reboot_required
    assert res.spec["networks"] == ["eng", "ops"]


def test_update_spec_with_a_builder_sends_only_the_difference():
    transport = FakeTransport([_vm_spec(), _update_reply()])
    Machines(transport).update_spec("vm-1", lambda s: s.network("ops").env("X", "1"))
    assert [c[0] for c in transport.calls] == ["GetVm", "UpdateMachineSpec"]
    assert json.loads(transport.calls[1][1].patch) == {"networks": ["eng", "ops"], "env": {"X": "1"}}
    assert transport.calls[1][1].dry_run is False


def test_update_spec_builder_cant_replace_what_the_spec_names():
    transport = FakeTransport([_vm_spec(size="2x8")])
    with pytest.raises(MachineSpecError) as e:
        Machines(transport).update_spec("vm-1", lambda s: s.size("4x16"))
    assert str(e.value) == 'spec.size: set twice to different values: "2x8" and "4x16"'
    assert [c[0] for c in transport.calls] == ["GetVm"]


def test_update_spec_builder_size_matches_however_it_is_written():
    transport = FakeTransport([_vm_spec(size="2x8"), _update_reply()])
    Machines(transport).update_spec("vm-1", lambda s: s.size("2X8").network("ops"))
    assert json.loads(transport.calls[1][1].patch) == {"networks": ["eng", "ops"]}


def test_update_spec_refuses_a_builder_and_says_what_to_pass():
    transport = FakeTransport()
    builder = Machine.spec().label("x", "1")
    with pytest.raises(MachineSpecError) as e:
        Machines(transport).update_spec("vm-1", builder)  # type: ignore[arg-type]
    assert str(e.value) == (
        "spec: a patch is a JSON object, not a builder: pass builder.resolve() to set the "
        'fields it names, or a function (lambda s: s.network("ops")) to add to the '
        "machine's current spec"
    )
    with pytest.raises(MachineSpecError, match="a patch is a JSON object"):
        Machines(transport).update_spec("vm-1", [("labels", {})])  # type: ignore[arg-type]
    assert transport.calls == []


def test_update_spec_refuses_before_sending():
    transport = FakeTransport([api_pb2.GetVmResponse(vm_id="v", name="n", status="running")])
    machines = Machines(transport)
    with pytest.raises(MachineSpecError, match="spec.ports: unknown field"):
        machines.update_spec("vm-1", {"ports": [1]})
    with pytest.raises(MachineSpecError, match="wasn't created from a spec"):
        machines.update_spec("vm-1", lambda s: s.network("ops"))
    assert [c[0] for c in transport.calls] == ["GetVm"]


def test_async_update_spec_with_a_builder():
    transport = FakeAsyncTransport([_vm_spec(), _update_reply()])
    res = asyncio.run(
        AsyncMachines(transport).update_spec("vm-1", lambda s: s.network("ops"), dry_run=True)
    )
    assert json.loads(transport.calls[1][1].patch) == {"networks": ["eng", "ops"]}
    assert transport.calls[1][1].dry_run is True
    assert res.changes[0].field == "networks"


def test_update_spec_retries_packages_with_an_empty_patch():
    transport = FakeTransport([_update_reply(), _update_reply()])
    machines = Machines(transport)
    machines.update_spec("vm-1", {}, retry_packages=True)
    request = transport.calls[0][1]
    assert json.loads(request.patch) == {}
    assert (request.retry_packages, request.dry_run, request.reboot) == (True, False, False)
    machines.update_spec("vm-1", {"labels": {"x": "1"}})
    assert transport.calls[1][1].retry_packages is False


def test_async_update_spec_retries_packages():
    transport = FakeAsyncTransport([_update_reply()])
    asyncio.run(AsyncMachines(transport).update_spec("vm-1", {}, retry_packages=True))
    assert transport.calls[0][1].retry_packages is True


# The spec read travels with the update, and the function form
# tries again on a conflict.
def _conflict(code="aborted"):
    numeric = 10 if code == "aborted" else 9
    return ConflictError("the machine's spec changed", code=code, grpc_code=numeric)


def test_update_spec_builder_sends_what_it_read_and_reads_again_after_a_conflict():
    moved = _vm_spec()
    moved.spec.networks[:] = ["eng", "ci"]
    transport = FakeTransport([_vm_spec(), _conflict(), moved, _update_reply()])
    Machines(transport).update_spec("vm-1", lambda s: s.network("ops"))
    assert [c[0] for c in transport.calls] == [
        "GetVm",
        "UpdateMachineSpec",
        "GetVm",
        "UpdateMachineSpec",
    ]
    first = json.loads(transport.calls[1][1].expected_spec)
    assert first["networks"] == ["eng"] and first["labels"] == {"team": "eng"}
    second = transport.calls[3][1]
    assert json.loads(second.expected_spec)["networks"] == ["eng", "ci"]
    assert json.loads(second.patch) == {"networks": ["eng", "ci", "ops"]}


def test_update_spec_builder_gives_up_after_3_retries_and_never_retries_another_refusal():
    transport = FakeTransport([_vm_spec(), _conflict()] * 4)
    with pytest.raises(ConflictError):
        Machines(transport).update_spec("vm-1", lambda s: s.network("ops"))
    assert [c[0] for c in transport.calls].count("UpdateMachineSpec") == 4

    once = FakeTransport([_vm_spec(), _conflict("failed_precondition")])
    with pytest.raises(ConflictError):
        Machines(once).update_spec("vm-1", lambda s: s.network("ops"))
    assert [c[0] for c in once.calls].count("UpdateMachineSpec") == 1


def test_update_spec_patch_sends_expected_spec_when_given_and_isnt_retried():
    read = {"version": 1, "networks": ["eng"]}
    transport = FakeTransport([_update_reply(), _update_reply()])
    machines = Machines(transport)
    machines.update_spec("vm-1", {"networks": ["eng", "ops"]}, expected_spec=read)
    assert json.loads(transport.calls[0][1].expected_spec) == read
    machines.update_spec("vm-1", {"labels": {"x": "1"}})
    assert transport.calls[1][1].expected_spec == ""

    aborted = FakeTransport([_conflict()])
    with pytest.raises(ConflictError):
        Machines(aborted).update_spec("vm-1", {"networks": []}, expected_spec=read)
    assert [c[0] for c in aborted.calls] == ["UpdateMachineSpec"]


def test_async_update_spec_builder_retries_a_conflict():
    transport = FakeAsyncTransport([_vm_spec(), _conflict(), _vm_spec(), _update_reply()])
    asyncio.run(AsyncMachines(transport).update_spec("vm-1", lambda s: s.network("ops")))
    assert [c[0] for c in transport.calls].count("UpdateMachineSpec") == 2
    assert json.loads(transport.calls[3][1].expected_spec)["networks"] == ["eng"]


def test_update_spec_reports_a_resize_that_failed_after_the_rest_applied():
    partial = _update_reply()
    partial.resize_error = "spec.size: the rest of the patch was applied, but the resize failed: x"
    partial.spec.size = "2x8"
    res = Machines(FakeTransport([partial])).update_spec("vm-1", {"size": "4x16"}, reboot=True)
    assert res.applied and not res.rebooted
    assert res.resize_error is not None and "the resize failed" in res.resize_error
    assert res.spec["size"] == "2x8"
    assert Machines(FakeTransport([_update_reply()])).update_spec("vm-1", {}).resize_error is None
