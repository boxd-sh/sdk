/**
 * Coding agents (Claude Code, Codex, OpenCode) running inside a machine:
 * `boxd.machines.agents`.
 *
 * A session is one conversation with one agent in one machine. Messages sent
 * to it run as turns, one at a time; everything a turn does comes back as
 * typed events, numbered 1, 2, 3… per session. The agent keeps working when
 * the client goes away, so a client that reconnects reads on from the last
 * `seq` it saw and misses nothing:
 *
 * ```ts
 * const session = await boxd.machines.agents.start("my-box", { harness: "claude-code" });
 * const { turn } = await boxd.machines.agents.send("my-box", session.id, "Add a /health endpoint");
 * for await (const ev of boxd.machines.agents.events("my-box", session.id, { follow: true })) {
 *   if (ev.type === "message.delta") process.stdout.write(ev.text);
 *   if (ev.type === "turn.finished" && ev.turn === turn) break;
 * }
 * ```
 *
 * `run()` does all of that for one task in one call: start, send, wait for
 * the turn to end, and resolve to the agent's last reply and how it ended.
 *
 * `runs()` reads how finished turns went, across your machines, from the
 * platform's run history instead: it never wakes a machine.
 *
 * `startLogin()` signs an agent in for your machines, with the platform's
 * own sign-in to Claude Code or Codex.
 */
import type { ReadableCall, Transport } from "./_rpc.js";
import { BoxdError, isRetryable } from "./errors.js";
import type { RegionOption } from "./regions.js";
import type { TimeBound } from "./utils.js";
import {
  AgentDelivery as PbAgentDelivery,
  AgentFinishReason as PbAgentFinishReason,
  AgentLoginMethod as PbAgentLoginMethod,
  AgentSendWhen as PbAgentSendWhen,
  AgentSessionState as PbAgentSessionState,
  AgentToolKind as PbAgentToolKind,
  BoxdApiDefinition,
  type AgentEvent as PbAgentEvent,
  type AgentLogin as PbAgentLogin,
  type AgentRun as PbAgentRun,
  type AgentSession as PbAgentSession,
  type CompleteAgentLoginResponse as PbCompleteAgentLoginResponse,
  type Harness as PbHarness,
  type ListAgentRunsResponse as PbListAgentRunsResponse,
  type StartAgentLoginResponse as PbStartAgentLoginResponse,
} from "./_generated/definitions.js";

// ─── Models ──────────────────────────────────────────────────────────────

/** An agent a machine can run, and what it can do. */
export interface Harness {
  /** `claude-code`, `codex` or `opencode`. */
  id: string;
  /** The version installed on the machine; `null` when it isn't installed. */
  version: string | null;
  /** Whether a message can join a turn while it runs (`when: "now"`).
   *  Without it such a message waits for the next turn. */
  midTurnInput: boolean;
  /** Models the agent accepts in `start({ model })`; empty when the agent
   *  doesn't list them. */
  models: string[];
}

/** `idle`: waiting for a message. `running`: a turn is running. `closed`:
 *  ended with `close()`. `failed`: the agent can't go on; see `error`. */
export type AgentSessionState = "idle" | "running" | "closed" | "failed" | "unknown";

export interface AgentSession {
  id: string;
  /** The machine's id. */
  machineId: string;
  harness: string;
  /** The agent version this session runs. It doesn't change during the
   *  session, even if the machine's agent is updated meanwhile. */
  harnessVersion: string;
  /** `null`: the agent's own default. */
  model: string | null;
  cwd: string;
  state: AgentSessionState;
  /** The turn running now, or the last one; 0 before the first. */
  turn: number;
  /** Messages waiting for the running turn to end, each its own turn. */
  queued: number;
  /** The latest event's `seq`; 0 before the first. */
  lastSeq: number;
  createdAt: Date;
  /** For a failed session: what went wrong and what to do about it. */
  error: string | null;
}

/**
 * `next` (the default): a turn of its own, at once when the session is idle,
 * else after the running turn and any messages already waiting.
 * `now`: into the running turn, for the agent to take into account before
 * the turn ends. An agent that can't take input mid-turn queues it for the
 * next turn instead (`queued_fallback`); an idle session starts a turn with it.
 */
export type AgentSendWhen = "next" | "now";

/** What a message did: started a turn, waits for the running one to end,
 *  joined the running turn, or asked to join but was queued because the
 *  agent can't take input mid-turn. */
export type AgentDelivery = "started" | "queued" | "joined" | "queued_fallback" | "unknown";

/** What a tool call does, the same for every agent; the agent's own tool
 *  name is in `name`. */
export type AgentToolKind =
  | "shell"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "mcp"
  | "computer"
  | "other";

/** Why a turn ended. `interrupted`: `interrupt()`, `close()`, or the machine
 *  stopped. `timeout` / `max_steps`: the limits `send()` set ran out.
 *  `failed`: see the event's `error`. */
export type AgentFinishReason =
  | "done"
  | "interrupted"
  | "timeout"
  | "max_steps"
  | "max_tokens"
  | "refused"
  | "failed"
  | "unknown";

export interface AgentSendResult {
  /** The turn the message started or joined, or the one it will start. */
  turn: number;
  delivery: AgentDelivery;
}

export interface AgentInterruptResult {
  /** The turn that was interrupted; `null` when none was running. */
  turn: number | null;
}

interface AgentEventBase {
  /** 1, 2, 3… per session: pass the last one seen as `afterSeq` to resume. */
  seq: number;
  /** The turn it belongs to. */
  turn: number;
  time: Date;
}

