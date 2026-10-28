"""`boxd.orgs` — the organizations the caller belongs to, and their billing."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from datetime import datetime

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..models import (
    BotProtectionMode,
    CreatedOrg,
    BillingActivityEntry,
    BillingActivityPage,
    Org,
    OrgBotProtectionDefault,
    OrgBotProtectionDefaultResult,
    OrgDomain,
    OrgIdleIgnoreOutboundDefault,
    OrgIdleIgnoreOutboundDefaultResult,
    OrgInvite,
    MachineLimitRequest,
    OrgMachineDefaults,
    OrgMachineLimit,
    OrgMembers,
    OrgUsage,
)
from . import Namespace


def _bot_protection_default_mode(mode: BotProtectionMode) -> BotProtectionMode:
    """The mode a ``set_bot_protection_default`` call asks for. An empty or
    unknown value is refused here: on the wire an empty mode CLEARS the
    default, and a typo must not do that."""
    if mode not in ("on", "sleep_only", "off"):
        raise ValueError(
            f"mode must be 'on', 'sleep_only' or 'off', not {mode!r}. "
            "To drop the default, call clear_bot_protection_default"
        )
    return mode


class Orgs(Namespace):
    """Create orgs, manage the active one's roster, and read its shared plan."""

    def list(self) -> list[Org]:
        """Every org the caller is a member of, plus their default org."""
        resp = self._transport.call("ListOrgs", api_pb2.ListOrgsRequest())
        return [m.org(o, resp.default_org_id) for o in resp.orgs]

    def create(self, name: str) -> CreatedOrg:
        """Create a new org. You become its owner and admin.

        Unlike every other org method here, this has no `org` parameter —
        there's nothing to scope to yet.
        """
        return m.created_org(
            self._transport.call("CreateOrg", api_pb2.CreateOrgRequest(name=name))
        )

    def rename(self, name: str, org: str = "") -> None:
        """Rename an org. Requires org admin."""
        self._transport.call(
            "RenameOrg", api_pb2.RenameOrgRequest(org_id=org, name=name)
        )

    def get_members(self, org: str = "") -> OrgMembers:
        """The org's roster, plus pending invites.

        Invites are populated for org admins only — a plain member always
        sees an empty invite list, matching the console.
        """
        return m.org_members(
            self._transport.call(
                "GetOrgMembers", api_pb2.GetOrgMembersRequest(org_id=org)
            )
        )

    def invite(self, email: str, *, role: str = "member", org: str = "") -> OrgInvite:
        """Invite someone to the org by email. Requires org admin.

        Best-effort emails the invite link (when the cluster has email
        configured) — `accept_url` on the result always works regardless, so
        delivery failing (or not being configured) never loses the invite.
        `email_status` on the result says whether the email went out.
        """
        resp = self._transport.call(
            "InviteOrgMember",
            api_pb2.InviteOrgMemberRequest(org_id=org, email=email, role=role),
        )
        return m.invited_org_member(resp, email, role)

    def revoke_invite(self, token: str) -> None:
        """Revoke a pending invite. Requires org admin of the invite's org."""
        self._transport.call(
            "RevokeOrgInvite", api_pb2.RevokeOrgInviteRequest(token=token)
        )

    def remove_member(self, user_id: str, org: str = "") -> None:
        """Remove a plain member from the org. Requires org admin.

        Refused for an org owner/admin (only the platform can remove those) or for a
        member who still owns machines billed to this org — move them to
        personal billing or destroy them first.
        """
        self._transport.call(
            "RemoveOrgMember",
            api_pb2.RemoveOrgMemberRequest(org_id=org, user_id=user_id),
        )

    def set_member_role(self, user_id: str, role: str, org: str = "") -> None:
        """Promote a member to ``"admin"`` or demote an admin to ``"member"``.

        Requires org admin. Demoting another admin is owner-only (you can
        always demote yourself). Refused for the org owner, whose ownership
        is transferred by the platform instead.
        """
        self._transport.call(
            "SetOrgMemberRole",
            api_pb2.SetOrgMemberRoleRequest(org_id=org, user_id=user_id, role=role),
        )

    def set_domain(self, org: str, domain: str) -> OrgDomain:
        """Set the org's wildcard apex (e.g. "preview.mysaas.com").

        Requires org admin. Starts verification immediately — call this only
        after delegation is actually live: a whole domain ("mysaas.com") gets
        boxd's cluster nameservers set at its registrar, a subdomain
        ("preview.mysaas.com") gets NS records for them in its parent
        domain's DNS. Checking before delegation is live risks a public
        resolver caching the "no records" answer, delaying propagation once
        delegation is actually there. A control loop then verifies
        delegation, issues certs, and flips the domain to `active`.
        """
        resp = self._transport.call(
            "SetOrgDomain", api_pb2.SetOrgDomainRequest(org_id=org, domain=domain)
        )
        return m.org_domain(resp.domain)

    def get_domain(self, org: str) -> OrgDomain | None:
        """The org's current wildcard domain, or `None` if unset."""
        resp = self._transport.call(
            "GetOrgDomain", api_pb2.GetOrgDomainRequest(org_id=org)
        )
        return m.org_domain(resp.domain) if resp.HasField("domain") else None

    def clear_domain(self, org: str) -> None:
        """Remove the org's wildcard domain. Requires org admin."""
        self._transport.call(
            "ClearOrgDomain", api_pb2.ClearOrgDomainRequest(org_id=org)
        )

    def set_machine_defaults(
        self,
        org: str = "",
        *,
        vcpu: int | None = None,
        memory: int | str | None = None,
    ) -> None:
        """Set the size machines in this org are born at. Requires org admin.

        Name either dimension and the server resolves the whole size class
        (1 vCPU/4 GiB, 2/8 GiB, 4/16 GiB); it must sit at or under the org
        quota. This is a preference below the quota, not the quota itself —
        the quota stays the operator-owned ceiling and the per-request
        maximum.

        Only machines created afterwards are affected. Every existing machine
        keeps the size it was created with; use `machines.resize` to move one.
        """
        if vcpu is None and memory is None:
            raise ValueError(
                "set_machine_defaults needs vcpu or memory - either one names "
                "a size class. To drop the default, call clear_machine_defaults"
            )
        self._transport.call(
            "SetOrgMachineDefaults",
            req.set_org_machine_defaults(org=org, vcpu=vcpu, memory=memory),
        )

    def get_machine_defaults(self, org: str = "") -> OrgMachineDefaults:
        """The org's default machine size, and the quota above it.

        Readable by any member. `is_set` false means no explicit default is
        stored and the effective size is simply the quota ceiling.
        """
        return m.org_machine_defaults(
            self._transport.call(
                "GetOrgMachineDefaults",
                api_pb2.GetOrgMachineDefaultsRequest(org_id=org),
            )
        )

    def clear_machine_defaults(self, org: str = "") -> None:
        """Drop the org's default size, so new machines are born at the org
        quota again. Requires org admin. Existing machines are untouched."""
        self._transport.call(
            "SetOrgMachineDefaults",
            req.set_org_machine_defaults(org=org, vcpu=None, memory=None),
        )

    def set_idle_ignore_outbound_default(
        self,
        org: str = "",
        *,
        enabled: bool,
        new_machines_only: bool = False,
        apply_existing: bool | None = None,
    ) -> OrgIdleIgnoreOutboundDefaultResult:
        """Set whether machines in this org run with ``idle_ignore_outbound``
        on: only connections opened TO a machine reset its idle clock, so its
        own outbound traffic no longer keeps it awake. Requires org admin.

        It is also set at once on the org's existing machines and snapshots
        you can manage (your own and the shared ones), and running machines
        pick it up without a restart. Pass ``new_machines_only=True`` to leave
        existing machines as they are. Other members' private machines are
        never changed. A create that passes ``idle_ignore_outbound`` itself
        still wins, and a fork or a restore keeps its source's value. The
        result counts what changed and what was left alone.

        ``apply_existing`` is still accepted from code written before existing
        machines changed by default, and changes nothing.
        """
        if enabled is None:
            raise ValueError(
                "set_idle_ignore_outbound_default needs enabled=True or False. "
                "To drop the default, call clear_idle_ignore_outbound_default"
            )
        return m.org_idle_ignore_outbound_default_result(
            self._transport.call(
                "SetOrgIdleIgnoreOutboundDefault",
                req.set_org_idle_ignore_outbound_default(
                    org=org,
                    enabled=enabled,
                    new_machines_only=new_machines_only,
                    apply_existing=apply_existing,
                ),
            )
        )

    def get_idle_ignore_outbound_default(
        self, org: str = ""
    ) -> OrgIdleIgnoreOutboundDefault:
        """The org's default for ``idle_ignore_outbound``.

        Readable by any member. ``is_set`` false means the org stores no
        default and ``enabled`` is the platform's setting.
        """
        return m.org_idle_ignore_outbound_default(
            self._transport.call(
                "GetOrgIdleIgnoreOutboundDefault",
                api_pb2.GetOrgIdleIgnoreOutboundDefaultRequest(org_id=org),
            )
        )

    def clear_idle_ignore_outbound_default(self, org: str = "") -> None:
        """Drop the org's ``idle_ignore_outbound`` default, so new machines
        follow the platform's setting again unless their create says
        otherwise. Requires org admin. Existing machines keep their value."""
        self._transport.call(
            "SetOrgIdleIgnoreOutboundDefault",
            req.set_org_idle_ignore_outbound_default(org=org, enabled=None),
        )

    def set_bot_protection_default(
        self,
        org: str = "",
        *,
        mode: BotProtectionMode,
        new_machines_only: bool = False,
    ) -> OrgBotProtectionDefaultResult:
        """Set the bot protection mode machines in this org start with.
        Requires org admin.

        ``"on"`` checks visitors in every state, ``"sleep_only"`` only when a
        request would wake the machine, ``"off"`` never; see
        :meth:`Machines.set_bot_protection`.

        It is also set at once on the org's existing machines and snapshots
        you can manage (your own and the shared ones), except machines whose
        bot protection is off. Pass ``new_machines_only=True`` to leave
        existing machines as they are. Other members' private machines are
        never changed, and a fork or a restore keeps its source's mode. The
        result counts what changed and what was left alone.
        """
        return m.org_bot_protection_default_result(
            self._transport.call(
                "SetOrgBotProtectionDefault",
                api_pb2.SetOrgBotProtectionDefaultRequest(
                    org_id=org,
                    mode=_bot_protection_default_mode(mode),
                    new_machines_only=new_machines_only,
                ),
            )
        )

    def get_bot_protection_default(self, org: str = "") -> OrgBotProtectionDefault:
        """The bot protection mode new machines in the org start with.

        Readable by any member. ``is_set`` false means the org stores no
        default and ``mode`` is the platform's setting.
        """
        return m.org_bot_protection_default(
            self._transport.call(
                "GetOrgBotProtectionDefault",
                api_pb2.GetOrgBotProtectionDefaultRequest(org_id=org),
            )
        )

    def clear_bot_protection_default(self, org: str = "") -> None:
        """Drop the org's default bot protection, so new machines follow the
        platform's setting again. Requires org admin. Existing machines keep
        their mode."""
        self._transport.call(
            "SetOrgBotProtectionDefault",
            api_pb2.SetOrgBotProtectionDefaultRequest(org_id=org, mode=""),
        )

    def get_machine_limit(self, org: str = "") -> OrgMachineLimit:
        """The org's machine limit, how many machines count against it, and
        the open request for a higher one.

        Readable by any member, with a login or an API key issued for the
        org; not from a token minted inside a machine.
        """
        return m.org_machine_limit(
            self._transport.call(
                "GetOrgMachineLimit",
                api_pb2.GetOrgMachineLimitRequest(org_id=org),
            )
        )

    def request_machine_limit(
        self, max_vms: int, *, message: str | None = None, org: str = ""
    ) -> MachineLimitRequest:
        """Ask boxd for a higher machine limit. The org's owner only, with
        their login or an API key of theirs issued for the org.

        ``max_vms`` is the new total wanted: above the current limit, at most
        1000. ``message`` (optional, at most 1000 characters) says why. The
        owner gets an email when the limit changes; until then the request
        stays open and another one raises `ConflictError`. Anyone else gets
        `PermissionDeniedError`, an out-of-range limit or message
        `BoxdError` with code ``invalid_argument``.
        """
        if isinstance(max_vms, bool) or not isinstance(max_vms, int) or max_vms < 1:
            raise ValueError(f"max_vms must be a whole number above 0, not {max_vms!r}")
        resp = self._transport.call(
            "RequestOrgMachineLimit",
            api_pb2.RequestOrgMachineLimitRequest(
                org_id=org, max_vms=max_vms, message=message or ""
            ),
        )
        return m.opened_machine_limit_request(resp)

    def usage(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
    ) -> OrgUsage:
        """What each machine in the org used and cost over a window.

        Most expensive first, including machines deleted since. `since`
        defaults to 28 days before `until`, `until` to now; each is a datetime
        or unix seconds, and the window spans at most 366 days. Costs are
        estimates at the org's current rates; `billing_activity()` is what was actually
        charged.

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.org_usage(
            self._transport.call(
                "GetOrgUsage",
                api_pb2.GetOrgUsageRequest(
                    org=org,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                ),
            )
        )

    def billing_activity_page(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        page_token: str = "",
        page_size: int = 0,
    ) -> BillingActivityPage:
        """One page of the org's billing activity, newest first.

        Top-ups, grants and usage charges (one org-wide charge per 15
        minutes): what was actually charged. Omit `since` and `until` for the
        whole history. Pass the returned `next_page_token` as `page_token`
        for the next page, or iterate every entry with `billing_activity()`.
        `page_size` defaults to 500, at most 1000.

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.billing_activity_page(
            self._transport.call(
                "ListBillingActivity",
                api_pb2.ListBillingActivityRequest(
                    org=org,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                    page_token=page_token,
                    page_size=page_size,
                ),
            )
        )

    def billing_activity(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        page_size: int = 0,
    ) -> Iterator[BillingActivityEntry]:
        """Every billing activity entry in the window, newest first, fetching pages as
        you go::

            for e in boxd.orgs.billing_activity(since=datetime(2026, 9, 1)):
                print(e.created_at, e.kind, e.amount_micro / 1e6)
        """
        token = ""
        while True:
            page = self.billing_activity_page(
                org=org, since=since, until=until, page_token=token, page_size=page_size
            )
            yield from page.entries
            if not page.next_page_token:
                return
            token = page.next_page_token


