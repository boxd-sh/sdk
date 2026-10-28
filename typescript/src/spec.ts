/**
 * Machine specs: describe a ready-to-work machine in one value, built from
 * reusable pieces.
 *
 * ```ts
 * import { Boxd, Machine, team, github, slack, jira, claude, secrets } from "@boxd-sh/sdk";
 *
 * const engineering = Machine.spec()
 *   .from(team("eng"))
 *   .network("eng")
 *   .label("team", "eng")
 *   .env("NODE_ENV", "development")
 *   .packages("apt-get install -y nginx", "npm i -g pnpm")
 *   .with(github({ shared: "eng-bot" }), claude());
 *
 * const mike = engineering
 *   .size("2x8")
 *   .with(slack(), jira({ shared: "jira" }), secrets("NPM_TOKEN"));
 * const m = await boxd.machines.create({ name: "mike-dev", spec: mike });
 * console.log(m.spec); // the resolved spec, as the machine keeps it
 * ```
 *
 * A piece is a plain function returning part of a spec, so you can write
 * your own. The SDK merges pieces and the server checks every field.
 *
 * Merge rules (the server applies the same ones when a restore adds a spec
 * to a snapshot's): maps (`labels`, `env`, `connections`) merge with the
 * later piece winning; lists (`networks`, `egress`, `secrets`, `agents`,
 * `packages`) combine in order without duplicates; `version`, `base`, `size` and
 * `assignTo` set twice to different values throw (a size compares as the
 * server stores it, so `"2X8"` is `"2x8"`); `isolated` only ever turns on. A
 * name can't be in both `env` and `secrets`.
 */

import { BoxdError } from "./errors.js";
import type {
  MachineSpec as MachineSpecWire,
  MachineSpecBase as MachineSpecBaseWire,
} from "./_generated/definitions.js";
import type { Machine as MachineInfo } from "./models.js";

/** The spec version this SDK writes. */
export const MACHINE_SPEC_VERSION = 1;

/**
 * `"<vcpu>x<memory GiB>"`. The three standard sizes autocomplete; any other
 * string is passed to the server, which checks it against the cluster's sizes
 * and the org's quota.
 */
export type MachineSize = "1x4" | "2x8" | "4x16" | (string & {});

/** What a machine boots from. Make one with {@link team} or {@link snapshot}. */
export type MachineSpecBase = { team: string } | { snapshot: string };

/**
 * How an integration is connected: the machine owner's own connection
 * (`"personal"`), or the org connection shared under a tag (`"shared:<tag>"`).
 */
export type MachineSpecConnection = "personal" | `shared:${string}`;

/** An agent login a machine needs. */
export type MachineSpecAgent = "claude" | "codex" | (string & {});

/**
 * A machine spec, in the form the server stores and returns: empty fields are
 * left out. `resolve()` on a builder returns one.
 */
export interface MachineSpec {
  version: number;
  /** Omitted: the default image. */
  base?: MachineSpecBase;
  /** Omitted: the org's default size (a restore keeps the snapshot's). */
  size?: MachineSize;
  /**
   * Create the machine for another member of the org: their user id. Org
   * owners and admins only, in a create that names the org. Never inherited
   * by forks, snapshots or restores.
   */
  assignTo?: string;
  labels?: Record<string, string>;
  networks?: string[];
  /** Isolated: a sandbox with no peers except through a shared network. */
  isolated?: boolean;
  /**
   * Egress allowlist: hosts, `*.` wildcards, public IPv4. `["none"]`: nothing
   * is reachable. Omitted: unrestricted.
   */
  egress?: string[];
  /** The machine's own env vars. They win over org and personal vars of the same name. */
  env?: Record<string, string>;
  /**
   * Names of secrets the machine gets: your own or the org's, usually
   * `unattached` ones, which reach no machine otherwise. The machine keeps a
   * reference, so rotating a secret reaches it. A name can't also be in `env`.
   */
  secrets?: string[];
  /** Integration name → how it is connected. Recorded on the machine. */
  connections?: Record<string, MachineSpecConnection>;
  /** Agent logins the machine needs. Recorded on the machine. */
  agents?: MachineSpecAgent[];
  /**
   * Shell commands run once, in order, as root, after the machine's first
   * boot (`DEBIAN_FRONTEND=noninteractive`, 30 minutes each, output in
   * `/var/log/boxd/packages.log`). The first failure stops the rest; the
   * machine stays usable. At most 50 commands of at most 4 KiB each.
   * `machine.packages` reports how each one went.
   */
  packages?: string[];
}

