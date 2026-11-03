"""Regions: which endpoint each call goes to, the endpoint cache, `list(region=
"all")`, and the hint a not-found carries when the name is in another region.

The router is driven over fake endpoints (one per base URL), so this pins what
would be sent where without a cluster.
"""

from __future__ import annotations

import grpc
import pytest

from boxd import AsyncBoxd, Boxd
from boxd._credentials import AsyncCredentials, SyncCredentials
from boxd._generated import api_pb2
from boxd._regions import AsyncRouter, SyncRouter, resolve_region
from boxd._urls import console_base_url
from boxd.errors import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    MachineFileNotFoundError,
    NotFoundError,
    RegionNotEnabledError,
)
from boxd.models import RegionCount, RegionalList
from boxd.resources.disks import Disks
from boxd.resources.machines import AsyncMachines, Machines
from boxd.resources.orgs import Orgs
from boxd.resources.regions import Regions
from boxd.resources.snapshots import Snapshots
from fakes import FakeTransport

HOME = "https://boxd.example.com:9443"
NYC = "https://nyc.boxd.example.com:9443"
LON = "https://lon.boxd.example.com:9443"
SEA = "https://sea.boxd.example.com:9443"


def listing(*, nyc="enabled", lon="available", this="fra", extra=()):
    return api_pb2.ListRegionsResponse(
        regions=[
            api_pb2.Region(
                id="fra",
                name="Frankfurt",
                api_endpoint=HOME,
                console_endpoint="https://app.boxd.example.com",
                home=True,
                org_state="enabled",
            ),
            api_pb2.Region(
                id="nyc",
                name="New York",
                api_endpoint=NYC,
                console_endpoint="https://app.nyc.boxd.example.com",
                org_state=nyc,
            ),
            api_pb2.Region(id="lon", name="London", api_endpoint=LON, org_state=lon),
            *extra,
        ],
        org_id="org-1",
        this_region=this,
    )


def vm(name="alpha", region=""):
    return api_pb2.GetVmResponse(vm_id=f"vm-{name}", name=name, region=region)


class Endpoint:
    """A fake transport for one base URL. `answers` maps a method to a
    response, an exception to raise, a callable of the request, or a list of
    those (one per call, the last one repeating)."""

    def __init__(self, url, answers=None):
        self.url = url
        self.answers = dict(answers or {})
        self.calls: list[tuple[str, object]] = []
        self.closed = False

    @property
    def base_url(self):
        return self.url

    @property
    def console_origin(self):
        return console_base_url(self.url)

    def methods(self):
        return [method for method, _ in self.calls]

    def _answer(self, method, request):
        self.calls.append((method, request))
        answer = self.answers.get(method)
        if isinstance(answer, list):
            answer = answer.pop(0) if len(answer) > 1 else answer[0]
        if callable(answer) and not isinstance(answer, type):
            answer = answer(request)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def call(self, method, request):
        return self._answer(method, request)

    def server_stream(self, method, request):
        return self._iterate(method, request)

    def bidi(self, method, requests, *, timeout=None):
        return self._iterate(method, list(requests))

    def _iterate(self, method, request):
        answer = self._answer(method, request)
        yield from answer or []

    def close(self):
        self.closed = True


class AsyncEndpoint(Endpoint):
    async def call(self, method, request):
        return self._answer(method, request)

    async def server_stream(self, method, request):
        return self._aiterate(method, request)

    async def bidi(self, method, requests, *, timeout=None):
        return self._aiterate(method, [r async for r in requests])

    async def _aiterate(self, method, request):
        for item in self._answer(method, request) or []:
            yield item

    async def close(self):
        self.closed = True


def make(home_answers=None, regions=None, *, region=None, kind=Endpoint):
    """A router over fake endpoints. `regions` maps an endpoint URL to its
    answers; `made` collects the endpoints the router dialled."""
    home = kind(HOME, home_answers)
    made: dict[str, Endpoint] = {}

    def connect(url):
        made[url] = kind(url, (regions or {}).get(url))
        return made[url]

    router_cls = AsyncRouter if kind is AsyncEndpoint else SyncRouter
    return router_cls(home, region=region, connect=connect), home, made


# --- where a call goes ---


def test_no_region_goes_home_without_asking_for_regions():
    router, home, made = make({"GetVm": vm()})
    Machines(router).get("alpha")
    assert home.methods() == ["GetVm"]
    assert made == {}


def test_the_client_region_routes_machine_calls_there():
    router, home, made = make(
        {"ListRegions": listing()}, {NYC: {"GetVm": vm(region="nyc")}}, region="nyc"
    )
    machine = Machines(router).get("alpha")
    assert machine.region == "nyc"
    assert made[NYC].methods() == ["GetVm"]
    assert home.methods() == ["ListRegions"]
    # The desktop link is on that region's console.
    assert (
        machine.access.desktop_url == "https://app.nyc.boxd.example.com/desktop/alpha"
    )