/** A session's events. Narrow on `type`. */
export type AgentEvent = AgentEventBase &
  (
    | { type: "turn.started" }
    /** A message the turn received: the one that started it, or one that
     *  joined it while it ran. */
    | { type: "user.message"; text: string; delivery: AgentDelivery }
    /** The next piece of the agent's reply, as it is written. */
    | { type: "message.delta"; text: string }
    /** One whole reply, once written: what its deltas add up to. */
    | { type: "message"; text: string }
    /** The next piece of the agent's reasoning, for agents that show it. */
    | { type: "thinking.delta"; text: string }
    | {
        type: "tool.started";
        /** Ties the call's output and end to it. */
        callId: string;
        kind: AgentToolKind;
        /** The agent's own name for the tool (`Bash`, `shell`, …). */
        name: string;
        /** The call's input as the agent sent it: parsed JSON, the raw text
         *  if it isn't JSON, `null` if there was none. */
        input: unknown;
      }
    /** Output a tool call produces while it runs, such as a command's output. */
    | { type: "tool.output"; callId: string; text: string }
    | {
        type: "tool.finished";
        callId: string;
        isError: boolean;
        /** The result as the agent received it; long results may be cut short. */
        result: string;
      }
    /** The agent's to-do list for the turn, whole each time it changes. */
    | { type: "plan"; items: Array<{ text: string; status: string }> }
    /** Tokens the turn has used so far, as the agent reports them; sent at
     *  least once per turn, before it finishes. */
    | {
        type: "usage";
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }
    /** The last event of every turn. */
    | { type: "turn.finished"; reason: AgentFinishReason; error: string | null }
  );

export type AgentEventType = AgentEvent["type"];

export interface AgentStartParams extends RegionOption {
  /** `claude-code` or `codex`: `harnesses()` lists what the machine has. */
  harness: string;
  /** Default: the agent's own. */
  model?: string;
  /** The directory the agent works in. Default: the home directory of the
   *  machine's user. */
  cwd?: string;
  /** Added to the agent's own system prompt, never replacing it. */
  instructions?: string;
  /** Environment variables for this session's agent, on top of the
   *  machine's own variables and secrets. */
  env?: Record<string, string>;
  /** Makes a retry safe: a second start with the same id on this machine
   *  returns the session the first one started instead of starting another.
   *  Default: a new id for this call, which the SDK's own retries keep. Pass
   *  your own to retry across processes, such as an automation re-running a
   *  step. */
  requestId?: string;
}

export interface AgentSendParams extends RegionOption {
  /** Default `"next"`. */
  when?: AgentSendWhen;
  /** For a turn this message starts: interrupt it after this many seconds.
   *  Doesn't apply to a running turn the message joins. */
  timeoutSecs?: number;
  /** For a turn this message starts: interrupt it after this many agent
   *  steps: calls to the model for Claude Code, tool calls for Codex. */
  maxSteps?: number;
  /** Makes a retry safe: a second message with the same id in this session
   *  isn't sent again, and gets the first one's answer. Default: a new id
   *  for this call, which the SDK's own retries keep. Pass your own to retry
   *  across processes, such as an automation re-running a step. */
  requestId?: string;
}

export interface AgentEventsParams extends RegionOption {
  /** Start after this event. Default 0: from the session's first event. */
  afterSeq?: number;
  /** Keep the stream open and carry new events as they happen. */
  follow?: boolean;
  /** Aborting it ends the stream at once, even while it waits on a quiet
   *  session: the loop finishes (nothing is thrown) and the call is
   *  cancelled. */
  signal?: AbortSignal;
}

/** `run()`'s task: one message to one session, start to reply. (Not
 *  {@link AgentRunsParams}, which filters the run history.) */
export interface AgentRunParams extends RegionOption {
  /** `claude-code` or `codex`: `harnesses()` lists what the machine has.
   *  With `session`, the agent that session runs. */
  harness: string;
  /** The task. */
  text: string;
  /** For a new session: the model. Default: the agent's own. */
  model?: string;
  /** For a new session: the directory the agent works in. Default: the home
   *  directory of the machine's user. */
  cwd?: string;
  /** For a new session: added to the agent's own system prompt, never
   *  replacing it. */
  instructions?: string;
  /** For a new session: environment variables for its agent, on top of the
   *  machine's own variables and secrets. */
  env?: Record<string, string>;
  /** Interrupt the turn after this many seconds. */
  timeoutSecs?: number;
  /** Interrupt the turn after this many agent steps: calls to the model for
   *  Claude Code, tool calls for Codex. */
  maxSteps?: number;
  /** Send the task to this open session instead of starting one. It stays
   *  open. Not with `model`, `cwd`, `instructions` or `env`, which are for a
   *  new session. */
  session?: string;
  /** Leave the session this starts open afterwards, to `send()` it more. */
  keep?: boolean;
  /** Aborting it interrupts the turn, closes a session this started (unless
   *  `keep`), and rejects with the abort's reason. */
  signal?: AbortSignal;
  /** Called with each of the turn's events as it happens, for progress. */
  onEvent?: (ev: AgentEvent) => void;
}

/** What `run()` did: the agent's last reply in the turn, how the turn ended,
 *  and the session it ran in. (Not {@link AgentRun}, a finished turn in the
 *  run history.) */
export interface AgentRunResult {
  sessionId: string;
  /** The machine's id. */
  machineId: string;
  turn: number;
  /** How the turn ended: anything but `done` means it didn't finish the
   *  task, with `error` for `failed`. */
  reason: AgentFinishReason;
  /** What went wrong; absent when nothing did. */
  error?: string;
  /** The agent's last reply in the turn; `""` when it wrote none. */
  reply: string;
  /** The tokens the turn used, as last reported; absent when the agent
   *  reported none. */
  usage?: AgentRunUsage;
  /** Whether the session is still open: `keep`, `session`, or a session
   *  this started that it couldn't close. */
  kept: boolean;
}