/** Part of a spec: what a piece returns and what `.with()` accepts. */
export type MachineSpecPiece = Partial<MachineSpec>;

const FIELDS = [
  "version",
  "base",
  "size",
  "assignTo",
  "labels",
  "networks",
  "isolated",
  "egress",
  "env",
  "secrets",
  "connections",
  "agents",
  "packages",
] as const;

/** Boot from this team's default snapshot (name or id). */
export function team(name: string): MachineSpecBase {
  return { team: name };
}

/** Boot from this snapshot (name or id): the machine is a restore of it. */
export function snapshot(name: string): MachineSpecBase {
  return { snapshot: name };
}

function specError(field: string, rule: string): BoxdError {
  return new BoxdError(field ? `spec.${field}: ${rule}` : `spec: ${rule}`);
}

function showBase(b: MachineSpecBase): string {
  return "team" in b ? `team(${JSON.stringify(b.team)})` : `snapshot(${JSON.stringify(b.snapshot)})`;
}

function sameBase(a: MachineSpecBase, b: MachineSpecBase): boolean {
  return showBase(a) === showBase(b);
}

/** Throws on a key a spec doesn't have, or a base that isn't `team` or `snapshot`. */
function checkPiece(piece: object): void {
  if (piece === null || typeof piece !== "object" || Array.isArray(piece)) {
    throw specError("", "a spec is an object");
  }
  for (const key of Object.keys(piece)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw specError(key, `unknown field; a spec has ${FIELDS.join(", ")}`);
    }
  }
  const base = (piece as MachineSpecPiece).base as unknown;
  if (base !== undefined) {
    const entries =
      base !== null && typeof base === "object" && !Array.isArray(base)
        ? Object.entries(base)
        : [];
    const ok =
      entries.length === 1 &&
      (entries[0]![0] === "team" || entries[0]![0] === "snapshot") &&
      typeof entries[0]![1] === "string";
    if (!ok) {
      throw specError("base", 'set exactly one of team or snapshot, e.g. {"team": "eng"}');
    }
  }
}

/**
 * A size as the server stores it, so `"2X8"` and `" 2x8 "` merge with a stored
 * `"2x8"`: `<vcpu>x<GiB>` with a lowercase `x`, no padding or leading zeros.
 * Anything else is only trimmed, for the server to refuse.
 */
function normalizeSize(size: string | undefined): string | undefined {
  if (typeof size !== "string") return size;
  const s = size.trim();
  const m = s ? /^([0-9]+)\s*[xX]\s*([0-9]+)$/.exec(s) : null;
  if (!m) return s || undefined;
  const digits = (d: string) => d.replace(/^0+(?=[0-9])/, "");
  return `${digits(m[1]!)}x${digits(m[2]!)}`;
}

function union(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const v of [...(a ?? []), ...(b ?? [])]) if (!out.includes(v)) out.push(v);
  return out;
}

/** The stored form: empty fields left out, version defaulted. */
function compact(s: MachineSpecPiece): MachineSpec {
  const out: MachineSpec = { version: s.version || MACHINE_SPEC_VERSION };
  if (s.base) out.base = "team" in s.base ? { team: s.base.team } : { snapshot: s.base.snapshot };
  const size = normalizeSize(s.size);
  if (size) out.size = size;
  if (s.assignTo) out.assignTo = s.assignTo;
  if (s.labels && Object.keys(s.labels).length) out.labels = { ...s.labels };
  if (s.networks?.length) out.networks = [...s.networks];
  if (s.isolated) out.isolated = true;
  if (s.egress?.length) out.egress = [...s.egress];
  if (s.env && Object.keys(s.env).length) out.env = { ...s.env };
  if (s.secrets?.length) out.secrets = [...s.secrets];
  if (s.connections && Object.keys(s.connections).length) out.connections = { ...s.connections };
  if (s.agents?.length) out.agents = [...s.agents];
  if (s.packages?.length) out.packages = [...s.packages];
  return out;
}

