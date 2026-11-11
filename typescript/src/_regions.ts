/**
 * @internal
 * Regions: which endpoint each call goes to.
 *
 * boxd runs one cluster per region. The client's base URL is its home:
 * account, org, API-key, env-var and billing calls always go there. A call on
 * a machine, snapshot or disk (and everything under a machine: exec, files,
 * proxies, checkpoints, backups, ...) goes to the region named by the call's
 * `region`, else by the client's (`new Boxd({ region })`, `BOXD_REGION`),
 * else home, which is where every call went before regions existed.
 *
 * A region's endpoint comes from `ListRegions` asked at home, once per client
 * and org; it is asked again (once) when a region is missing from the answer
 * or not enabled in it yet. One credential works in every region, so every
 * region's transport shares the client's.
 *
 * A call that names no org means the caller's default org. Home resolves
 * that itself, but a region holds only the orgs that enabled it, so the
 * default it would pick can be another org. A region other than home is
 * sent the org home's `ListRegions` answer names instead.
 *
 * Direct mode skips home. Asking it first costs a round trip to home before
 * the first call to a region, which from far away is most of the wait. With
 * an API key sent as itself (`auth.ts`) and a call that names no org, the
 * call needs neither thing that answer gives: the key belongs to one org,
 * which the region applies, and the region checks the key itself. So such a
 * call goes straight to the region's name derived from home's,
 * `<region>.<home host>` on home's scheme and port (`regionBaseURL`), sent as
 * it is. When it fails there before reaching a handler (a connection error,
 * or the region refusing the key: "API key not recognized in region …", or
 * as a server from before raw keys does), the region is asked through home
 * for the rest of the client's life and the call is sent again that way,
 * which is also where an unknown or not-enabled region is reported. Only a
 * unary call is sent again, so a stream goes to the derived name only once a
 * unary call there was answered. Calls that name an org, `"all"` lists,
 * tokens, in-machine credentials, a key that is exchanged, and a home whose
 * host is an IP address, `localhost` or one label keep asking home.
 *
 * {@link RegionRouter} is itself a {@link Transport}, so the namespaces only
 * pass `{ region }` through and never see an endpoint. Nothing here imports
 * grpc-js or a Node builtin: the web entry uses it too.
 */
import {
  BoxdApiDefinition,
  type ElsewhereItem as WireElsewhereItem,
  type FindElsewhereResponse,
  type ListRegionsResponse,
  type Region as WireRegion,
} from "./_generated/definitions.js";
import type {
  CallOptions,
  UnaryOptions,
  DuplexCall,
  MethodDef,
  ReadableCall,
  RegionPages,
  Transport,
  WritableCall,
} from "./_rpc.js";
import { refusesRawKey } from "./auth.js";
import {
  APIConnectionError,
  AuthenticationError,
  BoxdError,
  GrpcStatus,
  NotFoundError,
  RegionNotEnabledError,
  type ElsewhereItem,
} from "./errors.js";
import { consoleBaseUrl, regionBaseURL } from "./utils.js";

/** `list({ region: "all" })` asks every region the org has and merges. */
export const ALL_REGIONS = "all";

/**
 * Calls on the account, its orgs, keys, env vars, teams and billing. Home
 * holds them, so they go there whatever region the client or call names.
 */
const HOME_METHODS: ReadonlySet<string> = new Set([
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
  "SetOrgRdpDefault",
  "GetOrgRdpDefault",
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
]);

type Kind = "machine" | "snapshot" | "disk";

/**
 * Calls whose not-found can only mean the machine, snapshot or disk they name
 * is not in this region: the kind, and the request fields that may name it.
 * Calls on something inside a machine (a checkpoint, a backup, a proxy, a
 * file path) are left out, since their not-found may be about that thing.
 */