/** What started a turn: a message sent to the session (`message`), a
 *  message that waited for the turn before it to end (`queued`), or the
 *  agent itself (`by_agent`), as Claude Code does to report that a
 *  background command ended. */
export type AgentRunStartedBy = "message" | "queued" | "by_agent" | "unknown";

/** Tokens a turn used, as the agent reported them. */
export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One finished turn, from the platform's run history. It says how the turn
 *  went, not what was said: no prompts and no output. `events()` has the
 *  transcript, read from the machine. */
export interface AgentRun {
  /** The machine's id. */
  machineId: string;
  /** The machine's name. */
  machineName: string;
  sessionId: string;
  /** `claude-code`, `codex` or `opencode`. */
  harness: string;
  /** The agent version the session ran. */
  harnessVersion: string;
  /** The model the session asked for; `""` when it used the agent's own
   *  default. */
  model: string;
  turn: number;
  startedBy: AgentRunStartedBy;
  reason: AgentFinishReason;
  /** For `failed` and some `interrupted` turns: what went wrong, its first
   *  500 characters. */
  error?: string;
  startedAt: Date;
  endedAt: Date;
  /** Calls to the model (Claude Code) or tool calls (Codex) in the turn. */
  steps: number;
  usage: AgentRunUsage;
}

/** One page of `runs()`, newest first. */
export interface AgentRunsPage {
  runs: AgentRun[];
  /** Pass it as `pageToken` for the next, older page; absent on the last. */
  nextPageToken?: string;
}

export interface AgentRunsParams extends RegionOption {
  /** Only this machine's runs (name or id). Default: every machine you can
   *  see, and your own deleted ones. */
  machine?: string;
  /** Only this session's runs. */
  session?: string;
  /** The organization, by name or id. Default: your current one (with an
   *  API key, the key's). */
  org?: string;
  /** Only runs that ended at or after this time: a `Date`, or unix seconds.
   *  Default: everything that is kept (30 days). */
  since?: TimeBound;
  /** Runs per page. Default 50, at most 500. */
  limit?: number;
  /** `nextPageToken` from the page before. */
  pageToken?: string;
}

/** How a sign-in goes. `paste_code` (Claude Code): open `url`, approve, and
 *  pass the code the page then shows you to `completeLogin()`.
 *  `device_code` (Codex): open `url`, enter `userCode`, then
 *  `waitForLogin()`. `unknown`: a method this SDK doesn't know yet. */
export type AgentLoginMethod = "paste_code" | "device_code" | "unknown";

/** Where to sign in, from `startLogin()`. */
export interface AgentLoginStart {
  method: AgentLoginMethod;
  /** Where to sign in. */
  url: string;
  /** `device_code`: what to enter at `url`. */
  userCode?: string;
  /** `device_code`: pass it to `completeLogin()`. */
  handle?: string;
  /** `device_code`: when `userCode` stops working. */
  expiresAt?: Date;
  /** `device_code`: how often to ask whether you've approved, in seconds. */
  intervalSecs?: number;
}

/** Your sign-in to one agent in one organization. */
export interface AgentLogin {
  /** `claude-code` or `codex`. */
  harness: string;
  signedIn: boolean;
  /** The account's email, when the provider says. */
  account?: string;
  /** The organization it's kept in: the machine's. */
  orgId: string;
  /** The last sign-in or refresh; absent when signed out. */
  updatedAt?: Date;
}

/** What `completeLogin()` got. */
export interface AgentLoginResult {
  /** `device_code`: not approved yet; ask again in `intervalSecs`. */
  pending: boolean;
  /** Once signed in. */
  login?: AgentLogin;
}

/** How often `waitForLogin()` asks when the start doesn't say, in seconds. */
const LOGIN_INTERVAL_SECS = 5;

const emptyToNull = (s: string): string | null => (s === "" ? null : s);

/** Events a reader hasn't taken yet before the stream is paused: past this
 *  the transport stops reading and the server's flow control holds the rest
 *  back, so a slow reader never piles a session's history up in memory. */
const EVENTS_HIGH_WATER = 256;
/** Read again once the reader has taken the backlog down to this. */
const EVENTS_LOW_WATER = 64;

/**
 * `events()`'s iterator over one `AgentEvents` call. A hand-written iterator
 * rather than an `async function*`: a generator only sees `return()` (a
 * `break`, or a caller giving up) once its pending `next()` has settled,
 * which on a quiet follow stream may be never. Here `return()`, `throw()`
 * and the caller's abort signal end the call at once and settle a waiting
 * `next()` as done.
 */