def test_the_endpoint_is_cached_for_the_client():
    router, home, made = make(
        {"ListRegions": listing()},
        {NYC: {"GetVm": vm(), "StartVm": None}},
        region="nyc",
    )
    machines = Machines(router)
    machines.get("alpha")
    machines.start("alpha")
    machines.get("alpha")
    assert home.methods() == ["ListRegions"]
    assert made[NYC].methods() == ["GetVm", "StartVm", "GetVm"]


def test_a_call_region_overrides_the_client_region():
    router, home, made = make(
        {"ListRegions": listing(lon="enabled")},
        {NYC: {"GetVm": vm()}, LON: {"GetVm": vm()}},
        region="nyc",
    )
    Machines(router).get("alpha", region="lon")
    assert list(made) == [LON]


def test_naming_the_region_home_serves_uses_the_home_connection():
    router, home, made = make({"ListRegions": listing(), "GetVm": vm()})
    Machines(router).get("alpha", region="FRA ")
    assert home.methods() == ["ListRegions", "GetVm"]
    assert made == {}


def test_account_and_org_calls_always_go_home():
    router, home, made = make(
        {
            "Whoami": api_pb2.WhoamiResponse(),
            "GetOrgMachineDefaults": api_pb2.GetOrgMachineDefaultsResponse(),
        },
        region="nyc",
    )
    router.call("Whoami", api_pb2.WhoamiRequest(), region="nyc")
    Orgs(router).get_default_region()
    assert home.methods() == ["Whoami", "GetOrgMachineDefaults"]
    assert made == {}


def test_region_comes_from_the_argument_then_the_environment(monkeypatch):
    assert resolve_region(None) is None
    monkeypatch.setenv("BOXD_REGION", "nyc")
    assert resolve_region(None) == "nyc"
    assert resolve_region("lon") == "lon"
    assert Boxd(token="t").region == "nyc"
    assert AsyncBoxd(token="t", region="LON").region == "lon"


def test_a_client_cannot_be_set_to_all_regions():
    with pytest.raises(ValueError, match="list"):
        Boxd(token="t", region="all")


def test_all_is_refused_outside_list():
    router, _, _ = make({"ListRegions": listing()})
    with pytest.raises(ValueError, match="list"):
        Machines(router).get("alpha", region="all")


def test_every_region_shares_the_client_credential():
    boxd = Boxd(token="t", base_url=HOME, region="nyc")
    router = boxd._transport
    nyc = router._connect(NYC)
    assert nyc._credentials is router._home._credentials
    assert nyc.base_url == NYC
    assert boxd.base_url == HOME


# --- unknown and not-enabled regions ---


def test_an_unknown_region_is_asked_for_again_once():
    sea = api_pb2.Region(id="sea", api_endpoint=SEA, org_state="enabled")
    router, home, made = make(
        {"ListRegions": [listing(), listing(), listing(extra=[sea])]},
        {NYC: {"GetVm": vm()}, SEA: {"GetVm": vm()}},
    )
    machines = Machines(router)
    machines.get("alpha", region="nyc")
    with pytest.raises(NotFoundError, match='no region "sea"') as e:
        machines.get("alpha", region="sea")
    assert e.value.reason == "unknown_region"
    assert home.methods() == ["ListRegions", "ListRegions"]
    # A region added since is found by the next refresh.
    machines.get("alpha", region="sea")
    assert home.methods() == ["ListRegions", "ListRegions", "ListRegions"]


def test_a_region_the_org_has_not_enabled_says_how_to_ask_for_it():
    router, home, made = make({"ListRegions": listing(nyc="available")})
    with pytest.raises(RegionNotEnabledError) as e:
        Machines(router).create("alpha", region="nyc")
    assert 'orgs.request_region("nyc")' in str(e.value)
    assert e.value.org_state == "available"
    assert e.value.code == "permission_denied"
    assert made == {}


def test_a_requested_region_says_it_waits_for_boxd():
    router, _, _ = make({"ListRegions": listing(nyc="requested")})
    with pytest.raises(RegionNotEnabledError, match="request_region") as e:
        Machines(router).list(region="nyc")
    assert e.value.org_state == "requested"


def test_a_region_enabled_since_is_picked_up():
    router, home, made = make(
        {"ListRegions": [listing(nyc="requested"), listing(nyc="enabled")]},
        {NYC: {"ListVms": api_pb2.ListVmsResponse()}},
    )
    Regions(router).list()  # the cache says: requested
    Machines(router).list(region="nyc")  # asked again once: enabled now
    assert home.methods() == ["ListRegions", "ListRegions"]
    assert made[NYC].methods() == ["ListVms"]


def test_the_org_check_uses_the_org_the_call_names():
    router, home, made = make(
        {
            "ListRegions": lambda r: listing(
                nyc="enabled" if r.org_id == "acme" else "available"
            ),
        },
        {NYC: {"ListVms": api_pb2.ListVmsResponse()}},
    )
    Machines(router).list(org="acme", region="nyc")
    assert home.calls[0][1].org_id == "acme"
    with pytest.raises(RegionNotEnabledError):
        Machines(router).list(region="nyc")