const MACHINE_FIELDS = ["vm", "vmId", "vmName", "sourceVmId"];
const LOOKUP: ReadonlyMap<string, [Kind, string[]]> = new Map<string, [Kind, string[]]>([
  ...[
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
    "SetRdp",
    "ResetRdpPassword",
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
  ].map((m): [string, [Kind, string[]]] => [m, ["machine", MACHINE_FIELDS]]),
  ["GetSnapshot", ["snapshot", ["name"]]],
  ["DeleteSnapshot", ["snapshot", ["name"]]],
  ["CreateVmFromSnapshot", ["snapshot", ["snapshot"]]],
  ["DestroyDisk", ["disk", ["diskId"]]],
]);

/** A region id as the server writes it; undefined for none. */
export function normalizeRegion(region: string | null | undefined): string | undefined {
  const r = region?.trim().toLowerCase();
  return r ? r : undefined;
}

/** A client's region: never `"all"`, which only `list()` takes. */
export function checkClientRegion(region: string | undefined): string | undefined {
  const r = normalizeRegion(region);
  if (r === ALL_REGIONS) {
    throw new BoxdError('region "all" is for list() calls only; a client works in one region');
  }
  return r;
}

function field(req: unknown, name: string): unknown {
  return req !== null && typeof req === "object"
    ? (req as Record<string, unknown>)[name]
    : undefined;
}

/** The request field that names the org (`org` or `orgId`), if it has one. */
function orgField(req: unknown): string | undefined {
  return ["org", "orgId"].find((name) => typeof field(req, name) === "string");
}

/**
 * The org an org-scoped call names ("" = the caller's default org), or
 * undefined for a call that names none (one on a machine by name, say).
 */
function orgOf(req: unknown): string | undefined {
  const name = orgField(req);
  return name === undefined ? undefined : (field(req, name) as string);
}

/**
 * `req` with an empty org filled in with `org`, the id home's ListRegions
 * answer gave it. An org the caller set, a request that names none, and an
 * empty `org` (from a server that doesn't say) leave it as it is.
 */
function withOrg<Req>(req: Req, org: string): Req {
  const name = orgField(req);
  if (!org || name === undefined || field(req, name) !== "") return req;
  return Object.assign({}, req, { [name]: org });
}

/** What a not-found from this call is about: [kind, name], or undefined. */
function lookupOf(method: string, req: unknown): [Kind, string] | undefined {
  const lookup = LOOKUP.get(method);
  if (!lookup) return undefined;
  const [kind, fields] = lookup;
  for (const name of fields) {
    const value = field(req, name);
    if (typeof value === "string" && value) return [kind, value];
  }
  return undefined;
}

/** Why `region` can't be used, from a ListRegions answer; undefined if it can. */
function verdict(
  listing: ListRegionsResponse,
  region: string,
  checkOrg: boolean,
): BoxdError | undefined {
  const entry = listing.regions.find((r) => r.id === region);
  if (!entry) {
    const known = listing.regions.map((r) => r.id).join(", ");
    const where = known ? `the regions are ${known}` : "this boxd runs in one region";
    return new NotFoundError(`there is no region "${region}": ${where}`, 5, {
      reason: "unknown_region",
    });
  }
  if (checkOrg && entry.orgState !== "enabled") {
    const org = listing.orgId ? `org ${listing.orgId}` : "the org";
    const message =
      entry.orgState === "requested"
        ? `region "${region}" is not enabled for ${org} yet: it was asked for ` +
          "(orgs.requestRegion) and boxd has yet to enable it"
        : `region "${region}" is not enabled for ${org}: an org admin can ask for it ` +
          `with orgs.requestRegion("${region}")`;
    return new RegionNotEnabledError(message, region, entry.orgState);
  }
  if (entry.id !== listing.thisRegion && !entry.apiEndpoint) {
    return new BoxdError(`region "${region}" has no API endpoint`);
  }
  return undefined;
}

/** @internal */
export function toElsewhereItem(i: WireElsewhereItem): ElsewhereItem {
  return { region: i.region, name: i.name, orgId: i.orgId || null, id: i.id };
}

