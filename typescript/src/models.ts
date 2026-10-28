// Public models, and the hand-written mappers that produce them.
//
// The mappers exist for shape, not casing: unwrapping response framing,
// dropping redundant prefixes, and turning "unset" into `null` where the
// transport cannot express it.
//
// There is deliberately no blanket zero-to-null rule. `sshPort: 0` means "not
// allocated yet"; `autoSuspendTimeout: 0` means "disabled". Nothing but the
// per-field meaning tells them apart, which is why each mapper is written by
// hand.
import { fromSpecWire, type MachineSpec } from "./spec.js";
import { FsEntryType as WireFsEntryType } from "./_generated/definitions.js";
import type {
  FsEntry as WireFsEntry,
  ApiKeyInfo,
  BackupInfo,
  BillingInfo,
  CheckpointInfo,
  BillingActivityEntry as WireBillingActivityEntry,
  CreateApiKeyResponse,
  CreateCheckpointResponse,
  CreateDiskResponse,
  CreateOrgResponse,
  CreateProxyResponse,
  CreateSnapshotResponse,
  CustomDomainInfo,
  DirEntry as WireDirEntry,
  ListDirResponse as WireListDirResponse,
  DiskAttachment as WireDiskAttachment,
  DiskInfo,
  ExposePortResponse,
  GetBackupScheduleResponse,
  GetOrgIdleIgnoreOutboundDefaultResponse,
  GetOrgBotProtectionDefaultResponse,
  GetOrgMachineDefaultsResponse,
  GetOrgMachineLimitResponse,
  GetOrgMembersResponse,
  GetOrgUsageResponse,
  GetVmResponse,
  GetVmUsageResponse,
  InviteOrgMemberResponse,
  ListBillingActivityResponse,
  NetworkInfo,
  OrgDomainInfo,
  OrgInviteInfo,
  OrgMemberInfo,
  OrgSummary,
  ProxyInfo,
  RequestOrgMachineLimitResponse,
  ResizeVmResponse,
  UpdateMachineSpecResponse,
  SetOrgIdleIgnoreOutboundDefaultResponse,
  SetOrgBotProtectionDefaultResponse,
  SnapshotInfo,
  TeamInfo,
  TeamMemberInfo,
  UsageRates as UsageRatesPb,
  VarItem,
  VmSource,
  VmUsage,
  WhoamiResponse,
} from "./_generated/definitions.js";

/** An empty string is how the transport says "absent". */
function emptyToNull(s: string): string | null {
  return s === "" ? null : s;
}

/** Epoch seconds (most timestamps on this API) → `Date`. */
function secondsToDate(secs: number): Date {
  return new Date(secs * 1000);
}

/** Epoch seconds where `0` is the sentinel for "never" / "no expiry". */
function optionalSecondsToDate(secs: number): Date | null {
  return secs === 0 ? null : secondsToDate(secs);
}

/** Epoch **milliseconds** where `0` means "it never happened". */
function optionalMillisToDate(ms: number): Date | null {
  return ms === 0 ? null : new Date(ms);
}

/** Epoch milliseconds, for fields the server always sets. */
function millisToDate(ms: number): Date {
  return new Date(ms);
}

/** A duration in milliseconds where `0` means "never measured". */
function optionalMillis(ms: number): number | null {
  return ms === 0 ? null : ms;
}

// ─── Machines ────────────────────────────────────────────────────────────

export type MachineStatus =
  | "pending"
  | "starting"
  | "running"
  | "suspended"
  | "hibernated"
  | "stopped"
  | "failed"
  | "destroyed"
  | "migrating";

/** The machine's *effective* sizing. Every field is concrete — never a guess. */
export interface MachineResources {
  vcpu: number;
  memoryBytes: number;
  /**
   * The machine's fixed disk **allocation** — always the platform constant
   * (100 GiB), identical on every machine. It is **not** a usage figure: it
   * does not grow as the disk fills. There is no "disk used" field on the API
   * yet.
   */
  diskBytes: number;
}

/** What `machines.deleteSelf` answers: the machine is going away. */
export interface SelfDeleteResult {
  id: string;
  name: string;
  /**
   * The machine is deleted this long after the call resolves. Anything still
   * running on it, including the calling process, stops then.
   */
  deletesInSecs: number;
}

/** The size a machine now carries, after `machines.resize`. */
export interface ResizeResult {
  vcpu: number;
  memoryBytes: number;
  /**
   * `true` when the machine was running and was rebooted to apply the size.
   * A stopped machine picks the new size up at its next start instead.
   */
  rebooted: boolean;
}

export function toResizeResult(r: ResizeVmResponse): ResizeResult {
  return { vcpu: r.vcpu, memoryBytes: r.memoryBytes, rebooted: r.rebooted };
}

/** An org, by id and name. Both fields are set whenever this object exists. */
export interface OrgRef {
  id: string;
  name: string;
}

export interface MachineAccess {
  /** SSH port for this machine. `null` = not allocated yet (never "port 0"). */
  sshPort: number | null;
  /** Domain the machine is addressed under. */
  domain: string;
  /** `https://<name>.<domain>` — built for you, not sent on the wire. */
  url: string;
  /**
   * The machine's live Desktop view in the console — `https://app.<zone>/desktop/<name>`.
   * Built for you, like `url`. Empty when the client has no endpoint to derive
   * the console origin from. Opening it needs a signed-in browser; the machine
   * is woken if it is asleep.
   */
  desktopUrl: string;
  /**
   * Per-VM custom domains bound to this machine, e.g.
   * `app.example.com`. Distinct from `domain` above, which is the org's
   * wildcard domain or the cluster zone. Empty if none are bound.
   */
  customDomains: CustomDomain[];
}

/** Idle timers, all in **seconds**. `0` means *disabled*, never "unset". */
export interface MachineIdle {
  suspendAfter: number;
  hibernateAfter: number;
  destroyAfter: number;
}

export type MachineSourceKind = "fork" | "snapshot";

/** A machine's bot protection mode. See {@link Machine.botProtectionMode}. */
export type BotProtectionMode = "on" | "sleep_only" | "off";

/**
 * The mode a machine row reports. A server that predates the mode sends only
 * the boolean, whose `true` only ever meant `sleep_only`.
 */
export function toBotProtectionMode(mode: string | undefined, enabled: boolean): BotProtectionMode {
  if (mode === "on" || mode === "sleep_only" || mode === "off") return mode;
  return enabled ? "sleep_only" : "off";
}

/** Where a machine came from. A standalone machine has no source at all. */
export interface MachineSource {
  kind: MachineSourceKind;
  /** The source machine's name (fork) or the snapshot's name (snapshot). */
  name: string;
  /** Snapshot version. `null` for a fork, which has no version. */
  version: number | null;
  /**
   * Id of the source machine or snapshot. **Provenance only — it may not
   * resolve**: the source can have been destroyed or deleted since, and some
   * older machines report a name and version with no id. Treat a lookup miss
   * as normal.
   */
  id: string | null;
}

