import type { Platform } from "./_platform.js";
import type { DuplexCall, Transport } from "./_rpc.js";
import { AsyncByteQueue, ExecStream } from "./exec.js";
import {
  APIConnectionError,
  AuthenticationError,
  BoxdError,
  ConflictError,
  GrpcStatus,
} from "./errors.js";
import { metadataBase } from "./auth.js";
import { parseSize, toUnixSeconds, type TimeBound } from "./utils.js";
import {
  MachineSpecBuilder,
  checkSpecPatch,
  specPatch,
  toSpecWire,
  type MachineSpec,
  type MachineSpecPatch,
} from "./spec.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import {
  toMachine,
  toMachineFromCreate,
  toMachineUsageReport,
  toMachineSpecUpdate,
  toResizeResult,
  type BotProtectionMode,
  type ExecBytesResult,
  type ExecResult,
  type Machine,
  type MachineConfig,
  type MachineSpecUpdate,
  type MachineUsageReport,
  type ResizeResult,
  type SelfDeleteResult,
} from "./models.js";
import { MachineBackups } from "./backups.js";
import { MachineCheckpoints } from "./checkpoints.js";
import { MachineFiles } from "./files.js";
import { MachineFs } from "./fs.js";
import { MachinePorts } from "./ports.js";
import { MachineProxies } from "./proxies.js";
import type {
  CreateVmFromSnapshotRequest,
  CreateVmRequest,
  CreateVmResponse,
  DestroyVmRequest,
  DestroyVmResponse,
  ExecChunk,
  ForkVmRequest,
  ForkVmResponse,
  GetVmRequest,
  GetVmResponse,
  HibernateVmRequest,
  HibernateVmResponse,
  ListVmsRequest,
  ListVmsResponse,
  LogChunk,
  RebootVmRequest,
  RebootVmResponse,
  RenameVmRequest,
  RenameVmResponse,
  ResizeVmRequest,
  ResizeVmResponse,
  ResumeVmRequest,
  ResumeVmResponse,
  SetAutoHibernateTimeoutRequest,
  SetAutoHibernateTimeoutResponse,
  SetAutoSuspendTimeoutRequest,
  SetAutoSuspendTimeoutResponse,
  SetVmNetworksRequest,
  SetVmNetworksResponse,
  ShareVmRequest,
  ShareVmResponse,
  StartVmRequest,
  StartVmResponse,
  StopVmRequest,
  StopVmResponse,
  StreamLogsRequest,
  SuggestVmNameRequest,
  SuggestVmNameResponse,
  SuspendVmRequest,
  SuspendVmResponse,
  UnshareVmRequest,
  UnshareVmResponse,
  VmConfig,
  WakeVmRequest,
  WakeVmResponse,
} from "./_generated/definitions.js";

/** Options for `machines.updateSpec()`. */
export interface MachineUpdateSpecOptions {
  /** Return the diff and change nothing. */
  dryRun?: boolean;
  /**
   * Allow a change that reboots the machine (a new size for a running
   * machine). Without it such a patch is refused and nothing changes.
   */
  reboot?: boolean;
  /**
   * Run the machine's packages again from the first failed one: it and every
   * command after it that didn't finish go back to pending and run now (or
   * the next time the machine runs), in order, before any the patch adds.
   * Works with an empty patch (`{}`). Refused on a fork; with no failed
   * command it changes nothing, and the diff says so. Skipped commands stay
   * skipped, and a failed command the patch removes is skipped, not run
   * again.
   */
  retryPackages?: boolean;
  /**
   * The spec you read (`machine.spec`). When the machine's spec is no longer
   * that one, nothing is applied and the call throws `ConflictError`: read it
   * again and make the change on the new spec. The function form sends the
   * spec it read and retries by itself; pass this with a patch you built
   * from a spec you read, so it can't undo someone else's change.
   */
  expectedSpec?: MachineSpec;
}

/** How many times the function form of `updateSpec` tries again on a conflict. */
const UPDATE_SPEC_RETRIES = 3;

/** What both ways of creating a machine share. */
interface MachineCreateCommon {
  name?: string;
  /** Org (name or id) to create in — you must be a member. Empty = personal. */
  org?: string;
  config?: MachineConfig;
  /**
   * Permanently delete the machine this many seconds from now (wall-clock),
   * whatever state it is in. Change or clear it later with
   * {@link Machines.setDeleteAfter}.
   */
  deleteAfter?: number;
  /**
   * Or delete it at the next match of this cron expression, UTC
   * (`"0 18 * * *"`). Not together with `deleteAfter`.
   */
  deleteAfterCron?: string;
  /**
   * Machine labels: `key=value` metadata for grouping and finding machines
   * (`{ env: "prod" }`). On a restore they are merged over the labels the
   * snapshot captured, key by key. Edit them later with
   * {@link Machines.updateLabels}; the rules are there.
   */
  labels?: Record<string, string>;
}

/** Boot a fresh machine from an image. */
export interface MachineCreateFromImageParams extends MachineCreateCommon {
  image?: string;
  /** Share with the whole org (only meaningful with `org`). */
  shared?: boolean;
  env?: Record<string, string>;
  cmd?: string[];
  restartPolicy?: "always" | "never";
  /**
   * Networks this machine joins, for east-west reachability inside the org.
   * Omit to join the org's default network (its other machines that have no
   * networks); naming one opts out of it. Editable later with
   * {@link Machines.setNetworks}. See {@link MachineNetworking}.
   */
  networks?: string[];
  /**
   * Isolate the machine: reachable only through a shared `networks` entry,
   * never through the default network and never from another isolated
   * machine. No metadata endpoint, no in-VM `boxd` CLI, no integrations.
   * **Immutable** — there is no setter. A fork or restore inherits it, and
   * can only ever add it (see {@link MachineForkParams.isolated}).
   */
  isolated?: boolean;
  fromSnapshot?: never;
  spec?: never;
}

/**
 * Create a machine from a machine spec: a builder (`Machine.spec()...`) or a
 * resolved {@link MachineSpec}. The spec carries the base, size, labels,
 * networks, isolation, egress and env, so none of those can be passed next
 * to it (and `config` sizing neither). A spec whose base is a snapshot
 * restores that snapshot. The machine keeps the spec: see
 * {@link Machine.spec}.
 */
