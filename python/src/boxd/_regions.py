"""Regions: which endpoint each call goes to.

boxd runs one cluster per region. The client's base URL is its home: account,
org, API-key, env-var and billing calls always go there. A call on a machine,
snapshot or disk (and everything under a machine: exec, files, proxies,
checkpoints, backups, ...) goes to the region named by the call's
``region=``, else by the client's (``Boxd(region=...)``, ``BOXD_REGION``),
else home, which is where every call went before regions existed.

A region's endpoint comes from ``ListRegions`` asked at home, once per client
and org; it is asked again (once) when a region is missing from the answer or
not enabled in it yet. One credential works in every region, so every
region's transport shares the client's.

A call that names no org means the caller's default org. Home resolves that
itself, but a region holds only the orgs that enabled it, so the default it
would pick can be another org. A region other than home is sent the org
home's ``ListRegions`` answer names instead.

Direct mode skips home. Asking it first costs a round trip to home before the
first call to a region, which from far away is most of the wait. With an API
key sent as itself (``_credentials.py``) and a call that names no org, the
call needs neither thing that answer gives: the key belongs to one org, which
the region applies, and the region checks the key itself. So such a call goes
straight to the region's name derived from home's, ``<region>.<home host>`` on
home's scheme and port (``_urls.region_base_url``), sent as it is. When it
fails there before reaching a handler (a connection error, or the region
refusing the key: "API key not recognized in region ...", or as a server from
before raw keys does), the region is asked through home for the rest of the
client's life and the call is sent again that way, which is also where an
unknown or not-enabled region is reported. Only a unary call is sent again,
so a stream (or a streamed request) goes to the derived name only once a
unary call there was answered. Calls that name an org, ``"all"`` lists,
tokens, in-machine credentials, a key that is exchanged, and a home whose
host is an IP address, ``localhost`` or one label keep asking home.

The router has the transport's surface (``call``, ``server_stream``,
``bidi``, ``close``), so the resource namespaces only pass ``region=``
through and never see an endpoint.
"""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from . import _mappers as m
from ._generated import api_pb2
from ._transport import refuses_raw_key
from ._urls import raw_key_allowed, region_base_url
from .errors import (
    APIConnectionError,
    AuthenticationError,
    BoxdError,
    MachineFilesystemError,
    NotFoundError,
    RegionNotEnabledError,
)

#: ``list(region="all")`` asks every region the org has and merges the answers.
ALL = "all"

# Calls on the account, its orgs, keys, env vars, teams and billing. Home
# holds them, so they go there whatever region the client or call names.
HOME_METHODS = frozenset(
    {
        "Whoami",
        "GetConfig",
        "CreateToken",
        "ListTokens",
        "RevokeToken",
        "LinkSshKey",
        "SetVar",
        "ListVars",
        "RemoveVar",
        "SetSecretScope",
        "CreateApiKey",
        "ListApiKeys",
        "DeleteApiKey",
        "GetBilling",
        "CreateCheckoutSession",
        "CreateBillingPortalSession",
        "ListOrgs",
        "GetOrgBilling",
        "GetOrgUsage",
        "GetVmUsage",
        "ListBillingActivity",
        "SetOrgBackupsDefault",
        "GetOrgBackupsDefault",
        "SetOrgMachineDefaults",
        "GetOrgMachineDefaults",
        "SetOrgIdleIgnoreOutboundDefault",
        "GetOrgIdleIgnoreOutboundDefault",
        "SetOrgBotProtectionDefault",
        "GetOrgBotProtectionDefault",
        "GetOrgMachineLimit",
        "RequestOrgMachineLimit",
        "ListRegions",
        "RequestOrgRegion",
        "FindElsewhere",
        "CreateOrg",
        "RenameOrg",
        "GetOrgMembers",
        "InviteOrgMember",
        "RevokeOrgInvite",
        "RemoveOrgMember",
        "SetOrgMemberRole",
        "ListTeams",
        "GetTeam",
        "CreateTeam",
        "RenameTeam",
        "DestroyTeam",
        "AddTeamMember",
        "RemoveTeamMember",
        "SetTeamMemberRole",
        "SetTeamDefaultSnapshot",
    }
)

