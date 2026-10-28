import {
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  GrpcStatus,
  PermissionDeniedError,
  RateLimitError,
} from "./errors.js";
import type { ReadFile } from "./_platform.js";
import { readEnv } from "./utils.js";

const METADATA_PORT = 9002;
const DEFAULT_GATEWAY = "10.42.0.1";
const METADATA_TIMEOUT_MS = 2_000;

/** Re-exchange an API-key session's token this long before it expires. */
const REFRESH_SKEW_SEC = 300;
/** In-machine credentials are short-lived and re-issued rather than refreshed. */
const VM_REMINT_SKEW_SEC = 60;

/** Which kind of credential the client ended up using. */
export type CredentialSource = "token" | "apiKey" | "vm";

export interface CredentialsOptions {
  /** Explicit token. Used as-is, never refreshed. */
  token?: string;
  /** Explicit API key. Exchanged for a session token and kept fresh. */
  apiKey?: string;
  /** Derived from `baseURL` — see `deriveExchangeUrl`. */
  exchangeUrl: string;
  /**
   * Reads `/proc/net/route` to find the in-machine metadata adapter. Absent on
   * the web entry, which therefore has no automatic in-machine auth.
   */
  readFile?: ReadFile;
}

interface VmIdentity {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
  /** The cluster this machine belongs to. */
  apiUrl?: string;
}

/** @internal Default route's gateway, or `undefined` off Linux. */
export async function detectGateway(readFile: ReadFile): Promise<string | undefined> {
  let content: string;
  try {
    content = new TextDecoder().decode(await readFile("/proc/net/route"));
  } catch {
    return undefined; // not Linux, or no procfs
  }
  for (const line of content.split("\n").slice(1)) {
    // Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[1] !== "00000000") continue;
    // Hex-encoded little-endian IPv4.
    const ip = Number.parseInt(fields[2]!, 16);
    if (!Number.isFinite(ip)) return undefined;
    return [ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >>> 24) & 0xff].join(".");
  }
  return undefined;
}

/**
 * @internal
 * Obtain a credential from inside a boxd machine, or `undefined` when we are
 * not running in one or can't find its metadata adapter (the web entry).
 *
 * The cheap check is only a hint: it skips the probe in the common case of
 * running on a laptop. It is deliberately permissive, because which of these
 * a shell actually has depends on how the session was opened and on how old
 * the machine is — gating on any single one of them silently disables in-VM
 * auth on machines that are otherwise perfectly fine. The probe below is the
 * real test: nothing outside a boxd machine answers it.
 */
const VM_HINTS = ["BOXD_VM_ID", "BOXD_VM_NAME", "BOXD_PROXY_ENDPOINT"] as const;

/**
 * @internal
 * The in-machine metadata adapter's base URL, or `undefined` when this code
 * isn't running inside a boxd machine, or can't find the adapter (the web
 * entry has no file reader for the route table).
 */
export async function metadataBase(readFile: ReadFile | undefined): Promise<string | undefined> {
  if (!VM_HINTS.some((v) => readEnv(v))) return undefined;
  if (!readFile) return undefined;
  const gateway = await detectGateway(readFile);
  return gateway ? `http://${gateway}:${METADATA_PORT}` : undefined;
}

/**
 * @internal
 * A credential from the machine's metadata adapter, or `undefined` when this
 * code isn't running inside a boxd machine (no environment hint, or no file
 * reader to find the adapter with).
 *
 * The adapter not answering is an {@link APIConnectionError} carrying its
 * URL; the caller decides what that means (see `Credentials`). A 403 is a
 * {@link PermissionDeniedError} (the account may not use the API), a 429 a
 * {@link RateLimitError}, and any other answer that isn't a credential an
 * {@link APIStatusError}.
 */