export interface MachineCreateFromSpecParams extends Omit<MachineCreateCommon, "labels"> {
  spec: MachineSpecBuilder | MachineSpec;
  /** Share with the whole org (only meaningful with `org`). */
  shared?: boolean;
  labels?: never;
  fromSnapshot?: never;
  image?: never;
  env?: never;
  cmd?: never;
  restartPolicy?: never;
  networks?: never;
  isolated?: never;
}

/**
 * Restore a machine from a snapshot (name or id).
 *
 * A restore replays the machine as it was captured, so it takes none of the
 * options that describe a *new* machine — the `never`s below make asking for
 * one a compile error rather than a surprise at runtime.
 */
export interface MachineCreateFromSnapshotParams extends MachineCreateCommon {
  fromSnapshot: string;
  image?: never;
  shared?: never;
  env?: never;
  cmd?: never;
  restartPolicy?: never;
  /** Restored from what the snapshot captured — use `setNetworks` after. */
  networks?: never;
  /**
   * Isolate the restored machine even if the snapshot wasn't. One-way: the
   * snapshot's own `isolated` is always inherited, so this can add isolation
   * but never remove it. Omit to inherit.
   */
  isolated?: boolean;
  /**
   * A machine spec added to the snapshot's own: the server merges them (maps
   * merge with this one winning, lists combine, isolation only turns on) and
   * the machine keeps the result. Its size, if set, must be the snapshot's.
   * Not together with `labels` or `isolated`: put them in the spec.
   */
  spec?: MachineSpecBuilder | MachineSpec;
}

export type MachineCreateParams =
  | MachineCreateFromImageParams
  | MachineCreateFromSnapshotParams
  | MachineCreateFromSpecParams;

export interface MachineListParams {
  /** Org name. Empty = your personal machines. */
  org?: string;
  /** Every machine you can reach, across every org. Ignores `org`. */
  allContexts?: boolean;
  /**
   * Keep only machines that match every entry. An object means "equals" on
   * each pair (`{ env: "prod" }`); an array takes selector strings,
   * `"key=value"` (equals) or `"key"` (has the key), e.g.
   * `["env=prod", "gpu"]`.
   */
  labels?: string[] | Record<string, string>;
}

export interface MachineUpdateLabelsParams {
  /** Keys to add or overwrite. */
  set?: Record<string, string>;
  /** Keys to delete. A key the machine doesn't have is fine. */
  remove?: string[];
  /**
   * Make `set` the complete label set, dropping every other key. Not
   * together with `remove`. `{ replaceAll: true }` alone clears them.
   */
  replaceAll?: boolean;
}

/** The `ListVms` label selector from a `labels` filter. */
function labelSelector(labels?: string[] | Record<string, string>): string[] {
  if (labels === undefined) return [];
  if (Array.isArray(labels)) return [...labels];
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
}

/**
 * Whether a machine's labels match a selector: every `key=value` entry
 * equals, every `key` entry exists. The server filters too; `list` checks
 * again because a server from before labels ignores the selector and returns
 * every machine, with no labels, so nothing matches rather than everything.
 */
function labelsMatch(selector: string[], labels: Record<string, string>): boolean {
  return selector.every((term) => {
    const eq = term.indexOf("=");
    if (eq < 0) return Object.hasOwn(labels, term);
    const key = term.slice(0, eq);
    return Object.hasOwn(labels, key) && labels[key] === term.slice(eq + 1);
  });
}

export interface MachineForkParams {
  name?: string;
  config?: MachineConfig;
  /**
   * Like {@link MachineCreateFromImageParams.deleteAfter}. Omit both to keep
   * the timer a fork inherits: the source's, re-armed from the moment of the
   * fork. `0` gives the fork no timer.
   */
  deleteAfter?: number;
  /** Like {@link MachineCreateFromImageParams.deleteAfterCron}. */
  deleteAfterCron?: string;
  /**
   * Keep the fork shared with the source's org. Default: private to you.
   * With an org API key the fork is always shared, so the key can reach it.
   */
  shared?: boolean;
  /**
   * Networks for the fork. Omit to inherit the source's current networks
   * (like `image`, `org`, and the rest); a non-empty list replaces them.
   */
  networks?: string[];
  /**
   * Isolate the fork even if the source isn't. One-way: a fork of an isolated
   * machine is always isolated, so this can add isolation but never remove
   * it. Omit to inherit the source's setting.
   */
  isolated?: boolean;
  /**
   * Labels for the fork. It inherits the source's labels; these are merged
   * over them, key by key.
   */
  labels?: Record<string, string>;
}

export interface ExecParams {
  /** Argv (shell-quoted for you) or a ready-made shell command line. */
  command: string | string[];
  /** Prefixed onto the command line as `K=V` assignments. */
  env?: Record<string, string>;
  /**
   * Working directory to run the command in. A `cwd` that doesn't exist
   * fails fast — the remote `cd` errors and the command never runs — rather
   * than silently running in the default directory.
   */
  cwd?: string;
  /** Allocate a PTY. Merges stderr into stdout at the kernel level. */
  tty?: boolean;
  /** Initial PTY geometry. Unset → the server's 80×24. */
  cols?: number;
  rows?: number;
  /**
   * Milliseconds. Cancels the call when it elapses — the server kills the
   * remote process's whole process group (SIGTERM, then SIGKILL after a
   * short grace period if it hasn't exited) rather than leaving it running
   * with no one listening.
   */
  timeout?: number;
  /**
   * `"utf-8"` (default) decodes `stdout`/`stderr` as UTF-8, replacing any
   * invalid byte sequence with U+FFFD — fine for text output, silently
   * corrupts binary output. `"buffer"` returns them as `Uint8Array`
   * instead, byte-exact. `streamExec` is always byte-exact and has no
   * `encoding` option.
   */
  encoding?: "utf-8" | "buffer";
}

export interface StreamExecParams extends Omit<ExecParams, "timeout" | "encoding"> {
  /**
   * Half-close stdin right after the init chunk. Kills the ~3s wait a headless
   * one-shot (`claude -p`, `jq`, `cat`) spends blocked on stdin. Incompatible
   * with `tty`, where stdin must stay open for input.
   */
  closeStdin?: boolean;
}

/**
 * Either field names a whole size class, so one of them is enough — the server
 * resolves the other. Passing neither is refused rather than treated as "keep
 * the current size", which would make the call a silent no-op.
 */