export interface Machine {
  id: string;
  name: string;
  status: MachineStatus;
  imageRef: string;
  /** `"always"`, `"never"`, … `null` when the server did not set one. */
  restartPolicy: string | null;
  /** `null` on machines created before the platform recorded a creation time. */
  createdAt: Date | null;
  resources: MachineResources;
  /**
   * The org this machine belongs to and is billed to. `null` = it runs on your
   * personal quota. A machine never moves between orgs.
   */
  org: OrgRef | null;
  /** Whether the machine is shared with that org, rather than private to you. */
  shared: boolean;
  /** East-west reachability inside the org. See {@link MachineNetworking}. */
  networking: MachineNetworking;
  /**
   * The machine's egress allowlist. Empty = unrestricted. `["none"]` = nothing
   * is reachable. Otherwise web requests are admitted by hostname and
   * everything else by address, and nothing not named here is reachable. See
   * {@link Machines.setEgressAllow}.
   */
  egressAllow: string[];
  /**
   * User-set `key=value` labels, for grouping and finding machines. Set them
   * with `labels` on create, edit them with {@link Machines.updateLabels},
   * filter by them with `list({ labels })`. A fork or restore inherits its
   * source's. Empty when the machine has none.
   */
  labels: Record<string, string>;
  access: MachineAccess;
  idle: MachineIdle;
  /**
   * Whether visitors must pass a browser check before an HTTPS request
   * reaches the machine. True for both protecting modes; see
   * {@link Machine.botProtectionMode} for which.
   * See {@link Machines.setBotProtection}.
   */
  botProtection: boolean;
  /**
   * How far bot protection reaches. `"on"`: every request is checked, running
   * or asleep, so crawlers can neither wake the machine nor keep it awake.
   * `"sleep_only"`: only a request that would wake the machine from standby
   * or hibernation. `"off"`: never. Null only when the server did not report
   * it (a `create` whose re-read failed).
   * See {@link Machines.setBotProtection}.
   */
  botProtectionMode: BotProtectionMode | null;
  /**
   * Whether the idle clock behind auto-suspend and auto-hibernate ignores
   * connections the machine opened itself, so only connections opened TO it
   * (SSH, HTTPS, another machine) keep it awake. Off by default, unless its
   * org says otherwise. See {@link Machines.setIdleIgnoreOutbound}.
   */
  idleIgnoreOutbound: boolean;
  /**
   * Whether SSH answers on the machine's port (`access.sshPort`). Off:
   * nothing answers SSH for it, on the public address or the org's network;
   * the port stays allocated. `exec` and `boxd connect` don't use SSH.
   * See {@link Machines.setSsh}.
   */
  ssh: boolean;
  /**
   * When the platform will permanently delete this machine, whatever state it
   * is in. `null` = no delete-after timer. See {@link Machines.setDeleteAfter}.
   */
  deleteAt: Date | null;
  /**
   * The cron expression the timer was set with, if any: `deleteAt` is its
   * next match. `null` for a duration or no timer.
   */
  deleteAfterCron: string | null;
  /** `null` = standalone: booted from an image, not forked or restored. */
  source: MachineSource | null;
  /** When the machine went to disk. `null` = not hibernated. */
  hibernatedAt: Date | null;
  /** Last client connection. `null` = never connected. */
  lastConnectedAt: Date | null;
  /** How long the last boot took, in milliseconds. `null` = never booted. */
  bootTimeMs: number | null;
  /**
   * Set on the machine `fork()` returns, and on one `create({ fromSnapshot })`
   * returns: how many automations it was born with paused. A fork or a
   * snapshot carries its source's automations but the new machine does not
   * run them, so the same schedule or webhook is not handled twice;
   * `run restart <id>` inside it starts one there. `0` from every other call.
   */
  pausedAutomations: number;
  /**
   * The machine spec as it stands: the one it was created from
   * (`create({ spec })`), or inherited from its snapshot or fork source.
   * `machines.updateSpec()` changes it, and editing labels, networks, egress
   * or the size updates the matching field. `null` when the machine has none.
   */
  spec: MachineSpec | null;
  /** The spec the machine was created with. Edits never change it. */
  createdSpec: MachineSpec | null;
  /**
   * Who created the machine for its owner (a spec's `assignTo`): their user
   * id, and a name to show for them (`null` when the account has none).
   * `null` when the owner created it.
   */
  createdBy: string | null;
  createdByName: string | null;
  /**
   * What the spec's `connections` and `agents` need, and whether each is
   * connected now (computed when the machine is read). Empty without a spec.
   * An unmet one is only unavailable on the machine: nothing blocks it.
   */
  requirements: MachineRequirement[];
  /**
   * How each of the spec's `packages` went, in order: shell commands run
   * once after the first boot. Empty without any. The whole output is in
   * `/var/log/boxd/packages.log` in the machine.
   */
  packages: MachinePackage[];
}

/**
 * One of a machine's spec `packages` (`Machine.packages`). The first failure
 * stops the rest: the ones after it stay `"pending"` until a retry
 * (`updateSpec(id, {}, { retryPackages: true })`), or until the failed
 * command is removed from the spec, which skips it.
 */