function merge2(a: MachineSpecPiece, b: MachineSpecPiece): MachineSpecPiece {
  let version = a.version || b.version;
  if (a.version && b.version) {
    if (a.version !== b.version) {
      throw specError("version", `set twice to different values: ${a.version} and ${b.version}`);
    }
    version = b.version;
  }
  if (a.base && b.base && !sameBase(a.base, b.base)) {
    throw specError(
      "base",
      `set twice to different values: ${showBase(a.base)} and ${showBase(b.base)}`,
    );
  }
  const [aSize, bSize] = [normalizeSize(a.size), normalizeSize(b.size)];
  if (aSize && bSize && aSize !== bSize) {
    throw specError(
      "size",
      `set twice to different values: ${JSON.stringify(aSize)} and ${JSON.stringify(bSize)}`,
    );
  }
  if (a.assignTo && b.assignTo && a.assignTo !== b.assignTo) {
    throw specError(
      "assignTo",
      `set twice to different values: ${JSON.stringify(a.assignTo)} and ${JSON.stringify(b.assignTo)}`,
    );
  }
  const env = { ...a.env, ...b.env };
  const secretNames = union(a.secrets, b.secrets);
  const both = secretNames.find((name) => Object.hasOwn(env, name));
  if (both !== undefined) {
    throw specError(
      "secrets",
      `${JSON.stringify(both)} is also in env; a name is either a plain value (env) or a secret (secrets), not both`,
    );
  }
  return {
    version,
    base: b.base ?? a.base,
    size: bSize || aSize,
    assignTo: b.assignTo || a.assignTo,
    labels: { ...a.labels, ...b.labels },
    networks: union(a.networks, b.networks),
    isolated: Boolean(a.isolated || b.isolated),
    egress: union(a.egress, b.egress),
    env,
    secrets: secretNames,
    connections: { ...a.connections, ...b.connections },
    agents: union(a.agents, b.agents),
    packages: union(a.packages, b.packages),
  };
}

/**
 * Merge pieces in order with the rules above, and return the resolved spec.
 * Throws a `BoxdError` naming the field when two pieces disagree or a piece
 * has a key a spec doesn't.
 */
export function mergeSpecs(...pieces: MachineSpecPiece[]): MachineSpec {
  let out: MachineSpecPiece = {};
  for (const p of pieces) {
    checkPiece(p);
    out = merge2(out, p);
  }
  return compact(out);
}

/**
 * An immutable spec builder: every method returns a new builder, so a shared
 * base can be extended in several directions.
 */
export class MachineSpecBuilder {
  readonly #pieces: readonly MachineSpecPiece[];

  constructor(pieces: readonly MachineSpecPiece[] = []) {
    // Merge now, so a conflict throws where it was written.
    mergeSpecs(...pieces);
    this.#pieces = pieces;
  }