export async function mintVmToken(
  readFile: ReadFile | undefined,
): Promise<VmIdentity | undefined> {
  if (!VM_HINTS.some((v) => readEnv(v))) return undefined;
  // The metadata adapter listens on the worker's bridge gateway, which differs
  // per worker (`10.<n>.0.1`), so without a file reader to read the route
  // table (the web entry) there is no way to find it. `DEFAULT_GATEWAY` only
  // matches a local dev cluster, so guessing it would just time out.
  if (!readFile) return undefined;

  const detected = await detectGateway(readFile);
  const gateway = detected ?? DEFAULT_GATEWAY;
  const base = `http://${gateway}:${METADATA_PORT}`;
  const url = `${base}/v1/auth/token`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AdapterUnreachableError(
      `could not reach the machine's metadata adapter at ${url}: ${errorText(err)}`,
      detected ? base : undefined,
      err,
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // The adapter knows the machine by where the request comes from, so it
    // has no "wrong credential" answer: a 403 refuses the account itself.
    if (resp.status === 403) {
      throw new PermissionDeniedError(
        `the machine's metadata adapter refused a credential${body ? `: ${body}` : ""}`,
        GrpcStatus.PERMISSION_DENIED,
        { httpStatus: 403 },
      );
    }
    if (resp.status === 429) {
      throw new RateLimitError(
        `the machine's metadata adapter is rate limiting credential requests${body ? `: ${body}` : ""}`,
        GrpcStatus.RESOURCE_EXHAUSTED,
        { httpStatus: 429 },
      );
    }
    throw new APIStatusError(
      `the machine's metadata adapter answered ${resp.status}${body ? `: ${body}` : ""}`,
      undefined,
      { httpStatus: resp.status },
    );
  }
  const data = (await resp.json().catch(() => null)) as {
    token?: unknown;
    expires_at?: unknown;
    api_url?: unknown;
  } | null;
  if (typeof data?.token !== "string" || typeof data.expires_at !== "number") {
    throw new APIStatusError("malformed credential from the machine's metadata adapter", undefined, {
      httpStatus: resp.status,
    });
  }
  return {
    token: data.token,
    expiresAt: data.expires_at,
    apiUrl: typeof data.api_url === "string" && data.api_url ? data.api_url : undefined,
  };
}

/** The adapter didn't answer. `base` is its URL when the route table named
 *  it, `undefined` when it was only the local-dev guess. */
class AdapterUnreachableError extends APIConnectionError {
  constructor(
    message: string,
    readonly base: string | undefined,
    cause: unknown,
  ) {
    super(message, undefined, { cause });
  }
}

/**
 * The credential half of the client: decides *which* credential to use, then
 * keeps it fresh.
 *
 * Resolution is deferred to the first request, because deciding can require
 * I/O. The decision is made once and sticks. Order, first match wins:
 *
 *  1. explicit `token`
 *  2. explicit `apiKey`
 *  3. `BOXD_TOKEN`
 *  4. `BOXD_API_KEY`
 *  5. automatic, when running inside a boxd machine
 *  6. otherwise `AuthenticationError`
 */
export class Credentials {
  readonly #explicitToken?: string;
  readonly #explicitApiKey?: string;
  readonly #envToken?: string;
  readonly #envApiKey?: string;
  readonly #exchangeUrl: string;
  readonly #readFile: ReadFile | undefined;

  #resolving?: Promise<CredentialSource>;
  /** The cluster URL a boxd machine reported, when that rung won. */
  #vmApiUrl?: string;

  #apiKey?: string;
  #token?: string;
  /** Epoch seconds. 0 for a never-expiring explicit token. */
  #expiresAt = 0;
  #inflight?: Promise<void>;

  constructor(opts: CredentialsOptions) {
    this.#explicitToken = opts.token || undefined;
    this.#explicitApiKey = opts.apiKey || undefined;
    this.#envToken = readEnv("BOXD_TOKEN") || undefined;
    this.#envApiKey = readEnv("BOXD_API_KEY") || undefined;
    this.#exchangeUrl = opts.exchangeUrl;
    this.#readFile = opts.readFile;
  }