# Calls whose not-found can only mean the machine, snapshot or disk they name
# is not in this region: the kind, and the request fields that may name it.
# Calls on something inside a machine (a checkpoint, a backup, a proxy, a
# file path) are left out, since their not-found may be about that thing.
_MACHINE_FIELDS = ("vm", "vm_id", "vm_name", "source_vm_id")
_LOOKUP: dict[str, tuple[str, tuple[str, ...]]] = {
    **{
        method: ("machine", _MACHINE_FIELDS)
        for method in (
            "GetVm",
            "DestroyVm",
            "RenameVm",
            "StartVm",
            "StopVm",
            "RebootVm",
            "SuspendVm",
            "ResumeVm",
            "HibernateVm",
            "WakeVm",
            "ResizeVm",
            "ForkVm",
            "ShareVm",
            "UnshareVm",
            "SetVmNetworks",
            "SetVmEgressAllow",
            "UpdateVmLabels",
            "UpdateMachineSpec",
            "SetAutoSuspendTimeout",
            "SetAutoHibernateTimeout",
            "SetBotProtection",
            "SetIdleIgnoreOutbound",
            "SetSsh",
            "SetDeleteAfter",
            "StreamLogs",
            "ComputerAction",
            "ExposePort",
            "ListExposedPorts",
            "ListProxies",
            "CreateProxy",
            "SetProxyPort",
            "AddCustomDomain",
            "CreateSnapshot",
            "CreateCheckpoint",
            "ListCheckpoints",
            "SetBackupSchedule",
            "ClearBackupSchedule",
            "GetBackupSchedule",
            "ListBackups",
            "TriggerBackup",
            "FsRead",
            "FsStat",
            "FsList",
            "FsMkdir",
            "FsRemove",
            "FsRename",
            "FsRealpath",
        )
    },
    "GetSnapshot": ("snapshot", ("name",)),
    "DeleteSnapshot": ("snapshot", ("name",)),
    "CreateVmFromSnapshot": ("snapshot", ("snapshot",)),
    "DestroyDisk": ("disk", ("disk_id",)),
}


def normalize(region: str | None) -> str | None:
    """A region id as the server writes it; None for none."""
    if region is None:
        return None
    region = region.strip().lower()
    return region or None


def resolve_region(explicit: str | None) -> str | None:
    """The client's region: the argument, else `BOXD_REGION`, else None (home)."""
    region = normalize(explicit) or normalize(os.environ.get("BOXD_REGION"))
    if region == ALL:
        raise ValueError(
            'region="all" is for list() calls only; a client works in one region'
        )
    return region


def _fields(request) -> Any:
    descriptor = getattr(request, "DESCRIPTOR", None)
    return getattr(descriptor, "fields_by_name", None)


def _org_field(request) -> str | None:
    """The request field that names the org (`org` or `org_id`), if it has one."""
    fields = _fields(request)
    if not fields:
        return None
    return next((field for field in ("org", "org_id") if field in fields), None)


def _org_of(request) -> str | None:
    """The org an org-scoped call names ("" = the caller's default org), or
    None for a call that names none (one on a machine by name, say)."""
    field = _org_field(request)
    return None if field is None else getattr(request, field)


def _with_org(request, org: str):
    """`request` with an empty org filled in with `org`, the id home's
    ListRegions answer gave it. An org the caller set, a request that names
    none, and an empty `org` (from a server that doesn't say) leave it as it
    is."""
    field = _org_field(request)
    if not org or field is None or getattr(request, field):
        return request
    filled = type(request)()
    filled.CopyFrom(request)
    setattr(filled, field, org)
    return filled