  /** Add pieces (or other builders), merged in order after this one's. */
  with(...pieces: Array<MachineSpecPiece | MachineSpecBuilder>): MachineSpecBuilder {
    const parts = pieces.map((p) => (p instanceof MachineSpecBuilder ? p.resolve() : p));
    return new MachineSpecBuilder([...this.#pieces, ...parts]);
  }

  /** What the machine boots from: `team("eng")` or `snapshot("eng-base")`. */
  from(base: MachineSpecBase): MachineSpecBuilder {
    return this.with({ base });
  }

  size(size: MachineSize): MachineSpecBuilder {
    return this.with({ size });
  }

  /**
   * Create the machine for another member of the org (their user id): it is
   * theirs from the start, private to them and billed to the org. Only an
   * org owner or admin may, in a create that names the org.
   */
  assignTo(userId: string): MachineSpecBuilder {
    return this.with({ assignTo: userId });
  }

  label(key: string, value: string): MachineSpecBuilder;
  label(labels: Record<string, string>): MachineSpecBuilder;
  label(key: string | Record<string, string>, value = ""): MachineSpecBuilder {
    return this.with({ labels: typeof key === "string" ? { [key]: value } : key });
  }

  /** Networks the machine joins (east-west reachability inside the org). */
  network(...networks: string[]): MachineSpecBuilder {
    return this.with({ networks });
  }

  env(key: string, value: string): MachineSpecBuilder;
  env(env: Record<string, string>): MachineSpecBuilder;
  env(key: string | Record<string, string>, value = ""): MachineSpecBuilder {
    return this.with({ env: typeof key === "string" ? { [key]: value } : key });
  }

  /**
   * Hosts the machine may reach; naming any makes everything else
   * unreachable. `egress("none")` lets it reach nothing.
   */
  egress(...hosts: string[]): MachineSpecBuilder {
    return this.with({ egress: hosts });
  }

  /**
   * Shell commands to run once, in order, as root, after the first boot,
   * e.g. `"apt-get install -y nginx"`. The first failure stops the rest.
   * A command already listed isn't added twice.
   */
  packages(...commands: string[]): MachineSpecBuilder {
    return this.with({ packages: commands });
  }

  /** Isolate the machine. Once on, a later piece can't turn it off. */
  isolated(): MachineSpecBuilder {
    return this.with({ isolated: true });
  }

  /** The merged spec, to print, diff or keep. */
  resolve(): MachineSpec {
    return mergeSpecs(...this.#pieces);
  }
}

/**
 * As a type, a machine (what `machines.create()`, `get()` and `list()`
 * return). As a value, where a spec starts: `Machine.spec()`. One name for
 * both, so `import type { Machine }` keeps meaning the model.
 */
export type Machine = MachineInfo;
export const Machine = {
  /** An empty spec to build on. */
  spec(): MachineSpecBuilder {
    return new MachineSpecBuilder();
  },
};

/** Options for an integration piece. */
export interface ConnectionPieceOptions {
  /** Use the org connection shared under this tag instead of the owner's own. */
  shared?: string;
}

function connection(name: string, opts: ConnectionPieceOptions = {}): MachineSpecPiece {
  return { connections: { [name]: opts.shared ? `shared:${opts.shared}` : "personal" } };
}

/** The machine needs Slack. */
export const slack = (opts?: ConnectionPieceOptions): MachineSpecPiece => connection("slack", opts);
/** The machine needs Jira. */
export const jira = (opts?: ConnectionPieceOptions): MachineSpecPiece => connection("jira", opts);
/** The machine needs GitHub. */
export const github = (opts?: ConnectionPieceOptions): MachineSpecPiece =>
  connection("github", opts);
/** The machine needs Asana. */
export const asana = (opts?: ConnectionPieceOptions): MachineSpecPiece => connection("asana", opts);
/** The machine needs a Claude Code login. */
export const claude = (): MachineSpecPiece => ({ agents: ["claude"] });
/** The machine needs a Codex login. */
export const codex = (): MachineSpecPiece => ({ agents: ["codex"] });
/**
 * The machine gets these secrets, by name: your own or the org's, usually
 * `unattached` ones (`boxd.secrets.set(name, value, { scope: "unattached" })`).
 */
export const secrets = (...names: string[]): MachineSpecPiece => ({ secrets: names });

/**
 * A change to a machine's spec, for `machines.updateSpec()`: a JSON Merge
 * Patch (RFC 7396) on the spec. A field left out is untouched; a scalar
 * replaces the current value; maps (`labels`, `env`, `connections`) merge key
 * by key, a key set to `null` is removed; a list replaces the current list;
 * `null` removes a field. `base` is replaced whole.
 */
export interface MachineSpecPatch {
  version?: number | null;
  base?: MachineSpecBase | null;
  size?: MachineSize | null;
  assignTo?: string | null;
  labels?: Record<string, string | null> | null;
  networks?: string[] | null;
  isolated?: boolean | null;
  egress?: string[] | null;
  env?: Record<string, string | null> | null;
  secrets?: string[] | null;
  connections?: Record<string, MachineSpecConnection | null> | null;
  agents?: MachineSpecAgent[] | null;
  packages?: string[] | null;
}

const MAP_FIELDS = ["labels", "env", "connections"] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The smallest patch that turns spec `from` into spec `to`: what
 * `machines.updateSpec(id, s => ...)` sends. The server computes the same.
 */
export function specPatch(from: MachineSpec, to: MachineSpec): MachineSpecPatch {
  const a = compact(from) as unknown as Record<string, unknown>;
  const b = compact(to) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const x = a[key];
    const y = b[key];
    if (y === undefined) {
      if (x !== undefined) out[key] = null;
    } else if (x !== undefined && (MAP_FIELDS as readonly string[]).includes(key)) {
      // Key by key, so the order a builder wrote them in doesn't matter.
      const xm = x as Record<string, string>;
      const ym = y as Record<string, string>;
      const m: Record<string, string | null> = {};
      for (const k of Object.keys(xm)) if (!Object.hasOwn(ym, k)) m[k] = null;
      for (const [k, v] of Object.entries(ym)) if (xm[k] !== v) m[k] = v;
      if (Object.keys(m).length) out[key] = sorted(m);
    } else if (!same(x, y)) {
      out[key] = y;
    }
  }
  return out as MachineSpecPatch;
}

/**
 * @internal Throws on what the server would refuse before reading the patch:
 * not a plain object, an unknown field. A builder, a `Map` or a class instance
 * is refused rather than sent as the `{}` `JSON.stringify` makes of it.
 */
export function checkSpecPatch(patch: unknown): asserts patch is MachineSpecPatch {
  if (patch instanceof MachineSpecBuilder) {
    throw specError(
      "",
      "a patch is a JSON object, not a builder: pass builder.resolve() to set the " +
        "fields it names, or a function (s => s.network(\"ops\")) to add to the " +
        "machine's current spec",
    );
  }
  const proto = patch !== null && typeof patch === "object" ? Object.getPrototypeOf(patch) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw specError("", 'a patch is a JSON object, e.g. {"labels": {"team": "ops"}}');
  }
  for (const key of Object.keys(patch as object)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw specError(key, `unknown field; a spec has ${FIELDS.join(", ")}`);
    }
  }
}