export interface MachineResizeParams {
  vcpu?: number;
  /** One of the supported sizes: `"4G"`, `"8G"`, `"16G"`, `"32G"`. */
  memory?: string;
}

export interface WaitUntilReadyParams {
  /** Milliseconds. Default 90s. */
  timeout?: number;
  /** Milliseconds between polls. Default 500ms. */
  pollInterval?: number;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["destroyed", "failed", "stopped"]);

/**
 * The runtime backstop behind {@link MachineCreateFromSnapshotParams}: the
 * types already make these a compile error, but a plain-JavaScript caller has
 * no compiler. Each entry pairs the option with the test for "the caller
 * actually asked for this" — an empty `env` or a `shared: false` asks for
 * nothing, so neither is worth an error.
 */
const REJECTED_WITH_SNAPSHOT: ReadonlyArray<[string, (p: MachineCreateParams) => boolean]> = [
  ["image", (p) => !!p.image],
  ["env", (p) => Object.keys(p.env ?? {}).length > 0],
  ["cmd", (p) => (p.cmd ?? []).length > 0],
  ["restartPolicy", (p) => !!p.restartPolicy],
  ["shared", (p) => p.shared === true],
  // Captured on the snapshot at save time and replayed from it; settable
  // afterwards with `setNetworks`. (`isolated` is NOT rejected here — it is a
  // one-way override the restore accepts, see MachineCreateFromSnapshotParams.)
  ["networks", (p) => (p.networks ?? []).length > 0],
];

/** Every field is required on the wire — this fills the ones we don't set. */
function execChunk(fields: Partial<ExecChunk>): ExecChunk {
  return {
    data: new Uint8Array(),
    stdin: false,
    tty: false,
    command: "",
    vmId: "",
    exitCode: 0,
    cols: 0,
    rows: 0,
    windowChange: false,
    isStderr: false,
    deviceId: "",
    ...fields,
  };
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, `'"'"'`) + "'";
}

function commandLine(command: string | string[], env?: Record<string, string>, cwd?: string): string {
  const cmd = typeof command === "string" ? command : command.map(shellQuote).join(" ");
  let line = cmd;
  if (env && Object.keys(env).length > 0) {
    const prefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    line = `${prefix} ${line}`;
  }
  // No cwd field on the wire, so `cd` ahead of the command through the same
  // shell — same trick as the env prefix above.
  if (cwd) line = `cd ${shellQuote(cwd)} && ${line}`;
  return line;
}

/** Omitted fields stay zero, which the server reads as "use the default". */
function toVmConfig(config: MachineConfig | undefined): VmConfig | undefined {
  if (!config) return undefined;
  const vm: VmConfig = {
    vcpu: config.vcpu ?? 0,
    memoryBytes: config.memory ? parseSize(config.memory) : 0,
    diskBytes: config.disk ? parseSize(config.disk) : 0,
    volumes: (config.volumes ?? []).map((v) => ({
      diskId: v.diskId,
      mountPath: v.mountPath,
      readOnly: v.readOnly ?? false,
    })),
    // `optional` on the wire: unset means "not requested", which is
    // not the same as false. A new machine then takes its org's default and a
    // fork or restore keeps the source's value, so never default it here.
    idleIgnoreOutbound: config.idleIgnoreOutbound,
  };
  if (config.autoSuspendTimeout !== undefined || config.autoDestroyTimeout !== undefined) {
    vm.srf = {
      // `optional` on the wire: unset means "server default", which is not the
      // same as 0 ("disabled").
      autoSuspendTimeoutSecs: config.autoSuspendTimeout,
      autoDestroyTimeoutSecs: config.autoDestroyTimeout ?? 0,
    };
  }
  if (config.ssh !== undefined || config.proxies) {
    vm.network = {
      // `optional` on the wire: unset means "not requested", which is not the
      // same as true. A new machine then has SSH on and a fork or restore
      // keeps the source's setting, so never default it here.
      ssh: config.ssh,
      proxies: (config.proxies ?? []).map((p) => ({ name: p.name, port: p.port ?? 0 })),
    };
  }
  return vm;
}

/**
 * Record on a fork, or a machine created from a snapshot, how many
 * automations it was born with paused, and warn. Both carry their source's
 * automations but do not run them, or the same schedule or webhook would be
 * handled twice. Worth saying out loud: nothing else about the new machine
 * shows it.
 */
function notePausedAutomations(machine: Machine, n: number, origin: string): Machine {
  machine.pausedAutomations = n;
  if (n > 0) {
    console.warn(
      `boxd: ${n === 1 ? `1 automation ${origin}is` : `${n} automations ${origin}are`} paused in ` +
        `${machine.name} so nothing runs twice. Inside it, \`run jobs\` lists them and ` +
        "`run restart <id>` starts one.",
    );
  }
  return machine;
}

/**
 * Machines — the VMs themselves. Every method takes the machine id (or name;
 * the server resolves either) as its first argument.
 */

/**
 * A create's spec in wire form. A delete-after timer is set by a second call
 * once the machine exists, which the creator of a machine for someone else
 * (`assignTo`) may not make: it is the assignee's. Refused before anything
 * is created rather than after.
 */
function specForCreate(
  spec: MachineSpecBuilder | MachineSpec,
  params: { deleteAfter?: unknown; deleteAfterCron?: unknown },
): ReturnType<typeof toSpecWire> {
  const wire = toSpecWire(spec);
  if (wire.assignTo && (params.deleteAfter !== undefined || params.deleteAfterCron !== undefined)) {
    throw new BoxdError(
      "spec.assignTo: a machine created for someone else is theirs to manage, so the create " +
        "can't also set deleteAfter or deleteAfterCron",
    );
  }
  return wire;
}

/** Waits before each retry of an exec whose machine agent didn't answer. */
const EXEC_RETRY_BACKOFF_MS = [1_000, 3_000];

/**
 * The server's message when it couldn't reach the machine's agent: nothing
 * was sent to the machine, so the command never started and running it
 * again is safe. Any other failure may come after the command started.
 */
function agentUnreachable(err: unknown): boolean {
  return (
    err instanceof APIConnectionError && err.message.startsWith("cannot connect to VM agent")
  );
}