def test_a_call_on_a_machine_by_name_is_not_org_checked():
    router, _, made = make(
        {"ListRegions": listing(nyc="available")}, {NYC: {"GetVm": vm()}}
    )
    Machines(router).get("alpha", region="nyc")
    assert made[NYC].methods() == ["GetVm"]


def test_regions_list_refreshes_the_cache():
    router, home, made = make({"ListRegions": listing()}, {NYC: {"GetVm": vm()}})
    regions = Regions(router).list()
    assert [r.id for r in regions] == ["fra", "nyc", "lon"]
    assert regions[0].home and regions[1].org_state == "enabled"
    Machines(router).get("alpha", region="nyc")
    assert home.methods() == ["ListRegions"]


# --- list(region="all") and elsewhere ---


def test_list_all_merges_every_enabled_region():
    router, home, made = make(
        {
            "ListRegions": listing(),
            "ListVms": api_pb2.ListVmsResponse(vms=[vm("a", "fra")]),
        },
        {NYC: {"ListVms": api_pb2.ListVmsResponse(vms=[vm("b", "nyc"), vm("c")])}},
    )
    machines = Machines(router).list(region="all")
    assert [(m.name, m.region) for m in machines] == [
        ("a", "fra"),
        ("b", "nyc"),
        ("c", "nyc"),  # a server that doesn't say: where it was listed
    ]
    assert machines.unavailable == []
    assert LON not in made  # not enabled for the org
    assert not home.calls[-1][1].with_elsewhere
    assert machines[1].access.desktop_url.startswith(
        "https://app.nyc.boxd.example.com/"
    )


def test_list_all_names_a_region_it_could_not_reach():
    router, _, _ = make(
        {"ListRegions": listing(), "ListVms": api_pb2.ListVmsResponse(vms=[vm("a")])},
        {NYC: {"ListVms": APIConnectionError("down")}},
    )
    machines = Machines(router).list(region="all")
    assert [m.name for m in machines] == ["a"]
    assert machines.unavailable == ["nyc"]


def test_list_all_outside_a_federation_is_the_home_list():
    router, home, _ = make(
        {
            "ListRegions": api_pb2.ListRegionsResponse(),
            "ListVms": api_pb2.ListVmsResponse(vms=[vm("a")]),
        }
    )
    machines = Machines(router).list(region="all")
    assert [(m.name, m.region) for m in machines] == [("a", None)]
    assert home.methods() == ["ListRegions", "ListVms"]


def test_a_plain_list_asks_for_the_counts_elsewhere():
    transport = FakeTransport(
        [
            api_pb2.ListVmsResponse(
                vms=[vm("a", "fra")],
                elsewhere=[api_pb2.RegionCount(region="nyc", count=2)],
            )
        ]
    )
    machines = Machines(transport).list()
    assert transport.calls[0][1].with_elsewhere
    assert isinstance(machines, RegionalList) and isinstance(machines, list)
    assert machines.elsewhere == [RegionCount(region="nyc", count=2)]
    assert machines[0].region == "fra"


def test_snapshots_and_disks_lists_carry_elsewhere_and_all():
    transport = FakeTransport(
        [
            api_pb2.ListSnapshotsResponse(
                snapshots=[api_pb2.SnapshotInfo(name="s", region="fra")],
                elsewhere=[api_pb2.RegionCount(region="nyc", count=1)],
            ),
            api_pb2.ListDisksResponse(
                disks=[api_pb2.DiskInfo(name="d", region="fra")],
                elsewhere=[api_pb2.RegionCount(region="lon", count=3)],
            ),
        ]
    )
    snaps = Snapshots(transport).list(region="nyc")
    disks = Disks(transport).list()
    assert transport.regions == ["nyc", None]
    assert [c[1].with_elsewhere for c in transport.calls] == [True, True]
    assert snaps[0].region == "fra" and snaps.elsewhere[0].region == "nyc"
    assert disks[0].region == "fra" and disks.elsewhere[0].count == 3

    router, _, _ = make(
        {
            "ListRegions": listing(),
            "ListSnapshots": api_pb2.ListSnapshotsResponse(
                snapshots=[api_pb2.SnapshotInfo(name="s1")]
            ),
        },
        {
            NYC: {
                "ListSnapshots": api_pb2.ListSnapshotsResponse(
                    snapshots=[api_pb2.SnapshotInfo(name="s2")]
                )
            }
        },
    )
    every = Snapshots(router).list(region="all")
    assert [(s.name, s.region) for s in every] == [("s1", "fra"), ("s2", "nyc")]


# --- a call that names no org ---


def created(name="a"):
    return api_pb2.CreateVmResponse(vm_id=f"vm-{name}", name=name)