  /**
   * Which rung won. Resolves the chain on first call. The answer sticks, and
   * so does finding no credentials at all — except when the machine's
   * metadata adapter didn't answer (the `AuthenticationError`'s `cause` is
   * then an {@link APIConnectionError}): that may be an outage, so the next
   * call asks again, as it does after any other failure.
   */
  async source(): Promise<CredentialSource> {
    this.#resolving ??= this.#resolve().catch((err: unknown) => {
      const settled =
        err instanceof AuthenticationError && !(err.cause instanceof APIConnectionError);
      if (!settled) this.#resolving = undefined;
      throw err;
    });
    return this.#resolving;
  }

  /**
   * The cluster URL reported by the surrounding boxd machine, if any. An
   * explicit `baseURL` still takes precedence — the client decides.
   */
  async clusterUrl(): Promise<string | undefined> {
    await this.source();
    return this.#vmApiUrl;
  }

  async getToken(): Promise<string> {
    const source = await this.source();
    if (source === "token") return this.#token!;

    const now = Date.now() / 1000;
    const skew = source === "vm" ? VM_REMINT_SKEW_SEC : REFRESH_SKEW_SEC;
    if (!this.#token || now > this.#expiresAt - skew) {
      // Coalesce: N concurrent calls queue behind one refresh.
      this.#inflight ??= (source === "vm" ? this.#remint() : this.#exchange()).finally(() => {
        this.#inflight = undefined;
      });
      await this.#inflight;
    }
    return this.#token!;
  }

  async #resolve(): Promise<CredentialSource> {
    if (this.#explicitToken) {
      this.#token = this.#explicitToken;
      return "token";
    }
    if (this.#explicitApiKey) {
      this.#apiKey = this.#explicitApiKey;
      return "apiKey";
    }
    if (this.#envToken) {
      this.#token = this.#envToken;
      return "token";
    }
    if (this.#envApiKey) {
      this.#apiKey = this.#envApiKey;
      return "apiKey";
    }
    let vm: VmIdentity | undefined;
    let silent: AdapterUnreachableError | undefined;
    try {
      vm = await mintVmToken(this.#readFile);
    } catch (err) {
      if (!(err instanceof AdapterUnreachableError)) throw err;
      silent = err;
    }
    if (vm) {
      this.#token = vm.token;
      this.#expiresAt = vm.expiresAt;
      this.#vmApiUrl = vm.apiUrl;
      return "vm";
    }
    // An isolated machine keeps the environment hints but has no adapter, so
    // nothing answering can't be told apart from an outage: it stays "no
    // credentials" (terminal for this call), but carries the network failure
    // as `cause`, which is what keeps `source` from remembering it.
    if (silent?.base) {
      throw new AuthenticationError(
        `no credentials: the machine's metadata adapter at ${silent.base} did not answer ` +
          "(isolated machines have none); pass { apiKey } or { token }, " +
          "or set BOXD_API_KEY / BOXD_TOKEN",
        undefined,
        { reason: "missing_credentials", cause: silent },
      );
    }
    // Without a file reader (the web entry) in-machine auth never runs, so
    // don't imply it would.
    const inMachine = this.#readFile
      ? "authentication is automatic only inside a boxd machine"
      : "automatic authentication inside a boxd machine needs the Node entry, @boxd-sh/sdk";
    throw new AuthenticationError(
      "no credentials: pass { apiKey } or { token }, or set BOXD_API_KEY / BOXD_TOKEN " +
        `(${inMachine})`,
      undefined,
      { reason: "missing_credentials", cause: silent },
    );
  }

  async #exchange(): Promise<void> {
    // The token-exchange endpoint is rate-limited per source IP. A fleet of
    // workers behind one NAT can trip it even with legitimate traffic, so on a
    // 429 wait out the server's `Retry-After` once before surfacing the error.
    for (let attempt = 0; ; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(this.#exchangeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: this.#apiKey }),
        });
      } catch (err) {
        throw new APIConnectionError(
          `could not reach ${this.#exchangeUrl} to exchange the API key: ${errorText(err)}`,
          undefined,
          { cause: err },
        );
      }

      if (resp.status === 401) {
        throw new AuthenticationError("invalid or expired API key", undefined, {
          reason: "invalid_api_key",
          httpStatus: 401,
        });
      }
      if (resp.status === 403) {
        // The key is valid but its account may not use the API (e.g. it is
        // disabled): not an authentication failure.
        const body = await resp.text().catch(() => "");
        throw new PermissionDeniedError(
          `the API key was refused${body ? `: ${body}` : ""}`,
          GrpcStatus.PERMISSION_DENIED,
          { httpStatus: 403 },
        );
      }
      if (resp.status === 429) {
        const body = (await resp.text().catch(() => "")) || "token exchange rate limit exceeded";
        if (attempt === 0) {
          const raw = resp.headers.get("retry-after");
          const parsed = raw == null ? Number.NaN : Number(raw);
          const waitSec = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 60) : 5;
          await sleep(waitSec * 1000);
          continue;
        }
        throw new RateLimitError(
          `${body} — a token is valid for 1 hour; reuse one across your workers`,
          GrpcStatus.RESOURCE_EXHAUSTED,
          { httpStatus: 429 },
        );
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new APIStatusError(
          `could not exchange the API key: the exchange answered ${resp.status}${body ? ` ${body}` : ""}`,
          undefined,
          { httpStatus: resp.status },
        );
      }

      const data = (await resp.json().catch(() => null)) as {
        token?: unknown;
        expires_at?: unknown;
      } | null;
      if (typeof data?.token !== "string" || typeof data.expires_at !== "number") {
        throw new APIStatusError("malformed response while exchanging the API key", undefined, {
          httpStatus: resp.status,
        });
      }
      this.#token = data.token;
      this.#expiresAt = data.expires_at;
      return;
    }
  }

  /** In-machine credentials are re-issued, not refreshed. */
  async #remint(): Promise<void> {
    // Not answering now is the adapter being unreachable, not a machine-less
    // host: that was settled when it first answered. `AdapterUnreachableError`
    // is an APIConnectionError, so the client retries it.
    const vm = await mintVmToken(this.#readFile);
    if (!vm) {
      // Only when the environment that found the machine has since changed.
      throw new AuthenticationError(
        "the machine's automatic credential expired and could not be renewed",
        undefined,
        { reason: "missing_credentials" },
      );
    }
    this.#token = vm.token;
    this.#expiresAt = vm.expiresAt;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
