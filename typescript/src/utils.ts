const SIZE_RE = /^(\d+)\s*([KMGT]?)i?[Bb]?$/i;
const MULTIPLIERS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `"8G"` → bytes. Accepts a bare byte count, and K/M/G/T with optional `i`/`B`. */
export function parseSize(s: string): number {
  if (!s) return 0;
  const m = SIZE_RE.exec(s.trim());
  if (!m) throw new Error(`invalid size: ${JSON.stringify(s)}`);
  const num = Number.parseInt(m[1]!, 10);
  const unit = (m[2] ?? "").toUpperCase();
  return num * (MULTIPLIERS[unit] ?? 1);
}

/**
 * Read an environment variable across the runtimes we support. Deno needs
 * `--allow-env`; without it `Deno.env.get` throws, which we treat as unset.
 */
export function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) return process.env[name];
  // @ts-expect-error Deno global — not typed in the Node TS build
  if (typeof Deno !== "undefined") {
    try {
      // @ts-expect-error Deno global — requires --allow-env at runtime
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith("localhost") || url.startsWith("127.");
}

/**
 * Whether a `host:port` (as {@link resolveEndpoint} gives it) is a loopback
 * address: `localhost`, `127.*` or `[::1]`. Plaintext to one never leaves the
 * machine, so an API key may go as itself there, as over TLS.
 */
export function isLoopbackHost(hostPort: string): boolean {
  const host = bareHost(hostPort.trim()).toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Whether an API key may go as itself to `baseURL`: TLS, or loopback. */
export function rawKeyAllowed(baseURL: string): boolean {
  const { host, useTls } = resolveEndpoint(baseURL);
  return useTls || isLoopbackHost(host);
}

export interface Endpoint {
  /** Bare `host:port` to pass to the gRPC client. */
  host: string;
  /** Whether to use TLS for the channel. */
  useTls: boolean;
}

/**
 * Resolve a baseURL into a `(host, useTls)` pair.
 *
 * - `http://...`  → plaintext, scheme stripped
 * - `https://...` → TLS, scheme stripped
 * - bare `host:port` → TLS, except `localhost`/`127.*` which stay plaintext
 *
 * The proxy serves TLS and plain HTTP/2 on the same port, so an explicit
 * `http://` still reaches any cluster; the default is `https://`.
 */
export function resolveEndpoint(url: string): Endpoint {
  if (url.startsWith("http://")) {
    return { host: url.slice("http://".length), useTls: false };
  }
  if (url.startsWith("https://")) {
    return { host: url.slice("https://".length), useTls: true };
  }
  return { host: url, useTls: !isLocalUrl(url) };
}

/** One DNS label: letters, digits and inner hyphens. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A region's API endpoint by the platform's naming: `<region>.<host>` on the
 * home base URL's scheme and port (home `https://boxd.sh:9443` → nyc
 * `https://nyc.boxd.sh:9443`). Undefined when the home host is not a DNS name
 * a region can be put in front of (an IP literal, `localhost`, a name of one
 * label), when the base URL has a path, or when `region` is not one label.
 */
export function regionBaseURL(homeBaseURL: string, region: string): string | undefined {
  if (!DNS_LABEL.test(region)) return undefined;
  const trimmed = homeBaseURL.trim().replace(/\/+$/, "");
  const scheme = ["https://", "http://"].find((s) => trimmed.startsWith(s)) ?? "";
  const authority = trimmed.slice(scheme.length);
  if (authority.includes("/")) return undefined;
  const host = bareHost(authority).toLowerCase();
  const port = authority.slice(host.length);
  const labels = host.split(".");
  const dnsName =
    labels.length > 1 &&
    labels.every((l) => DNS_LABEL.test(l)) &&
    !/^\d+$/.test(labels[labels.length - 1]!) && // a dotted quad, valid or not
    labels[labels.length - 1] !== "localhost";
  if (!dnsName || (port !== "" && !/^:\d+$/.test(port))) return undefined;
  return `${scheme}${region}.${host}${port}`;
}

/** Path the console serves the API-key → JWT exchange on. */
const EXCHANGE_PATH = "/api/v1/auth/token";

/** Dotted-quad, or a bracketed IPv6 literal as it appears in a URL authority. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((o) => Number(o) <= 255);
}

/** Split a URL authority into its host part, keeping a bracketed IPv6 intact. */
function bareHost(authority: string): string {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  return authority.split(":")[0] ?? authority;
}

/**
 * Derive the API-key exchange endpoint from `baseURL`. Never passed by the
 * caller — keeping two URLs in lockstep is what made environment presets
 * necessary in the first place.
 *
 * A deployed cluster's API lives at `<zone>:9443` and its console at
 * `https://app.<zone>`, so the port and any path are dropped and the scheme is
 * forced to https. `localhost`, a raw IP, and an already-`app.` host are
 * single-host setups and are handed back untouched, port and all.
 */
export function deriveExchangeUrl(baseURL: string): string {
  return consoleBaseUrl(baseURL) + EXCHANGE_PATH;
}

/**
 * The web console's origin for a given API `baseURL` — `https://app.<zone>`.
 *
 * The console is where the API-key exchange and the live Desktop view both
 * live, so this is derived once here rather than assembled twice. Note it
 * cannot come from a machine's own `access.domain`: that may be the ORG's
 * wildcard domain (`preview.mysaas.com`), and the console is never under it.
 */
export function consoleBaseUrl(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  let scheme = "";
  let rest = trimmed;
  if (trimmed.startsWith("https://")) {
    scheme = "https://";
    rest = trimmed.slice("https://".length);
  } else if (trimmed.startsWith("http://")) {
    scheme = "http://";
    rest = trimmed.slice("http://".length);
  }
  const authority = rest.split("/")[0] ?? rest; // strip any path
  const bare = bareHost(authority); // strip any port

  if (bare === "localhost" || isIpLiteral(bare) || authority.startsWith("app.")) {
    // Same host as the API. No scheme given → pick the one `resolveEndpoint`
    // would have dialled, so both halves agree.
    const effective = scheme || (isLocalUrl(bare) ? "http://" : "https://");
    return `${effective}${authority}`;
  }
  return `https://app.${bare}`;
}

/** A usage window bound: a `Date`, or unix seconds. */
export type TimeBound = Date | number;

/** A {@link TimeBound} as unix seconds; `0` when absent (the server default). */
export function toUnixSeconds(t: TimeBound | undefined): number {
  if (t === undefined) return 0;
  return t instanceof Date ? Math.floor(t.getTime() / 1000) : Math.floor(t);
}