def test_a_region_other_than_home_is_sent_the_org_home_resolved():
    router, home, made = make(
        {"ListRegions": listing(), "ListVms": api_pb2.ListVmsResponse()},
        {
            NYC: {
                "CreateVm": created(),
                "GetVm": vm("a", "nyc"),
                "ListVms": api_pb2.ListVmsResponse(),
            }
        },
    )
    machines = Machines(router)
    machines.create("a", region="nyc")
    machines.list(region="nyc")
    machines.list(region="all")
    machines.list(org="acme", region="nyc")  # an org the caller set is kept
    assert [(m, getattr(r, "org", None)) for m, r in made[NYC].calls] == [
        ("CreateVm", "org-1"),
        ("GetVm", None),
        ("ListVms", "org-1"),
        ("ListVms", "org-1"),
        ("ListVms", "acme"),
    ]
    # Home resolves "" itself, in "all" too.
    assert [r.org for m, r in home.calls if m == "ListVms"] == [""]


def test_home_is_sent_the_empty_org_as_it_is():
    router, home, made = make(
        {
            "ListRegions": listing(),
            "CreateVm": created(),
            "GetVm": vm("a", "fra"),
            "ListVms": api_pb2.ListVmsResponse(),
        }
    )
    machines = Machines(router)
    machines.create("a", region="fra")
    machines.list(region="fra")
    assert [(m, getattr(r, "org", None)) for m, r in home.calls] == [
        ("ListRegions", None),
        ("CreateVm", ""),
        ("GetVm", None),
        ("ListVms", ""),
    ]
    assert made == {}


def test_an_answer_that_names_no_org_leaves_it_empty():
    old = listing()
    old.org_id = ""
    router, _, made = make(
        {"ListRegions": old}, {NYC: {"ListVms": api_pb2.ListVmsResponse()}}
    )
    Machines(router).list(region="nyc")
    assert made[NYC].calls[0][1].org == ""


async def test_async_a_region_other_than_home_is_sent_the_org_home_resolved():
    router, home, made = make(
        {"ListRegions": listing(), "ListVms": api_pb2.ListVmsResponse()},
        {NYC: {"ListVms": api_pb2.ListVmsResponse()}},
        kind=AsyncEndpoint,
    )
    machines = AsyncMachines(router)
    await machines.list(region="nyc")
    await machines.list(region="all")
    assert [r.org for _, r in made[NYC].calls] == ["org-1", "org-1"]
    assert [r.org for m, r in home.calls if m == "ListVms"] == [""]


# --- not found here, found elsewhere ---


def elsewhere(*, exact=(), close=()):
    item = lambda region, name: api_pb2.ElsewhereItem(  # noqa: E731
        region=region, name=name, org_id="org-1", id=f"id-{name}"
    )
    return api_pb2.FindElsewhereResponse(
        exact=[item(*e) for e in exact], close=[item(*c) for c in close]
    )


def test_a_not_found_says_where_the_name_is():
    router, home, _ = make(
        {
            "GetVm": NotFoundError("machine not found: foo", code="not_found"),
            "FindElsewhere": elsewhere(exact=[("nyc", "foo")]),
        }
    )
    with pytest.raises(NotFoundError) as e:
        Machines(router).get("foo")
    err = e.value
    assert 'there is a machine "foo" in nyc: pass region="nyc"' in str(err)
    assert err.message.startswith("machine not found: foo")
    assert [(i.region, i.name, i.id) for i in err.elsewhere] == [
        ("nyc", "foo", "id-foo")
    ]
    assert err.close == []
    method, request = home.calls[-1]
    assert method == "FindElsewhere"
    assert (request.kind, request.name) == ("machine", "foo")


def test_a_not_found_lists_close_names():
    router, _, _ = make(
        {
            "GetSnapshot": NotFoundError("no such snapshot"),
            "FindElsewhere": elsewhere(close=[("lon", "fooo")]),
        }
    )
    with pytest.raises(NotFoundError, match='"fooo" in lon') as e:
        router.call("GetSnapshot", api_pb2.GetSnapshotRequest(name="foo", org="acme"))
    assert e.value.close[0].name == "fooo"


def test_an_empty_snapshot_answer_is_looked_up_too():
    router, home, _ = make(
        {
            "GetSnapshot": api_pb2.GetSnapshotResponse(),
            "FindElsewhere": elsewhere(exact=[("nyc", "base")]),
        }
    )
    with pytest.raises(NotFoundError, match='pass region="nyc"'):
        Snapshots(router).get("base", org="acme")
    request = home.calls[-1][1]
    assert (request.kind, request.name, request.org) == ("snapshot", "base", "acme")


def test_a_failed_lookup_never_replaces_the_error():
    router, _, _ = make(
        {
            "GetVm": NotFoundError("machine not found: foo"),
            "FindElsewhere": APIStatusError("unimplemented", code="unimplemented"),
        }
    )
    with pytest.raises(NotFoundError) as e:
        Machines(router).get("foo")
    assert str(e.value) == "machine not found: foo"
    assert e.value.elsewhere == []


def test_nothing_elsewhere_leaves_the_message_alone():
    router, _, _ = make(
        {"DestroyVm": NotFoundError("gone"), "FindElsewhere": elsewhere()}
    )
    with pytest.raises(NotFoundError) as e:
        Machines(router).delete("foo")
    assert str(e.value) == "gone"