export interface MachinePackage {
  /** The command, as the spec lists it. */
  command: string;
  /**
   * `"pending"`: not run yet (after a failure, not until a retry).
   * `"skipped"`: removed from the spec before it finished, so it never runs
   * and doesn't stop the ones after it (`reason` says when; a failed run
   * keeps its exit code and output). Listing it again makes it pending.
   */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  /** The exit code once it exited; `null` before, and for a timeout or an interrupted run. */
  exitCode: number | null;
  /**
   * The last 4 KiB of its output (stdout and stderr), every secret value the
   * machine gets shown as `[secret NAME]`. Empty on machines from
   * `machines.list()`, which leaves it out to stay small: `machines.get()`
   * has it.
   */
  outputTail: string;
  /**
   * Why it failed without an exit code (a timeout, interrupted too often),
   * why a pending one waits (interrupted: it runs again once the machine is
   * running) or won't run (a fork), why it was skipped, or that a done one
   * ran before the snapshot it was restored from was taken. `null`
   * otherwise.
   */
  reason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * How a spec change reaches the machine (`MachineSpecChange.apply`):
 * - `"live"`: now (labels, networks, egress; connections and agents change
 *   `Machine.requirements`; added packages run now);
 * - `"reboot_recommended"`: env and secrets reach new shells and exec
 *   sessions now, running processes keep the old values until they restart;
 * - `"reboot"`: a new size for a running machine, which reboots it;
 * - `"refused"`: `base`, `isolated` and `assignTo` can't change, a fork runs
 *   no packages, a machine in standby or hibernated can't change size.
 */
export type MachineSpecApply = "live" | "reboot_recommended" | "reboot" | "refused";

/** One changed field of a machine's spec (`MachineSpecUpdate.changes`). */
export interface MachineSpecChange {
  /** The spec field: `"labels"`, `"size"`, `"packages"`, ... */
  field: string;
  apply: MachineSpecApply;
  /** Map keys, list entries or commands added and removed. */
  added: string[];
  removed: string[];
  /**
   * Map keys whose value changes (values are never shown); for `packages`,
   * the commands a retry runs again.
   */
  changed: string[];
  /** Scalars (`size`, `base`, `assignTo`, `isolated`): before and after; `null` when unset. */
  before: string | null;
  after: string | null;
  /** What happens on the machine, in one sentence. */
  note: string;
  /** What the change won't do, e.g. a removed package isn't undone. */
  warnings: string[];
  /**
   * `packages`: commands the change skips (removed from the spec before they
   * finished: they never run and stop nothing) and skipped commands it puts
   * back to pending (listed again).
   */
  skipped: string[];
  unskipped: string[];
}

/** What `machines.updateSpec()` did, or (a dry run) would do. */
export interface MachineSpecUpdate {
  /** Every changed field, in the spec's order; empty when nothing changes. */
  changes: MachineSpecChange[];
  /** A change applies only through a reboot: pass `reboot: true` to allow it. */
  rebootRequired: boolean;
  /** A change reaches running processes only once they restart. */
  rebootRecommended: boolean;
  /** The machine's spec after the patch (for a dry run, what it would be). */
  spec: MachineSpec;
  /** `false` for a dry run. */
  applied: boolean;
  /** The machine was rebooted to apply it. */
  rebooted: boolean;
  /**
   * The resize failed after the rest of the patch applied: its error, or
   * `null`. Then `applied` is still `true`, `rebooted` is `false`, and `spec`
   * is the spec stored now, with the size the machine has.
   */
  resizeError: string | null;
}

const SPEC_APPLY = ["live", "reboot_recommended", "reboot", "refused"] as const;

/** @internal */
export function toMachineSpecUpdate(r: UpdateMachineSpecResponse): MachineSpecUpdate {
  return {
    changes: (r.changes ?? []).map((c) => ({
      field: c.field,
      apply: (SPEC_APPLY as readonly string[]).includes(c.apply)
        ? (c.apply as MachineSpecApply)
        : "refused",
      added: c.added ?? [],
      removed: c.removed ?? [],
      changed: c.changed ?? [],
      before: c.before || null,
      after: c.after || null,
      note: c.note,
      warnings: c.warnings ?? [],
      skipped: c.skipped ?? [],
      unskipped: c.unskipped ?? [],
    })),
    rebootRequired: r.rebootRequired,
    rebootRecommended: r.rebootRecommended,
    spec: fromSpecWire(r.spec) ?? { version: 1 },
    applied: r.applied,
    rebooted: r.rebooted,
    resizeError: r.resizeError || null,
  };
}

/**
 * One thing a machine's spec needs connected (`Machine.requirements`).
 *
 * `personal` is the machine owner's own connection or agent login in the
 * machine's org (for a machine created with `assignTo`, the assignee's);
 * `shared` is the org's connection shared under `tag`.
 */
export interface MachineRequirement {
  /** A spec's `connections` entry, or one of its `agents`. */
  kind: "connection" | "agent";
  /** The toolkit (`"slack"`, `"github-app"`) or the agent (`"claude"`, `"codex"`). */
  name: string;
  /** Agents are always `"personal"`. */
  scope: "personal" | "shared";
  /** The shared connection's name; `null` for a personal one. */
  tag: string | null;
  /** Connected now, so the machine can use it. */
  met: boolean;
  /**
   * You could connect it: the owner for a personal connection or an agent,
   * an org owner or admin for a shared one. `false` once met, and when
   * connecting couldn't help (`reason`).
   */
  canFix: boolean;
  /**
   * Why it can't be met on this machine as it is: an isolated machine gets
   * no integrations, a shared one no personal connection or agent login, a
   * disabled owner's none. `null` otherwise.
   */
  reason: string | null;
}

/**
 * Which machines this one can reach, and be reached by, inside its org.
 *
 * Two machines are peers iff they share at least one entry in `networks`, OR
 * both have none and neither is `isolated` — the org's implicit **default
 * network**. Naming a network therefore opts a machine OUT of the default
 * network: it then reaches only machines it shares one with, and unnamed
 * machines no longer reach it.
 *
 * `isolated` means "explicit networks only": an isolated machine is never in
 * the default network and never peers with another isolated machine, so one
 * with no `networks` has no peers at all. It also has no metadata endpoint,
 * no in-VM `boxd` CLI, and no integrations. Inbound SSH/HTTPS and outbound
 * internet are unaffected.
 *
 * The same rule governs internal DNS (`<name>.boxd`) and `exec`/`cp` between
 * machines, so what resolves is exactly what is reachable.
 */
export interface MachineNetworking {
  networks: string[];
  /** Set at creation and immutable — a fork always inherits it. */
  isolated: boolean;
}

/** Every state this SDK knows about. Exported so callers can validate input. */
export const MACHINE_STATUSES: readonly MachineStatus[] = [
  "pending",
  "starting",
  "running",
  "suspended",
  "hibernated",
  "stopped",
  "failed",
  "destroyed",
  "migrating",
];

const KNOWN_STATUSES: ReadonlySet<string> = new Set(MACHINE_STATUSES);

export function isKnownMachineStatus(s: string): s is MachineStatus {
  return KNOWN_STATUSES.has(s);
}

/**
 * Narrow an untyped `status` string. An unknown value is passed
 * through rather than thrown on: a newer server adding a state must not break
 * an older client that only wanted to print it. Use
 * {@link isKnownMachineStatus} where the distinction matters.
 */
export function toMachineStatus(s: string): MachineStatus {
  return s as MachineStatus;
}

/** `<console>/desktop/<name>`, or `""` when the console origin is unknown. */
function desktopUrl(name: string, consoleOrigin: string): string {
  return consoleOrigin === "" ? "" : `${consoleOrigin}/desktop/${name}`;
}

/** `https://<name>.<domain>`, or `""` when the domain is not known yet. */
function machineUrl(name: string, domain: string): string {
  return domain === "" ? "" : `https://${name}.${domain}`;
}

/** An unset `VmSource` is how the wire says "standalone" — not a kind. */
export function toMachineSource(s: VmSource | undefined): MachineSource | null {
  if (!s) return null;
  return {
    kind: s.kind as MachineSourceKind,
    name: s.name,
    // A fork has no version; the wire sends 0 for it.
    version: s.version === 0 ? null : s.version,
    id: emptyToNull(s.id),
  };
}

/** `consoleOrigin` fills `access.desktopUrl`; the caller has it, the wire does not. */
export function toMachine(v: GetVmResponse, consoleOrigin = ""): Machine {
  // `billingOrg`/`billingOrgId` name the machine's org whether or not it is
  // shared. `org`/`orgId` are the same org, blanked when it is private — so
  // they answer "is it shared", and nothing else.
  const orgId = emptyToNull(v.billingOrgId);
  const orgName = emptyToNull(v.billingOrg);
  return {
    id: v.vmId,
    name: v.name,
    status: toMachineStatus(v.status),
    imageRef: v.imageRef,
    restartPolicy: emptyToNull(v.restartPolicy),
    createdAt: optionalSecondsToDate(v.createdAt),
    // NOT null-mapped: these are the server's effective values, always concrete.
    resources: { vcpu: v.vcpu, memoryBytes: v.memoryBytes, diskBytes: v.diskBytes },
    org: orgId !== null || orgName !== null ? { id: v.billingOrgId, name: v.billingOrg } : null,
    shared: v.org !== "" || v.orgId !== "",
    networking: { networks: v.networks ?? [], isolated: v.isolated },
    egressAllow: v.egressAllow ?? [],
    labels: { ...(v.labels ?? {}) },
    access: {
      // 0 = "not yet allocated" per the proto comment, not a real port.
      sshPort: v.sshPort === 0 ? null : v.sshPort,
      domain: v.accessDomain,
      url: machineUrl(v.name, v.accessDomain),
      desktopUrl: desktopUrl(v.name, consoleOrigin),
      customDomains: (v.customDomains ?? []).map(toCustomDomain),
    },
    // NOT null-mapped: 0 means the timer is off.
    idle: {
      suspendAfter: v.autoSuspendTimeoutSecs,
      hibernateAfter: v.autoHibernateTimeoutSecs,
      destroyAfter: v.autoDestroyTimeoutSecs,
    },
    botProtection: v.botProtection ?? true,
    botProtectionMode: toBotProtectionMode(v.botProtectionMode, v.botProtection ?? true),
    idleIgnoreOutbound: v.idleIgnoreOutbound ?? false,
    // Inverted on the wire, so a server that predates it reads as on.
    ssh: !(v.sshDisabled ?? false),
    deleteAt: optionalMillisToDate(v.deleteAtMs ?? 0),
    deleteAfterCron: v.deleteAfterCron || null,
    source: toMachineSource(v.sourceInfo),
    hibernatedAt: optionalMillisToDate(v.hibernatedAtMs),
    lastConnectedAt: optionalMillisToDate(v.lastConnectedMs),
    bootTimeMs: optionalMillis(v.bootTimeMs),
    pausedAutomations: 0,
    spec: fromSpecWire(v.spec),
    createdSpec: fromSpecWire(v.createdSpec),
    createdBy: v.createdBy || null,
    createdByName: v.createdByName || null,
    requirements: (v.requirements ?? []).map(toMachineRequirement),
    packages: (v.packages ?? []).map(toMachinePackage),
  };
}

const PACKAGE_STATES = ["pending", "running", "done", "failed", "skipped"] as const;

/** @internal */
export function toMachinePackage(p: {
  command: string;
  state: string;
  exitCode?: number | undefined;
  outputTail: string;
  reason: string;
  startedAtMs: number;
  finishedAtMs: number;
}): MachinePackage {
  return {
    command: p.command,
    state: (PACKAGE_STATES as readonly string[]).includes(p.state)
      ? (p.state as MachinePackage["state"])
      : "pending",
    exitCode: p.exitCode ?? null,
    outputTail: p.outputTail,
    reason: p.reason || null,
    startedAt: p.startedAtMs ? new Date(Number(p.startedAtMs)) : null,
    finishedAt: p.finishedAtMs ? new Date(Number(p.finishedAtMs)) : null,
  };
}

/** @internal */
export function toMachineRequirement(r: {
  kind: string;
  name: string;
  scope: string;
  tag: string;
  met: boolean;
  canFix: boolean;
  reason: string;
}): MachineRequirement {
  return {
    kind: r.kind === "agent" ? "agent" : "connection",
    name: r.name,
    scope: r.scope === "shared" ? "shared" : "personal",
    tag: r.tag || null,
    met: r.met,
    canFix: r.canFix,
    reason: r.reason || null,
  };
}

/**
 * @internal
 * Creating a machine answers with fewer fields than reading one back, so
 * `machines.create()` re-reads it. This mapper is only the fallback for when
 * that read fails, and reports the fields it cannot know as unset rather than
 * inventing values for them.
 */
export function toMachineFromCreate(v: {
  vmId: string;
  name: string;
  publicIp: string;
  status: string;
  image: string;
}): Machine {
  return {
    id: v.vmId,
    name: v.name,
    status: toMachineStatus(v.status),
    imageRef: v.image,
    restartPolicy: null,
    createdAt: null,
    // Zeros here mean "not reported by this response", not "sized at zero".
    resources: { vcpu: 0, memoryBytes: 0, diskBytes: 0 },
    org: null,
    shared: false,
    // Not reported by the create response — `machines.create()` re-reads the
    // machine, so this fallback only shows when that read failed.
    networking: { networks: [], isolated: false },
    egressAllow: [],
    // Not reported by the create/fork responses; the re-read fills them in.
    labels: {},
    access: { sshPort: null, domain: "", url: "", desktopUrl: "", customDomains: [] },
    idle: { suspendAfter: 0, hibernateAfter: 0, destroyAfter: 0 },
    // Not reported by the create response. A new machine starts protected;
    // which mode is the cluster's choice, so it stays unknown here.
    botProtection: true,
    botProtectionMode: null,
    // Not reported by the create response either. `false` here means "not
    // known", not "off": the org default or the fork's source may have set it.
    idleIgnoreOutbound: false,
    // Not reported either. `true` here means "not known": the fork's source
    // or the snapshot may have had SSH off.
    ssh: true,
    deleteAt: null,
    deleteAfterCron: null,
    source: null,
    hibernatedAt: null,
    lastConnectedAt: null,
    bootTimeMs: null,
    pausedAutomations: 0,
    // Not reported by the create response; the re-read fills them in. A
    // machine created for someone else (`assignTo`) can't be re-read by its
    // creator, so these stay unset for it.
    spec: null,
    createdSpec: null,
    createdBy: null,
    createdByName: null,
    requirements: [],
    packages: [],
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** `true` when the command exited 0. */
  success: boolean;
}

/**
 * `exec(id, { ..., encoding: "buffer" })`'s result. Byte-exact — unlike the
 * default `ExecResult`, whose `stdout`/`stderr` are UTF-8-decoded and
 * silently replace any invalid byte sequence with U+FFFD. Use this (or
 * `streamExec`, which is always byte-exact) for binary output.
 */
export interface ExecBytesResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  /** `true` when the command exited 0. */
  success: boolean;
}

// ─── Ports ───────────────────────────────────────────────────────────────

export type PortProtocol = "tcp" | "udp" | "both";

export interface ExposedPort {
  /** The machine this forward belongs to — address it without a name lookup. */
  machineId: string;
  machineName: string;
  /** Public hostname for the machine; connect on `publicPort`. */
  dns: string;
  publicPort: number;
  machinePort: number;
  protocol: PortProtocol;
}

export function toExposedPort(p: ExposePortResponse): ExposedPort {
  return {
    machineId: p.vmId,
    machineName: p.vmName,
    dns: p.dns,
    publicPort: p.publicPort,
    machinePort: p.vmPort,
    protocol: p.protocol as PortProtocol,
  };
}

// ─── HTTP proxies ────────────────────────────────────────────────────────

/** `"locked"` = you pinned the port; `"auto"` = discovered inside the machine. */
export type ProxyPortMode = "locked" | "auto";

export interface Proxy {
  /** `null` for the machine's default proxy. */
  name: string | null;
  /** The machine this route points at — address it without a name lookup. */
  machineId: string;
  machineName: string;
  domain: string;
  /** The port traffic is actually forwarded to. Always concrete. */
  port: number;
  portMode: ProxyPortMode;
  isDefault: boolean;
}

export function toProxy(p: ProxyInfo): Proxy {
  return {
    name: emptyToNull(p.name),
    machineId: p.vmId,
    machineName: p.vmName,
    domain: p.domain,
    port: p.effectivePort,
    portMode: p.portMode as ProxyPortMode,
    isDefault: p.isDefault,
  };
}

/**
 * Creating a proxy answers before the route is live, so it confirms only the
 * subdomain and the port it was pointed at. The machine id, the full domain
 * and the resolved port are what `list()` is for.
 */
export interface CreatedProxy {
  name: string;
  port: number;
}

export function toCreatedProxy(p: CreateProxyResponse): CreatedProxy {
  return { name: p.name, port: p.port };
}

// ─── Checkpoints ─────────────────────────────────────────────────────────

export type ArtifactStatus = "pending" | "ready" | "failed";

export interface Checkpoint {
  id: string;
  name: string;
  status: ArtifactStatus;
  sizeBytes: number;
  createdAt: Date;
  /** Who captured it. `null` on checkpoints taken before this was recorded. */
  createdBy: string | null;
  /**
   * Restorable right now — a read-only mirror of `status === "ready"` (also
   * `false` if the machine has since migrated off the checkpoint's worker).
   * Poll `status` for `"ready"` before calling `restore()`; `available` can't
   * say `true` while `status` is still `"pending"`.
   */
  available: boolean;
}

export function toCheckpoint(c: CheckpointInfo): Checkpoint {
  return {
    id: c.checkpointId,
    name: c.name,
    status: c.status as ArtifactStatus,
    sizeBytes: c.sizeBytes,
    createdAt: millisToDate(c.createdAt),
    createdBy: emptyToNull(c.createdBy),
    available: c.available,
  };
}

/** `CreateCheckpoint` answers before the artifact lands, so it is its own shape. */
export interface CreatedCheckpoint {
  id: string;
  name: string;
  status: ArtifactStatus;
}

export function toCreatedCheckpoint(c: CreateCheckpointResponse): CreatedCheckpoint {
  return { id: c.checkpointId, name: c.name, status: c.status as ArtifactStatus };
}

// ─── Backups (disaster recovery) ──────────────────────────────────────────

export type BackupStatus = "pending" | "ready" | "dedup" | "failed";

/** A machine's disaster-recovery backup schedule. `null` from `schedule()`
 * means backups are off — there's no separate enabled flag. */
export interface BackupSchedule {
  scheduleKind: "cron" | "interval" | (string & {});
  /** A cron expression, or an interval in seconds as text, per `scheduleKind`. */
  scheduleValue: string;
  retentionSecs: number;
  nextBackupAt: Date;
  /** `null` until the first tick resolves. */
  lastBackupAt: Date | null;
}

export function toBackupSchedule(s: GetBackupScheduleResponse): BackupSchedule | null {
  if (!s.enabled) return null;
  return {
    scheduleKind: s.scheduleKind as BackupSchedule["scheduleKind"],
    scheduleValue: s.scheduleValue,
    retentionSecs: s.retentionSecs,
    nextBackupAt: millisToDate(s.nextBackupAt),
    lastBackupAt: optionalMillisToDate(s.lastBackupAt),
  };
}

export interface Backup {
  id: string;
  status: BackupStatus;
  /** 0 for pending/dedup/failed. */
  sizeBytes: number;
  /** sha256, hex. `null` for pending/dedup/failed. */
  checksum: string | null;
  /** Set iff `status === "dedup"` — the backup this one is a cheap pointer to. */
  pointsToBackupId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export function toBackup(b: BackupInfo): Backup {
  return {
    id: b.backupId,
    status: b.status as BackupStatus,
    sizeBytes: b.sizeBytes,
    checksum: emptyToNull(b.checksum),
    pointsToBackupId: emptyToNull(b.pointsToBackupId),
    createdAt: millisToDate(b.createdAt),
    expiresAt: millisToDate(b.expiresAt),
  };
}

// ─── Files ───────────────────────────────────────────────────────────────

/** One entry from `machines.files.listDir` — a file or subdirectory. */
export interface DirEntry {
  /** Basename only, not the full path. */
  name: string;
  isDir: boolean;
  /** Meaningless (always 0) for a directory. */
  sizeBytes: number;
  /** ls-style, e.g. "-rw-r--r--" or "drwxr-xr-x". */
  permissions: string;
  modifiedAt: Date;
  /** Approximated with ctime — bumps on rename/chmod/chown, not just creation. */
  addedAt: Date;
}

/** `machines.files.listDir`'s result. `truncated` means the directory held
 *  more than the server's per-listing cap and `entries` is only the first
 *  slice (in no particular order) — never treat it as the whole folder. */
export interface DirListing {
  entries: DirEntry[];
  truncated: boolean;
}

export function toDirListing(r: WireListDirResponse): DirListing {
  return { entries: (r.entries ?? []).map(toDirEntry), truncated: !!r.truncated };
}

export function toDirEntry(e: WireDirEntry): DirEntry {
  return {
    name: e.name,
    isDir: e.isDir,
    sizeBytes: e.sizeBytes,
    permissions: e.permissions,
    modifiedAt: secondsToDate(e.modifiedAt),
    addedAt: secondsToDate(e.addedAt),
  };
}

// ─── machines.fs ─────────────────────────────────────────────────────────

/** What a path is. `"other"` is a FIFO, socket or device. */
export type FsEntryType = "file" | "directory" | "symlink" | "other";

/**
 * One file, directory or symlink inside a machine (`machines.fs.stat`/
 * `list`/`write`).
 *
 * Names and paths are bytes on the machine, so any filename works. `name` and
 * `path` decode them as UTF-8 for convenience (an invalid sequence becomes
 * U+FFFD); `nameBytes`/`pathBytes` (and `symlinkTargetBytes`) are exact, and
 * are what to pass back when a name may not be valid UTF-8.
 */
export interface FsEntry {
  name: string;
  nameBytes: Uint8Array;
  /** The path as given, or the listed directory joined with `name`. */
  path: string;
  pathBytes: Uint8Array;
  /** The entry itself: a symlink is `"symlink"`. */
  type: FsEntryType;
  /** What the entry resolves to after following symlinks — the same as
   *  `type` for anything but a symlink. `null` when a symlink dangles or
   *  loops. */
  targetType: FsEntryType | null;
  /** A directory, or a symlink to one. */
  isDir: boolean;
  /** A regular file, or a symlink to one. */
  isFile: boolean;
  isSymlink: boolean;
  /** Bytes, of what the entry resolves to (a dangling symlink's own). */
  size: number;
  /** Permission bits, e.g. `0o644`. */
  mode: number;
  mtime: Date;
  uid: number;
  gid: number;
  /** What a symlink points to, as stored (decoded as UTF-8); `null` for
   *  anything else. */
  symlinkTarget: string | null;
  /** `symlinkTarget`, as the exact bytes; `null` for anything but a
   *  symlink. */
  symlinkTargetBytes: Uint8Array | null;
}

// `ignoreBOM`: a filename may genuinely start with U+FEFF, which the default
// decoder would silently drop.
const fsNameDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 for display; invalid sequences become U+FFFD rather than throwing. */
export function decodeFsName(bytes: Uint8Array): string {
  return fsNameDecoder.decode(bytes);
}

function toFsEntryType(t: WireFsEntryType): FsEntryType | null {
  switch (t) {
    case WireFsEntryType.FS_ENTRY_TYPE_FILE:
      return "file";
    case WireFsEntryType.FS_ENTRY_TYPE_DIRECTORY:
      return "directory";
    case WireFsEntryType.FS_ENTRY_TYPE_SYMLINK:
      return "symlink";
    case WireFsEntryType.FS_ENTRY_TYPE_UNSPECIFIED:
      return null;
    default:
      // FS_ENTRY_TYPE_OTHER, and any kind a newer server adds.
      return "other";
  }
}

/** Nanoseconds since the epoch → `Date` (millisecond precision). A string
 *  when the stubs carry the 64-bit value exactly, a number otherwise. */
function nanosToDate(ns: number | string): Date {
  if (typeof ns === "string") return new Date(Number(BigInt(ns || "0") / 1_000_000n));
  return new Date(Math.floor(ns / 1_000_000));
}

export function toFsEntry(e: WireFsEntry): FsEntry {
  const type = toFsEntryType(e.type) ?? "other";
  const targetType = toFsEntryType(e.targetType);
  const symlinkTarget = e.symlinkTarget ?? new Uint8Array();
  return {
    name: decodeFsName(e.name),
    // Copies: the decoded message's bytes are views into the whole response.
    nameBytes: e.name.slice(),
    path: decodeFsName(e.path),
    pathBytes: e.path.slice(),
    type,
    targetType,
    isDir: targetType === "directory",
    isFile: targetType === "file",
    isSymlink: type === "symlink",
    size: e.size,
    mode: e.mode,
    mtime: nanosToDate(e.mtimeNs),
    uid: e.uid,
    gid: e.gid,
    symlinkTarget: type === "symlink" ? decodeFsName(symlinkTarget) : null,
    symlinkTargetBytes: type === "symlink" ? symlinkTarget.slice() : null,
  };
}

// ─── Snapshots ───────────────────────────────────────────────────────────

export interface Snapshot {
  id: string;
  name: string;
  /** Latest ready version. `null` = nothing captured yet. */
  version: number | null;
  status: ArtifactStatus;
  sizeBytes: number;
  /** First capture. Does **not** move when a new version is saved. */
  createdAt: Date | null;
  /** Last capture — moves with every new version. */
  updatedAt: Date | null;
  vcpu: number;
  memoryBytes: number;
  useCount: number;
  /**
   * Where its bytes are: `"local"` (on a worker's disk), `"archiving"` (being
   * copied to object storage), `"archived"` (in object storage only) or
   * `"unarchiving"` (being restored to disk). A plain string, so a value
   * added later doesn't break older clients.
   */
  storage: string;
  /**
   * `true` unless `storage` is `"local"`: machines can't be created from it,
   * nor can it be saved again, until an operator unarchives it.
   */
  archived: boolean;
}

export function toSnapshot(s: SnapshotInfo): Snapshot {
  return {
    id: s.snapshotId,
    name: s.name,
    version: s.version === 0 ? null : s.version,
    status: s.status as ArtifactStatus,
    sizeBytes: s.sizeBytes,
    createdAt: optionalMillisToDate(s.createdAt),
    updatedAt: optionalMillisToDate(s.updatedAt),
    vcpu: s.vcpu,
    memoryBytes: s.memoryBytes,
    useCount: s.useCount,
    // A server that predates archiving sends neither: on local disk.
    storage: s.storage || "local",
    archived: s.archived ?? false,
  };
}

/** `CreateSnapshot` answers before the artifact lands, so it is its own shape. */
export interface CreatedSnapshot {
  id: string;
  name: string;
  /** The version being captured. */
  version: number;
  status: ArtifactStatus;
  /**
   * How many of the source machine's automations this version captured.
   * Every machine created from it is born with them paused, as a fork is, so
   * nothing runs twice; `run restart <id>` inside that machine starts one.
   */
  pausedAutomations: number;
}

export function toCreatedSnapshot(s: CreateSnapshotResponse): CreatedSnapshot {
  return {
    id: s.snapshotId,
    name: s.name,
    version: s.version,
    status: s.status as ArtifactStatus,
    pausedAutomations: s.pausedAutomations ?? 0,
  };
}

// ─── Disks ───────────────────────────────────────────────────────────────

export interface DiskAttachment {
  machineId: string;
  machineName: string;
  mountPath: string;
  mountMode: "ro" | "rw";
}

/**
 * `"creating"` until the backing file is allocated and formatted, `"ready"`
 * once it can be attached, `"destroyed"` after deletion.
 */
export type DiskStatus = "creating" | "ready" | "destroyed";

export interface Disk {
  id: string;
  name: string;
  sizeBytes: number;
  status: DiskStatus;
  /** `null` on disks created before the platform recorded a creation time. */
  createdAt: Date | null;
  attachments: DiskAttachment[];
}

function toDiskAttachment(a: WireDiskAttachment): DiskAttachment {
  return {
    machineId: a.vmId,
    machineName: a.vmName,
    mountPath: a.mountPath,
    mountMode: a.mountMode as "ro" | "rw",
  };
}

export function toDisk(d: DiskInfo): Disk {
  return {
    id: d.diskId,
    name: d.name,
    sizeBytes: d.sizeBytes,
    status: d.status as DiskStatus,
    createdAt: optionalMillisToDate(d.createdAt),
    attachments: (d.attachments ?? []).map(toDiskAttachment),
  };
}

/**
 * `CreateDisk` answers with a subset of what `list()` reports — a brand-new
 * disk has no attachments to describe — so it is its own shape.
 */
export interface CreatedDisk {
  id: string;
  name: string;
  sizeBytes: number;
  status: DiskStatus;
}

export function toCreatedDisk(d: CreateDiskResponse): CreatedDisk {
  return {
    id: d.diskId,
    name: d.name,
    sizeBytes: d.sizeBytes,
    status: d.status as DiskStatus,
  };
}

// ─── Env vars & secrets ──────────────────────────────────────────────────

/**
 * Which machines a var reaches. `unattached` and `private-unattached` are for
 * secrets only: such a secret reaches only machines whose spec lists it in
 * `secrets`.
 */
export type VarScope = "all" | "shared" | "private" | "unattached" | "private-unattached";

export interface EnvVar {
  name: string;
  scope: VarScope;
  value: string;
}

/**
 * A secret carries no `value` **by construction**: secret values are
 * write-only and never leave the server. Modelling secrets and env vars as one
 * type would force `value: string | null` with the null decided elsewhere.
 */
export interface Secret {
  name: string;
  scope: VarScope;
  /**
   * Hosts the secret may be sent to. Empty = the real value is injected into
   * the machine. Non-empty = the machine only holds a `bxds_…` placeholder
   * and the real value is substituted into requests to exactly these hosts.
   */
  domains: string[];
  /**
   * How many machines list this secret in their spec. Only unattached
   * secrets have any; 0 for the rest.
   */
  boundMachines: number;
}

export function toEnvVar(v: VarItem): EnvVar {
  return { name: v.name, scope: v.scope as VarScope, value: v.value };
}

export function toSecret(v: VarItem): Secret {
  return {
    name: v.name,
    scope: v.scope as VarScope,
    domains: v.domains ?? [],
    boundMachines: v.boundMachines ?? 0,
  };
}

// ─── Domains ────────────────────────────────────────────────────────────

/** A custom domain pointed at one of your machines. */
export interface CustomDomain {
  domain: string;
  machineId: string;
  machineName: string;
  /** "pending" | "active" */
  status: string;
  /** Empty when active / healthy. */
  lastError: string;
}

export function toCustomDomain(d: CustomDomainInfo): CustomDomain {
  return {
    domain: d.domain,
    machineId: d.vmId,
    machineName: d.vmName,
    status: d.status,
    lastError: d.lastError,
  };
}

/** An org's wildcard domain. */
export interface OrgDomain {
  orgId: string;
  domain: string;
  /** "pending" | "active" */
  status: string;
  /** Empty when active / healthy. */
  lastError: string;
}

export function toOrgDomain(d: OrgDomainInfo): OrgDomain {
  return {
    orgId: d.orgId,
    domain: d.domain,
    status: d.status,
    lastError: d.lastError,
  };
}

// ─── Orgs ────────────────────────────────────────────────────────────────

export interface Org {
  id: string;
  /** Display label — may be shared across orgs. */
  name: string;
  /** Unique machine key, used for resolution. */
  slug: string;
  isAdmin: boolean;
  /** Your default org — where personal machines are billed. */
  isDefault: boolean;
}

export function toOrg(o: OrgSummary, defaultOrgId = ""): Org {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    isAdmin: o.isAdmin,
    isDefault: o.id === defaultOrgId,
  };
}

/** The size new machines in an org are born at, and the quota above it. */
export interface OrgMachineDefaults {
  /**
   * `true` when the org stores an explicit default. `false` means the
   * effective values below are simply the quota ceiling.
   */
  isSet: boolean;
  /** Effective default — what a create with no size asks for. */
  vcpu: number;
  memoryBytes: number;
  /** The org quota. A create or resize above it is refused, never clamped. */
  ceilingVcpu: number;
  ceilingMemoryBytes: number;
}

export function toOrgMachineDefaults(d: GetOrgMachineDefaultsResponse): OrgMachineDefaults {
  return {
    // `set` on the wire; `isSet` here, so it reads as a flag and not a verb.
    isSet: d.set,
    vcpu: d.vcpu,
    memoryBytes: d.memoryBytes,
    ceilingVcpu: d.ceilingVcpu,
    ceilingMemoryBytes: d.ceilingMemoryBytes,
  };
}

/** An open request for a higher machine limit. */
export interface MachineLimitRequest {
  requestedAt: Date;
  /** The machine limit asked for, in total. `null` for a request that named no number. */
  maxVms: number | null;
}

/**
 * How many machines an org may have at once, how many it has, and the open
 * request for more.
 */
export interface OrgMachineLimit {
  orgId: string;
  orgName: string;
  /** The machine limit. */
  maxVms: number;
  /** Machines that count against it now. */
  vmCount: number;
  /** `true` when you are the org's owner, who may ask for more. */
  isOwner: boolean;
  /** The open request for a higher limit, or `null`. The owner's message is never shown back. */
  request: MachineLimitRequest | null;
}

export function toOrgMachineLimit(d: GetOrgMachineLimitResponse): OrgMachineLimit {
  return {
    orgId: d.orgId,
    orgName: d.orgName,
    maxVms: d.maxVms,
    vmCount: d.vmCount,
    isOwner: d.isOwner,
    // `requestedAt` 0 = none open; `requestedMaxVms` 0 = it named no number.
    request:
      d.requestedAt > 0
        ? { requestedAt: secondsToDate(d.requestedAt), maxVms: d.requestedMaxVms || null }
        : null,
  };
}

export function toMachineLimitRequest(d: RequestOrgMachineLimitResponse): MachineLimitRequest {
  return { requestedAt: secondsToDate(d.requestedAt), maxVms: d.requestedMaxVms || null };
}

/** Whether new machines in an org start with `idleIgnoreOutbound` on. */
export interface OrgIdleIgnoreOutboundDefault {
  /**
   * `true` when the org stores an explicit default. `false` means new
   * machines follow the platform's setting, which is what `enabled` then
   * holds.
   */
  isSet: boolean;
  /** Effective default: what a create that does not say gets. */
  enabled: boolean;
  /**
   * The platform's setting, whether or not the org has its own default: what
   * clearing it would give. `false` from a server that predates the field.
   */
  platformEnabled: boolean;
}

export function toOrgIdleIgnoreOutboundDefault(
  d: GetOrgIdleIgnoreOutboundDefaultResponse,
): OrgIdleIgnoreOutboundDefault {
  // `set` on the wire; `isSet` here, like `OrgMachineDefaults`.
  return { isSet: d.set, enabled: d.enabled, platformEnabled: d.platformEnabled };
}

/**
 * What `orgs.setIdleIgnoreOutboundDefault` did to the org's existing
 * machines. All counts are 0 with `newMachinesOnly`.
 */
export interface OrgIdleIgnoreOutboundDefaultResult {
  /** Existing machines whose value was changed. */
  machinesChanged: number;
  /** Snapshots whose value was changed (a restore takes its snapshot's). */
  snapshotsChanged: number;
  /** Other members' private machines, left as they were. */
  machinesSkipped: number;
}

export function toOrgIdleIgnoreOutboundDefaultResult(
  r: SetOrgIdleIgnoreOutboundDefaultResponse,
): OrgIdleIgnoreOutboundDefaultResult {
  return {
    machinesChanged: r.machinesChanged,
    snapshotsChanged: r.snapshotsChanged,
    machinesSkipped: r.machinesSkipped,
  };
}

/** The bot protection mode new machines in an org start with. */
export interface OrgBotProtectionDefault {
  /**
   * `true` when the org stores an explicit default. `false` means new
   * machines follow the platform's setting, which is what `mode` then holds.
   */
  isSet: boolean;
  /** What a machine created in the org right now starts with. */
  mode: BotProtectionMode;
  /**
   * The platform's setting, whether or not the org has its own default: what
   * clearing it would give. `null` from a server that predates the field.
   */
  platformMode: BotProtectionMode | null;
}

export function toOrgBotProtectionDefault(d: GetOrgBotProtectionDefaultResponse): OrgBotProtectionDefault {
  // `set` on the wire; `isSet` here, so it reads as a flag and not a verb.
  return {
    isSet: d.set,
    mode: d.mode as BotProtectionMode,
    platformMode: (d.platformMode || null) as BotProtectionMode | null,
  };
}

/**
 * What `orgs.setBotProtectionDefault` did to the org's existing machines. All
 * counts are 0 with `newMachinesOnly`.
 */
export interface OrgBotProtectionDefaultResult {
  /** Existing machines whose mode was changed. */
  machinesChanged: number;
  /** Snapshots whose mode was changed (a restore takes its snapshot's). */
  snapshotsChanged: number;
  /** Machines with bot protection off, left off. */
  machinesOff: number;
  /** Other members' private machines, left as they were. */
  machinesSkipped: number;
}

export function toOrgBotProtectionDefaultResult(
  r: SetOrgBotProtectionDefaultResponse,
): OrgBotProtectionDefaultResult {
  return {
    machinesChanged: r.machinesChanged,
    snapshotsChanged: r.snapshotsChanged,
    machinesOff: r.machinesOff,
    machinesSkipped: r.machinesSkipped,
  };
}

export interface CreatedOrg {
  id: string;
  name: string;
}

export function toCreatedOrg(o: CreateOrgResponse): CreatedOrg {
  return { id: o.id, name: o.name };
}

export type OrgRole = "owner" | "admin" | "member";

export interface OrgMember {
  userId: string;
  role: OrgRole | string;
  /** Empty when the member has none set. */
  displayName: string;
  /** Empty when the member isn't signed in via GitHub. */
  githubUsername: string;
}

export function toOrgMember(m: OrgMemberInfo): OrgMember {
  return {
    userId: m.userId,
    role: m.role as OrgRole,
    displayName: m.displayName,
    githubUsername: m.githubUsername,
  };
}

/**
 * A pending invite. Visible to org admins only — a plain member's
 * `Orgs.getMembers` returns an empty invite list.
 */
export interface OrgInvite {
  token: string;
  email: string;
  acceptUrl: string;
  createdAt: Date;
  expiresAt: Date;
  /** The role the invitee lands with on accept. */
  role: "admin" | "member" | string;
  /**
   * What happened to the invite email. From `invite`: "sent", "failed" (the
   * send was refused) or "not_configured" (the cluster sends no email). From
   * `getMembers`, also the mail provider's delivery reports: "delivered",
   * "delivery_delayed", "bounced", "complained", "opened", "clicked". "" =
   * unknown (an older server or invite). `acceptUrl` works either way, so
   * share it yourself when the email didn't arrive.
   */
  emailStatus: string;
}

export function toOrgInvite(i: OrgInviteInfo): OrgInvite {
  return {
    token: i.token,
    email: i.email,
    acceptUrl: i.acceptUrl,
    createdAt: secondsToDate(i.createdAt),
    expiresAt: secondsToDate(i.expiresAt),
    role: i.role,
    emailStatus: i.emailStatus,
  };
}

export interface OrgMembers {
  members: OrgMember[];
  invites: OrgInvite[];
}

export function toOrgMembers(r: GetOrgMembersResponse): OrgMembers {
  return {
    members: (r.members ?? []).map(toOrgMember),
    invites: (r.invites ?? []).map(toOrgInvite),
  };
}

/**
 * `InviteOrgMember` doesn't echo `email`/`role` back on the wire (the caller
 * already has them) — fold them in here so `Orgs.invite` returns the same
 * `OrgInvite` shape `getMembers` does.
 */
export function toInvitedOrgMember(
  r: InviteOrgMemberResponse,
  email: string,
  role: string,
): OrgInvite {
  return {
    token: r.token,
    email,
    acceptUrl: r.acceptUrl,
    createdAt: secondsToDate(r.createdAt),
    expiresAt: secondsToDate(r.expiresAt),
    role,
    emailStatus: r.emailStatus,
  };
}

// ─── Teams ──────────────────────────────────────────────────────────────

export interface TeamMember {
  userId: string;
  role: "admin" | "member" | string;
  displayName: string;
  githubUsername: string;
  addedAt: Date;
}

function toTeamMember(m: TeamMemberInfo): TeamMember {
  return {
    userId: m.userId,
    role: m.role,
    displayName: m.displayName,
    githubUsername: m.githubUsername,
    addedAt: millisToDate(m.addedAt),
  };
}

/**
 * An org-scoped sub-group of members, with an optional default snapshot new
 * team machines boot from.
 */
export interface Team {
  id: string;
  orgId: string;
  name: string;
  /** Empty if the creating user no longer exists. */
  createdByUserId: string;
  createdAt: Date;
  /**
   * `true` when the caller has team-admin authority — an inherited org
   * admin/owner, or a direct team-admin membership.
   */
  isAdmin: boolean;
  members: TeamMember[];
  /** `null` when no default is set. */
  defaultSnapshotId: string | null;
}

export function toTeam(t: TeamInfo): Team {
  return {
    id: t.id,
    orgId: t.orgId,
    name: t.name,
    createdByUserId: t.createdByUserId,
    createdAt: millisToDate(t.createdAt),
    isAdmin: t.isAdmin,
    members: (t.members ?? []).map(toTeamMember),
    defaultSnapshotId: t.defaultSnapshotId || null,
  };
}

// ─── API keys & tokens ───────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  /** `null` = never used. */
  lastUsedAt: Date | null;
  /** `null` = no expiry. */
  expiresAt: Date | null;
  /** Org the key is fenced to — every key is scoped to exactly one. */
  org: string;
  kind: "member" | "org";
  /**
   * Who made it: display name, else sign-in handle. An org admin also gets
   * the org's `"org"` keys other people made, and may delete them.
   */
  createdBy: string;
  /** You made it. */
  mine: boolean;
}

