import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { BoxdError } from "./errors.js";
import { parseSize, toUnixSeconds, type TimeBound } from "./utils.js";
import {
  toCreatedOrg,
  toInvitedOrgMember,
  toOrg,
  toOrgDomain,
  toBillingActivityPage,
  toOrgIdleIgnoreOutboundDefault,
  toOrgIdleIgnoreOutboundDefaultResult,
  toOrgBotProtectionDefault,
  toOrgBotProtectionDefaultResult,
  toMachineLimitRequest,
  toOrgMachineDefaults,
  toOrgMachineLimit,
  toOrgMembers,
  toOrgUsage,
  type BillingActivityEntry,
  type BillingActivityPage,
  type BotProtectionMode,
  type CreatedOrg,
  type Org,
  type OrgBotProtectionDefault,
  type OrgBotProtectionDefaultResult,
  type OrgDomain,
  type OrgIdleIgnoreOutboundDefault,
  type OrgIdleIgnoreOutboundDefaultResult,
  type OrgInvite,
  type MachineLimitRequest,
  type OrgMachineDefaults,
  type OrgMachineLimit,
  type OrgMembers,
  type OrgUsage,
} from "./models.js";
import type {
  ClearOrgDomainRequest,
  ClearOrgDomainResponse,
  GetOrgDomainRequest,
  GetOrgDomainResponse,
  GetOrgMachineDefaultsRequest,
  GetOrgMachineDefaultsResponse,
  ListOrgsRequest,
  ListOrgsResponse,
  SetOrgDomainRequest,
  SetOrgDomainResponse,
  SetOrgMachineDefaultsRequest,
  SetOrgMachineDefaultsResponse,
} from "./_generated/definitions.js";

/**
 * Either field names a whole size class, so one of them is enough. Passing
 * neither would clear the default on the wire, which `clearMachineDefaults`
 * says out loud — so `setMachineDefaults` refuses it instead.
 */
export interface OrgMachineDefaultsParams {
  vcpu?: number;
  /** One of the supported sizes: `"4G"`, `"8G"`, `"16G"`, `"32G"`. */
  memory?: string;
}

/**
 * `enabled` is required: leaving it out would clear the default on the wire,
 * which `clearIdleIgnoreOutboundDefault` says out loud, so
 * `setIdleIgnoreOutboundDefault` refuses it instead.
 */
export interface OrgIdleIgnoreOutboundDefaultParams {
  /** What new machines in the org start with when their create does not say. */
  enabled: boolean;
  /**
   * Leave existing machines as they are: only machines created from now on
   * start with it. Without it, `enabled` is also set on the org's existing
   * machines and snapshots you can manage.
   */
  newMachinesOnly?: boolean;
  /**
   * Accepted from code written before existing machines changed by default;
   * changes nothing. `true` together with `newMachinesOnly: true` is refused.
   */
  applyExisting?: boolean;
}

/** Which org's usage, and over what window. */
/** `requestMachineLimit`'s optional parts. */
export interface OrgMachineLimitRequestParams {
  /** Why you need them; at most 1000 characters. */
  message?: string;
  /** Name or id; empty = your home org (an API key's own org). */
  org?: string;
}

export interface OrgUsageParams {
  /** Org name or id. Omit for your default org (with an API key: the key's org). */
  org?: string;
  /** Window start. Omit for the 28 days before `until`. */
  since?: TimeBound;
  /** Window end, exclusive. Omit for now. At most 366 days after `since`. */
  until?: TimeBound;
}

/** Which org's billing activity, over what window, and which page. */
export interface OrgBillingActivityParams {
  /** Org name or id. Omit for your default org (with an API key: the key's org). */
  org?: string;
  /** Only entries created at or after this. Omit both bounds for the whole history. */
  since?: TimeBound;
  /** Only entries created before this. */
  until?: TimeBound;
  /** Entries per page: default 500, at most 1000. */
  pageSize?: number;
}

/**
 * Organizations. There is one org type — your own org is a normal org,
 * selected by name like any other.
 */
export class Orgs {
  constructor(private readonly transport: Transport) {}

