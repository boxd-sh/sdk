"""Request builders — sizes, config assembly, and the awkward wire corners."""

from __future__ import annotations

import pytest

from boxd import _requests as req
from boxd._generated import api_pb2
from boxd.models import ProxyEntry, VolumeMount


# --- sizes ---


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, 0),
        (0, 0),
        (1024, 1024),
        ("8G", 8 * 1024**3),
        ("512M", 512 * 1024**2),
        ("100GB", 100 * 1024**3),
        ("2Ti", 2 * 1024**4),
        ("  4g  ", 4 * 1024**3),
    ],
)
def test_parse_size(value, expected):
    assert req.parse_size(value) == expected


def test_parse_size_rejects_garbage():
    with pytest.raises(ValueError, match="invalid size"):
        req.parse_size("many gigabytes")


# --- vm_config ---


def test_vm_config_is_none_when_nothing_was_asked_for():
    # All-zero config is indistinguishable from an omitted one; let the server
    # pick the defaults.
    assert req.vm_config() is None


def test_vm_config_sizes():
    config = req.vm_config(vcpu=4, memory="16G", disk="200G")
    assert config.vcpu == 4
    assert config.memory_bytes == 16 * 1024**3
    assert config.disk_bytes == 200 * 1024**3


def test_auto_suspend_timeout_zero_is_sent_explicitly():
    # The field is `optional` on the wire: unset = server default, 0 = disabled.
    config = req.vm_config(auto_suspend_timeout=0)
    assert config.srf.HasField("auto_suspend_timeout_secs")
    assert config.srf.auto_suspend_timeout_secs == 0


def test_auto_suspend_timeout_left_unset_when_not_given():
    config = req.vm_config(auto_destroy_timeout=60)
    assert not config.srf.HasField("auto_suspend_timeout_secs")
    assert config.srf.auto_destroy_timeout_secs == 60


def _vm_config_on_the_wire(config):
    """What the server decodes, which is where unset and False part ways."""
    return api_pb2.VmConfig.FromString(config.SerializeToString())


def test_idle_ignore_outbound_left_unset_when_not_given():
    # `optional` on the wire: unset lets a new machine take its
    # org's default, so a defaulted False must never go out.
    config = req.vm_config(vcpu=2)
    assert not config.HasField("idle_ignore_outbound")
    assert not _vm_config_on_the_wire(config).HasField("idle_ignore_outbound")


def test_idle_ignore_outbound_false_is_sent_explicitly():
    # Asking for False alone is still asking: the config must not collapse
    # to None, and False must survive the wire as False, not as unset.
    config = req.vm_config(idle_ignore_outbound=False)
    assert config is not None
    sent = _vm_config_on_the_wire(config)
    assert sent.HasField("idle_ignore_outbound")
    assert sent.idle_ignore_outbound is False


def test_idle_ignore_outbound_true_is_sent():
    sent = _vm_config_on_the_wire(req.vm_config(idle_ignore_outbound=True))
    assert sent.HasField("idle_ignore_outbound")
    assert sent.idle_ignore_outbound is True


def test_ssh_left_unset_when_only_proxies_are_given():
    # `optional` on the wire: unset = not requested. A new machine then has
    # SSH on and a fork or restore keeps the source's setting, so a defaulted
    # True must never go out.
    config = req.vm_config(proxies=[ProxyEntry(name="web", port=3000)])
    assert not config.network.HasField("ssh")
    assert not _vm_config_on_the_wire(config).network.HasField("ssh")
    assert config.network.proxies[0].name == "web"
    assert config.network.proxies[0].port == 3000


def test_ssh_left_unset_when_not_given():
    config = req.vm_config(vcpu=2)
    assert not config.HasField("network")


def test_ssh_false_is_sent_explicitly():
    # Asking for False alone is still asking: the config must not collapse
    # to None, and False must survive the wire as False, not as unset.
    config = req.vm_config(ssh=False)
    assert config is not None
    sent = _vm_config_on_the_wire(config)
    assert sent.network.HasField("ssh")
    assert sent.network.ssh is False


def test_ssh_true_is_sent():
    sent = _vm_config_on_the_wire(req.vm_config(ssh=True))
    assert sent.network.HasField("ssh")
    assert sent.network.ssh is True


