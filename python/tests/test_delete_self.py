"""`machines.delete_self()` against a stand-in metadata adapter."""

from __future__ import annotations

import http.server
import json
import threading

import pytest

from boxd.errors import AuthenticationError, BoxdError
from boxd.resources import machines as machines_mod
from boxd.resources.machines import AsyncMachines, Machines
from fakes import FakeAsyncTransport, FakeTransport


@pytest.fixture
def adapter(monkeypatch):
    """A local HTTP server playing the metadata adapter for a machine named job-7."""
    seen: list[dict] = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append({"path": self.path, "body": body})
            if body.get("confirm_name") == "job-7":
                out, code = {"name": "job-7", "vm_id": "vm-7", "status": "destroying", "destroy_in_secs": 2}, 200
            else:
                out, code = {"error": f"self-deletion refused: confirm_name '{body.get('confirm_name')}' is not this machine ('job-7')"}, 400
            data = json.dumps(out).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setattr(machines_mod._creds, "metadata_base", lambda *a: base)

    async def base_async(*a):
        return base

    monkeypatch.setattr(machines_mod._creds, "metadata_base_async", base_async)
    yield seen
    srv.shutdown()


def test_delete_self_posts_the_confirmation_and_returns_before_teardown(adapter):
    r = Machines(FakeTransport()).delete_self(confirm="job-7")
    assert (r.id, r.name, r.deletes_in_secs) == ("vm-7", "job-7", 2)
    assert adapter == [{"path": "/v1/self/destroy", "body": {"confirm_name": "job-7"}}]


def test_delete_self_raises_the_servers_refusal(adapter):
    with pytest.raises(BoxdError, match="is not this machine"):
        Machines(FakeTransport()).delete_self(confirm="other-vm")


def test_delete_self_needs_a_name_before_any_request(adapter):
    for blank in ["", "   "]:
        with pytest.raises(ValueError, match="needs this machine's name"):
            Machines(FakeTransport()).delete_self(confirm=blank)
    assert adapter == []


def test_delete_self_outside_a_machine_says_where_it_works(monkeypatch):
    # No in-VM hints in the (cleaned) environment: refused before any I/O.
    with pytest.raises(AuthenticationError, match="only works inside a boxd machine"):
        Machines(FakeTransport()).delete_self(confirm="job-7")


async def test_async_delete_self(adapter):
    r = await AsyncMachines(FakeAsyncTransport()).delete_self(confirm="job-7")
    assert r.deletes_in_secs == 2
    with pytest.raises(BoxdError, match="is not this machine"):
        await AsyncMachines(FakeAsyncTransport()).delete_self(confirm="nope")


def test_delete_self_on_a_machine_without_an_adapter_says_so(monkeypatch):
    monkeypatch.setenv("BOXD_VM_ID", "vm-7")
    monkeypatch.setattr(machines_mod._creds, "detect_gateway", lambda: "10.42.0.1")
    monkeypatch.setattr(machines_mod._creds, "probe", lambda *a, **k: False)
    with pytest.raises(AuthenticationError, match="did not answer") as info:
        Machines(FakeTransport()).delete_self(confirm="job-7")
    assert "http://10.42.0.1:9002" in info.value.message
    assert info.value.reason == "missing_credentials"