  /** The orgs you are a member of, plus your default org's id. */
  async list(): Promise<Org[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listOrgs,
      {},
    );
    // `defaultOrgId` used to ride along beside the array; it is now a flag on
    // each org, so the return stays a plain array.
    return (resp.orgs ?? []).map((o) => toOrg(o, resp.defaultOrgId));
  }

  /**
   * Create a new org. You become its owner and admin.
   *
   * Unlike every other org method here, this takes no `org` parameter —
   * there's nothing to scope to yet.
   */
  async create(name: string): Promise<CreatedOrg> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createOrg, { name });
    return toCreatedOrg(resp);
  }

  /** Rename an org. Requires org admin. `org` defaults to your home org. */
  async rename(name: string, org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.renameOrg, { orgId: org, name });
  }

  /**
   * The org's roster, plus pending invites. Invites are populated for org
   * admins only — a plain member always sees an empty invite list, matching
   * the console. `org` defaults to your home org.
   */
  async getMembers(org = ""): Promise<OrgMembers> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgMembers, { orgId: org });
    return toOrgMembers(resp);
  }

  /**
   * Invite someone to the org by email. Requires org admin.
   *
   * Best-effort emails the invite link (when the cluster has email
   * configured) — `acceptUrl` on the result always works regardless, so
   * delivery failing (or not being configured) never loses the invite.
   * `emailStatus` on the result says whether the email went out.
   * `org` defaults to your home org.
   */
  async invite(email: string, params: { role?: string; org?: string } = {}): Promise<OrgInvite> {
    const role = params.role ?? "member";
    const resp = await this.transport.unary(BoxdApiDefinition.methods.inviteOrgMember, {
      orgId: params.org ?? "",
      email,
      role,
    });
    return toInvitedOrgMember(resp, email, role);
  }

  /** Revoke a pending invite. Requires org admin of the invite's org. */
  async revokeInvite(token: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.revokeOrgInvite, { token });
  }

  /**
   * Remove a plain member from the org. Requires org admin.
   *
   * Refused for an org owner/admin (only the platform can remove those) or for a
   * member who still owns machines billed to this org — move them to
   * personal billing or destroy them first. `org` defaults to your home org.
   */
  async removeMember(userId: string, org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.removeOrgMember, { orgId: org, userId });
  }

  /**
   * Promote a member to `"admin"` or demote an admin to `"member"`.
   *
   * Requires org admin. Demoting another admin is owner-only (you can
   * always demote yourself). Refused for the org owner, whose ownership is
   * transferred by the platform instead. `org` defaults to your home org.
   */
  async setMemberRole(userId: string, role: "admin" | "member", org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setOrgMemberRole, { orgId: org, userId, role });
  }

  /**
   * Set the org's wildcard apex (e.g. "preview.mysaas.com").
   *
   * Requires org admin. Starts verification immediately — call this only
   * after delegation is actually live: a whole domain ("mysaas.com") gets
   * boxd's cluster nameservers set at its registrar, a subdomain
   * ("preview.mysaas.com") gets NS records for them in its parent domain's
   * DNS. Checking before delegation is live risks a public resolver caching
   * the "no records" answer, delaying propagation once delegation is
   * actually there. A control loop then verifies delegation, issues certs,
   * and flips it to `active`.
   */
  async setDomain(org: string, domain: string): Promise<OrgDomain> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setOrgDomain,
      { orgId: org, domain },
    );
    return toOrgDomain(resp.domain!);
  }

  /** The org's current wildcard domain, or `null` if unset. */
  async getDomain(org: string): Promise<OrgDomain | null> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgDomain,
      { orgId: org },
    );
    return resp.domain ? toOrgDomain(resp.domain) : null;
  }

  /** Remove the org's wildcard domain. Requires org admin. */
  async clearDomain(org: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.clearOrgDomain,
      { orgId: org },
    );
  }

  /**
   * Set the size machines in this org are born at. Requires org admin.
   *
   * Name either dimension and the server resolves the whole size class
   * (1 vCPU/4 GiB, 2/8 GiB, 4/16 GiB); it must sit at or under the org quota.
   * This is a preference below the quota, not the quota itself — the quota
   * stays the operator-owned ceiling and the per-request maximum.
   *
   * Only machines created afterwards are affected. Every existing machine
   * keeps the size it was created with; use `machines.resize` to move one.
   *
   * `org` defaults to your home org.
   */
  async setMachineDefaults(org = "", params: OrgMachineDefaultsParams = {}): Promise<void> {
    if (params.vcpu === undefined && params.memory === undefined) {
      throw new BoxdError(
        "setMachineDefaults needs vcpu or memory - either one names a size class. " +
          "To drop the default, call clearMachineDefaults",
      );
    }
    await this.transport.unary(BoxdApiDefinition.methods.setOrgMachineDefaults,
      {
        orgId: org,
        // `optional` on the wire, and absence is what clears the default — so
        // an unset field must stay undefined rather than become 0.
        vcpu: params.vcpu,
        memoryBytes: params.memory === undefined ? undefined : parseSize(params.memory),
      },
    );
  }

  /**
   * The org's default machine size, and the quota above it. Readable by any
   * member. `isSet` false means no explicit default is stored and the
   * effective size is simply the quota ceiling.
   */
  async getMachineDefaults(org = ""): Promise<OrgMachineDefaults> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgMachineDefaults, { orgId: org });
    return toOrgMachineDefaults(resp);
  }

  /**
   * Drop the org's default size, so new machines are born at the org quota
   * again. Requires org admin. Existing machines are untouched.
   */
  async clearMachineDefaults(org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setOrgMachineDefaults,
      { orgId: org, vcpu: undefined, memoryBytes: undefined },
    );
  }

  /**
   * Set whether machines in this org run with `idleIgnoreOutbound` on: only
   * connections opened TO a machine reset its idle clock, so its own outbound
   * traffic no longer keeps it awake. Requires org admin.
   *
   * It is also set at once on the org's existing machines and snapshots you
   * can manage (your own and the shared ones), and running machines pick it
   * up without a restart. Pass `newMachinesOnly: true` to leave existing
   * machines as they are. Other members' private machines are never changed.
   * A create that names `config.idleIgnoreOutbound` itself still wins, and a
   * fork or a restore keeps its source's value. The result counts what
   * changed and what was left alone.
   *
   * `org` defaults to your home org.
   */
  async setIdleIgnoreOutboundDefault(
    org = "",
    params: OrgIdleIgnoreOutboundDefaultParams,
  ): Promise<OrgIdleIgnoreOutboundDefaultResult> {
    if (typeof params?.enabled !== "boolean") {
      throw new BoxdError(
        "setIdleIgnoreOutboundDefault needs enabled: true or false. " +
          "To drop the default, call clearIdleIgnoreOutboundDefault",
      );
    }
    const newMachinesOnly = params.newMachinesOnly ?? false;
    if (newMachinesOnly && params.applyExisting) {
      throw new BoxdError(
        "applyExisting: true and newMachinesOnly: true contradict each other: " +
          "existing machines change unless newMachinesOnly is true",
      );
    }
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setOrgIdleIgnoreOutboundDefault, {
      orgId: org,
      enabled: params.enabled,
      newMachinesOnly,
      // An older server reads only `applyExisting`; sent as the
      // opposite of `newMachinesOnly`, it does the same there.
      applyExisting: !newMachinesOnly,
    });
    return toOrgIdleIgnoreOutboundDefaultResult(resp);
  }

  /**
   * The org's default for `idleIgnoreOutbound`. Readable by any member.
   * `isSet` false means the org stores no default and `enabled` is the
   * platform's setting.
   */
  async getIdleIgnoreOutboundDefault(org = ""): Promise<OrgIdleIgnoreOutboundDefault> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgIdleIgnoreOutboundDefault,
      { orgId: org },
    );
    return toOrgIdleIgnoreOutboundDefault(resp);
  }

  /**
   * Drop the org's `idleIgnoreOutbound` default, so new machines follow the
   * platform's setting again unless their create says otherwise. Requires org
   * admin. Existing machines keep their value.
   */
  async clearIdleIgnoreOutboundDefault(org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setOrgIdleIgnoreOutboundDefault,
      // `enabled` is `optional` on the wire, and absence is what clears the
      // default. An older server refuses `applyExisting` without it.
      { orgId: org, enabled: undefined, applyExisting: false, newMachinesOnly: false },
    );
  }

  /**
   * Set the bot protection mode machines in this org start with. Requires
   * org admin.
   *
   * `"on"` checks visitors in every state, `"sleep_only"` only when a request
   * would wake the machine, `"off"` never; see `machines.setBotProtection`.
   *
   * It is also set at once on the org's existing machines and snapshots you
   * can manage (your own and the shared ones), except machines whose bot
   * protection is off. Pass `{ newMachinesOnly: true }` to leave existing
   * machines as they are. Other members' private machines are never changed,
   * and a fork or a restore keeps its source's mode. The result counts what
   * changed and what was left alone.
   *
   * Pass `""` as `org` for your home org.
   */
  async setBotProtectionDefault(
    org: string,
    mode: BotProtectionMode,
    opts: { newMachinesOnly?: boolean } = {},
  ): Promise<OrgBotProtectionDefaultResult> {
    // An empty mode CLEARS the default on the wire, so a missing or mistyped
    // one from untyped code is refused here rather than sent.
    if (mode !== "on" && mode !== "sleep_only" && mode !== "off") {
      throw new BoxdError(
        `mode must be "on", "sleep_only" or "off", not ${JSON.stringify(mode)}. ` +
          "To drop the default, call clearBotProtectionDefault",
      );
    }
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setOrgBotProtectionDefault, {
      orgId: org,
      mode,
      newMachinesOnly: opts.newMachinesOnly ?? false,
    });
    return toOrgBotProtectionDefaultResult(resp);
  }

  /**
   * The bot protection mode new machines in the org start with. Readable by
   * any member. `isSet` false means the org stores no default and `mode` is
   * the platform's setting.
   */
  async getBotProtectionDefault(org = ""): Promise<OrgBotProtectionDefault> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgBotProtectionDefault, { orgId: org });
    return toOrgBotProtectionDefault(resp);
  }

  /**
   * Drop the org's default bot protection, so new machines follow the
   * platform's setting again. Requires org admin. Existing machines keep
   * their mode.
   */
  async clearBotProtectionDefault(org = ""): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setOrgBotProtectionDefault, {
      orgId: org,
      mode: "",
      newMachinesOnly: false,
    });
  }

  /**
   * What each machine in the org used and cost over a window, most expensive
   * first, including machines deleted since. Costs are estimates at the org's
   * current rates; {@link Orgs.billingActivity} is what was actually charged.
   *
   * Org owners and admins only. Works with an API key issued for the org.
   */
  /**
   * The org's machine limit, how many machines count against it, and the
   * open request for a higher one. Readable by any member, with a login or
   * an API key issued for the org; not from a token minted inside a machine.
   */
  async getMachineLimit(org = ""): Promise<OrgMachineLimit> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgMachineLimit, { orgId: org });
    return toOrgMachineLimit(resp);
  }

  /**
   * Ask boxd for a higher machine limit. The org's owner only, with their
   * login or an API key of theirs issued for the org.
   *
   * `maxVms` is the new total wanted: above the current limit, at most 1000.
   * The owner gets an email when the limit changes; until then the request
   * stays open and another one throws `ConflictError`. Anyone else gets
   * `PermissionDeniedError`; an out-of-range limit or message an `APIStatusError`
   * whose `grpcCode` is 3 (INVALID_ARGUMENT), with the reason as its message.
   */
  async requestMachineLimit(maxVms: number, params: OrgMachineLimitRequestParams = {}): Promise<MachineLimitRequest> {
    if (!Number.isInteger(maxVms) || maxVms < 1) {
      throw new BoxdError(`maxVms must be a whole number above 0, not ${String(maxVms)}`);
    }
    const resp = await this.transport.unary(BoxdApiDefinition.methods.requestOrgMachineLimit, {
      orgId: params.org ?? "",
      maxVms,
      message: params.message ?? "",
    });
    return toMachineLimitRequest(resp);
  }

  async usage(params: OrgUsageParams = {}): Promise<OrgUsage> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getOrgUsage, {
      org: params.org ?? "",
      since: toUnixSeconds(params.since),
      until: toUnixSeconds(params.until),
    });
    return toOrgUsage(resp);
  }

  /**
   * One page of the org's billing activity, newest first: top-ups, grants and
   * usage charges (one org-wide charge per 15 minutes). This is what was
   * actually charged. Pass the returned `nextPageToken` as `pageToken` for
   * the next page, or iterate every entry with {@link Orgs.billingActivity}.
   *
   * Org owners and admins only. Works with an API key issued for the org.
   */
  async billingActivityPage(params: OrgBillingActivityParams & { pageToken?: string } = {}): Promise<BillingActivityPage> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listBillingActivity, {
      org: params.org ?? "",
      since: toUnixSeconds(params.since),
      until: toUnixSeconds(params.until),
      pageToken: params.pageToken ?? "",
      pageSize: params.pageSize ?? 0,
    });
    return toBillingActivityPage(resp);
  }

  /**
   * Every billing activity entry in the window, newest first, fetching pages as you
   * go:
   *
   * ```ts
   * for await (const e of boxd.orgs.billingActivity({ since: new Date("2026-09-01") })) {
   *   console.log(e.createdAt, e.kind, e.amountMicro / 1e6);
   * }
   * ```
   */
  async *billingActivity(params: OrgBillingActivityParams = {}): AsyncGenerator<BillingActivityEntry, void, undefined> {
    let pageToken = "";
    do {
      const page = await this.billingActivityPage({ ...params, pageToken });
      yield* page.entries;
      pageToken = page.nextPageToken ?? "";
    } while (pageToken !== "");
  }
}