function hint(
  kind: Kind,
  name: string,
  exact: ElsewhereItem[],
  close: ElsewhereItem[],
): string | undefined {
  if (exact.length > 0) {
    const regions = [...new Set(exact.map((i) => i.region))];
    return (
      `there is a ${kind} "${name}" in ${regions.join(", ")}: ` + `pass { region: "${regions[0]}" }`
    );
  }
  if (close.length > 0) {
    const near = close
      .slice(0, 3)
      .map((i) => `"${i.name}" in ${i.region}`)
      .join(", ");
    return `close names in other regions: ${near}`;
  }
  return undefined;
}

/** Put a FindElsewhere answer on the error, and a hint in its message. */
function attach(err: NotFoundError, kind: Kind, name: string, found: FindElsewhereResponse): void {
  err.elsewhere = (found.exact ?? []).map(toElsewhereItem);
  err.close = (found.close ?? []).map(toElsewhereItem);
  const h = hint(kind, name, err.elsewhere, err.close);
  if (h) err.message = `${err.message}; ${h}`;
}

/** The start of a region's refusal of a key it doesn't hold: the key was
 *  deleted, or its org doesn't use the region. */
const KEY_NOT_IN_REGION = "API key not recognized in region";

/**
 * Whether a call sent to a region's derived name never reached a handler
 * there, so it can be sent again through home: the name led to no server (a
 * connection error: DNS, connect, TLS), the region doesn't hold the key, or
 * it refuses a key sent as itself as a server from before raw keys does.
 */
function missedRegion(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  return (
    err instanceof AuthenticationError &&
    err.grpcCode === GrpcStatus.UNAUTHENTICATED &&
    (err.message.startsWith(KEY_NOT_IN_REGION) || refusesRawKey(err))
  );
}

/**
 * Makes a transport for one region, given how to find its endpoint.
 * `derived`: the endpoint is the region's name derived from home's (direct
 * mode), so a failure comes back to the router instead of being retried.
 */
export type RegionTransportFactory = (
  baseURL: () => Promise<string>,
  opts?: { derived?: boolean },
) => Transport;

/** What direct mode needs to know of the client (`client.ts` builds it). */
export interface DirectRouting {
  /** The base URL home calls go to. */
  homeBaseURL(): Promise<string>;
  /** Whether a call to `baseURL` carries the API key itself. */
  sendsRawKey(baseURL: string): Promise<boolean>;
}

export interface RegionRouterOptions {
  /** The client's region; undefined = home. */
  region?: string;
  connect: RegionTransportFactory;
  /** Direct mode; without it every call to a region asks home first. */
  direct?: DirectRouting;
}

/** Routes each call of a client to its region's endpoint. */
export class RegionRouter implements Transport {
  /** The client's region; undefined = home. */
  readonly region: string | undefined;
  readonly #home: Transport;
  readonly #connect: RegionTransportFactory;
  /** ListRegions answers, by the org they were asked for ("" = default). */
  readonly #listings = new Map<string, ListRegionsResponse>();
  /** A ListRegions in flight, by org, so concurrent calls share it. */
  readonly #asking = new Map<string, Promise<ListRegionsResponse>>();
  /** Region transports, by region id. Home's region uses `#home` for unary calls. */
  readonly #regional = new Map<string, Transport>();
  readonly #direct: DirectRouting | undefined;
  /** Direct mode, by region id: "confirmed" once a unary call sent to the
   *  derived name was answered; "off", for the client's life, once one never
   *  reached a handler there. Neither: not tried yet. */
  readonly #directState = new Map<string, "confirmed" | "off">();
  /** Transports to regions' derived names, by region id. */
  readonly #derived = new Map<string, Transport>();

  constructor(home: Transport, opts: RegionRouterOptions) {
    this.#home = home;
    this.#connect = opts.connect;
    this.#direct = opts.direct;
    this.region = checkClientRegion(opts.region);
  }

  get supportsInteractiveExec(): boolean {
    return this.#home.supportsInteractiveExec;
  }