def test_volumes():
    config = req.vm_config(
        volumes=[VolumeMount(disk_id="d1", mount_path="/data", read_only=True)]
    )
    assert config.volumes[0].disk_id == "d1"
    assert config.volumes[0].mount_path == "/data"
    assert config.volumes[0].read_only is True


# --- create ---


def test_create_vm_defaults():
    request = req.create_vm(
        name=None,
        image=None,
        env=None,
        cmd=None,
        restart_policy=None,
        org=None,
        shared=False,
        networks=None,
        isolated=False,
        config=None,
    )
    assert request.name == ""
    assert request.image_ref == ""
    assert request.org == ""
    assert request.restart_policy == "always"
    # Empty networks is the default network, not "no peers" — so the default
    # create must send an EMPTY list, never a placeholder entry.
    assert list(request.networks) == []
    assert request.isolated is False
    assert not request.HasField("config")


def test_create_vm_env_is_a_repeated_pair_list():
    request = req.create_vm(
        name="a",
        image=None,
        env={"MODE": "prod"},
        cmd=["sleep", "1"],
        restart_policy=None,
        org="acme",
        shared=True,
        networks=None,
        isolated=False,
        config=None,
    )
    assert [(e.key, e.value) for e in request.env] == [("MODE", "prod")]
    assert list(request.cmd) == ["sleep", "1"]
    assert request.shared is True
    assert request.org == "acme"


def test_fork_carries_config_when_given():
    request = req.fork_vm(
        source="alpha",
        name="beta",
        shared=False,
        networks=None,
        isolated=False,
        config=req.vm_config(vcpu=2),
    )
    assert request.source_vm_id == "alpha"
    assert request.config.vcpu == 2
    # Empty means "inherit the source's networks"; a fork never resets them.
    assert list(request.networks) == []
    # Likewise False means "inherit" — the server ORs it with the source's flag.
    assert request.isolated is False


def test_create_vm_carries_networks_and_isolated():
    request = req.create_vm(
        name="sandbox",
        image=None,
        env=None,
        cmd=None,
        restart_policy=None,
        org=None,
        shared=False,
        networks=["demo", "test"],
        isolated=True,
        config=None,
    )
    assert list(request.networks) == ["demo", "test"]
    assert request.isolated is True


def test_fork_networks_override_replaces_the_source_set():
    request = req.fork_vm(
        source="alpha",
        name="beta",
        shared=False,
        networks=["demo"],
        isolated=False,
        config=None,
    )
    assert list(request.networks) == ["demo"]


def test_fork_isolated_override_is_carried():
    request = req.fork_vm(
        source="alpha",
        name="beta",
        shared=False,
        networks=None,
        isolated=True,
        config=None,
    )
    assert request.isolated is True


def test_create_from_snapshot_carries_the_isolated_override():
    # One-way: the server ORs this with the snapshot's captured flag, so
    # False on the wire means "inherit", never "de-isolate".
    inherited = req.create_vm_from_snapshot(
        snapshot="snap", name=None, org=None, isolated=False, config=None
    )
    assert inherited.isolated is False
    forced = req.create_vm_from_snapshot(
        snapshot="snap", name=None, org=None, isolated=True, config=None
    )
    assert forced.isolated is True
    assert forced.snapshot == "snap"


def test_list_vms_all_contexts():
    assert req.list_vms(org="acme", all_contexts=True).all_contexts is True
    assert req.list_vms(org=None, all_contexts=False).org == ""


# --- org defaults ---


def test_set_org_idle_ignore_outbound_default_carries_enabled_and_apply_existing():
    request = req.set_org_idle_ignore_outbound_default(
        org="acme", enabled=False, apply_existing=True
    )
    assert request.org_id == "acme"
    # An explicit False is a default too, so it is present on the wire.
    assert request.HasField("enabled")
    assert request.enabled is False
    assert request.apply_existing is True


def test_set_org_idle_ignore_outbound_default_without_enabled_leaves_it_unset():
    # Absence is what clears the default; None must not become False.
    request = req.set_org_idle_ignore_outbound_default(
        org=None, enabled=None, apply_existing=False
    )
    assert request.org_id == ""
    assert not request.HasField("enabled")
    assert request.apply_existing is False


