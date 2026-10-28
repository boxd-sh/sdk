import { Credentials } from "./auth.js";
import type { Platform } from "./_platform.js";
import type { Transport } from "./_rpc.js";
import { deriveExchangeUrl, readEnv } from "./utils.js";
import { AccountNamespace } from "./account.js";
import { ApiKeys } from "./apiKeys.js";
import { Disks } from "./disks.js";
import { Domains } from "./domains.js";
import { Machines } from "./machines.js";
import { Orgs } from "./orgs.js";
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
  /** API key. Exchanged for a session token and kept fresh. `BOXD_API_KEY`. */
  apiKey?: string;
  /** A token, used verbatim and never refreshed. `BOXD_TOKEN`. */
  token?: string;
  /**
   * API endpoint. `BOXD_BASE_URL`, or the deprecated `BOXD_API_URL` alias.
   * Defaults to production. Inside a boxd machine, leaving it unset points the
   * client at that machine's own cluster — so the same code runs anywhere.
   */
  baseURL?: string;
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
  return { creds, explicitBaseURL, defaultBaseURL: DEFAULT_BASE_URL, timeoutMs, maxRetries };
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
  readonly #transport: Transport;

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

  constructor(transport: Transport, platform: Platform) {
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
  }

  /** Close the channel. Safe to call more than once. */
  async close(): Promise<void> {
    this.#transport.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