  #target(method: string, region: string | undefined): string | undefined {
    if (HOME_METHODS.has(method)) return undefined;
    const target = normalizeRegion(region) ?? this.region;
    if (target === ALL_REGIONS) throw new BoxdError('region "all" is for list() calls only');
    return target;
  }

  #listing(org: string): Promise<ListRegionsResponse> {
    let asking = this.#asking.get(org);
    if (!asking) {
      asking = this.#home
        .unary(BoxdApiDefinition.methods.listRegions, { orgId: org })
        .then((resp) => {
          this.#listings.set(org, resp);
          return resp;
        })
        .finally(() => this.#asking.delete(org));
      this.#asking.set(org, asking);
    }
    return asking;
  }

  #cached(region: string, org: string | undefined): ListRegionsResponse | undefined {
    if (org !== undefined) return this.#listings.get(org);
    // No org to check: any answer that lists the region names its endpoint.
    for (const listing of this.#listings.values()) {
      if (listing.regions.some((r) => r.id === region)) return listing;
    }
    return this.#listings.get("");
  }

  async #resolve(
    region: string,
    org: string | undefined,
  ): Promise<{ entry: WireRegion; listing: ListRegionsResponse }> {
    let listing = this.#cached(region, org);
    const fresh = listing === undefined;
    if (!listing) listing = await this.#listing(org ?? "");
    let err = verdict(listing, region, org !== undefined);
    if (err && !fresh) {
      listing = await this.#listing(org ?? "");
      err = verdict(listing, region, org !== undefined);
    }
    if (err) throw err;
    const entry = listing.regions.find((r) => r.id === region)!;
    return { entry, listing };
  }

  /** The transport for a region, dialled on first use. Its endpoint is
   *  resolved when it connects, so a stream can be handed out at once. */
  #regionTransport(region: string): Transport {
    let transport = this.#regional.get(region);
    if (!transport) {
      transport = this.#connect(
        async () => (await this.#resolve(region, undefined)).entry.apiEndpoint,
      );
      this.#regional.set(region, transport);
    }
    return transport;
  }

  /** The transport a call goes to, and the request it is sent. */
  async #route<Req>(
    method: string,
    req: Req,
    region: string | undefined,
  ): Promise<[Transport, Req]> {
    const target = this.#target(method, region);
    if (target === undefined) return [this.#home, req];
    const { entry, listing } = await this.#resolve(target, orgOf(req));
    if (entry.id === listing.thisRegion) return [this.#home, req];
    // `listing` is home's answer for the call's org: for an empty one, it
    // names the default org, which the region is sent.
    return [this.#regionTransport(entry.id), withOrg(req, listing.orgId)];
  }

  /**
   * Where a call goes in direct mode: the region and the transport to its
   * derived name, or undefined when direct mode doesn't apply (see the module
   * doc). The call is sent as it is: no org is filled in.
   */
  async #directRoute(
    method: string,
    req: unknown,
    region: string | undefined,
  ): Promise<{ region: string; transport: Transport } | undefined> {
    const target = this.#target(method, region);
    if (!this.#direct || target === undefined || orgOf(req)) return undefined;
    if (this.#directState.get(target) === "off") return undefined;
    const url = regionBaseURL(await this.#direct.homeBaseURL(), target);
    if (url === undefined || !(await this.#direct.sendsRawKey(url))) return undefined;
    let transport = this.#derived.get(target);
    if (!transport) {
      transport = this.#connect(async () => url, { derived: true });
      this.#derived.set(target, transport);
    }
    return { region: target, transport };
  }

  /** The transport to a region's derived name, once a unary call there was
   *  answered; undefined before that, or after it fell back. */
  #confirmed(region: string): Transport | undefined {
    return this.#directState.get(region) === "confirmed" ? this.#derived.get(region) : undefined;
  }

  /** The transport for a stream: one can't wait for the region to resolve,
   *  nor be sent again, so a derived name only once it is confirmed. */
  #streamRoute(method: string, region: string | undefined): Transport {
    const target = this.#target(method, region);
    if (target === undefined) return this.#home;
    return this.#confirmed(target) ?? this.#regionTransport(target);
  }

  async #lookElsewhere(
    err: NotFoundError,
    transport: Transport,
    lookup: [Kind, string] | undefined,
    org: string | undefined,
  ): Promise<void> {
    // A region that doesn't exist is not a machine somewhere else.
    if (!lookup || err.reason === "unknown_region") return;
    const [kind, name] = lookup;
    try {
      const found = await transport.unary(BoxdApiDefinition.methods.findElsewhere, {
        kind,
        name,
        org: org ?? "",
      });
      attach(err, kind, name, found);
    } catch {
      // Never replaces the real error.
    }
  }

  async unary<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts?: UnaryOptions,
  ): Promise<Resp> {
    const direct = await this.#directRoute(method.name, req, opts?.region);
    if (direct) {
      try {
        const resp = await this.#send(direct.transport, method, req, req, opts);
        if (this.#directState.get(direct.region) !== "off") {
          this.#directState.set(direct.region, "confirmed");
        }
        return resp;
      } catch (err) {
        if (!missedRegion(err)) throw err;
        // Refused before any handler ran: ask home where the region is, from
        // now on, and send the call there.
        this.#directState.set(direct.region, "off");
      }
    }
    const [transport, sent] = await this.#route(method.name, req, opts?.region);
    return this.#send(transport, method, sent, req, opts);
  }

  /** One unary call on `transport`: `sent` is what it is sent, `req` what
   *  the caller asked for. */
  async #send<Req, Resp>(
    transport: Transport,
    method: MethodDef<Req, Resp>,
    sent: Req,
    req: Req,
    opts?: UnaryOptions,
  ): Promise<Resp> {
    let resp: Resp;
    try {
      resp = await transport.unary(method, sent, opts);
    } catch (err) {
      if (err instanceof NotFoundError) {
        await this.#lookElsewhere(err, transport, lookupOf(method.name, req), orgOf(req));
      }
      throw err;
    }
    // Every ListRegions answer refreshes the directory, whoever asked.
    if (method.name === "ListRegions") {
      this.#listings.set(orgOf(req) ?? "", resp as unknown as ListRegionsResponse);
    }
    return resp;
  }

  serverStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts?: CallOptions & { deadline?: boolean },
  ): ReadableCall<Resp> {
    const transport = this.#streamRoute(method.name, opts?.region);
    const lookup = lookupOf(method.name, req);
    return findingCall(transport.serverStream(method, req, { deadline: opts?.deadline }), (err) =>
      this.#lookElsewhere(err, transport, lookup, undefined),
    );
  }

  duplex<Req, Resp>(
    method: MethodDef<Req, Resp>,
    opts?: CallOptions & { machine?: string },
  ): DuplexCall<Req, Resp> {
    const transport = this.#streamRoute(method.name, opts?.region);
    const lookup: [Kind, string] | undefined = opts?.machine
      ? ["machine", opts.machine]
      : undefined;
    return findingCall(transport.duplex(method), (err) =>
      this.#lookElsewhere(err, transport, lookup, undefined),
    );
  }

  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
    opts?: CallOptions,
  ): WritableCall<Req> {
    return this.#streamRoute(method.name, opts?.region).clientStream(method, callback);
  }

  /** The web console of a region (`machines` builds `access.desktopUrl` from
   *  it); home's when the region is home's, or can't be resolved. */
  async consoleOrigin(region?: string): Promise<string> {
    const target = normalizeRegion(region) ?? this.region;
    if (target === undefined || target === ALL_REGIONS) return this.#home.consoleOrigin();
    // A region reached directly: its console is named like its API
    // (`app.<region>.<zone>`), so home isn't asked for it either.
    const derived = this.#confirmed(target);
    if (derived) return derived.consoleOrigin();
    try {
      const { entry, listing } = await this.#resolve(target, undefined);
      if (entry.id === listing.thisRegion) return this.#home.consoleOrigin();
      return entry.consoleEndpoint.replace(/\/+$/, "") || consoleBaseUrl(entry.apiEndpoint);
    } catch {
      return this.#home.consoleOrigin();
    }
  }

  async eachRegion<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts: { org?: string },
  ): Promise<RegionPages<Resp>> {
    const org = opts.org ?? "";
    const listing = this.#listings.get(org) ?? (await this.#listing(org));
    const enabled = listing.regions.filter((r) => r.orgState === "enabled");
    if (enabled.length === 0) {
      const resp = await this.#home.unary(method, req);
      return { pages: [{ region: listing.thisRegion || undefined, resp }], unavailable: [] };
    }
    // Home resolves an empty org itself; the other regions are sent the
    // org it resolved, so every page is of the same org.
    const regional = withOrg(req, listing.orgId);
    const settled = await Promise.allSettled(
      enabled.map((r) =>
        r.id === listing.thisRegion
          ? this.#home.unary(method, req)
          : this.#regionTransport(r.id).unary(method, regional),
      ),
    );
    const pages: RegionPages<Resp>["pages"] = [];
    const unavailable: string[] = [];
    settled.forEach((result, i) => {
      const region = enabled[i]!.id;
      if (result.status === "fulfilled") pages.push({ region, resp: result.value });
      else if (result.reason instanceof APIConnectionError) unavailable.push(region);
      else throw result.reason;
    });
    return { pages, unavailable };
  }

  async findElsewhere<Req>(
    err: NotFoundError,
    method: MethodDef<Req, unknown>,
    req: Req,
    opts?: CallOptions,
  ): Promise<NotFoundError> {
    const direct = await this.#directRoute(method.name, req, opts?.region);
    const [transport] = direct
      ? [direct.transport]
      : await this.#route(method.name, req, opts?.region);
    await this.#lookElsewhere(err, transport, lookupOf(method.name, req), orgOf(req));
    return err;
  }

  close(): void {
    this.#home.close();
    for (const transport of [...this.#regional.values(), ...this.#derived.values()]) {
      transport.close();
    }
    this.#regional.clear();
    this.#derived.clear();
  }
}

