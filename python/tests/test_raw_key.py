"""An API key sent as the bearer itself, with no exchange first, and the
fallback to the exchange when a server refuses it as one from before raw keys
does ("invalid token: ...")."""

from __future__ import annotations

import time

import grpc
import pytest

from boxd._credentials import AsyncCredentials, SyncCredentials
from boxd._generated import api_pb2
from boxd._transport import AsyncTransport, SyncTransport, _refuses_raw_key
from boxd._urls import is_loopback_target, raw_key_allowed
from boxd.errors import APIConnectionError, AuthenticationError
from fakes import FakeMulticallable, FakeRpcError, FakeStub

KEY = "bxd_test-key"
JWT = "jwt-1"
EXCHANGE = "https://app.example.com/api/v1/auth/token"
OLD_REFUSAL = "invalid token: InvalidToken"
REQUEST = api_pb2.GetVmRequest(vm_id="vm-1")


def old_refusal():
    return FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, OLD_REFUSAL)


def bearers(method: FakeMulticallable) -> list[str]:
    return [dict(md)["authorization"] for md in method.metadata_seen]


class Exchanges:
    """Stands in for the console's exchange: counts, hands out `JWT`."""

    def __init__(self):
        self.count = 0

    def sync(self, creds):
        def exchange():
            self.count += 1
            creds._cached, creds._expires_at = JWT, time.time() + 3600

        return exchange

    def aio(self, creds):
        async def exchange():
            self.count += 1
            creds._cached, creds._expires_at = JWT, time.time() + 3600

        return exchange


def sync_transport(
    stub_methods, *, base_url="http://127.0.0.1:9443", max_retries=0, derived=False
):
    creds = SyncCredentials(api_key=KEY, token=None, exchange_url=EXCHANGE)
    exchanges = Exchanges()
    creds._exchange = exchanges.sync(creds)
    t = SyncTransport(
        base_url=base_url,
        credentials=creds,
        timeout=1.0,
        max_retries=max_retries,
        derived=derived,
    )
    t._stub = FakeStub(**stub_methods)
    return t, exchanges


# --- the pieces ---


def test_a_key_goes_as_itself_over_tls_or_loopback_only():
    creds = SyncCredentials(api_key=KEY, token=None, exchange_url=EXCHANGE)
    assert creds.raw_key(allowed=True) == KEY
    assert creds.raw_key(allowed=False) is None
    creds.raw_key_refused()
    assert creds.raw_key(allowed=True) is None


def test_a_token_is_never_replaced_by_the_key(monkeypatch):
    monkeypatch.setenv("BOXD_API_KEY", KEY)
    creds = SyncCredentials(api_key=None, token="fixed", exchange_url=EXCHANGE)
    assert creds.raw_key(allowed=True) is None
    # The environment's key is a key like an explicit one.
    creds = SyncCredentials(api_key=None, token=None, exchange_url=EXCHANGE)
    assert creds.raw_key(allowed=True) == KEY


def test_loopback_and_tls_endpoints():
    assert is_loopback_target("localhost:9443")
    assert is_loopback_target("127.0.0.1:9443")
    assert is_loopback_target("[::1]:9443")
    assert not is_loopback_target("192.0.2.1:9443")
    assert not is_loopback_target("localhost.example.com:9443")
    assert raw_key_allowed("https://api.example.com:9443")
    assert raw_key_allowed("api.example.com:9443")
    assert raw_key_allowed("http://127.0.0.1:9443")
    assert not raw_key_allowed("http://api.example.com:9443")


def test_only_an_old_servers_answer_or_the_plaintext_one_means_exchange():
    unauth = grpc.StatusCode.UNAUTHENTICATED
    assert _refuses_raw_key(FakeRpcError(unauth, OLD_REFUSAL))
    assert _refuses_raw_key(FakeRpcError(unauth, "API keys are accepted over TLS only: ..."))
    assert not _refuses_raw_key(FakeRpcError(unauth, "API key not recognized"))
    assert not _refuses_raw_key(FakeRpcError(unauth, "API key expired"))
    assert not _refuses_raw_key(FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, OLD_REFUSAL))