export class Machines {
  readonly files: MachineFiles;
  /** Read, write, list and manage files inside a machine. */
  readonly fs: MachineFs;
  readonly ports: MachinePorts;
  readonly proxies: MachineProxies;
  readonly checkpoints: MachineCheckpoints;
  readonly backups: MachineBackups;

  readonly #platform: Platform;

  constructor(
    private readonly transport: Transport,
    platform: Platform = {},
  ) {
    this.#platform = platform;
    this.files = new MachineFiles(transport, platform);
    this.fs = new MachineFs(transport);
    this.ports = new MachinePorts(transport);
    this.proxies = new MachineProxies(transport);
    this.checkpoints = new MachineCheckpoints(transport);
    this.backups = new MachineBackups(transport);
  }

  async create(params: MachineCreateParams = {}): Promise<Machine> {
    if (params.fromSnapshot) {
      // Restoring a snapshot accepts only a name and an org — the machine is
      // always born at the size the snapshot was captured at (the server
      // refuses config sizing here). Refuse the rest client-side rather than
      // drop them on the floor.
      const rejected = REJECTED_WITH_SNAPSHOT.filter(([, asked]) => asked(params)).map(
        ([label]) => label,
      );
      if (rejected.length > 0) {
        throw new BoxdError(
          `create({ fromSnapshot }) does not accept ${rejected.join(", ")} — ` +
            "restoring a snapshot replays the machine as it was captured, it does not " +
            "configure a new one",
        );
      }
      const resp = await this.transport.unary(BoxdApiDefinition.methods.createVmFromSnapshot,
        {
          snapshot: params.fromSnapshot,
          name: params.name ?? "",
          config: toVmConfig(params.config),
          org: params.org ?? "",
          // One-way: the server ORs this with the snapshot's captured flag,
          // so `false` means "inherit", never "de-isolate".
          isolated: params.isolated ?? false,
          labels: params.labels ?? {},
          spec: params.spec ? specForCreate(params.spec, params) : undefined,
        },
      );
      const machine = await this.#complete(resp, params.deleteAfter, params.deleteAfterCron);
      // The snapshot's automations came along paused, like a fork's.
      return notePausedAutomations(machine, resp.pausedAutomations ?? 0, "from the snapshot ");
    }

    if (params.spec) {
      const resp = await this.transport.unary(BoxdApiDefinition.methods.createVm, {
        name: params.name ?? "",
        imageRef: "",
        env: [],
        cmd: [],
        restartPolicy: "",
        config: toVmConfig(params.config),
        org: params.org ?? "",
        team: "",
        shared: params.shared ?? false,
        networks: [],
        isolated: false,
        labels: {},
        spec: specForCreate(params.spec, params),
      });
      const machine = await this.#complete(resp, params.deleteAfter, params.deleteAfterCron);
      // A team or snapshot base is a restore, whose automations came along paused.
      return notePausedAutomations(machine, resp.pausedAutomations ?? 0, "from the snapshot ");
    }

    const req: CreateVmRequest = {
      name: params.name ?? "",
      imageRef: params.image ?? "",
      env: Object.entries(params.env ?? {}).map(([key, value]) => ({ key, value })),
      cmd: params.cmd ?? [],
      restartPolicy: params.restartPolicy ?? "",
      config: toVmConfig(params.config),
      org: params.org ?? "",
      // The team-borrowed starting image. The SDK has no surface for it
      // yet, and empty is "no team" — the same request the server has always
      // seen from here. Only the regenerated stubs make it explicit.
      team: "",
      shared: params.shared ?? false,
      networks: params.networks ?? [],
      isolated: params.isolated ?? false,
      labels: params.labels ?? {},
    };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createVm,
      req,
    );
    return this.#complete(resp, params.deleteAfter, params.deleteAfterCron);
  }

  /**
   * Fetch one machine by id or name.
   *
   * Throws `NotFoundError` for a destroyed machine's id/name, same as
   * `delete()` followed by `list()` omitting it — polling `get(id)` after
   * `delete(id)` resolves is a reliable way to confirm teardown completed
   *.
   */
  async get(id: string): Promise<Machine> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getVm, {
      vmId: id,
    });
    return toMachine(resp, await this.transport.consoleOrigin());
  }

  /**
   * What a machine used and cost: seconds in each state and an estimated cost
   * at the org's current rates. Defaults to the machine's whole life (at most
   * a year back). A deleted machine is found by its id or name in the usage
   * history of `org` (default: your default org, or an API key's org), so
   * this still answers after `delete()`. If several deleted machines had that
   * name the call fails with their ids:
   *
   * ```ts
   * const u = await boxd.machines.usage(machine.id);
   * console.log(`${u.costMicro / 1e6} ${u.currency}`);
   * ```
   *
   * Org owners and admins only. Works with an API key issued for the org.
   */
  async usage(
    id: string,
    params: { since?: TimeBound; until?: TimeBound; org?: string } = {},
  ): Promise<MachineUsageReport> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getVmUsage, {
      vmId: id,
      since: toUnixSeconds(params.since),
      until: toUnixSeconds(params.until),
      org: params.org ?? "",
    });
    return toMachineUsageReport(resp);
  }

  /**
   * List machines: personal by default, an org's with `org`, everything you
   * can reach with `allContexts`. Each machine's `packages` come without
   * their `outputTail`, to keep the list small; `get()` has it.
   */
  async list(params: MachineListParams = {}): Promise<Machine[]> {
    const selector = labelSelector(params.labels);
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listVms, {
      org: params.org ?? "",
      allContexts: params.allContexts ?? false,
      labelSelector: selector,
    });
    const consoleOrigin = await this.transport.consoleOrigin();
    return (resp.vms ?? [])
      .map((v) => toMachine(v, consoleOrigin))
      .filter((m) => labelsMatch(selector, m.labels));
  }

  async delete(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.destroyVm, {
      vmId: id,
    });
  }

  /**
   * Delete **the machine this code is running on**: call it inside a boxd
   * machine when its task is done.
   *
   * The SDK twin of `boxd machine remove --self`, not a plain
   * {@link Machines.delete} of your own id: the same server checks apply, and
   * the call resolves *before* the machine shuts down (`deletesInSecs` later),
   * so your code gets the answer. Everything on the machine, its disk and
   * every process including this one, is then gone, so ship results out
   * first.
   *
   * `confirm` must be this machine's name (`machine.name`), spelled out as a
   * deliberate decision; any other value is refused before anything is
   * touched. Refused, too, on a machine shared with your org, and for anyone
   * but its owner. Throws `AuthenticationError` when not running inside a boxd
   * machine on Node (an isolated machine has no metadata adapter, and the web
   * entry can't find one).
   */
  async deleteSelf(opts: { confirm: string }): Promise<SelfDeleteResult> {
    if (!opts?.confirm?.trim()) {
      throw new BoxdError(
        "deleteSelf({ confirm }) needs this machine's name, to confirm you mean to delete the machine this code runs on",
      );
    }
    const base = await metadataBase(this.#platform.readFile);
    if (!base) {
      throw new AuthenticationError(
        "deleteSelf() only works inside a boxd machine: it deletes the machine the code runs on. From anywhere else, use machines.delete(id)",
        undefined,
        { reason: "missing_credentials" },
      );
    }
    let resp: Response;
    try {
      resp = await fetch(`${base}/v1/self/destroy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_name: opts.confirm }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new APIConnectionError(
        `self-delete request failed: could not reach the machine's metadata adapter: ${e instanceof Error ? e.message : String(e)}`,
        undefined,
        { cause: e },
      );
    }
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!resp.ok || !body) {
      const msg = typeof body?.error === "string" ? body.error : `self-delete failed: ${resp.status}`;
      throw new BoxdError(msg);
    }
    return {
      id: String(body.vm_id ?? ""),
      name: String(body.name ?? ""),
      deletesInSecs: typeof body.destroy_in_secs === "number" ? body.destroy_in_secs : 2,
    };
  }

  /**
   * Rename. Its own call, not an `update()`, because **it reboots the
   * machine**: routing and DNS follow immediately, but the in-VM hostname only
   * changes on the next boot. Returns the new name.
   */
  async rename(id: string, newName: string): Promise<string> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.renameVm,
      { vmId: id, newName },
    );
    return resp.name;
  }

  async start(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.startVm, { vmId: id });
  }

  async stop(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.stopVm, { vmId: id });
  }

  async reboot(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.rebootVm, {
      vmId: id,
    });
  }

  /** Suspend to RAM. Returns how long the freeze took, in microseconds. */
  async pause(id: string): Promise<{ suspendUs: number }> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.suspendVm,
      { vmId: id },
    );
    return { suspendUs: resp.suspendUs };
  }

  /** Resume a paused machine. Returns the thaw time in microseconds. */
  async resume(id: string): Promise<{ resumeUs: number }> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.resumeVm,
      { vmId: id },
    );
    return { resumeUs: resp.resumeUs };
  }

  /** Suspend to disk. Frees the host's memory; `wake` restores it. */
  async hibernate(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.hibernateVm, {
      vmId: id,
    });
  }

  async wake(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.wakeVm, { vmId: id });
  }

  /**
   * Move a machine to another size class. Sizes it for good, not for now.
   *
   * Name either dimension — `{ vcpu: 2 }` and `{ memory: "8G" }` are the same
   * request — and the server resolves the whole class (1 vCPU/4 GiB, 2/8 GiB,
   * 4/16 GiB). Anything above the org quota is refused, never quietly clamped.
   *
   * A **running** machine is rebooted to apply the size: a cold boot, so the
   * disk survives and anything in RAM does not. A **stopped** machine takes it
   * at its next start. A suspended or hibernated machine is refused, because
   * its saved memory image is the old size — resume or wake it first.
   */
  async resize(id: string, params: MachineResizeParams): Promise<ResizeResult> {
    if (params.vcpu === undefined && params.memory === undefined) {
      throw new BoxdError(
        'resize needs vcpu or memory - either one names a size class ' +
          '(1 vCPU/"4G", 2/"8G", 4/"16G", 8/"32G") and the other follows from it',
      );
    }
    const resp = await this.transport.unary(BoxdApiDefinition.methods.resizeVm,
      {
        vmId: id,
        vcpu: params.vcpu ?? 0,
        memoryBytes: params.memory ? parseSize(params.memory) : 0,
      },
    );
    return toResizeResult(resp);
  }

  /**
   * Change the spec of a machine created from one, and apply what changes.
   * Pass a patch, or a function that extends the current spec with a
   * builder:
   *
   * ```ts
   * // A JSON Merge Patch: maps merge (null removes a key), lists replace.
   * await boxd.machines.updateSpec(id, { labels: { owner: "mike", team: null } });
   *
   * // Additive: read the spec, add to it, send the difference.
   * await boxd.machines.updateSpec(id, (s) => s.network("ops").env("X", "1"));
   *
   * const diff = await boxd.machines.updateSpec(id, { size: "4x16" }, { dryRun: true });
   * if (diff.rebootRequired) await boxd.machines.updateSpec(id, { size: "4x16" }, { reboot: true });
   *
   * // Run the packages again from the one that failed.
   * await boxd.machines.updateSpec(id, {}, { retryPackages: true });
   * ```
   *
   * The builder form uses the composition rules, so it adds: setting a
   * `size` the spec already names differently throws, and nothing is
   * removed. Use a patch to replace or remove.
   *
   * Each change says how it applies (`MachineSpecChange.apply`): labels,
   * networks, egress, connections and agents live; added packages run now
   * (removing one undoes nothing, and skips it if it hadn't finished, so the
   * ones after it run; a running one can't be removed), and so do retried
   * ones (`retryPackages`);
   * env and secrets reach new shells and exec
   * sessions, while running processes keep the old values until they
   * restart; a new size reboots a running machine and needs `reboot: true`.
   * `base`, `isolated` and `assignTo` can't change. A refused change refuses
   * the whole patch, and nothing is applied. New egress rules are in force
   * within about a second of the call returning.
   *
   * The function form sends the spec it read, so a change someone made in
   * between can't be undone by it: it reads the spec again and reapplies the
   * function, up to 3 times, then throws `ConflictError`. A patch is sent
   * as it is; pass `expectedSpec` when you built it from a spec you read.
   *
   * If a resize fails after the rest of the patch applied, the call still
   * returns: `resizeError` says why, and `spec` has the size the machine has.
   */
  async updateSpec(
    id: string,
    patch: MachineSpecPatch | ((spec: MachineSpecBuilder) => MachineSpecBuilder),
    opts: MachineUpdateSpecOptions = {},
  ): Promise<MachineSpecUpdate> {
    const send = (doc: MachineSpecPatch, expected: MachineSpec | undefined) =>
      this.transport
        .unary(BoxdApiDefinition.methods.updateMachineSpec, {
          vm: id,
          patch: JSON.stringify(doc),
          dryRun: opts.dryRun ?? false,
          reboot: opts.reboot ?? false,
          retryPackages: opts.retryPackages ?? false,
          expectedSpec: expected ? JSON.stringify(expected) : "",
        })
        .then(toMachineSpecUpdate);
    if (typeof patch !== "function") {
      checkSpecPatch(patch);
      return send(patch, opts.expectedSpec);
    }
    // The builder's lists are the spec it read plus its entries, so it sends
    // that spec along: a change made in between refuses it (ConflictError),
    // and it reads the spec again and reapplies the function.
    for (let attempt = 0; ; attempt++) {
      const current = (await this.get(id)).spec;
      if (!current) {
        throw new BoxdError(
          `spec: machine ${JSON.stringify(id)} wasn't created from a spec, so it has no spec to update`,
        );
      }
      const doc = specPatch(current, patch(new MachineSpecBuilder().with(current)).resolve());
      try {
        return await send(doc, current);
      } catch (e) {
        // Only a conflict (aborted), not FAILED_PRECONDITION, which maps to
        // ConflictError too: that one would refuse again.
        const conflict = e instanceof ConflictError && e.grpcCode === GrpcStatus.ABORTED;
        if (!conflict || attempt >= UPDATE_SPEC_RETRIES) {
          throw e;
        }
        // Updates racing each other would collide again in step: wait a
        // little, longer each time, and not the same for everyone.
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1) + Math.random() * 200));
      }
    }
  }

  async fork(id: string, params: MachineForkParams = {}): Promise<Machine> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.forkVm, {
      sourceVmId: id,
      name: params.name ?? "",
      config: toVmConfig(params.config),
      shared: params.shared ?? false,
      networks: params.networks ?? [],
      // One-way: the server ORs this with the source's flag, so `false` means
      // "inherit", never "de-isolate".
      isolated: params.isolated ?? false,
      labels: params.labels ?? {},
    });
    const machine = await this.#complete(resp, params.deleteAfter, params.deleteAfterCron);
    return notePausedAutomations(machine, resp.pausedAutomations ?? 0, "");
  }

  /**
   * Replace the machine's networks — the complete desired set, not an
   * add/remove. Returns the set now in effect.
   *
   * Clearing it to `[]` does not mean "no peers": it moves the machine into
   * the org's default network (its other machines that have no networks). On
   * an **isolated** machine this is the only reachability lever there is, so
   * clearing it does leave that machine with no peers at all. Reachability,
   * internal DNS, and `exec`/`cp` between machines all follow immediately.
   *
   * See {@link MachineNetworking} for the full rule.
   */
  async setNetworks(id: string, networks: string[]): Promise<string[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setVmNetworks,
      { vmId: id, networks },
    );
    return resp.networks ?? [];
  }

  /**
   * Replace the machine's egress allowlist: the complete set of what it may
   * reach on the internet. Returns the list now in effect.
   *
   * Entries are hostnames (`api.example.com`, `*.example.com`) or public
   * IPv4 addresses and CIDRs. HTTP and HTTPS are admitted by hostname;
   * everything else by address, with the addresses of allowlisted names
   * learned as the machine resolves them. Nothing not named here is
   * reachable; the hosts of any bound secret the machine holds are always
   * admitted. Pass `["none"]` to let the machine reach nothing else, and `[]`
   * to clear. Takes effect within a second.
   */
  async setEgressAllow(id: string, entries: string[]): Promise<string[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setVmEgressAllow, {
      vm: id,
      entries,
    });
    return resp.entries ?? [];
  }

  /**
   * Edit the machine's labels in one atomic change. Returns the labels now in
   * effect.
   *
   * `set` adds or overwrites keys and `remove` deletes them. `replaceAll`
   * makes `set` the complete label set instead and does not take `remove`.
   *
   * Keys are 1-63 characters of `a-z 0-9 . _ / -`, starting and ending with a
   * letter or digit; the `boxd/` prefix is reserved. Values are up to 256
   * characters, no control characters, and may be empty. A machine holds at
   * most 64 labels.
   */
  async updateLabels(
    id: string,
    params: MachineUpdateLabelsParams,
  ): Promise<Record<string, string>> {
    const remove = params.remove ?? [];
    if (params.replaceAll && remove.length > 0) {
      throw new BoxdError(
        "updateLabels({ replaceAll: true }) does not accept remove - replaceAll makes " +
          "`set` the complete label set, so any key not in it is removed already",
      );
    }
    const resp = await this.transport.unary(BoxdApiDefinition.methods.updateVmLabels, {
      vm: id,
      set: params.set ?? {},
      remove,
      replaceAll: params.replaceAll ?? false,
    });
    return resp.labels ?? {};
  }

  /** Make the machine visible to its whole org. A machine never changes org. */
  async share(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.shareVm, { vmId: id });
  }

  async unshare(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.unshareVm, {
      vmId: id,
    });
  }

  /** Seconds of idleness before auto-suspend. `0` disables. */
  async setAutoSuspendTimeout(id: string, seconds: number): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setAutoSuspendTimeout,
      { vmId: id, timeoutSecs: seconds },
    );
  }

  /** Seconds of idleness before auto-hibernate. `0` disables. */
  async setAutoHibernateTimeout(id: string, seconds: number): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setAutoHibernateTimeout,
      { vmId: id, timeoutSecs: seconds },
    );
  }

  /**
   * Permanently delete the machine `seconds` from now (wall-clock), whatever
   * state it is in — enforced by the platform, so it fires on a suspended or
   * hibernated machine too. Calling it again replaces the timer (keep
   * extending a lease); `0` clears it. A fork inherits the timer, re-armed
   * from the moment of the fork. Resolves to the new deadline, or `null`
   * when cleared.
   */
  async setDeleteAfter(id: string, seconds: number): Promise<Date | null> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setDeleteAfter,
      { vmId: id, deleteAfterSecs: seconds, deleteAfterCron: "" },
    );
    return resp.deleteAtMs ? new Date(resp.deleteAtMs) : null;
  }

  /**
   * Like {@link Machines.setDeleteAfter}, but the deadline is the next match
   * of a cron expression, UTC (`"0 18 * * *"` = the next 18:00). Resolves to
   * that deadline.
   */
  async setDeleteAfterCron(id: string, cron: string): Promise<Date | null> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setDeleteAfter,
      { vmId: id, deleteAfterSecs: 0, deleteAfterCron: cron },
    );
    return resp.deleteAtMs ? new Date(resp.deleteAtMs) : null;
  }

  /**
   * Set the machine's bot protection mode.
   *
   * `"on"` makes visitors pass a browser check before any HTTPS request
   * reaches the machine, running or asleep, so crawlers can neither wake it
   * nor keep it awake. Clients that aren't a browser (webhooks, API callers)
   * are stopped too: give those a named proxy or a custom domain, or use
   * `"sleep_only"`, which checks only a request that would wake the machine.
   * `"off"` never checks.
   *
   * A boolean is the older form: `true` is `"on"`, `false` is `"off"`.
   */
  async setBotProtection(id: string, mode: BotProtectionMode | boolean): Promise<void> {
    const m: BotProtectionMode = typeof mode === "boolean" ? (mode ? "on" : "off") : mode;
    await this.transport.unary(BoxdApiDefinition.methods.setBotProtection,
      // `enabled` rides along for a server that predates the mode.
      { vmId: id, enabled: m !== "off", mode: m },
    );
  }

  /**
   * Choose what counts as activity for auto-suspend and auto-hibernate. On:
   * only connections opened TO the machine (SSH, HTTPS, another machine)
   * reset the idle clock, so its own outbound traffic no longer keeps it
   * awake. Off: any traffic does. Applies to a running machine at once.
   */
  async setIdleIgnoreOutbound(id: string, enabled: boolean): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setIdleIgnoreOutbound,
      { vmId: id, enabled },
    );
  }

  /**
   * Turn SSH on or off for the machine. Off: nothing answers SSH on its port,
   * on the public address or the org's network, and SSH sessions already open
   * to it are closed. `exec`, `boxd connect` and the console terminal don't
   * use SSH and keep working. The port stays allocated, so turning SSH back on
   * keeps the address. Can't be called from inside the machine itself.
   */
  async setSsh(id: string, enabled: boolean): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setSsh,
      { vmId: id, enabled },
    );
  }

  /**
   * Run one command and collect its output.
   *
   * With `tty` the command runs under a PTY, which merges stderr into stdout —
   * `stderr` comes back empty and everything lands in `stdout`.
   *
   * `stdout`/`stderr` are UTF-8-decoded by default, which silently replaces
   * any invalid byte sequence with U+FFFD — pass `encoding: "buffer"` for
   * byte-exact `Uint8Array` output instead (e.g. `head -c 4096 /dev/urandom`).
   */
  async exec(id: string, params: ExecParams & { encoding: "buffer" }): Promise<ExecBytesResult>;
  async exec(id: string, params: ExecParams): Promise<ExecResult>;
  async exec(id: string, params: ExecParams): Promise<ExecResult | ExecBytesResult> {
    // A machine whose agent didn't answer never got the command, so it is
    // run again, within the caller's `timeout` when there is one. Anything
    // else is reported as it is: the command may have run.
    const deadline = params.timeout === undefined ? undefined : Date.now() + params.timeout;
    for (let attempt = 0; ; attempt++) {
      const left =
        attempt === 0 || deadline === undefined ? params.timeout : deadline - Date.now();
      try {
        return await this.#execOnce(id, params, left);
      } catch (err) {
        const backoff = EXEC_RETRY_BACKOFF_MS[attempt];
        if (
          !agentUnreachable(err) ||
          backoff === undefined ||
          (deadline !== undefined && Date.now() + backoff >= deadline)
        ) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  /** One exec call, cancelled after `left` ms (what remains of `params.timeout`). */
  async #execOnce(
    id: string,
    params: ExecParams,
    left: number | undefined,
  ): Promise<ExecResult | ExecBytesResult> {
    const call = this.transport.duplex(BoxdApiDefinition.methods.exec);
    const init = execChunk({
      vmId: id,
      command: commandLine(params.command, params.env, params.cwd),
      tty: params.tty ?? false,
      cols: params.cols ?? 0,
      rows: params.rows ?? 0,
    });

    return new Promise<ExecResult | ExecBytesResult>((resolve, reject) => {
      const outParts: Uint8Array[] = [];
      const errParts: Uint8Array[] = [];
      let exitCode = -1;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (left !== undefined) {
        timer = setTimeout(() => {
          call.cancel();
          reject(new BoxdError(`exec timed out after ${params.timeout}ms`));
        }, left);
      }

      call.on("data", (chunk: ExecChunk) => {
        if (chunk.data && chunk.data.length > 0) {
          (chunk.isStderr ? errParts : outParts).push(chunk.data);
        }
        if (typeof chunk.exitCode === "number") exitCode = chunk.exitCode;
      });
      call.on("error", (err: unknown) => {
        if (timer) clearTimeout(timer);
        // The transport already mapped this to a `BoxdError` subclass —
        // both `_transport.ts` and `_transportWeb.ts` normalize errors
        // before emitting them, so a namespace file never touches
        // `fromGrpcError` (or a raw grpc-js `ServiceError`) itself.
        reject(err);
      });
      call.on("end", () => {
        if (timer) clearTimeout(timer);
        const stdout = concatBytes(outParts);
        const stderr = concatBytes(errParts);
        resolve(
          params.encoding === "buffer"
            ? { stdout, stderr, exitCode, success: exitCode === 0 }
            : {
                stdout: decodeUtf8(stdout),
                stderr: decodeUtf8(stderr),
                exitCode,
                success: exitCode === 0,
              },
        );
      });

      call.write(init);
      call.end();
    });
  }

  /**
   * Interactive / PTY exec. The one place a handle is unavoidable — a live
   * bidi stream is genuinely stateful. Synchronous: the returned
   * {@link ExecStream} buffers writes until the call is up.
   */
  streamExec(id: string, params: StreamExecParams): ExecStream {
    if (!this.transport.supportsInteractiveExec) {
      throw new BoxdError(
        "streamExec() needs an interactive full-duplex connection, which the " +
          "web transport (@boxd-sh/sdk/web) can't provide — grpc-web's request " +
          "must finish before the response can start streaming back. Use the " +
          "Node entry (@boxd-sh/sdk) or SSH for an interactive session.",
      );
    }
    const tty = params.tty ?? false;
    if (params.closeStdin && tty) {
      throw new BoxdError(
        "streamExec: `closeStdin` is incompatible with `tty` — a PTY shell needs stdin open",
      );
    }

    // The call is dialled asynchronously (auth + channel), so queue everything
    // the caller does in the meantime and flush it in order.
    let pending: Array<(c: DuplexCall<ExecChunk, ExecChunk>) => void> = [];
    let live: DuplexCall<ExecChunk, ExecChunk> | undefined;
    let cancelled = false;
    const enqueue = (fn: (c: DuplexCall<ExecChunk, ExecChunk>) => void) => {
      if (live) fn(live);
      else pending.push(fn);
    };

    const stream = new ExecStream({
      write: (data) => enqueue((c) => c.write(execChunk({ data, stdin: true }))),
      end: () => enqueue((c) => c.end()),
      resize: (cols, rows) =>
        enqueue((c) => {
          try {
            c.write(execChunk({ cols, rows, windowChange: true }));
          } catch {
            /* stream already gone */
          }
        }),
      cancel: () => {
        cancelled = true;
        try {
          live?.cancel();
        } catch {
          /* already finished */
        }
      },
    });

    void (async () => {
      try {
        const call = this.transport.duplex<ExecChunk, ExecChunk>(BoxdApiDefinition.methods.exec);
        if (cancelled) {
          call.cancel();
          return;
        }

        let exitCode = -1;
        call.on("data", (chunk: ExecChunk) => {
          if (chunk.data && chunk.data.length > 0) {
            (chunk.isStderr ? stream.stderr : stream.stdout).push(chunk.data);
          }
          if (typeof chunk.exitCode === "number") exitCode = chunk.exitCode;
        });
        call.on("error", (err: unknown) => {
          // Already a `BoxdError` — see the comment in `exec()` above.
          const e = err as BoxdError;
          stream.stdout.fail(e);
          stream.stderr.fail(e);
          stream._setError(e);
        });
        call.on("end", () => {
          stream.stdout.close();
          stream.stderr.close();
          stream._setExit(exitCode);
        });

        call.write(
          execChunk({
            vmId: id,
            command: commandLine(params.command, params.env, params.cwd),
            tty,
            cols: params.cols ?? 0,
            rows: params.rows ?? 0,
          }),
        );
        if (params.closeStdin) call.end();

        live = call;
        const queued = pending;
        pending = [];
        for (const fn of queued) fn(call);
      } catch (err) {
        const e = err instanceof BoxdError ? err : new BoxdError(String(err));
        stream.stdout.fail(e);
        stream.stderr.fail(e);
        stream._setError(e);
      }
    })();

    return stream;
  }

  /** Console output. `follow: true` keeps the stream open. */
  async *logs(id: string, params: { follow?: boolean } = {}): AsyncGenerator<Uint8Array> {
    const req: StreamLogsRequest = { vmId: id, follow: params.follow ?? false };
    // No deadline: a follow stream is meant to stay open indefinitely — the
    // client's normal per-call timeout would otherwise silently kill it.
    const call = this.transport.serverStream(BoxdApiDefinition.methods.streamLogs, req, {
      deadline: false,
    });

    const queue = new AsyncByteQueue();
    call.on("data", (chunk: LogChunk) => {
      if (chunk.data && chunk.data.length > 0) queue.push(chunk.data);
    });
    call.on("error", (err: unknown) => queue.fail(err));
    call.on("end", () => queue.close());

    for await (const chunk of queue) yield chunk;
  }

  /**
   * Block until the machine is genuinely usable: status `running` **and** an
   * exec round-trip succeeds.
   *
   * `create()` returns as soon as the machine is scheduled — exec may already
   * work while the machine still reports `pending`, and anything that gates on
   * the authoritative status (notably another `fork()`) would take a cold-boot
   * path and lose the source's in-memory state.
   */
  async waitUntilReady(id: string, params: WaitUntilReadyParams = {}): Promise<Machine> {
    const timeout = params.timeout ?? 90_000;
    const pollInterval = params.pollInterval ?? 500;
    const deadline = Date.now() + timeout;

    let machine = await this.get(id);
    while (machine.status !== "running" && Date.now() < deadline) {
      if (TERMINAL_STATES.has(machine.status)) {
        throw new BoxdError(
          `machine ${machine.name} entered terminal state '${machine.status}' while waiting`,
        );
      }
      await sleep(pollInterval);
      machine = await this.get(id);
    }
    if (machine.status !== "running") {
      throw new BoxdError(`machine ${machine.name} did not reach 'running' within ${timeout}ms`);
    }

    while (Date.now() < deadline) {
      try {
        await this.exec(id, { command: ["true"] });
        return machine;
      } catch {
        await sleep(pollInterval);
      }
    }
    throw new BoxdError(
      `machine ${machine.name} reached 'running' but exec did not succeed within ${timeout}ms`,
    );
  }

  /** A fresh, available auto-generated name — what the CLI pre-fills prompts with. */
  async suggestName(): Promise<string> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.suggestVmName,
      {},
    );
    return resp.name;
  }

  /**
   * Creating answers with fewer fields than reading back, so re-read to hand
   * back a complete `Machine`. If that read fails, fall back to the partial
   * mapping rather than failing a create that actually succeeded.
   */
  async #complete(
    resp: CreateVmResponse | ForkVmResponse,
    deleteAfter?: number,
    deleteAfterCron?: string,
  ): Promise<Machine> {
    // Not part of the create request, so set right after it.
    if (deleteAfterCron !== undefined) {
      if (deleteAfter) throw new BoxdError("pass deleteAfter or deleteAfterCron, not both");
      await this.setDeleteAfterCron(resp.vmId, deleteAfterCron);
    } else if (deleteAfter !== undefined) {
      await this.setDeleteAfter(resp.vmId, deleteAfter);
    }
    try {
      return await this.get(resp.vmId);
    } catch {
      return toMachineFromCreate(resp);
    }
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    raw.set(p, offset);
    offset += p.length;
  }
  return raw;
}

/** Lossy — replaces any invalid byte sequence with U+FFFD. See `ExecParams.encoding`. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