/**
 * A call whose not-found error is looked up elsewhere before its error
 * handlers see it. Everything else passes straight through.
 */
function findingCall<C extends ReadableCall<unknown>>(
  call: C,
  onNotFound: (err: NotFoundError) => Promise<void>,
): C {
  const handlers: Array<(err: unknown) => void> = [];
  let hooked = false;
  const on = (event: string, fn: (arg: unknown) => void): void => {
    const register = call.on.bind(call) as (event: string, fn: (arg: unknown) => void) => void;
    if (event !== "error") {
      register(event, fn);
      return;
    }
    handlers.push(fn);
    if (hooked) return;
    hooked = true;
    register("error", (err: unknown) => {
      void (async () => {
        if (err instanceof NotFoundError) await onNotFound(err);
        for (const handler of handlers) handler(err);
      })();
    });
  };
  return new Proxy(call, {
    get(target, prop) {
      if (prop === "on") return on;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `eachRegion` on the router, or the one call on a plain transport (a test's,
 * or one built by hand).
 */
export async function eachRegion<Req, Resp>(
  transport: Transport,
  method: MethodDef<Req, Resp>,
  req: Req,
  org?: string,
): Promise<RegionPages<Resp>> {
  if (transport.eachRegion) return transport.eachRegion(method, req, { org });
  return {
    pages: [{ region: undefined, resp: await transport.unary(method, req) }],
    unavailable: [],
  };
}

/** `findElsewhere` on the router; the error as it is on a plain transport. */
export async function notFoundElsewhere<Req>(
  transport: Transport,
  err: NotFoundError,
  method: MethodDef<Req, unknown>,
  req: Req,
  opts?: CallOptions,
): Promise<NotFoundError> {
  return transport.findElsewhere ? transport.findElsewhere(err, method, req, opts) : err;
}
