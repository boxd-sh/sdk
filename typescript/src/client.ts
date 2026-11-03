import { Credentials } from "./auth.js";
import type { Platform } from "./_platform.js";
import {
  RegionRouter,
  checkClientRegion,
  type DirectRouting,
  type RegionTransportFactory,
} from "./_regions.js";
import type { Transport } from "./_rpc.js";
import { deriveExchangeUrl, rawKeyAllowed, readEnv } from "./utils.js";
import { AccountNamespace } from "./account.js";
import { ApiKeys } from "./apiKeys.js";
import { Disks } from "./disks.js";
import { Domains } from "./domains.js";
import { Machines } from "./machines.js";
import { Orgs } from "./orgs.js";
import { Regions } from "./regions.js";
import { Snapshots } from "./snapshots.js";
import { Teams } from "./teams.js";
import { EnvVars, Secrets } from "./vars.js";

/**
 * Production. Every other cluster is one `baseURL` away — there is no
 * environment preset table, and no separate exchange URL to keep in lockstep.
 */
export const DEFAULT_BASE_URL = "https://boxd.sh:9443";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface BoxdOptions {
  /**
   * API key. `BOXD_API_KEY`. Sent as the bearer itself over TLS (or to a
   * loopback address); otherwise, and against a server too old to take it,
   * exchanged for a session token that is kept fresh.
   */
  apiKey?: string;
  /** A token, used verbatim and never refreshed. `BOXD_TOKEN`. */
  token?: string;
  /**
   * API endpoint. `BOXD_BASE_URL`, or the deprecated `BOXD_API_URL` alias.
   * Defaults to production. Inside a boxd machine, leaving it unset points the
   * client at that machine's own cluster — so the same code runs anywhere.
   */
  baseURL?: string;
  /**
   * The region machines, snapshots and disks are created in and looked up in
   * (`"fra"`, `"nyc"`, ...). `BOXD_REGION`. Defaults to the region `baseURL`
   * serves. Account and org calls always go to `baseURL`. Every such method
   * also takes its own `{ region }`.
   */
  region?: string;
  /** Per-request deadline in milliseconds. Default 60s. */
  timeout?: number;
  /** Retries on connection failures. Default 2. */
  maxRetries?: number;
}

/**
 * Resolve {@link BoxdOptions} into the pieces a `Transport` constructor needs
 * (`_transport.ts`'s `TransportOptions` and `_transportWeb.ts`'s
 * `WebTransportOptions` are both shaped like this). Shared by both entry
 * points (`index.ts`, `web.ts`) so option/env resolution — and the
 * credential, which is transport-agnostic — can never drift between them.
 * `platform` is what the entry's runtime can do (`_platform.ts`).
 */
export function resolveOptions(
  opts: BoxdOptions,
  platform: Platform,
): {
  creds: Credentials;
  explicitBaseURL?: string;
  defaultBaseURL: string;
  timeoutMs: number;
  maxRetries: number;
  region?: string;
} {
  const explicitBaseURL =
    opts.baseURL ?? readEnv("BOXD_BASE_URL") ?? readEnv("BOXD_API_URL") ?? undefined;
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  // The exchange endpoint is derived, never passed.
  const creds = new Credentials({
    token: opts.token,
    apiKey: opts.apiKey,
    exchangeUrl: deriveExchangeUrl(explicitBaseURL ?? DEFAULT_BASE_URL),
    readFile: platform.readFile,
  });
  const region = checkClientRegion(opts.region ?? readEnv("BOXD_REGION"));
  return {
    creds,
    explicitBaseURL,
    defaultBaseURL: DEFAULT_BASE_URL,
    timeoutMs,
    maxRetries,
    region,
  };
}

/**
 * What the region router needs to send a call straight to a region (direct
 * mode, `_regions.ts`): home's base URL, resolved as the home transport
 * resolves it, and whether a call to an endpoint carries the API key itself.
 */
export function directRouting(
  resolved: Pick<ReturnType<typeof resolveOptions>, "creds" | "explicitBaseURL" | "defaultBaseURL">,
): DirectRouting {
  const { creds, explicitBaseURL, defaultBaseURL } = resolved;
  return {
    homeBaseURL: async () => explicitBaseURL ?? (await creds.clusterUrl()) ?? defaultBaseURL,
    sendsRawKey: (baseURL) => creds.sendsRawKey(rawKeyAllowed(baseURL)),
  };
}

/**
 * The one stateful thing in the SDK: holds a {@link Transport} and wires up
 * every resource namespace on top of it. Transport-agnostic on purpose —
 * this class never imports `_transport.ts` (grpc-js) or `_transportWeb.ts`
 * (fetch/WebSocket) itself, so it never picks a runtime. `index.ts`
 * (`@boxd-sh/sdk`) and `web.ts` (`@boxd-sh/sdk/web`) each subclass this,
 * constructing the transport their environment supports and nothing else —
 * that separation is what keeps `@grpc/grpc-js` (which cannot load in a
 * Cloudflare Worker) out of the web entry's import graph entirely. The same
 * goes for Node builtins: the entry passes a {@link Platform} instead.
 */
export class BoxdCore {
  readonly #transport: RegionRouter;

  readonly machines: Machines;
  readonly snapshots: Snapshots;
  readonly disks: Disks;
  readonly env: EnvVars;
  readonly secrets: Secrets;
  readonly domains: Domains;
  readonly orgs: Orgs;
  readonly teams: Teams;
  readonly apiKeys: ApiKeys;
  readonly account: AccountNamespace;
  /** The regions boxd runs in, and which ones your org can use. */
  readonly regions: Regions;

  /**
   * `home` talks to `baseURL`; `connect` makes a transport for another
   * region's endpoint, sharing the credential; `direct` lets a call skip
   * asking home where a region is ({@link directRouting}). Every namespace
   * gets the region router built from them.
   */
  constructor(
    home: Transport,
    platform: Platform,
    regions: { region?: string; connect: RegionTransportFactory; direct?: DirectRouting },
  ) {
    const transport = new RegionRouter(home, regions);
    this.#transport = transport;
    // Namespaces get the transport, never `this` — that is what keeps the
    // wire plumbing off the client's public surface.
    this.machines = new Machines(transport, platform);
    this.snapshots = new Snapshots(transport);
    this.disks = new Disks(transport);
    this.env = new EnvVars(transport);
    this.secrets = new Secrets(transport);
    this.domains = new Domains(transport);
    this.orgs = new Orgs(transport);
    this.teams = new Teams(transport);
    this.apiKeys = new ApiKeys(transport);
    this.account = new AccountNamespace(transport);
    this.regions = new Regions(transport);
  }

  /** The client's region (`region` or `BOXD_REGION`); `undefined` = the
   *  region `baseURL` serves. */
  get region(): string | undefined {
    return this.#transport.region;
  }

  /** Close the channel. Safe to call more than once. */
  async close(): Promise<void> {
    this.#transport.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
