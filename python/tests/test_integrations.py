"""`integrations`: the coding agents' sign-ins, kept per organization. What
goes on the wire (`org`, never a machine), the Codex wait, and the old
`machines.agents.*_login` methods, which still work and warn."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from boxd import AgentLogin, AgentLoginResult, AgentLoginStart
from boxd import _mappers as m
from boxd._generated import api_pb2
from boxd.resources.integrations import AsyncIntegrations, Integrations
from boxd.resources.machines import Machines
from fakes import FakeAsyncTransport, FakeTransport

T0 = 1_794_800_000_000


def a_login(**overrides):
    fields = dict(
        harness="claude",
        signed_in=True,
        account="me@example.com",
        org_id="org-1",
        updated_at_ms=T0,
    )
    fields.update(overrides)
    return api_pb2.AgentLogin(**fields)


def pending(n):
    return [api_pb2.CompleteAgentLoginResponse(pending=True)] * n


def approved(**overrides):
    return api_pb2.CompleteAgentLoginResponse(login=a_login(**overrides))


def integrations(*responses):
    t = FakeTransport(list(responses))
    return Integrations(t), t


class FakeClock:
    """Stands in for `time` (and `asyncio.sleep`): sleeping moves it on."""

    def __init__(self):
        self.now = T0 / 1000
        self.slept: list[float] = []

    def time(self):
        return self.now

    def monotonic(self):
        return self.now

    def sleep(self, secs):
        self.slept.append(secs)
        self.now += secs

    async def async_sleep(self, secs):
        self.sleep(secs)


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    for module in ("boxd.resources.agents", "boxd.resources.integrations"):
        monkeypatch.setattr(f"{module}.time", c)
        monkeypatch.setattr(f"{module}.asyncio", SimpleNamespace(sleep=c.async_sleep))
    return c


def device_start(*, expires_in=900, interval=5):
    return m.agent_login_start(
        api_pb2.StartAgentLoginResponse(
            method=api_pb2.AGENT_LOGIN_METHOD_DEVICE_CODE,
            url="https://auth.example.com/device",
            user_code="ABCD-1234",
            handle="h-1",
            expires_at_ms=T0 + expires_in * 1000,
            interval_secs=interval,
        )
    )


def test_connect_names_the_org_and_never_a_machine():
    i, t = integrations(
        api_pb2.StartAgentLoginResponse(
            method=api_pb2.AGENT_LOGIN_METHOD_PASTE_CODE, url="https://claude.example.com/oauth"
        ),
        api_pb2.StartAgentLoginResponse(
            method=api_pb2.AGENT_LOGIN_METHOD_DEVICE_CODE,
            url="https://auth.example.com/device",
            user_code="ABCD-1234",
            handle="h-1",
        ),
    )
    claude = i.connect("claude")
    codex = i.connect("codex", org="acme")
    assert claude == AgentLoginStart(method="paste_code", url="https://claude.example.com/oauth")
    assert codex.method == "device_code" and codex.handle == "h-1"
    assert t.calls == [
        ("StartAgentLogin", api_pb2.StartAgentLoginRequest(harness="claude")),
        ("StartAgentLogin", api_pb2.StartAgentLoginRequest(harness="codex", org="acme")),
    ]


def test_complete_sends_the_code_or_the_handle():
    i, t = integrations(approved(), *pending(1))
    done = i.complete("claude", code="abc#state", org="acme")
    assert done == AgentLoginResult(pending=False, login=m.agent_login(a_login()))
    assert i.complete("codex", handle="h-1") == AgentLoginResult(pending=True, login=None)
    assert t.calls == [
        (
            "CompleteAgentLogin",
            api_pb2.CompleteAgentLoginRequest(harness="claude", org="acme", code="abc#state"),
        ),
        ("CompleteAgentLogin", api_pb2.CompleteAgentLoginRequest(harness="codex", handle="h-1")),
    ]


def test_wait_asks_with_the_handle_until_it_is_approved(clock):
    i, t = integrations(*pending(2), approved(harness="codex"))
    login = i.wait("codex", device_start(), org="acme")
    assert login == m.agent_login(a_login(harness="codex"))
    asked = (
        "CompleteAgentLogin",
        api_pb2.CompleteAgentLoginRequest(harness="codex", org="acme", handle="h-1"),
    )
    assert t.calls == [asked] * 3
    assert clock.slept == [5, 5]


def test_wait_says_to_connect_again_once_the_code_expires(clock):
    i, _ = integrations(*pending(10))
    with pytest.raises(TimeoutError, match=r"start again with connect\(\)"):
        i.wait("codex", device_start(expires_in=12))


def test_wait_refuses_a_paste_code_sign_in():
    i, t = integrations()
    start = AgentLoginStart(method="paste_code", url="https://claude.example.com/oauth")
    with pytest.raises(ValueError, match=r"complete\(code=\.\.\.\)"):
        i.wait("claude", start)
    assert t.calls == []


def test_get_and_disconnect():
    i, t = integrations(a_login(account=""), api_pb2.DeleteAgentLoginResponse())
    login = i.get("claude", org="acme")
    assert isinstance(login, AgentLogin)
    assert login.signed_in is True and login.account is None
    assert i.disconnect("codex") is None
    assert t.calls == [
        ("GetAgentLogin", api_pb2.GetAgentLoginRequest(harness="claude", org="acme")),
        ("DeleteAgentLogin", api_pb2.DeleteAgentLoginRequest(harness="codex")),
    ]


def test_the_async_twin_sends_the_same(clock):
    t = FakeAsyncTransport([*pending(1), approved(harness="codex"), a_login()])
    i = AsyncIntegrations(t)

    async def go():
        login = await i.wait("codex", device_start(), org="acme")
        status = await i.get("claude")
        return login, status

    login, status = asyncio.run(go())
    assert login.harness == "codex" and status.signed_in
    assert [c[0] for c in t.calls] == ["CompleteAgentLogin", "CompleteAgentLogin", "GetAgentLogin"]
    assert t.calls[0][1] == api_pb2.CompleteAgentLoginRequest(
        harness="codex", org="acme", handle="h-1"
    )


def test_the_machine_methods_still_work_and_say_where_they_moved():
    t = FakeTransport([a_login(), api_pb2.DeleteAgentLoginResponse()])
    agents = Machines(t).agents
    with pytest.warns(DeprecationWarning, match=r"integrations\.get"):
        assert agents.get_login("box", "codex").signed_in
    with pytest.warns(DeprecationWarning, match=r"integrations\.disconnect"):
        agents.logout("box", "claude-code")
    assert t.calls == [
        ("GetAgentLogin", api_pb2.GetAgentLoginRequest(vm_id="box", harness="codex")),
        ("DeleteAgentLogin", api_pb2.DeleteAgentLoginRequest(vm_id="box", harness="claude-code")),
    ]