class AsyncOrgs(Namespace):
    """Async twin of :class:`Orgs`."""

    async def list(self) -> list[Org]:
        """Every org the caller is a member of, plus their default org."""
        resp = await self._transport.call("ListOrgs", api_pb2.ListOrgsRequest())
        return [m.org(o, resp.default_org_id) for o in resp.orgs]

    async def create(self, name: str) -> CreatedOrg:
        """Create a new org. You become its owner and admin.

        Unlike every other org method here, this has no `org` parameter —
        there's nothing to scope to yet.
        """
        return m.created_org(
            await self._transport.call(
                "CreateOrg", api_pb2.CreateOrgRequest(name=name)
            )
        )

    async def rename(self, name: str, org: str = "") -> None:
        """Rename an org. Requires org admin."""
        await self._transport.call(
            "RenameOrg", api_pb2.RenameOrgRequest(org_id=org, name=name)
        )

    async def get_members(self, org: str = "") -> OrgMembers:
        """The org's roster, plus pending invites.

        Invites are populated for org admins only — a plain member always
        sees an empty invite list, matching the console.
        """
        return m.org_members(
            await self._transport.call(
                "GetOrgMembers", api_pb2.GetOrgMembersRequest(org_id=org)
            )
        )

    async def invite(
        self, email: str, *, role: str = "member", org: str = ""
    ) -> OrgInvite:
        """Invite someone to the org by email. Requires org admin.

        Best-effort emails the invite link (when the cluster has email
        configured) — `accept_url` on the result always works regardless, so
        delivery failing (or not being configured) never loses the invite.
        `email_status` on the result says whether the email went out.
        """
        resp = await self._transport.call(
            "InviteOrgMember",
            api_pb2.InviteOrgMemberRequest(org_id=org, email=email, role=role),
        )
        return m.invited_org_member(resp, email, role)

    async def revoke_invite(self, token: str) -> None:
        """Revoke a pending invite. Requires org admin of the invite's org."""
        await self._transport.call(
            "RevokeOrgInvite", api_pb2.RevokeOrgInviteRequest(token=token)
        )

    async def remove_member(self, user_id: str, org: str = "") -> None:
        """Remove a plain member from the org. Requires org admin.

        Refused for an org owner/admin (only the platform can remove those) or for a
        member who still owns machines billed to this org — move them to
        personal billing or destroy them first.
        """
        await self._transport.call(
            "RemoveOrgMember",
            api_pb2.RemoveOrgMemberRequest(org_id=org, user_id=user_id),
        )

    async def set_member_role(self, user_id: str, role: str, org: str = "") -> None:
        """Promote a member to ``"admin"`` or demote an admin to ``"member"``.

        Requires org admin. Demoting another admin is owner-only (you can
        always demote yourself). Refused for the org owner, whose ownership
        is transferred by the platform instead.
        """
        await self._transport.call(
            "SetOrgMemberRole",
            api_pb2.SetOrgMemberRoleRequest(org_id=org, user_id=user_id, role=role),
        )

    async def set_domain(self, org: str, domain: str) -> OrgDomain:
        """Set the org's wildcard apex (e.g. "preview.mysaas.com").

        Requires org admin. Starts verification immediately — call this only
        after delegation is actually live: a whole domain ("mysaas.com") gets
        boxd's cluster nameservers set at its registrar, a subdomain
        ("preview.mysaas.com") gets NS records for them in its parent
        domain's DNS. Checking before delegation is live risks a public
        resolver caching the "no records" answer, delaying propagation once
        delegation is actually there. A control loop then verifies
        delegation, issues certs, and flips the domain to `active`.
        """
        resp = await self._transport.call(
            "SetOrgDomain", api_pb2.SetOrgDomainRequest(org_id=org, domain=domain)
        )
        return m.org_domain(resp.domain)

    async def get_domain(self, org: str) -> OrgDomain | None:
        """The org's current wildcard domain, or `None` if unset."""
        resp = await self._transport.call(
            "GetOrgDomain", api_pb2.GetOrgDomainRequest(org_id=org)
        )
        return m.org_domain(resp.domain) if resp.HasField("domain") else None

    async def clear_domain(self, org: str) -> None:
        """Remove the org's wildcard domain. Requires org admin."""
        await self._transport.call(
            "ClearOrgDomain", api_pb2.ClearOrgDomainRequest(org_id=org)
        )

    async def set_machine_defaults(
        self,
        org: str = "",
        *,
        vcpu: int | None = None,
        memory: int | str | None = None,
    ) -> None:
        """Set the size machines in this org are born at. Requires org admin.

        Name either dimension and the server resolves the whole size class
        (1 vCPU/4 GiB, 2/8 GiB, 4/16 GiB); it must sit at or under the org
        quota. This is a preference below the quota, not the quota itself —
        the quota stays the operator-owned ceiling and the per-request
        maximum.

        Only machines created afterwards are affected. Every existing machine
        keeps the size it was created with; use `machines.resize` to move one.
        """
        if vcpu is None and memory is None:
            raise ValueError(
                "set_machine_defaults needs vcpu or memory - either one names "
                "a size class. To drop the default, call clear_machine_defaults"
            )
        await self._transport.call(
            "SetOrgMachineDefaults",
            req.set_org_machine_defaults(org=org, vcpu=vcpu, memory=memory),
        )

    async def get_machine_defaults(self, org: str = "") -> OrgMachineDefaults:
        """The org's default machine size, and the quota above it.

        Readable by any member. `is_set` false means no explicit default is
        stored and the effective size is simply the quota ceiling.
        """
        return m.org_machine_defaults(
            await self._transport.call(
                "GetOrgMachineDefaults",
                api_pb2.GetOrgMachineDefaultsRequest(org_id=org),
            )
        )

    async def clear_machine_defaults(self, org: str = "") -> None:
        """Drop the org's default size, so new machines are born at the org
        quota again. Requires org admin. Existing machines are untouched."""
        await self._transport.call(
            "SetOrgMachineDefaults",
            req.set_org_machine_defaults(org=org, vcpu=None, memory=None),
        )

    async def set_idle_ignore_outbound_default(
        self,
        org: str = "",
        *,
        enabled: bool,
        new_machines_only: bool = False,
        apply_existing: bool | None = None,
    ) -> OrgIdleIgnoreOutboundDefaultResult:
        """See :meth:`Orgs.set_idle_ignore_outbound_default`."""
        if enabled is None:
            raise ValueError(
                "set_idle_ignore_outbound_default needs enabled=True or False. "
                "To drop the default, call clear_idle_ignore_outbound_default"
            )
        return m.org_idle_ignore_outbound_default_result(
            await self._transport.call(
                "SetOrgIdleIgnoreOutboundDefault",
                req.set_org_idle_ignore_outbound_default(
                    org=org,
                    enabled=enabled,
                    new_machines_only=new_machines_only,
                    apply_existing=apply_existing,
                ),
            )
        )

    async def get_idle_ignore_outbound_default(
        self, org: str = ""
    ) -> OrgIdleIgnoreOutboundDefault:
        """See :meth:`Orgs.get_idle_ignore_outbound_default`."""
        return m.org_idle_ignore_outbound_default(
            await self._transport.call(
                "GetOrgIdleIgnoreOutboundDefault",
                api_pb2.GetOrgIdleIgnoreOutboundDefaultRequest(org_id=org),
            )
        )

    async def clear_idle_ignore_outbound_default(self, org: str = "") -> None:
        """See :meth:`Orgs.clear_idle_ignore_outbound_default`."""
        await self._transport.call(
            "SetOrgIdleIgnoreOutboundDefault",
            req.set_org_idle_ignore_outbound_default(org=org, enabled=None),
        )

    async def set_bot_protection_default(
        self,
        org: str = "",
        *,
        mode: BotProtectionMode,
        new_machines_only: bool = False,
    ) -> OrgBotProtectionDefaultResult:
        """See :meth:`Orgs.set_bot_protection_default`."""
        return m.org_bot_protection_default_result(
            await self._transport.call(
                "SetOrgBotProtectionDefault",
                api_pb2.SetOrgBotProtectionDefaultRequest(
                    org_id=org,
                    mode=_bot_protection_default_mode(mode),
                    new_machines_only=new_machines_only,
                ),
            )
        )

    async def get_bot_protection_default(
        self, org: str = ""
    ) -> OrgBotProtectionDefault:
        """See :meth:`Orgs.get_bot_protection_default`."""
        return m.org_bot_protection_default(
            await self._transport.call(
                "GetOrgBotProtectionDefault",
                api_pb2.GetOrgBotProtectionDefaultRequest(org_id=org),
            )
        )

    async def clear_bot_protection_default(self, org: str = "") -> None:
        """See :meth:`Orgs.clear_bot_protection_default`."""
        await self._transport.call(
            "SetOrgBotProtectionDefault",
            api_pb2.SetOrgBotProtectionDefaultRequest(org_id=org, mode=""),
        )

    async def get_machine_limit(self, org: str = "") -> OrgMachineLimit:
        """The org's machine limit, how many machines count against it, and
        the open request for a higher one.

        Readable by any member, with a login or an API key issued for the
        org; not from a token minted inside a machine.
        """
        return m.org_machine_limit(
            await self._transport.call(
                "GetOrgMachineLimit",
                api_pb2.GetOrgMachineLimitRequest(org_id=org),
            )
        )

    async def request_machine_limit(
        self, max_vms: int, *, message: str | None = None, org: str = ""
    ) -> MachineLimitRequest:
        """Ask boxd for a higher machine limit. The org's owner only, with
        their login or an API key of theirs issued for the org.

        ``max_vms`` is the new total wanted: above the current limit, at most
        1000. ``message`` (optional, at most 1000 characters) says why. The
        owner gets an email when the limit changes; until then the request
        stays open and another one raises `ConflictError`. Anyone else gets
        `PermissionDeniedError`, an out-of-range limit or message
        `BoxdError` with code ``invalid_argument``.
        """
        if isinstance(max_vms, bool) or not isinstance(max_vms, int) or max_vms < 1:
            raise ValueError(f"max_vms must be a whole number above 0, not {max_vms!r}")
        resp = await self._transport.call(
            "RequestOrgMachineLimit",
            api_pb2.RequestOrgMachineLimitRequest(
                org_id=org, max_vms=max_vms, message=message or ""
            ),
        )
        return m.opened_machine_limit_request(resp)

    async def usage(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
    ) -> OrgUsage:
        """What each machine in the org used and cost over a window.

        Most expensive first, including machines deleted since. `since`
        defaults to 28 days before `until`, `until` to now; each is a datetime
        or unix seconds, and the window spans at most 366 days. Costs are
        estimates at the org's current rates; `billing_activity()` is what was actually
        charged.

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.org_usage(
            await self._transport.call(
                "GetOrgUsage",
                api_pb2.GetOrgUsageRequest(
                    org=org,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                ),
            )
        )

    async def billing_activity_page(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        page_token: str = "",
        page_size: int = 0,
    ) -> BillingActivityPage:
        """One page of the org's billing activity, newest first.

        Top-ups, grants and usage charges (one org-wide charge per 15
        minutes): what was actually charged. Omit `since` and `until` for the
        whole history. Pass the returned `next_page_token` as `page_token`
        for the next page, or iterate every entry with `billing_activity()`.
        `page_size` defaults to 500, at most 1000.

        Org owners and admins only. Works with an API key issued for the org.
        """
        return m.billing_activity_page(
            await self._transport.call(
                "ListBillingActivity",
                api_pb2.ListBillingActivityRequest(
                    org=org,
                    since=req.unix_seconds(since),
                    until=req.unix_seconds(until),
                    page_token=page_token,
                    page_size=page_size,
                ),
            )
        )

    async def billing_activity(
        self,
        *,
        org: str = "",
        since: datetime | int | None = None,
        until: datetime | int | None = None,
        page_size: int = 0,
    ) -> AsyncIterator[BillingActivityEntry]:
        """Every billing activity entry in the window, newest first, fetching pages as
        you go (``async for e in boxd.orgs.billing_activity(): ...``)."""
        token = ""
        while True:
            page = await self.billing_activity_page(
                org=org, since=since, until=until, page_token=token, page_size=page_size
            )
            for e in page.entries:
                yield e
            if not page.next_page_token:
                return
            token = page.next_page_token