def _lookup_of(method: str, request) -> tuple[str, str] | None:
    """What a not-found from this call is about: (kind, name), or None."""
    lookup = _LOOKUP.get(method)
    fields = _fields(request)
    if lookup is None or not fields:
        return None
    kind, names = lookup
    for field in names:
        if field in fields and getattr(request, field):
            return kind, getattr(request, field)
    return None


def _verdict(listing, region: str, check_org: bool) -> BoxdError | None:
    """Why `region` can't be used, from a ListRegions answer; None if it can."""
    entry = next((r for r in listing.regions if r.id == region), None)
    if entry is None:
        known = ", ".join(r.id for r in listing.regions)
        where = f"the regions are {known}" if known else "this boxd runs in one region"
        return NotFoundError(
            f'there is no region "{region}": {where}',
            code="not_found",
            grpc_code=5,
            reason="unknown_region",
        )
    if check_org and entry.org_state != "enabled":
        org = f"org {listing.org_id}" if listing.org_id else "the org"
        if entry.org_state == "requested":
            message = (
                f'region "{region}" is not enabled for {org} yet: it was asked '
                "for (orgs.request_region) and boxd has yet to enable it"
            )
        else:
            message = (
                f'region "{region}" is not enabled for {org}: an org admin can '
                f'ask for it with orgs.request_region("{region}")'
            )
        return RegionNotEnabledError(message, region=region, org_state=entry.org_state)
    if entry.id != listing.this_region and not entry.api_endpoint:
        return BoxdError(f'region "{region}" has no API endpoint')
    return None


def _hint(kind: str, name: str, exact: list, close: list) -> str | None:
    if exact:
        regions = list(dict.fromkeys(item.region for item in exact))
        return (
            f'there is a {kind} "{name}" in {", ".join(regions)}: '
            f'pass region="{regions[0]}"'
        )
    if close:
        near = ", ".join(f'"{item.name}" in {item.region}' for item in close[:3])
        return f"close names in other regions: {near}"
    return None


def _attach(err: NotFoundError, kind: str, name: str, found) -> None:
    """Put a FindElsewhere answer on the error, and a hint in its message."""
    err.elsewhere = [m.elsewhere_item(item) for item in found.exact]
    err.close = [m.elsewhere_item(item) for item in found.close]
    hint = _hint(kind, name, err.elsewhere, err.close)
    if hint:
        err.message = f"{err.message}; {hint}"
        err.args = (err.message, *err.args[1:])


# The start of a region's refusal of a key it doesn't hold: the key was
# deleted, or its org doesn't use the region.
_KEY_NOT_IN_REGION = "API key not recognized in region"


def _missed_region(err: BoxdError) -> bool:
    """Whether a call sent to a region's derived name never reached a handler
    there, so it can be sent again through home: the name led to no server (a
    connection error: DNS, connect, TLS), the region doesn't hold the key, or
    it refuses a key sent as itself as a server from before raw keys does."""
    if isinstance(err, APIConnectionError):
        return True
    return (
        isinstance(err, AuthenticationError)
        and err.code == "unauthenticated"
        and (err.message.startswith(_KEY_NOT_IN_REGION) or refuses_raw_key(err.message))
    )


def _one_shot(request) -> bool:
    """A stream's request, or a client-streamed one: never sent twice."""
    return not hasattr(request, "DESCRIPTOR")


def _worth_looking(err: BoxdError, lookup: tuple[str, str] | None) -> bool:
    # A file the machine lacks, or a region that doesn't exist, is not a
    # machine somewhere else.
    return (
        lookup is not None
        and not isinstance(err, MachineFilesystemError)
        and err.reason != "unknown_region"
    )