def test_a_missing_file_is_not_a_machine_elsewhere():
    router, home, _ = make(
        {"FsStat": MachineFileNotFoundError("no such file", reason="not_found")}
    )
    with pytest.raises(MachineFileNotFoundError):
        router.call("FsStat", api_pb2.FsStatRequest(vm_id="foo", path=b"/x"))
    assert home.methods() == ["FsStat"]


def test_a_sub_resource_not_found_is_not_looked_up():
    # The checkpoint may be what is missing, not the machine.
    router, home, _ = make({"DeleteCheckpoint": NotFoundError("no checkpoint")})
    with pytest.raises(NotFoundError):
        Machines(router).checkpoints.delete("foo", "cp1")
    assert home.methods() == ["DeleteCheckpoint"]


def test_the_lookup_asks_the_region_that_said_not_found():
    router, home, made = make(
        {"ListRegions": listing()},
        {
            NYC: {
                "GetVm": NotFoundError("machine not found: foo"),
                "FindElsewhere": elsewhere(exact=[("fra", "foo")]),
            }
        },
        region="nyc",
    )
    with pytest.raises(NotFoundError, match='pass region="fra"'):
        Machines(router).get("foo")
    assert made[NYC].methods() == ["GetVm", "FindElsewhere"]


def test_exec_not_found_says_where_the_machine_is():
    router, _, _ = make(
        {
            "Exec": NotFoundError("machine not found: foo"),
            "FindElsewhere": elsewhere(exact=[("nyc", "foo")]),
        }
    )
    with pytest.raises(NotFoundError, match='pass region="nyc"'):
        Machines(router).exec("foo", "true")


def test_logs_not_found_says_where_the_machine_is():
    router, _, _ = make(
        {
            "StreamLogs": NotFoundError("machine not found: foo"),
            "FindElsewhere": elsewhere(exact=[("lon", "foo")]),
        }
    )
    with pytest.raises(NotFoundError, match='pass region="lon"'):
        list(Machines(router).logs("foo"))


def test_close_closes_every_region():
    router, home, made = make(
        {"ListRegions": listing()}, {NYC: {"GetVm": vm()}}, region="nyc"
    )
    Machines(router).get("alpha")
    router.close()
    assert home.closed and made[NYC].closed


# --- the org's regions ---


def test_org_region_calls():
    transport = FakeTransport(
        [
            listing(),
            api_pb2.RequestOrgRegionResponse(state="requested"),
            api_pb2.SetOrgMachineDefaultsResponse(),
            api_pb2.SetOrgMachineDefaultsResponse(),
            api_pb2.GetOrgMachineDefaultsResponse(region="nyc"),
            api_pb2.GetOrgMachineDefaultsResponse(),
        ]
    )
    orgs = Orgs(transport)
    assert [r.id for r in orgs.regions("acme")] == ["fra", "nyc", "lon"]
    assert orgs.request_region("lon", "acme") == "requested"
    orgs.set_default_region("nyc", "acme")
    orgs.clear_default_region("acme")
    assert orgs.get_default_region() == "nyc"
    assert orgs.get_default_region() is None

    methods = [c[0] for c in transport.calls]
    assert methods[:4] == [
        "ListRegions",
        "RequestOrgRegion",
        "SetOrgMachineDefaults",
        "SetOrgMachineDefaults",
    ]
    assert transport.calls[0][1].org_id == "acme"
    assert (transport.calls[1][1].org_id, transport.calls[1][1].region) == (
        "acme",
        "lon",
    )
    set_req, clear_req = transport.calls[2][1], transport.calls[3][1]
    # The region alone: the default size is left as it is.
    assert set_req.region == "nyc" and set_req.HasField("region")
    assert not set_req.HasField("vcpu") and not set_req.HasField("memory_bytes")
    assert clear_req.HasField("region") and clear_req.region == ""
    with pytest.raises(ValueError, match="clear_default_region"):
        orgs.set_default_region("")


def test_org_domain_calls_take_a_region():
    transport = FakeTransport(
        [
            api_pb2.SetOrgDomainResponse(
                domain=api_pb2.OrgDomainInfo(
                    org_id="o", domain="d.example.com", region="nyc"
                )
            ),
            api_pb2.GetOrgDomainResponse(),
            api_pb2.ClearOrgDomainResponse(),
        ]
    )
    orgs = Orgs(transport)
    assert orgs.set_domain("o", "d.example.com", region="nyc").region == "nyc"
    assert orgs.get_domain("o", region="lon") is None
    orgs.clear_domain("o")
    assert transport.regions == ["nyc", "lon", None]


def test_machine_defaults_carry_the_default_region():
    transport = FakeTransport([api_pb2.GetOrgMachineDefaultsResponse(region="nyc")])
    assert Orgs(transport).get_machine_defaults().region == "nyc"


# --- async ---


