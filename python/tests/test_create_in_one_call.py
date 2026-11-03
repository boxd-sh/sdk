"""`create()` and `fork()` with a delete-after timer: the timer rides in the
create request and a server that knows it answers with the whole machine, so
the call is one round trip. A server from before the fields ignores them and
answers without `machine`; the SDK then sets the timer and reads the machine
back itself, as it always did (tests/test_namespaces.py covers that path)."""

from __future__ import annotations

import pytest

from boxd._generated import api_pb2
from boxd.resources.machines import AsyncMachines, Machines

from fakes import FakeAsyncTransport, FakeTransport

DEADLINE = 1_893_520_800_000  # 2030-01-01T18:00:00Z


def a_machine(**kw) -> api_pb2.GetVmResponse:
    return api_pb2.GetVmResponse(vm_id="vm-1", name="alpha", status="running", **kw)


def test_create_with_a_timer_is_one_call_when_the_answer_has_the_machine():
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(
                vm_id="vm-1", name="alpha", machine=a_machine(delete_at_ms=DEADLINE)
            )
        ]
    )
    machine = Machines(transport).create("alpha", delete_after=3600)
    assert [c[0] for c in transport.calls] == ["CreateVm"]
    sent = transport.calls[0][1]
    assert sent.HasField("delete_after_secs") and sent.delete_after_secs == 3600
    assert not sent.HasField("delete_after_cron")
    assert machine.delete_at is not None
    assert int(machine.delete_at.timestamp() * 1000) == DEADLINE


def test_a_restore_with_a_cron_timer_is_one_call():
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(
                vm_id="vm-1",
                name="alpha",
                machine=a_machine(delete_at_ms=DEADLINE, delete_after_cron="0 18 * * *"),
            )
        ]
    )
    machine = Machines(transport).create(
        "alpha", from_snapshot="base", delete_after_cron="0 18 * * *"
    )
    assert [c[0] for c in transport.calls] == ["CreateVmFromSnapshot"]
    assert transport.calls[0][1].delete_after_cron == "0 18 * * *"
    assert machine.delete_after_cron == "0 18 * * *"


def test_a_machine_that_does_not_show_the_timer_gets_it_set_again():
    transport = FakeTransport(
        [
            api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", machine=a_machine()),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=DEADLINE),
            a_machine(delete_at_ms=DEADLINE),
        ]
    )
    Machines(transport).create("alpha", delete_after=3600)
    assert [c[0] for c in transport.calls] == ["CreateVm", "SetDeleteAfter", "GetVm"]


def test_both_a_duration_and_a_cron_are_refused_before_anything_is_sent():
    transport = FakeTransport([])
    with pytest.raises(ValueError, match="not both"):
        Machines(transport).create(
            "alpha", delete_after=60, delete_after_cron="0 18 * * *"
        )
    assert transport.calls == []


def test_a_plain_create_sends_no_timer_and_takes_the_machine_it_gets_back():
    transport = FakeTransport(
        [api_pb2.CreateVmResponse(vm_id="vm-1", name="alpha", machine=a_machine())]
    )
    machine = Machines(transport).create("alpha")
    assert [c[0] for c in transport.calls] == ["CreateVm"]
    sent = transport.calls[0][1]
    assert not sent.HasField("delete_after_secs")
    assert not sent.HasField("delete_after_cron")
    assert machine.delete_at is None


def test_a_fork_keeps_its_sources_timer_unless_it_names_one():
    transport = FakeTransport(
        [
            api_pb2.ForkVmResponse(
                vm_id="vm-2", name="beta", machine=a_machine(delete_at_ms=DEADLINE)
            ),
            api_pb2.ForkVmResponse(vm_id="vm-3", name="gamma", machine=a_machine()),
        ]
    )
    machines = Machines(transport)
    inherited = machines.fork("alpha", "beta")
    assert not transport.calls[0][1].HasField("delete_after_secs")
    assert inherited.delete_at is not None
    dropped = machines.fork("alpha", "gamma", delete_after=0)
    sent = transport.calls[1][1]
    assert sent.HasField("delete_after_secs") and sent.delete_after_secs == 0
    assert dropped.delete_at is None
    assert [c[0] for c in transport.calls] == ["ForkVm", "ForkVm"]


async def test_async_create_and_fork_are_one_call_each():
    transport = FakeAsyncTransport(
        [
            api_pb2.CreateVmResponse(
                vm_id="vm-1", name="alpha", machine=a_machine(delete_at_ms=DEADLINE)
            ),
            api_pb2.ForkVmResponse(vm_id="vm-2", name="beta", machine=a_machine()),
            # A server from before the fields: no machine in the answer.
            api_pb2.ForkVmResponse(vm_id="vm-3", name="gamma"),
            api_pb2.SetDeleteAfterResponse(delete_at_ms=DEADLINE),
            a_machine(delete_at_ms=DEADLINE),
        ]
    )
    machines = AsyncMachines(transport)
    created = await machines.create("alpha", delete_after=90)
    assert created.delete_at is not None
    await machines.fork("alpha", "beta", delete_after=0)
    await machines.fork("alpha", "gamma", delete_after=60)
    assert [c[0] for c in transport.calls] == [
        "CreateVm",
        "ForkVm",
        "ForkVm",
        "SetDeleteAfter",
        "GetVm",
    ]
    assert transport.calls[3][1].delete_after_secs == 60