class _RouterBase:
    def __init__(
        self,
        home,
        *,
        region: str | None,
        connect: Callable[..., Any],
        credentials=None,
    ):
        """`connect(url)` makes a transport for a region's endpoint;
        `connect(url, derived=True)` one for its name derived from home's.
        `credentials` is the client's, for direct mode; without them every
        call to a region asks home first."""
        self._home = home
        self._region = resolve_region(region)
        self._connect = connect
        self._credentials = credentials
        # ListRegions answers, by the org they were asked for ("" = default).
        self._listings: dict[str, Any] = {}
        # Region transports, by API endpoint. Home's region uses `_home`.
        self._transports: dict[str, Any] = {}
        # Console origins, by region id, once a region has been reached.
        self._consoles: dict[str, str] = {}
        # Direct mode, by region id: "confirmed" once a unary call sent to the
        # derived name was answered; "off", for the client's life, once one
        # never reached a handler there. Absent: not tried yet.
        self._direct: dict[str, str] = {}
        # Transports to regions' derived names, by region id.
        self._derived: dict[str, Any] = {}

    @property
    def region(self) -> str | None:
        """The client's region; None = home."""
        return self._region

    @property
    def base_url(self) -> str:
        return self._home.base_url

    @property
    def console_origin(self) -> str:
        return self.console_origin_for(None)

    def console_origin_for(self, region: str | None) -> str:
        """The web console of the region a call went to (`machines` builds
        `access.desktop_url` from it); home's until that region is reached."""
        region = normalize(region) or self._region
        return (region and self._consoles.get(region)) or self._home.console_origin

    def _target(self, method: str, region: str | None) -> str | None:
        """The region a call goes to; None = home."""
        if method in HOME_METHODS:
            return None
        target = normalize(region) or self._region
        if target == ALL:
            raise ValueError('region="all" is for list() calls only')
        return target

    def _direct_route(self, method: str, request, region: str | None):
        """Where a call goes in direct mode: ``(region, transport)`` to the
        region's derived name, or None when direct mode doesn't apply (see the
        module doc). The call is sent as it is: no org is filled in."""
        target = self._target(method, region)
        if self._credentials is None or target is None or _org_of(request):
            return None
        if self._direct.get(target) == "off":
            return None
        url = region_base_url(self._home.base_url, target)
        if url is None:
            return None
        if self._credentials.raw_key(allowed=raw_key_allowed(url)) is None:
            return None
        transport = self._derived.get(target)
        if transport is None:
            transport = self._connect(url, derived=True)
            self._derived[target] = transport
        return target, transport

    def _confirmed(self, region: str | None):
        """The transport to a region's derived name, once a unary call there
        was answered; None before that, or after it fell back."""
        if region is None or self._direct.get(region) != "confirmed":
            return None
        return self._derived.get(region)

    def _confirm(self, region: str, transport) -> None:
        if self._direct.get(region) == "off":
            return
        self._direct[region] = "confirmed"
        # Its console is named like its API (`app.<region>.<zone>`), so home
        # isn't asked for it either.
        self._consoles[region] = transport.console_origin

    def _remember(self, request, response) -> None:
        # Every ListRegions answer refreshes the directory, whoever asked.
        self._listings[request.org_id] = response

    def _cached(self, region: str, org: str | None):
        if org is not None:
            return self._listings.get(org)
        # No org to check: any answer that lists the region names its endpoint.
        for listing in self._listings.values():
            if any(r.id == region for r in listing.regions):
                return listing
        return self._listings.get("")

    def _pick(self, listing, region: str):
        entry = next(r for r in listing.regions if r.id == region)
        if entry.id == listing.this_region:
            self._consoles[entry.id] = self._home.console_origin
            return self._home
        transport = self._transports.get(entry.api_endpoint)
        if transport is None:
            transport = self._connect(entry.api_endpoint)
            self._transports[entry.api_endpoint] = transport
        self._consoles[entry.id] = (
            entry.console_endpoint.rstrip("/") or transport.console_origin
        )
        return transport

    def _regional(self, transport, listing, request):
        """`request` as `transport` is sent it. `listing` is home's answer for
        the call's org: for an empty one, it names the default org, which a
        region other than home is sent."""
        if transport is self._home:
            return request
        return _with_org(request, listing.org_id)

    @staticmethod
    def _enabled(listing) -> list:
        return [r for r in listing.regions if r.org_state == "enabled"]