async def test_async_routing_all_and_not_found():
    router, home, made = make(
        {
            "ListRegions": listing(),
            "ListVms": api_pb2.ListVmsResponse(vms=[vm("a", "fra")]),
        },
        {
            NYC: {
                "ListVms": api_pb2.ListVmsResponse(vms=[vm("b", "nyc")]),
                "GetVm": NotFoundError("machine not found: a"),
                "FindElsewhere": elsewhere(exact=[("fra", "a")]),
            }
        },
        region="nyc",
        kind=AsyncEndpoint,
    )
    machines = AsyncMachines(router)
    every = await machines.list(region="all")
    assert [(m.name, m.region) for m in every] == [("a", "fra"), ("b", "nyc")]
    with pytest.raises(NotFoundError, match='pass region="fra"') as e:
        await machines.get("a")
    assert e.value.elsewhere[0].region == "fra"
    assert home.methods() == ["ListRegions", "ListVms"]


async def test_async_region_not_enabled():
    router, _, _ = make({"ListRegions": listing(nyc="available")}, kind=AsyncEndpoint)
    with pytest.raises(RegionNotEnabledError, match="request_region"):
        await AsyncMachines(router).create("a", region="nyc")


async def test_async_exec_not_found_hint():
    router, _, _ = make(
        {
            "Exec": NotFoundError("machine not found: foo"),
            "FindElsewhere": elsewhere(exact=[("nyc", "foo")]),
        },
        kind=AsyncEndpoint,
    )
    with pytest.raises(NotFoundError, match='pass region="nyc"'):
        await AsyncMachines(router).exec("foo", "true")


async def test_async_list_all_names_a_region_it_could_not_reach():
    router, _, _ = make(
        {"ListRegions": listing(), "ListVms": api_pb2.ListVmsResponse(vms=[vm("a")])},
        {NYC: {"ListVms": APIConnectionError("down")}},
        kind=AsyncEndpoint,
    )
    machines = await AsyncMachines(router).list(region="all")
    assert machines.unavailable == ["nyc"]


def test_real_grpc_not_found_maps_before_the_lookup():
    # The router sees BoxdErrors, never raw gRPC errors: the transport maps
    # them first. Pin the one it keys on.
    from boxd.errors import from_grpc_error
    from fakes import FakeRpcError

    err = from_grpc_error(FakeRpcError(grpc.StatusCode.NOT_FOUND, "machine not found"))
    assert isinstance(err, NotFoundError) and err.elsewhere == []


# --- direct mode: an API key skips asking home ---

KEY = "bxd_test-key"
EXCHANGE = "https://app.example.com/api/v1/auth/token"
# Where home's answer puts nyc when a test needs it apart from the derived
# name (on the platform the two are the same).
NYC_LISTED = "https://nyc-api.example.net:9443"
NOT_IN_REGION = (
    "API key not recognized in region nyc: it was deleted, or its org doesn't "
    "use this region (`boxd manage regions` lists your org's regions)"
)


def key_credentials(kind=SyncCredentials):
    return kind(api_key=KEY, token=None, exchange_url=EXCHANGE)


def listed_apart(**kwargs):
    """`listing()` with nyc at NYC_LISTED."""
    answer = listing(**kwargs)
    answer.regions[1].api_endpoint = NYC_LISTED
    return answer


def make_direct(
    home_answers=None,
    regions=None,
    *,
    region=None,
    home_url=HOME,
    credentials=None,
    kind=Endpoint,
):
    """A router with the client's credential, as `Boxd` builds one. `made`
    lists the endpoints it dialled, each marked `derived` or not."""
    home = kind(home_url, home_answers)
    made: list = []

    def connect(url, *, derived=False):
        endpoint = kind(url, (regions or {}).get(url))
        endpoint.derived = derived
        made.append(endpoint)
        return endpoint

    router_cls = AsyncRouter if kind is AsyncEndpoint else SyncRouter
    if credentials is None:
        credentials = key_credentials(
            AsyncCredentials if kind is AsyncEndpoint else SyncCredentials
        )
    router = router_cls(home, region=region, connect=connect, credentials=credentials)
    return router, home, made


def derived(made):
    return next((e for e in made if e.derived), None)


def listed(made):
    return next((e for e in made if not e.derived), None)


def test_direct_an_api_key_goes_straight_to_the_region_as_it_is():
    router, home, made = make_direct(
        regions={
            NYC: {
                "CreateVm": created(),
                "GetVm": vm("a", "nyc"),
                "ListVms": api_pb2.ListVmsResponse(vms=[vm("a", "nyc")]),
            }
        },
        region="nyc",
    )
    machines = Machines(router)
    machine = machines.create("a")
    every = machines.list()
    assert home.calls == []
    assert len(made) == 1 and derived(made).url == NYC
    # No org filled in: the key's org applies.
    assert [(m, getattr(r, "org", None)) for m, r in derived(made).calls] == [
        ("CreateVm", ""),
        ("GetVm", None),
        ("ListVms", ""),
    ]
    # The console is named like the API, so home isn't asked for it either.
    assert machine.access.desktop_url == "https://app.nyc.boxd.example.com/desktop/a"
    assert every[0].access.desktop_url == "https://app.nyc.boxd.example.com/desktop/a"