export function toApiKey(k: ApiKeyInfo): ApiKey {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: secondsToDate(k.createdAt),
    lastUsedAt: optionalSecondsToDate(k.lastUsedAt),
    expiresAt: optionalSecondsToDate(k.expiresAt),
    org: k.org,
    kind: k.kind as "member" | "org",
    createdBy: k.createdBy,
    // An older server lists only the caller's own keys and
    // sends neither field.
    mine: k.mine || k.createdBy === "",
  };
}

/** The raw key is shown once and never stored — persist it now or lose it. */
export interface CreatedApiKey {
  id: string;
  apiKey: string;
  expiresAt: Date | null;
}

export function toCreatedApiKey(r: CreateApiKeyResponse): CreatedApiKey {
  return { id: r.id, apiKey: r.apiKey, expiresAt: optionalSecondsToDate(r.expiresAt) };
}

// ─── Billing ─────────────────────────────────────────────────────────────

export interface Billing {
  /** `"active"`, `"trialing"`, … `null` on an account that never subscribed. */
  subscriptionStatus: string | null;
  /** `null` = not past due. */
  pastDueSince: Date | null;
  /** Effective quota. */
  maxVms: number;
  vcpu: number;
  memoryBytes: number;
}

export function toBilling(b: BillingInfo | undefined): Billing {
  return {
    subscriptionStatus: emptyToNull(b?.subscriptionStatus ?? ""),
    pastDueSince: optionalSecondsToDate(b?.pastDueSince ?? 0),
    maxVms: b?.maxVms ?? 0,
    vcpu: b?.vcpu ?? 0,
    memoryBytes: b?.memoryBytes ?? 0,
  };
}