/**
 * @internal Apply a patch the way the server does, before its checks (which
 * also normalize, e.g. sort `egress`). For tests and previews.
 */
export function applySpecPatch(current: MachineSpec, patch: MachineSpecPatch): MachineSpec {
  checkSpecPatch(patch);
  const doc = { ...compact(current) } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete doc[key];
    } else if ((MAP_FIELDS as readonly string[]).includes(key)) {
      const m = { ...((doc[key] as Record<string, string>) ?? {}) };
      for (const [k, v] of Object.entries(value as Record<string, string | null>)) {
        if (v === null) delete m[k];
        else m[k] = v;
      }
      doc[key] = sorted(m);
    } else {
      doc[key] = value;
    }
  }
  return compact(doc as MachineSpecPiece);
}

/** @internal A builder or a resolved spec, checked and in wire form. */
export function toSpecWire(spec: MachineSpec | MachineSpecBuilder): MachineSpecWire {
  const s = spec instanceof MachineSpecBuilder ? spec.resolve() : mergeSpecs(spec);
  const base: MachineSpecBaseWire | undefined = s.base
    ? "team" in s.base
      ? { team: s.base.team }
      : { snapshot: s.base.snapshot }
    : undefined;
  return {
    version: s.version,
    base,
    size: s.size ?? "",
    assignTo: s.assignTo ?? "",
    labels: s.labels ?? {},
    networks: s.networks ?? [],
    isolated: s.isolated ?? false,
    egress: s.egress ?? [],
    env: s.env ?? {},
    secrets: s.secrets ?? [],
    connections: s.connections ?? {},
    agents: s.agents ?? [],
    packages: s.packages ?? [],
  };
}

/** Wire maps arrive in no particular order; sorted, a spec prints the same every time. */
function sorted<V>(m: Record<string, V> | undefined): Record<string, V> {
  return Object.fromEntries(Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** @internal A spec off the wire, in the stored form; `null` when unset. */
export function fromSpecWire(w: MachineSpecWire | undefined): MachineSpec | null {
  if (!w) return null;
  const base = w.base?.team
    ? team(w.base.team)
    : w.base?.snapshot
      ? snapshot(w.base.snapshot)
      : undefined;
  return compact({
    version: w.version,
    base,
    size: w.size,
    assignTo: w.assignTo,
    labels: sorted(w.labels),
    networks: w.networks,
    isolated: w.isolated,
    egress: w.egress,
    env: sorted(w.env),
    secrets: w.secrets,
    connections: sorted(w.connections) as Record<string, MachineSpecConnection>,
    agents: w.agents,
    packages: w.packages,
  });
}