# --- sync transport ---


def test_a_server_that_takes_keys_gets_the_key_and_no_exchange_happens():
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    get_vm = FakeMulticallable([response, response])
    t, exchanges = sync_transport({"GetVm": get_vm})
    assert t.call("GetVm", REQUEST) is response
    assert t.call("GetVm", REQUEST) is response
    assert bearers(get_vm) == [f"Bearer {KEY}"] * 2
    assert exchanges.count == 0


def test_an_old_servers_refusal_falls_back_to_the_exchange_for_good():
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    get_vm = FakeMulticallable([old_refusal(), response, response])
    t, exchanges = sync_transport({"GetVm": get_vm})
    assert t.call("GetVm", REQUEST) is response
    assert t.call("GetVm", REQUEST) is response
    assert bearers(get_vm) == [f"Bearer {KEY}", f"Bearer {JWT}", f"Bearer {JWT}"]
    assert exchanges.count == 1


def test_a_regions_derived_name_raises_an_old_servers_refusal():
    # The router asks home instead; every endpoint exchanges from now on.
    get_vm = FakeMulticallable([old_refusal(), api_pb2.GetVmResponse()])
    t, exchanges = sync_transport({"GetVm": get_vm}, derived=True)
    with pytest.raises(AuthenticationError, match="invalid token"):
        t.call("GetVm", REQUEST)
    assert bearers(get_vm) == [f"Bearer {KEY}"]
    assert exchanges.count == 0
    assert t._credentials.raw_key(allowed=True) is None


def test_a_regions_derived_name_is_tried_once(monkeypatch):
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _: None)
    unavailable = FakeRpcError(grpc.StatusCode.UNAVAILABLE, "DNS resolution failed")
    get_vm = FakeMulticallable([unavailable, api_pb2.GetVmResponse()])
    t, _ = sync_transport({"GetVm": get_vm}, max_retries=2, derived=True)
    with pytest.raises(APIConnectionError):
        t.call("GetVm", REQUEST)
    assert get_vm.attempts == 1


def test_plaintext_to_another_host_exchanges_first():
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    get_vm = FakeMulticallable([response])
    t, exchanges = sync_transport({"GetVm": get_vm}, base_url="http://api.example.com:9443")
    t.call("GetVm", REQUEST)
    assert bearers(get_vm) == [f"Bearer {JWT}"]
    assert exchanges.count == 1


def test_a_key_the_server_does_not_know_is_refused_not_exchanged():
    get_vm = FakeMulticallable(
        [FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "API key not recognized")]
    )
    t, exchanges = sync_transport({"GetVm": get_vm})
    with pytest.raises(AuthenticationError):
        t.call("GetVm", REQUEST)
    assert exchanges.count == 0


def test_a_stream_first_asks_whoami_and_is_never_refused():
    whoami = FakeMulticallable([old_refusal(), api_pb2.WhoamiResponse(user_id="alice")])
    fs_list = FakeMulticallable([iter([api_pb2.FsListChunk()])])
    t, exchanges = sync_transport({"Whoami": whoami, "FsList": fs_list})
    assert len(list(t.server_stream("FsList", api_pb2.FsListRequest(vm_id="m1")))) == 1
    assert bearers(whoami) == [f"Bearer {KEY}", f"Bearer {JWT}"]
    assert bearers(fs_list) == [f"Bearer {JWT}"]
    assert exchanges.count == 1


def test_a_stream_first_on_a_server_that_takes_keys_asks_once():
    whoami = FakeMulticallable([api_pb2.WhoamiResponse(user_id="alice")])
    fs_list = FakeMulticallable([iter([]), iter([])])
    t, exchanges = sync_transport({"Whoami": whoami, "FsList": fs_list})
    list(t.server_stream("FsList", api_pb2.FsListRequest(vm_id="m1")))
    list(t.server_stream("FsList", api_pb2.FsListRequest(vm_id="m1")))
    assert whoami.attempts == 1
    assert bearers(fs_list) == [f"Bearer {KEY}"] * 2
    assert exchanges.count == 0