def test_direct_a_call_region_goes_there_and_account_calls_stay_home():
    router, home, made = make_direct(
        {"GetOrgMachineDefaults": api_pb2.GetOrgMachineDefaultsResponse()},
        {LON: {"GetVm": vm("a", "lon")}},
    )
    Machines(router).get("a", region="lon")
    Orgs(router).get_default_region()
    assert derived(made).url == LON
    assert home.methods() == ["GetOrgMachineDefaults"]


def test_direct_a_call_that_names_an_org_asks_home():
    router, home, made = make_direct(
        {"ListRegions": listed_apart()},
        {NYC_LISTED: {"ListVms": api_pb2.ListVmsResponse()}},
    )
    Machines(router).list(org="acme", region="nyc")
    assert home.methods() == ["ListRegions"]
    assert home.calls[0][1].org_id == "acme"
    assert [r.org for _, r in listed(made).calls] == ["acme"]
    assert derived(made) is None


def test_direct_all_asks_home():
    router, home, made = make_direct(
        {"ListRegions": listing(), "ListVms": api_pb2.ListVmsResponse()},
        {NYC: {"ListVms": api_pb2.ListVmsResponse()}},
    )
    Machines(router).list(region="all")
    assert home.methods() == ["ListRegions", "ListVms"]
    assert derived(made) is None


def test_direct_a_connection_error_goes_through_home_for_good():
    router, home, made = make_direct(
        {"ListRegions": listed_apart()},
        {
            NYC: {"GetVm": APIConnectionError("DNS resolution failed")},
            NYC_LISTED: {
                "GetVm": vm("alpha", "nyc"),
                "ListVms": api_pb2.ListVmsResponse(),
            },
        },
        region="nyc",
    )
    machines = Machines(router)
    assert machines.get("alpha").region == "nyc"
    machines.list()
    assert derived(made).methods() == ["GetVm"]
    assert home.methods() == ["ListRegions"]
    # Through home, the region is sent the org home names, as before.
    assert listed(made).url == NYC_LISTED
    assert [(m, getattr(r, "org", None)) for m, r in listed(made).calls] == [
        ("GetVm", None),
        ("ListVms", "org-1"),
    ]


def test_direct_a_region_that_does_not_hold_the_key_is_explained_by_home():
    router, home, made = make_direct(
        {"ListRegions": listing(nyc="available")},
        {NYC: {"CreateVm": AuthenticationError(NOT_IN_REGION)}},
    )
    with pytest.raises(RegionNotEnabledError, match='request_region\\("nyc"\\)'):
        Machines(router).create("a", region="nyc")
    assert derived(made).methods() == ["CreateVm"]
    assert home.methods() == ["ListRegions"]
    assert len(made) == 1


def test_direct_a_region_that_does_not_hold_the_key_yet_is_asked_through_home():
    router, _, made = make_direct(
        {"ListRegions": listed_apart()},
        {
            NYC: {"ListVms": AuthenticationError(NOT_IN_REGION)},
            NYC_LISTED: {"ListVms": api_pb2.ListVmsResponse(vms=[vm("b", "nyc")])},
        },
    )
    assert [m.name for m in Machines(router).list(region="nyc")] == ["b"]
    assert derived(made).methods() == ["ListVms"]
    assert [r.org for _, r in listed(made).calls] == ["org-1"]


def test_direct_an_unknown_region_is_reported_by_home():
    router, home, _ = make_direct(
        {"ListRegions": listing()},
        {"https://sea.boxd.example.com:9443": {"GetVm": APIConnectionError("no host")}},
    )
    with pytest.raises(NotFoundError, match='no region "sea"') as e:
        Machines(router).get("a", region="sea")
    assert e.value.reason == "unknown_region"
    assert home.methods() == ["ListRegions"]


def test_direct_any_other_error_is_the_calls_own():
    router, home, made = make_direct(
        regions={
            NYC: {
                "GetVm": NotFoundError("machine not found: foo"),
                "FindElsewhere": elsewhere(exact=[("fra", "foo")]),
                "StartVm": AuthenticationError("API key expired"),
            }
        },
        region="nyc",
    )
    machines = Machines(router)
    with pytest.raises(NotFoundError, match='pass region="fra"'):
        machines.get("foo")
    with pytest.raises(AuthenticationError, match="expired"):
        machines.start("foo")
    assert derived(made).methods() == ["GetVm", "FindElsewhere", "StartVm"]
    assert home.calls == []


def test_direct_a_token_and_an_exchanged_key_ask_home():
    exchanged = key_credentials()
    exchanged.raw_key_refused()
    token = SyncCredentials(api_key=None, token="t", exchange_url=EXCHANGE)
    for credentials in (token, exchanged):
        router, home, made = make_direct(
            {"ListRegions": listing()},
            {NYC: {"GetVm": vm()}},
            region="nyc",
            credentials=credentials,
        )
        Machines(router).get("alpha")
        assert home.methods() == ["ListRegions"]
        assert derived(made) is None