// ─── Usage & cost ────────────────────────────────────────────────────────

/**
 * Rates costs are priced at: micro-units (1e-6) of the org's currency per
 * unit-hour.
 */
export interface UsageRates {
  /** Per vCPU-hour while running. */
  vcpuHourMicro: number;
  /** Per GiB-hour of resident RAM, while running or in standby. */
  ramGibHourMicro: number;
  /** Per GiB-hour of used disk, in every state. */
  diskGibHourMicro: number;
}

/** Seconds a machine spent in each state over the window. */
export interface StateSeconds {
  running: number;
  standby: number;
  hibernated: number;
  stopped: number;
}

/** The window usage covers. Usage is metered in 15-minute buckets. */
export interface UsagePeriod {
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** One machine's usage and cost over a window. */
export interface MachineUsage {
  machineId: string;
  /** Current name, or the last one seen if the machine was deleted. */
  name: string;
  /** Owner's user id. `null` for a machine no user owns. */
  ownerId: string | null;
  /** Owner's human label. `null` when nothing better than the id is known. */
  ownerName: string | null;
  shared: boolean;
  /** The machine's current status, or `"deleted"` once it no longer exists. */
  status: string;
  /** Size now (or when last seen, if deleted). */
  resources: { vcpu: number; memoryBytes: number; diskBytes: number };
  seconds: StateSeconds;
  /** vCPU-hours while running. */
  vcpuHours: number;
  /** GiB-hours of resident RAM while running or in standby. */
  ramGibHours: number;
  /** GiB-hours of used disk, in every state. */
  diskGibHours: number;
  /**
   * Estimated cost at current rates, micro-units of the currency
   * (`costMicro / 1e6` is the amount). Billing activity is what was charged.
   */
  costMicro: number;
  /**
   * All of this machine's usage in the window has been metered, so the figures
   * won't grow. Metering lags by up to ~25 minutes: a machine read right after
   * `delete()` is not complete yet, and one that still exists never is in a
   * window that runs to now. Store a cost once this is `true`.
   */
  complete: boolean;
}

/** {@link Machines.usage}: one machine over a window. */
export interface MachineUsageReport extends MachineUsage {
  period: UsagePeriod;
  /** Lower-case ISO 4217: `"eur"` or `"usd"`. */
  currency: string;
  rates: UsageRates;
}

/** {@link Orgs.usage}: every machine in an org over a window. */
export interface OrgUsage {
  orgId: string;
  org: string;
  period: UsagePeriod;
  /** Lower-case ISO 4217: `"eur"` or `"usd"`. */
  currency: string;
  rates: UsageRates;
  /** Sum of the machines' `costMicro`. */
  totalCostMicro: number;
  /** Every machine is complete, so the total won't grow. */
  complete: boolean;
  /** Most expensive first, including machines deleted since. */
  machines: MachineUsage[];
}

/** One entry of the org's billing activity: what was actually charged or added. */
export interface BillingActivityEntry {
  id: string;
  /**
   * `"usage_charge"` (one org-wide charge per 15 minutes), `"topup"`,
   * `"grant"`, `"signup"`, `"promo"`, `"adjustment"`, `"operator_credit"`.
   * New kinds may appear.
   */
  kind: string;
  /** Signed micro-units of the currency: credits positive, charges negative. */
  amountMicro: number;
  createdAt: Date;
}

/** {@link Orgs.billingActivityPage}: one page of billing activity, newest first. */
export interface BillingActivityPage {
  currency: string;
  /** The org's balance now, micro-units of `currency`. */
  balanceMicro: number;
  entries: BillingActivityEntry[];
  /** Pass as `pageToken` for the next (older) page. `null` = this was the last. */
  nextPageToken: string | null;
}

function toUsageRates(r: UsageRatesPb | undefined): UsageRates {
  return {
    vcpuHourMicro: r?.vcpuHourMicro ?? 0,
    ramGibHourMicro: r?.ramGibHourMicro ?? 0,
    diskGibHourMicro: r?.diskGibHourMicro ?? 0,
  };
}

function toPeriod(start: number, end: number): UsagePeriod {
  return { start: secondsToDate(start), end: secondsToDate(end) };
}

export function toMachineUsage(v: VmUsage | undefined): MachineUsage {
  const s = v?.seconds;
  return {
    machineId: v?.vmId ?? "",
    name: v?.name ?? "",
    ownerId: emptyToNull(v?.owner ?? ""),
    ownerName: emptyToNull(v?.ownerName ?? ""),
    shared: v?.sharing === "shared",
    status: v?.status ?? "",
    resources: {
      vcpu: v?.vcpu ?? 0,
      memoryBytes: v?.memoryBytes ?? 0,
      diskBytes: v?.diskBytes ?? 0,
    },
    seconds: {
      running: s?.running ?? 0,
      standby: s?.standby ?? 0,
      hibernated: s?.hibernated ?? 0,
      stopped: s?.stopped ?? 0,
    },
    vcpuHours: v?.vcpuHours ?? 0,
    ramGibHours: v?.ramGibHours ?? 0,
    diskGibHours: v?.diskGibHours ?? 0,
    costMicro: v?.costMicro ?? 0,
    complete: v?.complete ?? false,
  };
}

export function toMachineUsageReport(r: GetVmUsageResponse): MachineUsageReport {
  return {
    ...toMachineUsage(r.usage),
    period: toPeriod(r.periodStart, r.periodEnd),
    currency: r.currency,
    rates: toUsageRates(r.rates),
  };
}

export function toOrgUsage(r: GetOrgUsageResponse): OrgUsage {
  return {
    orgId: r.orgId,
    org: r.org,
    period: toPeriod(r.periodStart, r.periodEnd),
    currency: r.currency,
    rates: toUsageRates(r.rates),
    totalCostMicro: r.totalCostMicro,
    complete: r.complete,
    machines: (r.vms ?? []).map(toMachineUsage),
  };
}

function toBillingActivityEntry(e: WireBillingActivityEntry): BillingActivityEntry {
  return {
    id: e.entryId,
    kind: e.kind,
    amountMicro: e.amountMicro,
    createdAt: secondsToDate(e.createdAt),
  };
}

export function toBillingActivityPage(r: ListBillingActivityResponse): BillingActivityPage {
  return {
    currency: r.currency,
    balanceMicro: r.balanceMicro,
    entries: (r.entries ?? []).map(toBillingActivityEntry),
    nextPageToken: emptyToNull(r.nextPageToken),
  };
}

// ─── Account ─────────────────────────────────────────────────────────────

export interface Account {
  userId: string;
  /** Identity handle / display name. `null` falls back to `userId`. */
  displayName: string | null;
  sshKeyFingerprints: string[];
  billing: Billing;
}

export function toAccount(w: WhoamiResponse): Account {
  return {
    userId: w.userId,
    displayName: emptyToNull(w.displayName),
    sshKeyFingerprints: w.pubkeyFingerprints ?? [],
    billing: toBilling(w.billing),
  };
}

export interface ClusterConfig {
  defaultImage: string;
  zone: string;
}

// ─── Machine creation config ─────────────────────────────────────────────

export interface MachineConfig {
  vcpu?: number;
  /** One of the supported sizes: 1 vCPU/"4G", 2/"8G", 4/"16G", 8/"32G". */
  memory?: string;
  disk?: string;
  /** Seconds; `0` disables. Unset = server default. */
  autoSuspendTimeout?: number;
  /** Seconds; `0` = no auto-destroy. */
  autoDestroyTimeout?: number;
  /**
   * `true`: only connections opened TO the machine (SSH, HTTPS, another
   * machine) reset the idle clock behind auto-suspend and auto-hibernate, so
   * its own outbound traffic no longer keeps it awake. `false`: any traffic
   * does. Unset = not requested: a new machine takes its org's default (the
   * platform's setting when the org has none), and a fork or a restore keeps
   * the source's value.
   * Change it later with `machines.setIdleIgnoreOutbound`.
   */
  idleIgnoreOutbound?: boolean;
  /**
   * `false`: SSH off. Nothing answers SSH on the machine's port, on the public
   * address or the org's network; `exec`, `boxd connect` and the console
   * terminal don't use SSH and keep working. Unset = not requested: a new
   * machine has SSH on, and a fork or a restore keeps the source's setting.
   * Change it later with `machines.setSsh`.
   */
  ssh?: boolean;
  proxies?: { name: string; port?: number }[];
  volumes?: { diskId: string; mountPath: string; readOnly?: boolean }[];
}