def test_a_streamed_request_is_settled_before_it_is_sent():
    whoami = FakeMulticallable([old_refusal(), api_pb2.WhoamiResponse(user_id="alice")])
    upload = FakeMulticallable([api_pb2.UploadFileResponse(bytes_written=1)])
    t, _ = sync_transport({"Whoami": whoami, "UploadFileStream": upload})
    t.call("UploadFileStream", iter([api_pb2.UploadFileChunk()]))
    assert bearers(upload) == [f"Bearer {JWT}"]


# --- async transport ---


class AioCall:
    def __init__(self, outcome):
        self._outcome = outcome

    def __await__(self):
        async def run():
            if isinstance(self._outcome, BaseException):
                raise self._outcome
            return self._outcome

        return run().__await__()

    async def initial_metadata(self):
        return []


class AioMethod:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.metadata_seen: list = []

    def __call__(self, request, timeout=None, metadata=None):
        self.metadata_seen.append(list(metadata or []))
        return AioCall(self.outcomes.pop(0) if self.outcomes else None)


class AioRefusal(grpc.aio.AioRpcError):
    def __init__(self, details):
        super().__init__(
            code=grpc.StatusCode.UNAUTHENTICATED,
            initial_metadata=grpc.aio.Metadata(),
            trailing_metadata=grpc.aio.Metadata(),
            details=details,
        )


async def test_async_an_old_servers_refusal_falls_back_to_the_exchange():
    creds = AsyncCredentials(api_key=KEY, token=None, exchange_url=EXCHANGE)
    exchanges = Exchanges()
    creds._exchange = exchanges.aio(creds)
    t = AsyncTransport(
        base_url="https://api.example.com:9443", credentials=creds, timeout=1.0, max_retries=0
    )
    response = api_pb2.GetVmResponse(vm_id="vm-1")
    get_vm = AioMethod([AioRefusal(OLD_REFUSAL), response, response])
    t._stub = FakeStub(GetVm=get_vm)
    assert await t.call("GetVm", REQUEST) is response
    assert await t.call("GetVm", REQUEST) is response
    assert bearers(get_vm) == [f"Bearer {KEY}", f"Bearer {JWT}", f"Bearer {JWT}"]
    assert exchanges.count == 1


async def test_async_a_regions_derived_name_raises_an_old_servers_refusal():
    creds = AsyncCredentials(api_key=KEY, token=None, exchange_url=EXCHANGE)
    exchanges = Exchanges()
    creds._exchange = exchanges.aio(creds)
    t = AsyncTransport(
        base_url="https://nyc.example.com:9443",
        credentials=creds,
        timeout=1.0,
        max_retries=2,
        derived=True,
    )
    get_vm = AioMethod([AioRefusal(OLD_REFUSAL), api_pb2.GetVmResponse()])
    t._stub = FakeStub(GetVm=get_vm)
    with pytest.raises(AuthenticationError, match="invalid token"):
        await t.call("GetVm", REQUEST)
    assert bearers(get_vm) == [f"Bearer {KEY}"]
    assert exchanges.count == 0


async def test_async_a_server_that_takes_keys_gets_the_key():
    creds = AsyncCredentials(api_key=KEY, token=None, exchange_url=EXCHANGE)
    exchanges = Exchanges()
    creds._exchange = exchanges.aio(creds)
    t = AsyncTransport(
        base_url="https://api.example.com:9443", credentials=creds, timeout=1.0, max_retries=0
    )
    whoami = AioMethod([api_pb2.WhoamiResponse(user_id="alice")])

    def fs_list(request, timeout=None, metadata=None):
        fs_list.seen.append(dict(metadata)["authorization"])

        async def gen():
            yield api_pb2.FsListChunk()

        return gen()

    fs_list.seen = []
    t._stub = FakeStub(Whoami=whoami, FsList=fs_list)
    stream = await t.server_stream("FsList", api_pb2.FsListRequest(vm_id="m1"))
    assert [c async for c in stream] == [api_pb2.FsListChunk()]
    assert bearers(whoami) == [f"Bearer {KEY}"]
    assert fs_list.seen == [f"Bearer {KEY}"]
    assert exchanges.count == 0