@pytest.mark.parametrize(
    "home_url",
    [
        "https://192.0.2.10:9443",
        "https://[2001:db8::1]:9443",
        "http://localhost:9443",
        "http://127.0.0.1:9443",
        "https://boxd:9443",
        "http://boxd.example.com:9443",  # plaintext: the key is exchanged
    ],
)
def test_direct_a_home_that_is_an_address_localhost_or_one_label_asks_home(home_url):
    router, home, made = make_direct(
        {"ListRegions": listing()},
        {NYC: {"GetVm": vm()}},
        region="nyc",
        home_url=home_url,
    )
    Machines(router).get("alpha")
    assert home.methods() == ["ListRegions"]
    assert derived(made) is None


def test_direct_streams_go_there_only_after_a_unary_call_was_answered():
    # A list is one answer per call: a stream's answer is a list in one.
    chunks = [[api_pb2.ExecChunk(data=b"hi", exit_code=0)]]
    uploaded = api_pb2.UploadFileResponse(bytes_written=2)
    router, home, made = make_direct(
        {"ListRegions": listed_apart()},
        {
            NYC: {
                "GetVm": vm(),
                "Exec": chunks,
                "StreamLogs": [[]],
                "UploadFileStream": uploaded,
            },
            NYC_LISTED: {
                "Exec": chunks,
                "StreamLogs": [[]],
                "UploadFileStream": uploaded,
            },
        },
        region="nyc",
    )
    machines = Machines(router)
    # Nothing confirmed the derived name yet: through home, as before.
    assert machines.exec("alpha", "echo hi").stdout == "hi"
    list(machines.logs("alpha"))
    assert machines.files.upload("alpha", "/tmp/x", b"hi") == 2
    assert home.methods() == ["ListRegions"]
    assert listed(made).methods() == ["Exec", "StreamLogs", "UploadFileStream"]
    # A unary call answered there: streams follow it.
    machines.get("alpha")
    assert machines.exec("alpha", "echo hi").stdout == "hi"
    list(machines.logs("alpha"))
    assert machines.files.upload("alpha", "/tmp/x", b"hi") == 2
    assert derived(made).methods() == [
        "GetVm",
        "Exec",
        "StreamLogs",
        "UploadFileStream",
    ]
    assert listed(made).methods() == ["Exec", "StreamLogs", "UploadFileStream"]


def test_direct_a_region_that_fell_back_takes_its_streams_through_home():
    router, _, made = make_direct(
        {"ListRegions": listed_apart()},
        {
            NYC: {"GetVm": [vm(), APIConnectionError("reset")], "StreamLogs": [[]]},
            NYC_LISTED: {"GetVm": vm(), "StreamLogs": [[]]},
        },
        region="nyc",
    )
    machines = Machines(router)
    machines.get("alpha")  # confirmed
    machines.get("alpha")  # fails there: off
    list(machines.logs("alpha"))
    assert derived(made).methods() == ["GetVm", "GetVm"]
    assert listed(made).methods() == ["GetVm", "StreamLogs"]


def test_direct_close_closes_the_derived_transports():
    router, _, made = make_direct(regions={NYC: {"GetVm": vm()}}, region="nyc")
    Machines(router).get("alpha")
    router.close()
    assert derived(made).closed


def test_direct_the_client_wires_its_credential_and_derived_transports():
    boxd = Boxd(api_key=KEY, base_url=HOME, region="nyc")
    router = boxd._transport
    assert router._credentials is router._home._credentials
    nyc = router._connect(NYC, derived=True)
    assert nyc._derived and nyc._max_retries == 0
    assert nyc._credentials is router._credentials
    assert not router._home._derived and router._home._max_retries == 2


async def test_async_direct_and_its_fallback():
    router, home, made = make_direct(
        {"ListRegions": listed_apart(nyc="available")},
        {
            NYC: {
                "GetVm": vm("a", "nyc"),
                "CreateVm": AuthenticationError(NOT_IN_REGION),
            },
        },
        region="nyc",
        kind=AsyncEndpoint,
    )
    machines = AsyncMachines(router)
    machine = await machines.get("a")
    assert machine.access.desktop_url == "https://app.nyc.boxd.example.com/desktop/a"
    assert home.calls == []
    with pytest.raises(RegionNotEnabledError):
        await machines.create("b")
    assert derived(made).methods() == ["GetVm", "CreateVm"]
    assert home.methods() == ["ListRegions"]


async def test_async_direct_streams_wait_for_a_confirmed_unary_call():
    router, home, made = make_direct(
        {"ListRegions": listed_apart()},
        {NYC: {"GetVm": vm(), "StreamLogs": [[]]}, NYC_LISTED: {"StreamLogs": [[]]}},
        region="nyc",
        kind=AsyncEndpoint,
    )
    machines = AsyncMachines(router)
    async for _ in machines.logs("alpha"):
        pass
    await machines.get("alpha")
    async for _ in machines.logs("alpha"):
        pass
    assert listed(made).methods() == ["StreamLogs"]
    assert derived(made).methods() == ["GetVm", "StreamLogs"]
    assert home.methods() == ["ListRegions"]