class SyncRouter(_RouterBase):
    """Routes each call of a :class:`~boxd.Boxd` to its region's endpoint."""

    def _listing(self, org: str):
        request = api_pb2.ListRegionsRequest(org_id=org)
        response = self._home.call("ListRegions", request)
        self._remember(request, response)
        return response

    def _resolve(self, region: str, org: str | None):
        listing = self._cached(region, org)
        fresh = listing is None
        if fresh:
            listing = self._listing(org or "")
        err = _verdict(listing, region, org is not None)
        if err is not None and not fresh:
            listing = self._listing(org or "")
            err = _verdict(listing, region, org is not None)
        if err is not None:
            raise err
        return self._pick(listing, region), listing

    def _route(self, method: str, request, region: str | None):
        """The transport a call goes to, and the request it is sent."""
        target = self._target(method, region)
        if target is None:
            return self._home, request
        transport, listing = self._resolve(target, _org_of(request))
        return transport, self._regional(transport, listing, request)

    def _stream_route(self, method: str, request, region: str | None):
        """`_route` for a call that can't be sent again: a derived name only
        once it is confirmed."""
        confirmed = self._confirmed(self._target(method, region))
        if confirmed is not None:
            return confirmed, request
        return self._route(method, request, region)

    def _find_elsewhere(self, err, transport, lookup, org) -> None:
        if not _worth_looking(err, lookup):
            return
        kind, name = lookup
        try:
            found = transport.call(
                "FindElsewhere",
                api_pb2.FindElsewhereRequest(kind=kind, name=name, org=org or ""),
            )
        except Exception:  # noqa: BLE001 — never replaces the real error
            return
        _attach(err, kind, name, found)

    def find_elsewhere(
        self, err: NotFoundError, method: str, request, *, region: str | None = None
    ) -> NotFoundError:
        """Look up elsewhere a not-found the SDK raises itself (an answer that
        carries nothing rather than a not-found status). Returns `err`."""
        direct = self._direct_route(method, request, region)
        if direct is not None:
            transport = direct[1]
        else:
            transport, _ = self._route(method, request, region)
        self._find_elsewhere(
            err, transport, _lookup_of(method, request), _org_of(request)
        )
        return err

    def call(self, method: str, request, *, region: str | None = None, **options):
        if _one_shot(request):
            transport, sent = self._stream_route(method, request, region)
            return self._send(transport, method, sent, request, **options)
        direct = self._direct_route(method, request, region)
        if direct is not None:
            target, transport = direct
            try:
                response = self._send(transport, method, request, request, **options)
            except BoxdError as err:
                if not _missed_region(err):
                    raise
                # Refused before any handler ran: ask home where the region
                # is, from now on, and send the call there.
                self._direct[target] = "off"
            else:
                self._confirm(target, transport)
                return response
        transport, sent = self._route(method, request, region)
        return self._send(transport, method, sent, request, **options)

    def _send(self, transport, method: str, sent, request, **options):
        """One call on `transport`: `sent` is what it is sent, `request` what
        the caller asked for."""
        try:
            response = transport.call(method, sent, **options)
        except NotFoundError as err:
            self._find_elsewhere(
                err, transport, _lookup_of(method, request), _org_of(request)
            )
            raise
        if method == "ListRegions":
            self._remember(request, response)
        return response

    def server_stream(self, method: str, request, *, region: str | None = None):
        transport, sent = self._stream_route(method, request, region)
        lookup = _lookup_of(method, request)
        return _FindingStream(
            transport.server_stream(method, sent),
            lambda err: self._find_elsewhere(err, transport, lookup, None),
        )

    def bidi(
        self,
        method: str,
        requests,
        *,
        timeout: float | None = None,
        region: str | None = None,
        machine: str | None = None,
    ):
        """`machine` names the machine the stream is about (`Exec`), for the
        hint on a not-found."""
        transport, _ = self._stream_route(method, None, region)
        lookup = ("machine", machine) if machine else None
        return _FindingStream(
            transport.bidi(method, requests, timeout=timeout),
            lambda err: self._find_elsewhere(err, transport, lookup, None),
        )

    def each_region(self, method: str, request, *, org: str | None):
        """Make one call in every region the org has enabled.

        Returns ``([(region, response), ...], unavailable)``: the regions that
        could not be reached are named, not raised. Outside a federation it is
        the one call at home, with region None.
        """
        key = org or ""
        listing = self._listings.get(key)
        if listing is None:
            listing = self._listing(key)
        enabled = self._enabled(listing)
        if not enabled:
            return [(listing.this_region or None, self._home.call(method, request))], []
        targets = [(r.id, self._pick(listing, r.id)) for r in enabled]
        with ThreadPoolExecutor(max_workers=len(targets)) as pool:
            # Home resolves an empty org itself; the other regions are sent
            # the org it resolved, so every page is of the same org.
            futures = [
                (rid, pool.submit(t.call, method, self._regional(t, listing, request)))
                for rid, t in targets
            ]
        results, unavailable = [], []
        for rid, future in futures:
            try:
                results.append((rid, future.result()))
            except APIConnectionError:
                unavailable.append(rid)
        return results, unavailable

    def close(self) -> None:
        self._home.close()
        for transport in [*self._transports.values(), *self._derived.values()]:
            transport.close()
        self._transports.clear()
        self._derived.clear()