class AgentEventStream implements AsyncGenerator<AgentEvent, void, undefined> {
  #start: (() => ReadableCall<PbAgentEvent>) | undefined;
  #call?: ReadableCall<PbAgentEvent>;
  #items: AgentEvent[] = [];
  #waiting?: {
    resolve: (r: IteratorResult<AgentEvent, void>) => void;
    reject: (e: unknown) => void;
  };
  #done = false;
  #failed = false;
  #error: unknown;
  #paused = false;
  readonly #signal?: AbortSignal;
  readonly #onAbort = () => void this.return();

  constructor(start: () => ReadableCall<PbAgentEvent>, signal?: AbortSignal) {
    this.#start = start;
    this.#signal = signal;
    if (signal?.aborted) this.#finish();
    else signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  /** The call starts with the first `next()`, as a generator's body would. */
  #open(): void {
    const start = this.#start;
    this.#start = undefined;
    if (!start || this.#done) return;
    const call = start();
    this.#call = call;
    call.on("data", (raw: PbAgentEvent) => {
      const ev = toAgentEvent(raw);
      if (ev) this.#push(ev);
    });
    call.on("error", (err: unknown) => this.#fail(err));
    call.on("end", () => this.#finish());
  }

  #push(ev: AgentEvent): void {
    if (this.#done) return;
    const w = this.#waiting;
    if (w) {
      this.#waiting = undefined;
      w.resolve({ value: ev, done: false });
      return;
    }
    this.#items.push(ev);
    if (!this.#paused && this.#items.length >= EVENTS_HIGH_WATER) {
      this.#paused = true;
      this.#call?.pause?.();
    }
  }

  #fail(err: unknown): void {
    if (this.#done) return;
    this.#failed = true;
    this.#error = err;
    this.#finish();
  }

  /** No more events: what's queued is still read, then it's done. */
  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#start = undefined;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    const w = this.#waiting;
    if (!w) return;
    this.#waiting = undefined;
    if (this.#failed) {
      this.#failed = false;
      w.reject(this.#error);
    } else {
      w.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<AgentEvent, void>> {
    this.#open();
    const ev = this.#items.shift();
    if (ev) {
      if (this.#paused && this.#items.length <= EVENTS_LOW_WATER) {
        this.#paused = false;
        this.#call?.resume?.();
      }
      return Promise.resolve({ value: ev, done: false });
    }
    if (this.#failed) {
      // Thrown once, as a generator would.
      this.#failed = false;
      return Promise.reject(this.#error);
    }
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  /** Stop: the call is cancelled (a follow stream would otherwise stay open
   *  on the server) and nothing more is read. */
  return(): Promise<IteratorResult<AgentEvent, void>> {
    this.#items = [];
    this.#failed = false;
    this.#call?.cancel?.();
    this.#finish();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(err?: unknown): Promise<IteratorResult<AgentEvent, void>> {
    void this.return();
    return Promise.reject(err);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

// `await using` (where the runtime has it) ends the call, as `return()` does.
const asyncDispose = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose;
if (asyncDispose) {
  Object.defineProperty(AgentEventStream.prototype, asyncDispose, {
    value(this: AgentEventStream) {
      return this.return().then(() => undefined);
    },
  });
}

export function toHarness(h: PbHarness): Harness {
  return {
    id: h.id,
    version: emptyToNull(h.version),
    midTurnInput: h.midTurnInput,
    models: h.models ?? [],
  };
}

function toSessionState(s: PbAgentSessionState): AgentSessionState {
  switch (s) {
    case PbAgentSessionState.AGENT_SESSION_STATE_IDLE:
      return "idle";
    case PbAgentSessionState.AGENT_SESSION_STATE_RUNNING:
      return "running";
    case PbAgentSessionState.AGENT_SESSION_STATE_CLOSED:
      return "closed";
    case PbAgentSessionState.AGENT_SESSION_STATE_FAILED:
      return "failed";
    default:
      return "unknown";
  }
}

function toDelivery(d: PbAgentDelivery): AgentDelivery {
  switch (d) {
    case PbAgentDelivery.AGENT_DELIVERY_STARTED:
      return "started";
    case PbAgentDelivery.AGENT_DELIVERY_QUEUED:
      return "queued";
    case PbAgentDelivery.AGENT_DELIVERY_JOINED:
      return "joined";
    case PbAgentDelivery.AGENT_DELIVERY_QUEUED_FALLBACK:
      return "queued_fallback";
    default:
      return "unknown";
  }
}

function toToolKind(k: PbAgentToolKind): AgentToolKind {
  switch (k) {
    case PbAgentToolKind.AGENT_TOOL_KIND_SHELL:
      return "shell";
    case PbAgentToolKind.AGENT_TOOL_KIND_EDIT:
      return "edit";
    case PbAgentToolKind.AGENT_TOOL_KIND_READ:
      return "read";
    case PbAgentToolKind.AGENT_TOOL_KIND_SEARCH:
      return "search";
    case PbAgentToolKind.AGENT_TOOL_KIND_WEB:
      return "web";
    case PbAgentToolKind.AGENT_TOOL_KIND_MCP:
      return "mcp";
    case PbAgentToolKind.AGENT_TOOL_KIND_COMPUTER:
      return "computer";
    default:
      return "other";
  }
}

function toFinishReason(r: PbAgentFinishReason): AgentFinishReason {
  switch (r) {
    case PbAgentFinishReason.AGENT_FINISH_REASON_DONE:
      return "done";
    case PbAgentFinishReason.AGENT_FINISH_REASON_INTERRUPTED:
      return "interrupted";
    case PbAgentFinishReason.AGENT_FINISH_REASON_TIMEOUT:
      return "timeout";
    case PbAgentFinishReason.AGENT_FINISH_REASON_MAX_STEPS:
      return "max_steps";
    case PbAgentFinishReason.AGENT_FINISH_REASON_MAX_TOKENS:
      return "max_tokens";
    case PbAgentFinishReason.AGENT_FINISH_REASON_REFUSED:
      return "refused";
    case PbAgentFinishReason.AGENT_FINISH_REASON_FAILED:
      return "failed";
    default:
      return "unknown";
  }
}

export function toAgentSession(s: PbAgentSession): AgentSession {
  return {
    id: s.id,
    machineId: s.vmId,
    harness: s.harness,
    harnessVersion: s.harnessVersion,
    model: emptyToNull(s.model),
    cwd: s.cwd,
    state: toSessionState(s.state),
    turn: s.turn,
    queued: s.queued,
    lastSeq: s.lastSeq,
    createdAt: new Date(s.createdAtMs),
    error: emptyToNull(s.error),
  };
}

function toStartedBy(s: string): AgentRunStartedBy {
  return s === "message" || s === "queued" || s === "by_agent" ? s : "unknown";
}

export function toAgentRun(r: PbAgentRun): AgentRun {
  const run: AgentRun = {
    machineId: r.vmId,
    machineName: r.vmName,
    sessionId: r.sessionId,
    harness: r.harness,
    harnessVersion: r.harnessVersion,
    model: r.model,
    turn: r.turn,
    startedBy: toStartedBy(r.startedBy),
    reason: toFinishReason(r.reason),
    startedAt: new Date(r.startedAtMs),
    endedAt: new Date(r.endedAtMs),
    steps: r.steps,
    usage: {
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
    },
  };
  if (r.error) run.error = r.error;
  return run;
}

export function toAgentRunsPage(r: PbListAgentRunsResponse): AgentRunsPage {
  const page: AgentRunsPage = { runs: (r.runs ?? []).map(toAgentRun) };
  if (r.nextPageToken) page.nextPageToken = r.nextPageToken;
  return page;
}

function toLoginMethod(m: PbAgentLoginMethod): AgentLoginMethod {
  switch (m) {
    case PbAgentLoginMethod.AGENT_LOGIN_METHOD_PASTE_CODE:
      return "paste_code";
    case PbAgentLoginMethod.AGENT_LOGIN_METHOD_DEVICE_CODE:
      return "device_code";
    default:
      return "unknown";
  }
}

export function toAgentLoginStart(r: PbStartAgentLoginResponse): AgentLoginStart {
  const start: AgentLoginStart = { method: toLoginMethod(r.method), url: r.url };
  if (r.userCode) start.userCode = r.userCode;
  if (r.handle) start.handle = r.handle;
  if (r.expiresAtMs) start.expiresAt = new Date(r.expiresAtMs);
  if (r.intervalSecs) start.intervalSecs = r.intervalSecs;
  return start;
}

export function toAgentLogin(l: PbAgentLogin): AgentLogin {
  const login: AgentLogin = { harness: l.harness, signedIn: l.signedIn, orgId: l.orgId };
  if (l.account) login.account = l.account;
  if (l.updatedAtMs) login.updatedAt = new Date(l.updatedAtMs);
  return login;
}

export function toAgentLoginResult(r: PbCompleteAgentLoginResponse): AgentLoginResult {
  const result: AgentLoginResult = { pending: r.pending };
  if (r.login) result.login = toAgentLogin(r.login);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `ms`, or until `signal` aborts: then it rejects with the abort's reason. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How many times `run()` follows its turn again after the event stream
 *  breaks (a network blip, a proxy restart), from the last event it saw. */
const RUN_RECONNECTS = 5;

/** What a turn came to, from its events (`run()`): its last whole reply (or,
 *  for an agent that only streams, what the pieces since add up to), its
 *  tokens, and how it ended. */
class TurnOutcome {
  #reply = "";
  #streamed = "";
  usage?: AgentRunUsage;
  /** Set by the turn's `turn.finished`. */
  reason?: AgentFinishReason;
  error: string | null = null;

  observe(ev: AgentEvent): void {
    switch (ev.type) {
      case "message.delta":
        this.#streamed += ev.text;
        break;
      case "message":
        this.#reply = ev.text;
        this.#streamed = "";
        break;
      case "usage":
        this.usage = {
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          cacheWriteTokens: ev.cacheWriteTokens,
        };
        break;
      case "turn.finished":
        this.reason = ev.reason;
        this.error = ev.error;
        break;
    }
  }

  /** The agent's last reply. */
  get reply(): string {
    return this.#streamed.trim() === "" ? this.#reply : this.#streamed;
  }
}

/** A time bound as ms since the epoch; 0 when absent (the server default). */
function toEpochMs(t: TimeBound | undefined): number {
  if (t === undefined) return 0;
  return t instanceof Date ? t.getTime() : Math.floor(t * 1000);
}

/** A tool call's input: parsed JSON, else the raw text, `null` when empty. */
function parseInput(json: string): unknown {
  if (json === "") return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** `null` for an event whose kind this SDK doesn't know (a newer server):
 *  callers skip it. */
export function toAgentEvent(e: PbAgentEvent): AgentEvent | null {
  const base: AgentEventBase = { seq: e.seq, turn: e.turn, time: new Date(e.timeMs) };
  if (e.turnStarted) return { ...base, type: "turn.started" };
  if (e.userMessage) {
    return {
      ...base,
      type: "user.message",
      text: e.userMessage.text,
      delivery: toDelivery(e.userMessage.delivery),
    };
  }
  if (e.messageDelta) return { ...base, type: "message.delta", text: e.messageDelta.text };
  if (e.message) return { ...base, type: "message", text: e.message.text };
  if (e.thinkingDelta) return { ...base, type: "thinking.delta", text: e.thinkingDelta.text };
  if (e.toolStarted) {
    return {
      ...base,
      type: "tool.started",
      callId: e.toolStarted.callId,
      kind: toToolKind(e.toolStarted.kind),
      name: e.toolStarted.name,
      input: parseInput(e.toolStarted.inputJson),
    };
  }
  if (e.toolOutput) {
    return { ...base, type: "tool.output", callId: e.toolOutput.callId, text: e.toolOutput.text };
  }
  if (e.toolFinished) {
    return {
      ...base,
      type: "tool.finished",
      callId: e.toolFinished.callId,
      isError: e.toolFinished.isError,
      result: e.toolFinished.result,
    };
  }
  if (e.plan) {
    return {
      ...base,
      type: "plan",
      items: (e.plan.items ?? []).map((i) => ({ text: i.text, status: i.status })),
    };
  }
  if (e.usage) {
    return {
      ...base,
      type: "usage",
      inputTokens: e.usage.inputTokens,
      outputTokens: e.usage.outputTokens,
      cacheReadTokens: e.usage.cacheReadTokens,
      cacheWriteTokens: e.usage.cacheWriteTokens,
    };
  }
  if (e.turnFinished) {
    return {
      ...base,
      type: "turn.finished",
      reason: toFinishReason(e.turnFinished.reason),
      error: emptyToNull(e.turnFinished.error),
    };
  }
  return null;
}

// ─── Namespace ───────────────────────────────────────────────────────────

/** Coding agents inside a machine. `machine` is a machine's name or id. */
export class MachineAgents {
  constructor(private readonly transport: Transport) {}

  /** The agents the machine can run, with their versions and abilities. */
  async harnesses(machine: string, opts: RegionOption = {}): Promise<Harness[]> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listHarnesses,
      { vmId: machine },
      { region: opts.region },
    );
    return (resp.harnesses ?? []).map(toHarness);
  }

  /** Start a session. Nothing runs until the first `send()`. Retried after
   *  a lost connection: its `requestId` makes a repeat return the session
   *  the first attempt started. */
  async start(machine: string, params: AgentStartParams): Promise<AgentSession> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.startAgentSession,
      {
        vmId: machine,
        harness: params.harness,
        model: params.model ?? "",
        cwd: params.cwd ?? "",
        instructions: params.instructions ?? "",
        env: params.env ?? {},
        requestId: params.requestId ?? crypto.randomUUID(),
      },
      { region: params.region },
    );
    return toAgentSession(resp);
  }

  /** Send a message. Resolves once it is delivered, not when the turn ends:
   *  read the turn's events with `events()`. Retried after a lost
   *  connection: its `requestId` makes a repeat get the first attempt's
   *  answer instead of sending the message twice. */
  async send(
    machine: string,
    sessionId: string,
    text: string,
    params: AgentSendParams = {},
  ): Promise<AgentSendResult> {
    if (params.when !== undefined && params.when !== "next" && params.when !== "now") {
      throw new BoxdError(`when is "next" or "now", not ${JSON.stringify(params.when)}`);
    }
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.sendToAgent,
      {
        vmId: machine,
        sessionId,
        text,
        when:
          params.when === "now"
            ? PbAgentSendWhen.AGENT_SEND_WHEN_NOW
            : PbAgentSendWhen.AGENT_SEND_WHEN_NEXT,
        timeoutSecs: params.timeoutSecs ?? 0,
        maxSteps: params.maxSteps ?? 0,
        requestId: params.requestId ?? crypto.randomUUID(),
      },
      { region: params.region },
    );
    return { turn: resp.turn, delivery: toDelivery(resp.delivery) };
  }

  /**
   * The session's events in order, from after `afterSeq`. Without `follow`
   * it ends after the latest one; with it, it stays open and carries new
   * events as they happen, until the caller stops: a `break`, the
   * iterator's `return()`, or aborting `signal`, any of which ends the call
   * at once. An event of a kind this SDK doesn't know yet is skipped. A
   * reader that falls behind slows the stream down rather than having the
   * events pile up in memory.
   */
  events(
    machine: string,
    sessionId: string,
    params: AgentEventsParams = {},
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const follow = params.follow ?? false;
    return new AgentEventStream(
      () =>
        this.transport.serverStream(
          BoxdApiDefinition.methods.agentEvents,
          { vmId: machine, sessionId, afterSeq: params.afterSeq ?? 0, follow },
          // A follow stream is meant to stay open: the client's per-call
          // deadline would cut it.
          { region: params.region, deadline: !follow },
        ),
      params.signal,
    );
  }

  /** Interrupt the running turn; its last event says `interrupted`.
   *  `clearQueue` also drops the messages waiting for the next turns;
   *  without it the next one starts once the interrupted turn has ended. */
  async interrupt(
    machine: string,
    sessionId: string,
    params: { clearQueue?: boolean } & RegionOption = {},
  ): Promise<AgentInterruptResult> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.interruptAgent,
      { vmId: machine, sessionId, clearQueue: params.clearQueue ?? false },
      // Not repeated after a lost answer: it could stop the turn the next
      // waiting message has just started.
      { region: params.region, retry: false },
    );
    return { turn: resp.turn === 0 ? null : resp.turn };
  }

  /** End the session: a running turn is interrupted, waiting messages are
   *  dropped, and its events stay readable. */
  async close(machine: string, sessionId: string, opts: RegionOption = {}): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.closeAgentSession,
      { vmId: machine, sessionId },
      { region: opts.region },
    );
  }

  async get(machine: string, sessionId: string, opts: RegionOption = {}): Promise<AgentSession> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.getAgentSession,
      { vmId: machine, sessionId },
      { region: opts.region },
    );
    return toAgentSession(resp);
  }

  /** The machine's sessions; `all` includes closed and failed ones. */
  async list(
    machine: string,
    params: { all?: boolean } & RegionOption = {},
  ): Promise<AgentSession[]> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listAgentSessions,
      { vmId: machine, all: params.all ?? false },
      { region: params.region },
    );
    return (resp.sessions ?? []).map(toAgentSession);
  }

  /**
   * Run one task, start to reply: start a session with `harness` (or use
   * the open `session`), send it `text`, wait for that turn to end, and
   * resolve to the agent's last reply and how the turn ended. (`runs()` is
   * something else: the history of finished turns.)
   *
   * ```ts
   * const r = await boxd.machines.agents.run("my-box", {
   *   harness: "claude-code",
   *   text: "Fix the failing test",
   *   cwd: "/home/boxd/app",
   * });
   * console.log(r.reply);
   * if (r.reason !== "done") console.error(`[${r.reason}] ${r.error ?? ""}`);
   * ```
   *
   * A turn that ends other than `done` doesn't reject: `reason` (and
   * `error`) says how it ended. A session this starts is closed afterwards,
   * also when following the turn fails, unless `keep`. Aborting `signal`
   * interrupts the turn, closes a session this started (unless `keep`), and
   * rejects with the abort's reason. The start and the send are retried as
   * `start()` and `send()` are, and an event stream that breaks is followed
   * again from the last event seen, up to 5 times.
   */
  async run(machine: string, params: AgentRunParams): Promise<AgentRunResult> {
    const { harness, signal, region } = params;
    if (
      params.session !== undefined &&
      (params.model !== undefined ||
        params.cwd !== undefined ||
        params.instructions !== undefined ||
        params.env !== undefined)
    ) {
      throw new BoxdError(
        "model, cwd, instructions and env are for a new session: leave them out with session",
      );
    }
    signal?.throwIfAborted();
    let session: AgentSession;
    if (params.session === undefined) {
      session = await this.start(machine, {
        harness,
        model: params.model,
        cwd: params.cwd,
        instructions: params.instructions,
        env: params.env,
        region,
      });
    } else {
      const id = params.session;
      session = await this.get(machine, id, { region });
      if (session.harness !== harness) {
        throw new BoxdError(`session ${id} runs ${session.harness}, not ${harness}`);
      }
      if (session.state === "closed" || session.state === "failed") {
        throw new BoxdError(
          `session ${id} is ${session.state}: leave out session to start a new one`,
        );
      }
    }
    const close = params.session === undefined && !params.keep;
    let turn: number | undefined;
    let outcome: TurnOutcome;
    try {
      signal?.throwIfAborted();
      ({ turn } = await this.send(machine, session.id, params.text, {
        timeoutSecs: params.timeoutSecs,
        maxSteps: params.maxSteps,
        region,
      }));
      outcome = await this.#followTurn(machine, session, turn, params);
    } catch (err) {
      // Best effort: what the caller hears about is `err`.
      if (turn !== undefined && signal?.aborted) {
        await this.interrupt(machine, session.id, { region }).catch(() => {});
      }
      if (close) await this.close(machine, session.id, { region }).catch(() => {});
      throw err;
    }
    let kept = !close;
    if (close) {
      try {
        await this.close(machine, session.id, { region });
      } catch {
        // The turn's reply isn't lost to it: `kept` says it's still open.
        kept = true;
      }
    }
    const result: AgentRunResult = {
      sessionId: session.id,
      machineId: session.machineId,
      turn,
      reason: outcome.reason ?? "unknown",
      reply: outcome.reply,
      kept,
    };
    if (outcome.error) result.error = outcome.error;
    if (outcome.usage) result.usage = outcome.usage;
    return result;
  }

  /** `run()`'s wait: the session's events from after `session.lastSeq`
   *  until `turn`'s `turn.finished`, the other turns' skipped. A stream that
   *  breaks is followed again from the last event seen: one that fails to
   *  open only after a lost connection, one that has carried events after
   *  any failure. */
  async #followTurn(
    machine: string,
    session: AgentSession,
    turn: number,
    params: AgentRunParams,
  ): Promise<TurnOutcome> {
    const { signal, region } = params;
    const outcome = new TurnOutcome();
    let after = session.lastSeq;
    let reconnects = 0;
    for (;;) {
      const stream = this.events(machine, session.id, {
        afterSeq: after,
        follow: true,
        signal,
        region,
      });
      let carried = false;
      try {
        for (;;) {
          let next: IteratorResult<AgentEvent, void>;
          try {
            next = await stream.next();
          } catch (err) {
            if (reconnects < RUN_RECONNECTS && (carried || isRetryable(err))) break;
            throw err;
          }
          if (next.done) {
            signal?.throwIfAborted();
            throw new BoxdError(
              `the session's events ended before turn ${turn} finished: it may have been closed`,
            );
          }
          const ev = next.value;
          carried = true;
          after = ev.seq;
          if (ev.turn !== turn) continue;
          outcome.observe(ev);
          params.onEvent?.(ev);
          if (outcome.reason !== undefined) return outcome;
        }
      } finally {
        await stream.return(undefined);
      }
      reconnects += 1;
      await abortableSleep(reconnects * 1000, signal);
    }
  }

  /**
   * One page of finished turns, newest first, from the platform's run
   * history: across the machines you can see, or only `machine`'s or
   * `session`'s. It never reaches into a machine, so it doesn't wake one,
   * and a machine's runs are kept for 30 days, also after it's deleted.
   * There are no prompts or output, only how each turn went: `events()` has
   * the transcript.
   *
   * Pass the page's `nextPageToken` as `pageToken` for the next, older page,
   * or iterate every run with {@link MachineAgents.runsIter}:
   *
   * ```ts
   * const { runs } = await boxd.machines.agents.runs({ machine: "my-box", limit: 10 });
   * for (const r of runs) console.log(r.sessionId, r.turn, r.reason, r.error ?? "");
   * ```
   *
   * A cluster that doesn't keep run history (one without an analytics
   * store, such as some self-hosted ones) refuses the call with a
   * `ConflictError` saying so.
   */
  async runs(params: AgentRunsParams = {}): Promise<AgentRunsPage> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listAgentRuns,
      {
        org: params.org ?? "",
        vmId: params.machine ?? "",
        sessionId: params.session ?? "",
        sinceMs: toEpochMs(params.since),
        limit: params.limit ?? 0,
        pageToken: params.pageToken ?? "",
      },
      { region: params.region },
    );
    return toAgentRunsPage(resp);
  }

  /**
   * Every run `runs()` would list, newest first, reading pages as you go
   * (`limit` is the page size). Stop with `break` to read no further:
   *
   * ```ts
   * for await (const r of boxd.machines.agents.runsIter({ since: new Date(Date.now() - 86_400_000) })) {
   *   if (r.reason === "failed") console.log(r.machineName, r.sessionId, r.error);
   * }
   * ```
   */
  async *runsIter(
    params: Omit<AgentRunsParams, "pageToken"> = {},
  ): AsyncGenerator<AgentRun, void, undefined> {
    let pageToken: string | undefined;
    do {
      const page = await this.runs({ ...params, pageToken });
      yield* page.runs;
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /**
   * Sign a coding agent in (`harness`: `claude-code` or `codex`) for
   * `machine`, one of yours: the platform's own sign-in, the same as the
   * console's Integrations page. The login is kept for you in the machine's
   * organization, refreshed by the platform, and given to every private
   * machine of yours there; your agent sessions use it.
   *
   * This says where to go. Claude Code (`paste_code`): open `url`, approve,
   * and pass the code the page then shows you to `completeLogin()`. Codex
   * (`device_code`): open `url`, enter `userCode`, and `waitForLogin()`:
   *
   * ```ts
   * const start = await boxd.machines.agents.startLogin("my-box", "codex");
   * console.log(`Open ${start.url} and enter ${start.userCode}`);
   * const login = await boxd.machines.agents.waitForLogin("my-box", "codex", start);
   * ```
   *
   * A machine that would never get the login (a shared or isolated one,
   * another member's, a Windows one) is refused with a `ConflictError`
   * saying what to do instead.
   */
  async startLogin(
    machine: string,
    harness: string,
    opts: RegionOption = {},
  ): Promise<AgentLoginStart> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.startAgentLogin,
      { vmId: machine, harness, org: "" },
      { region: opts.region },
    );
    return toAgentLoginStart(resp);
  }

  /**
   * Finish a sign-in `startLogin()` began, in one call. Claude Code: `code`
   * is the code the page showed you after you approved, and you're signed
   * in. Codex: `handle` is the start's, and the result is `pending` until
   * you've approved; `waitForLogin()` asks again for you.
   */
  async completeLogin(
    machine: string,
    harness: string,
    params: {
      /** `paste_code`: the code the page showed you after you approved. */
      code?: string;
      /** `device_code`: the start's `handle`. */
      handle?: string;
    } & RegionOption,
  ): Promise<AgentLoginResult> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.completeAgentLogin,
      {
        vmId: machine,
        harness,
        org: "",
        code: params.code ?? "",
        handle: params.handle ?? "",
      },
      { region: params.region },
    );
    return toAgentLoginResult(resp);
  }

  /**
   * Wait until you've approved a Codex (`device_code`) sign-in: asks with
   * the start's `handle` every `intervalSecs` until it's no longer pending,
   * and resolves to the login. It gives up with an error once the code
   * expires (`expiresAt`), or after `timeout` milliseconds when that comes
   * first. A Claude Code (`paste_code`) sign-in can't be waited on: pass the
   * code its page shows you to `completeLogin()`.
   */
  async waitForLogin(
    machine: string,
    harness: string,
    start: AgentLoginStart,
    opts: {
      /** Milliseconds. Default: until the code expires. */
      timeout?: number;
    } & RegionOption = {},
  ): Promise<AgentLogin> {
    if (start.method === "paste_code") {
      throw new BoxdError(
        "a paste_code sign-in can't be waited on: pass the code its page shows you " +
          "after you approve to completeLogin()",
      );
    }
    if (start.method !== "device_code") {
      throw new BoxdError(`waitForLogin() waits on a device_code sign-in, not ${start.method}`);
    }
    const handle = start.handle;
    if (!handle) {
      throw new BoxdError("the sign-in has no handle: pass what startLogin() returned");
    }
    const intervalMs = (start.intervalSecs || LOGIN_INTERVAL_SECS) * 1000;
    const expiresAt = start.expiresAt?.getTime() ?? Infinity;
    const timeoutAt = opts.timeout === undefined ? Infinity : Date.now() + opts.timeout;
    for (;;) {
      const r = await this.completeLogin(machine, harness, { handle, region: opts.region });
      if (!r.pending) {
        if (r.login) return r.login;
        throw new BoxdError(`the ${harness} sign-in ended without a login`);
      }
      const left = Math.min(expiresAt, timeoutAt) - Date.now();
      if (left <= 0) {
        throw new BoxdError(
          timeoutAt < expiresAt
            ? `the ${harness} sign-in wasn't approved within ${opts.timeout}ms`
            : `the ${harness} sign-in code expired before it was approved: ` +
                "start again with startLogin()",
        );
      }
      await sleep(Math.min(intervalMs, left));
    }
  }

  /** Whether you're signed in to `harness` for `machine`, and as whom: the
   *  login kept in the machine's organization. */
  async getLogin(machine: string, harness: string, opts: RegionOption = {}): Promise<AgentLogin> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.getAgentLogin,
      { vmId: machine, harness, org: "" },
      { region: opts.region },
    );
    return toAgentLogin(resp);
  }

  /** Forget your sign-in to `harness` in the machine's organization. It
   *  isn't revoked at Anthropic or OpenAI; do that from your account there. */
  async logout(machine: string, harness: string, opts: RegionOption = {}): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.deleteAgentLogin,
      { vmId: machine, harness, org: "" },
      { region: opts.region },
    );
  }
}