# --- exec ---


def test_join_command_accepts_a_string_or_a_list():
    assert req.join_command("ls -la") == "ls -la"
    assert req.join_command(["ls", "-la"]) == "ls -la"


def test_join_command_quotes_arguments_that_need_it():
    assert req.join_command(["echo", "a b"]) == "echo 'a b'"


def test_exec_chunk_defaults():
    chunk = req.exec_chunk(machine_id="vm-1", command="true")
    assert chunk.vm_id == "vm-1"
    assert chunk.tty is False
    assert chunk.stdin is False


# --- uploads ---


def test_upload_chunks_headers_the_first_chunk_only():
    chunks = list(
        req.upload_chunks(machine_id="vm-1", path="/tmp/f", data=b"abcdef", chunk_size=4)
    )
    assert len(chunks) == 2
    assert chunks[0].vm_id == "vm-1"
    assert chunks[0].path == "/tmp/f"
    assert chunks[0].total_size == 6
    assert chunks[0].data == b"abcd"
    # Later chunks carry bytes only.
    assert chunks[1].vm_id == ""
    assert chunks[1].data == b"ef"


def test_upload_chunks_still_sends_a_header_for_an_empty_file():
    chunks = list(
        req.upload_chunks(machine_id="vm-1", path="/tmp/f", data=b"", chunk_size=4)
    )
    assert len(chunks) == 1
    assert chunks[0].total_size == 0


# --- env / secrets ---


def test_set_var_carries_the_kind():
    request = req.set_var(kind="secret", name="K", value="v", scope="all", org="acme")
    assert request.kind == "secret"
    assert request.scope == "all"
    assert request.org == "acme"


def test_unset_scope_and_org_become_empty_strings():
    request = req.set_var(kind="env", name="K", value="v", scope=None, org=None)
    assert request.scope == ""
    assert request.org == ""


def test_move_var_sets_the_reserved_from_field():
    # `from` is a Python keyword — it can only be reached with setattr.
    request = req.move_var(
        name="K", from_scope="private", to_scope="all", org="acme"
    )
    assert getattr(request, "from") == "private"
    assert request.to == "all"
    assert request.name == "K"


def test_set_var_domains_default_empty_and_forward():
    from boxd import _requests as req

    plain = req.set_var(kind="secret", name="T", value="v", scope=None, org=None)
    assert list(plain.domains) == []
    scoped = req.set_var(
        kind="secret",
        name="T",
        value="v",
        scope="all",
        org="acme",
        domains=["api.example.com"],
    )
    assert list(scoped.domains) == ["api.example.com"]


def test_label_selector_from_a_dict_or_a_list():
    assert req.label_selector(None) == []
    assert req.label_selector({"env": "prod", "team": ""}) == ["env=prod", "team="]
    assert req.label_selector(["env=prod", "gpu"]) == ["env=prod", "gpu"]
    assert req.label_selector("gpu") == ["gpu"]


def test_create_fork_and_restore_carry_labels():
    common = dict(name="a", isolated=False, config=None)
    create = req.create_vm(
        image=None, env=None, cmd=None, restart_policy=None, shared=False,
        networks=None, org=None, labels={"env": "prod"}, **common,
    )
    restore = req.create_vm_from_snapshot(
        snapshot="s", org=None, labels={"env": "x"}, **common
    )
    fork = req.fork_vm(
        source="alpha", shared=False, networks=None, labels={"run": "1"}, **common
    )
    assert dict(create.labels) == {"env": "prod"}
    assert dict(restore.labels) == {"env": "x"}
    assert dict(fork.labels) == {"run": "1"}


def test_update_vm_labels_request():
    request = req.update_vm_labels(
        machine_id="alpha", set={"a": "1"}, remove="b", replace_all=False
    )
    assert (request.vm, dict(request.set), list(request.remove)) == ("alpha", {"a": "1"}, ["b"])
    cleared = req.update_vm_labels(machine_id="alpha", set=None, remove=None, replace_all=True)
    assert dict(cleared.set) == {} and cleared.replace_all is True