class AsyncRouter(_RouterBase):
    """Async twin of :class:`SyncRouter`."""

    async def _listing(self, org: str):
        request = api_pb2.ListRegionsRequest(org_id=org)
        response = await self._home.call("ListRegions", request)
        self._remember(request, response)
        return response

    async def _resolve(self, region: str, org: str | None):
        listing = self._cached(region, org)
        fresh = listing is None
        if fresh:
            listing = await self._listing(org or "")
        err = _verdict(listing, region, org is not None)
        if err is not None and not fresh:
            listing = await self._listing(org or "")
            err = _verdict(listing, region, org is not None)
        if err is not None:
            raise err
        return self._pick(listing, region), listing

    async def _route(self, method: str, request, region: str | None):
        """The transport a call goes to, and the request it is sent."""
        target = self._target(method, region)
        if target is None:
            return self._home, request
        transport, listing = await self._resolve(target, _org_of(request))
        return transport, self._regional(transport, listing, request)

    async def _stream_route(self, method: str, request, region: str | None):
        """Async twin of :meth:`SyncRouter._stream_route`."""
        confirmed = self._confirmed(self._target(method, region))
        if confirmed is not None:
            return confirmed, request
        return await self._route(method, request, region)

    async def _find_elsewhere(self, err, transport, lookup, org) -> None:
        if not _worth_looking(err, lookup):
            return
        kind, name = lookup
        try:
            found = await transport.call(
                "FindElsewhere",
                api_pb2.FindElsewhereRequest(kind=kind, name=name, org=org or ""),
            )
        except Exception:  # noqa: BLE001 — never replaces the real error
            return
        _attach(err, kind, name, found)

    async def find_elsewhere(
        self, err: NotFoundError, method: str, request, *, region: str | None = None
    ) -> NotFoundError:
        """Async twin of :meth:`SyncRouter.find_elsewhere`."""
        direct = self._direct_route(method, request, region)
        if direct is not None:
            transport = direct[1]
        else:
            transport, _ = await self._route(method, request, region)
        await self._find_elsewhere(
            err, transport, _lookup_of(method, request), _org_of(request)
        )
        return err

    async def call(self, method: str, request, *, region: str | None = None, **options):
        if _one_shot(request):
            transport, sent = await self._stream_route(method, request, region)
            return await self._send(transport, method, sent, request, **options)
        direct = self._direct_route(method, request, region)
        if direct is not None:
            target, transport = direct
            try:
                response = await self._send(transport, method, request, request, **options)
            except BoxdError as err:
                if not _missed_region(err):
                    raise
                # Refused before any handler ran: ask home where the region
                # is, from now on, and send the call there.
                self._direct[target] = "off"
            else:
                self._confirm(target, transport)
                return response
        transport, sent = await self._route(method, request, region)
        return await self._send(transport, method, sent, request, **options)

    async def _send(self, transport, method: str, sent, request, **options):
        """Async twin of :meth:`SyncRouter._send`."""
        try:
            response = await transport.call(method, sent, **options)
        except NotFoundError as err:
            await self._find_elsewhere(
                err, transport, _lookup_of(method, request), _org_of(request)
            )
            raise
        if method == "ListRegions":
            self._remember(request, response)
        return response

    async def server_stream(self, method: str, request, *, region: str | None = None):
        transport, sent = await self._stream_route(method, request, region)
        lookup = _lookup_of(method, request)
        return _AsyncFindingStream(
            await transport.server_stream(method, sent),
            lambda err: self._find_elsewhere(err, transport, lookup, None),
        )

    async def bidi(
        self,
        method: str,
        requests,
        *,
        timeout: float | None = None,
        region: str | None = None,
        machine: str | None = None,
    ):
        transport, _ = await self._stream_route(method, None, region)
        lookup = ("machine", machine) if machine else None
        return _AsyncFindingStream(
            await transport.bidi(method, requests, timeout=timeout),
            lambda err: self._find_elsewhere(err, transport, lookup, None),
        )

    async def each_region(self, method: str, request, *, org: str | None):
        """Async twin of :meth:`SyncRouter.each_region`."""
        key = org or ""
        listing = self._listings.get(key)
        if listing is None:
            listing = await self._listing(key)
        enabled = self._enabled(listing)
        if not enabled:
            response = await self._home.call(method, request)
            return [(listing.this_region or None, response)], []
        targets = [(r.id, self._pick(listing, r.id)) for r in enabled]
        answers = await asyncio.gather(
            *(t.call(method, self._regional(t, listing, request)) for _, t in targets),
            return_exceptions=True,
        )
        results, unavailable = [], []
        for (rid, _), answer in zip(targets, answers):
            if isinstance(answer, APIConnectionError):
                unavailable.append(rid)
            elif isinstance(answer, BaseException):
                raise answer
            else:
                results.append((rid, answer))
        return results, unavailable

    async def close(self) -> None:
        await self._home.close()
        for transport in [*self._transports.values(), *self._derived.values()]:
            await transport.close()
        self._transports.clear()
        self._derived.clear()


class _FindingStream:
    """A stream whose not-found error is looked up elsewhere before it is
    raised. Keeps `cancel()` reachable, as the stream it wraps does."""

    def __init__(self, call, on_not_found):
        self._call = call
        self._iter = iter(call)
        self._on_not_found = on_not_found

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._iter)
        except NotFoundError as err:
            self._on_not_found(err)
            raise

    def cancel(self):
        cancel = getattr(self._call, "cancel", None)
        return cancel() if cancel is not None else None


class _AsyncFindingStream:
    """Async twin of :class:`_FindingStream`."""

    def __init__(self, call, on_not_found):
        self._call = call
        self._iter = call.__aiter__()
        self._on_not_found = on_not_found

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self._iter.__anext__()
        except NotFoundError as err:
            await self._on_not_found(err)
            raise

    def cancel(self):
        cancel = getattr(self._call, "cancel", None)
        return cancel() if cancel is not None else None


__all__ = ["ALL", "AsyncRouter", "HOME_METHODS", "SyncRouter", "resolve_region"]
