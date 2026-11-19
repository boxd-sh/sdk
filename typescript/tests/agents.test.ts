/**
 * `machines.agents`: the right RPC and request for each call, the models out,
 * the event stream (every kind, unknown kinds skipped, no deadline on a
 * follow stream, the call ended when the reader stops early), the run
 * history (`runs`, its pages and their iterator), signing an agent in
 * (`startLogin`, `completeLogin`, `waitForLogin`, `getLogin`, `logout`), and
 * one task start to reply (`run`: its session, its reply, abort, cleanup).
 */
import { describe, expect, it } from "bun:test";
import {
  AgentDelivery,
  AgentFinishReason,
  AgentLoginMethod,
  AgentSendWhen,
  AgentSessionState,
  AgentToolKind,
  type AgentEvent as PbAgentEvent,
} from "../src/_generated/definitions.js";
import type { CallOptions, MethodDef, Transport, UnaryOptions } from "../src/_rpc.js";
import { withRetries } from "../src/_retry.js";
import { APIConnectionError, BoxdError } from "../src/errors.js";
import { toAgentEvent, toAgentLoginStart, toAgentRun } from "../src/agents.js";
import {
  Boxd,
  Integrations,
  MachineAgents,
  Machines,
  type AgentEvent,
  type AgentRunParams,
} from "../src/index.js";

interface Recorded {
  method: string;
  req: Record<string, unknown>;
  opts: (UnaryOptions & { deadline?: boolean }) | undefined;
}

/** A server stream that replays `chunks` once its handlers are on. */
class FakeStream {
  cancelled = false;
  /** Every pause() and resume(), in order. */
  readonly flow: string[] = [];
  #handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  constructor(
    private readonly chunks: unknown[],
    private readonly error?: unknown,
    private readonly stayOpen = false,
  ) {}
  on(event: string, fn: (arg?: unknown) => void): void {
    (this.#handlers[event] ??= []).push(fn);
    if (event === "end") {
      queueMicrotask(() => {
        for (const c of this.chunks) this.#emit("data", c);
        if (this.error) this.#emit("error", this.error);
        else if (!this.stayOpen) this.#emit("end");
      });
    }
  }
  cancel(): void {
    this.cancelled = true;
  }
  pause(): void {
    this.flow.push("pause");
  }
  resume(): void {
    this.flow.push("resume");
  }
  #emit(event: string, arg?: unknown): void {
    if (this.cancelled) return;
    for (const fn of this.#handlers[event] ?? []) fn(arg);
  }
}

class FakeTransport implements Transport {
  readonly calls: Recorded[] = [];
  readonly streams: FakeStream[] = [];
  readonly supportsInteractiveExec = true;
  constructor(
    private readonly responses: unknown[] = [],
    private readonly stream: { chunks: unknown[]; error?: unknown; stayOpen?: boolean } = {
      chunks: [],
    },
  ) {}
  async consoleOrigin(): Promise<string> {
    return "https://app.boxd.sh";
  }
  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req, opts?: UnaryOptions) {
    this.calls.push({ method: method.name, req: req as Record<string, unknown>, opts });
    return (this.responses.shift() ?? {}) as Resp;
  }
  serverStream<Req>(
    method: MethodDef<Req, unknown>,
    req: Req,
    opts?: CallOptions & { deadline?: boolean },
  ) {
    this.calls.push({ method: method.name, req: req as Record<string, unknown>, opts });
    const s = new FakeStream(this.stream.chunks, this.stream.error, this.stream.stayOpen);
    this.streams.push(s);
    return s;
  }
  duplex(): never {
    throw new Error("not used");
  }
  clientStream(): never {
    throw new Error("not used");
  }
  close(): void {}
}

const agents = (t: FakeTransport) => new MachineAgents(t as Transport);

/** A transport that retries as the real ones do (`withRetries`), its first
 *  attempt at each call failing to connect. */
class FlakyTransport extends FakeTransport {
  override async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req, opts?: UnaryOptions) {
    let failed = false;
    return withRetries(opts?.retry === false ? 0 : 2, async () => {
      if (!failed) {
        failed = true;
        this.calls.push({ method: method.name, req: { ...(req as Record<string, unknown>) }, opts });
        throw new APIConnectionError("connection reset");
      }
      return super.unary(method, req, opts);
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const aSession = (fields: Record<string, unknown> = {}) => ({
  id: "s-1",
  vmId: "vm-1",
  harness: "claude-code",
  harnessVersion: "2.1.317",
  model: "",
  cwd: "/home/boxd",
  state: AgentSessionState.AGENT_SESSION_STATE_IDLE,
  turn: 0,
  queued: 0,
  lastSeq: 0,
  createdAtMs: 1_700_000_000_000,
  error: "",
  ...fields,
});

const aRun = (fields: Record<string, unknown> = {}) => ({
  vmId: "vm-1",
  vmName: "box",
  sessionId: "s-1",
  harness: "claude-code",
  harnessVersion: "2.1.317",
  model: "",
  turn: 1,
  startedBy: "message",
  reason: AgentFinishReason.AGENT_FINISH_REASON_DONE,
  error: "",
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_042_000,
  steps: 3,
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4 },
  ...fields,
});

const ev = (seq: number, kind: Partial<PbAgentEvent>): PbAgentEvent => ({
  seq,
  turn: 1,
  timeMs: 1_700_000_000_000 + seq,
  ...kind,
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("machines.agents", () => {
  it("is on machines", () => {
    const m = new Machines(new FakeTransport() as Transport);
    expect(m.agents).toBeInstanceOf(MachineAgents);
  });

  it("harnesses calls ListHarnesses and maps an empty version to null", async () => {
    const t = new FakeTransport([
      {
        harnesses: [
          { id: "claude-code", version: "2.1.317", midTurnInput: true, models: [] },
          { id: "codex", version: "", midTurnInput: false, models: ["gpt-5"] },
        ],
      },
    ]);
    const hs = await agents(t).harnesses("box", { region: "nyc" });
    expect(t.calls).toEqual([{ method: "ListHarnesses", req: { vmId: "box" }, opts: { region: "nyc" } }]);
    expect(hs).toEqual([
      { id: "claude-code", version: "2.1.317", midTurnInput: true, models: [] },
      { id: "codex", version: null, midTurnInput: false, models: ["gpt-5"] },
    ]);
  });

  it("start sends every field, defaults to empty, and maps the session", async () => {
    const t = new FakeTransport([aSession(), aSession({ model: "opus", error: "x" })]);
    const s = await agents(t).start("box", { harness: "claude-code" });
    expect(t.calls[0]!.method).toBe("StartAgentSession");
    expect(t.calls[0]!.opts).toEqual({ region: undefined });
    const { requestId, ...rest } = t.calls[0]!.req;
    expect(requestId).toMatch(UUID);
    expect(rest).toEqual({
      vmId: "box",
      harness: "claude-code",
      model: "",
      cwd: "",
      instructions: "",
      env: {},
    });
    expect(s).toEqual({
      id: "s-1",
      machineId: "vm-1",
      harness: "claude-code",
      harnessVersion: "2.1.317",
      model: null,
      cwd: "/home/boxd",
      state: "idle",
      turn: 0,
      queued: 0,
      lastSeq: 0,
      createdAt: new Date(1_700_000_000_000),
      error: null,
    });

    const s2 = await agents(t).start("box", {
      harness: "claude-code",
      model: "opus",
      cwd: "/srv",
      instructions: "be brief",
      env: { A: "1" },
      requestId: "deploy-42",
    });
    expect(t.calls[1]!.req).toEqual({
      vmId: "box",
      harness: "claude-code",
      model: "opus",
      cwd: "/srv",
      instructions: "be brief",
      env: { A: "1" },
      requestId: "deploy-42",
    });
    expect(s2.model).toBe("opus");
    expect(s2.error).toBe("x");
  });

  it("send maps when and limits, with a request id of its own", async () => {
    const t = new FakeTransport([
      { turn: 1, delivery: AgentDelivery.AGENT_DELIVERY_STARTED },
      { turn: 1, delivery: AgentDelivery.AGENT_DELIVERY_QUEUED_FALLBACK },
    ]);
    expect(await agents(t).send("box", "s-1", "hi")).toEqual({ turn: 1, delivery: "started" });
    const { requestId, ...rest } = t.calls[0]!.req;
    expect(requestId).toMatch(UUID);
    expect({ method: t.calls[0]!.method, req: rest, opts: t.calls[0]!.opts }).toEqual({
      method: "SendToAgent",
      req: {
        vmId: "box",
        sessionId: "s-1",
        text: "hi",
        when: AgentSendWhen.AGENT_SEND_WHEN_NEXT,
        timeoutSecs: 0,
        maxSteps: 0,
      },
      opts: { region: undefined },
    });
    expect(
      await agents(t).send("box", "s-1", "and this", {
        when: "now",
        timeoutSecs: 60,
        maxSteps: 5,
        requestId: "step-7",
      }),
    ).toEqual({ turn: 1, delivery: "queued_fallback" });
    expect(t.calls[1]!.req).toMatchObject({
      when: AgentSendWhen.AGENT_SEND_WHEN_NOW,
      timeoutSecs: 60,
      maxSteps: 5,
      requestId: "step-7",
    });
    await expect(
      agents(t).send("box", "s-1", "x", { when: "later" as "now" }),
    ).rejects.toThrow('when is "next" or "now", not "later"');
    expect(t.calls).toHaveLength(2);
  });

  it("start and send are retried after a lost connection, with the same request id", async () => {
    const t = new FlakyTransport([aSession(), { turn: 2, delivery: AgentDelivery.AGENT_DELIVERY_QUEUED }]);
    const s = await agents(t).start("box", { harness: "codex" });
    expect(s.id).toBe("s-1");
    expect(t.calls.map((c) => c.method)).toEqual(["StartAgentSession", "StartAgentSession"]);
    expect(t.calls[0]!.req.requestId).toMatch(UUID);
    expect(t.calls[1]!.req.requestId).toBe(t.calls[0]!.req.requestId);

    expect(await agents(t).send("box", "s-1", "go")).toEqual({ turn: 2, delivery: "queued" });
    expect(t.calls[3]!.req.requestId).toBe(t.calls[2]!.req.requestId);
    expect(t.calls[2]!.req.requestId).not.toBe(t.calls[0]!.req.requestId);
  });

  it("interrupt maps turn 0 to null", async () => {
    const t = new FakeTransport([{ turn: 3 }, { turn: 0 }]);
    expect(await agents(t).interrupt("box", "s-1", { clearQueue: true })).toEqual({ turn: 3 });
    expect(t.calls[0]!.req).toEqual({ vmId: "box", sessionId: "s-1", clearQueue: true });
    expect(t.calls[0]!.opts).toEqual({ region: undefined, retry: false });
    expect(await agents(t).interrupt("box", "s-1")).toEqual({ turn: null });
    expect(t.calls[1]!.req).toEqual({ vmId: "box", sessionId: "s-1", clearQueue: false });
  });

  it("close, get and list", async () => {
    const t = new FakeTransport([
      {},
      aSession({ state: AgentSessionState.AGENT_SESSION_STATE_RUNNING, turn: 2 }),
      {
        sessions: [
          aSession({ state: AgentSessionState.AGENT_SESSION_STATE_CLOSED }),
          aSession({ id: "s-2", state: AgentSessionState.AGENT_SESSION_STATE_FAILED, error: "boom" }),
          aSession({ id: "s-3", state: 42 }),
        ],
      },
    ]);
    await agents(t).close("box", "s-1");
    const got = await agents(t).get("box", "s-1");
    const all = await agents(t).list("box", { all: true });
    expect(t.calls.map((c) => [c.method, c.req])).toEqual([
      ["CloseAgentSession", { vmId: "box", sessionId: "s-1" }],
      ["GetAgentSession", { vmId: "box", sessionId: "s-1" }],
      ["ListAgentSessions", { vmId: "box", all: true }],
    ]);
    expect(got.state).toBe("running");
    expect(got.turn).toBe(2);
    expect(all.map((s) => [s.id, s.state, s.error])).toEqual([
      ["s-1", "closed", null],
      ["s-2", "failed", "boom"],
      ["s-3", "unknown", null],
    ]);
  });

  it("events maps every kind and skips one it doesn't know", async () => {
    const t = new FakeTransport([], {
      chunks: [
        ev(1, { turnStarted: {} }),
        ev(2, { userMessage: { text: "hi", delivery: AgentDelivery.AGENT_DELIVERY_STARTED } }),
        ev(3, { thinkingDelta: { text: "hmm" } }),
        ev(4, {
          toolStarted: {
            callId: "c1",
            kind: AgentToolKind.AGENT_TOOL_KIND_SHELL,
            name: "Bash",
            inputJson: '{"command":"ls"}',
          },
        }),
        ev(5, { toolOutput: { callId: "c1", text: "a\nb\n" } }),
        ev(6, { toolFinished: { callId: "c1", isError: false, result: "a\nb" } }),
        ev(7, { plan: { items: [{ text: "look", status: "done" }] } }),
        ev(8, {}), // a kind from a newer server
        ev(9, { messageDelta: { text: "Hel" } }),
        ev(10, { message: { text: "Hello" } }),
        ev(11, {
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
        }),
        ev(12, {
          turnFinished: { reason: AgentFinishReason.AGENT_FINISH_REASON_DONE, error: "" },
        }),
      ],
    });
    const got = await collect(agents(t).events("box", "s-1", { afterSeq: 0 }));
    expect(t.calls[0]).toEqual({
      method: "AgentEvents",
      req: { vmId: "box", sessionId: "s-1", afterSeq: 0, follow: false },
      opts: { region: undefined, deadline: true },
    });
    const time = (seq: number) => new Date(1_700_000_000_000 + seq);
    expect(got).toEqual([
      { seq: 1, turn: 1, time: time(1), type: "turn.started" },
      { seq: 2, turn: 1, time: time(2), type: "user.message", text: "hi", delivery: "started" },
      { seq: 3, turn: 1, time: time(3), type: "thinking.delta", text: "hmm" },
      {
        seq: 4,
        turn: 1,
        time: time(4),
        type: "tool.started",
        callId: "c1",
        kind: "shell",
        name: "Bash",
        input: { command: "ls" },
      },
      { seq: 5, turn: 1, time: time(5), type: "tool.output", callId: "c1", text: "a\nb\n" },
      {
        seq: 6,
        turn: 1,
        time: time(6),
        type: "tool.finished",
        callId: "c1",
        isError: false,
        result: "a\nb",
      },
      { seq: 7, turn: 1, time: time(7), type: "plan", items: [{ text: "look", status: "done" }] },
      { seq: 9, turn: 1, time: time(9), type: "message.delta", text: "Hel" },
      { seq: 10, turn: 1, time: time(10), type: "message", text: "Hello" },
      {
        seq: 11,
        turn: 1,
        time: time(11),
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      { seq: 12, turn: 1, time: time(12), type: "turn.finished", reason: "done", error: null },
    ]);
  });

  it("a tool's input: raw text when not JSON, null when empty; unknown enums", () => {
    const started = (inputJson: string, kind = AgentToolKind.AGENT_TOOL_KIND_EDIT) =>
      toAgentEvent(ev(1, { toolStarted: { callId: "c", kind, name: "x", inputJson } }));
    expect(started("not json")).toMatchObject({ input: "not json", kind: "edit" });
    expect(started("")).toMatchObject({ input: null });
    expect(started("{}", 99 as AgentToolKind)).toMatchObject({ kind: "other" });
    expect(
      toAgentEvent(ev(2, { turnFinished: { reason: 99 as AgentFinishReason, error: "e" } })),
    ).toMatchObject({ reason: "unknown", error: "e" });
    expect(
      toAgentEvent(ev(3, { userMessage: { text: "t", delivery: 99 as AgentDelivery } })),
    ).toMatchObject({ delivery: "unknown" });
  });

  it("a follow stream has no deadline and is cancelled when the reader stops", async () => {
    const t = new FakeTransport([], {
      chunks: [ev(5, { messageDelta: { text: "a" } }), ev(6, { messageDelta: { text: "b" } })],
      stayOpen: true,
    });
    const seen: number[] = [];
    for await (const e of agents(t).events("box", "s-1", { afterSeq: 4, follow: true })) {
      seen.push(e.seq);
      if (e.seq === 6) break;
    }
    expect(seen).toEqual([5, 6]);
    expect(t.calls[0]!.req).toEqual({ vmId: "box", sessionId: "s-1", afterSeq: 4, follow: true });
    expect(t.calls[0]!.opts).toEqual({ region: undefined, deadline: false });
    expect(t.streams[0]!.cancelled).toBe(true);
  });

  it("an abort ends a quiet follow stream at once and cancels the call", async () => {
    const t = new FakeTransport([], {
      chunks: [ev(1, { messageDelta: { text: "a" } })],
      stayOpen: true,
    });
    const ctl = new AbortController();
    const seen: number[] = [];
    const done = (async () => {
      for await (const e of agents(t).events("box", "s-1", { follow: true, signal: ctl.signal })) {
        seen.push(e.seq);
        if (e.seq === 1) setTimeout(() => ctl.abort(), 5);
      }
    })();
    await done; // would hang without the abort: nothing more comes
    expect(seen).toEqual([1]);
    expect(t.streams[0]!.cancelled).toBe(true);
  });

  it("return() while a next() waits settles it and cancels the call", async () => {
    const t = new FakeTransport([], { chunks: [], stayOpen: true });
    const it = agents(t).events("box", "s-1", { follow: true });
    const waiting = it.next();
    await new Promise((r) => setTimeout(r, 5));
    expect(await it.return(undefined)).toEqual({ value: undefined, done: true });
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("an aborted signal never opens the call; nothing opens before next()", async () => {
    const t = new FakeTransport([], { chunks: [ev(1, { turnStarted: {} })] });
    const it = agents(t).events("box", "s-1", { signal: AbortSignal.abort() });
    expect(await it.next()).toEqual({ value: undefined, done: true });
    const lazy = agents(t).events("box", "s-1");
    expect(t.calls).toHaveLength(0);
    await lazy.return(undefined);
    expect(t.calls).toHaveLength(0);
  });

  it("a reader that falls behind pauses the stream, and catching up resumes it", async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => ev(i + 1, { messageDelta: { text: "x" } }));
    const t = new FakeTransport([], { chunks });
    const it = agents(t).events("box", "s-1");
    const first = await it.next(); // the call opens; all 300 arrive at once
    expect(first.value?.seq).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    const s = t.streams[0]!;
    expect(s.flow).toEqual(["pause"]); // at 256 waiting
    const seen = [1];
    for (let i = 0; i < 299; i++) {
      const r = await it.next();
      if (!r.done) seen.push(r.value.seq);
      // 299 waited (2…300); taking 236 leaves 64, the low water mark.
      if (r.value?.seq === 235) expect(s.flow).toEqual(["pause"]);
      if (r.value?.seq === 236) expect(s.flow).toEqual(["pause", "resume"]);
    }
    expect(s.flow).toEqual(["pause", "resume"]);
    expect(seen).toEqual(chunks.map((c) => c.seq));
    expect((await it.next()).done).toBe(true);
  });

  it("a stream that fails fails the reader", async () => {
    const t = new FakeTransport([], {
      chunks: [ev(1, { turnStarted: {} })],
      error: new Error("machine went away"),
    });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const e of agents(t).events("box", "s-1")) seen.push(e.seq);
      })(),
    ).rejects.toThrow("machine went away");
    expect(seen).toEqual([1]);
  });
});

describe("machines.agents.runs", () => {
  it("sends empty filters by default, with the normal retry policy", async () => {
    const t = new FakeTransport([{ runs: [aRun()], nextPageToken: "" }]);
    const page = await agents(t).runs();
    expect(t.calls).toEqual([
      {
        method: "ListAgentRuns",
        req: { org: "", vmId: "", sessionId: "", sinceMs: 0, limit: 0, pageToken: "" },
        opts: { region: undefined },
      },
    ]);
    // The last page has no token at all.
    expect(page).toEqual({
      runs: [
        {
          machineId: "vm-1",
          machineName: "box",
          sessionId: "s-1",
          harness: "claude-code",
          harnessVersion: "2.1.317",
          model: "",
          turn: 1,
          startedBy: "message",
          reason: "done",
          startedAt: new Date(1_700_000_000_000),
          endedAt: new Date(1_700_000_042_000),
          steps: 3,
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4 },
        },
      ],
    });
    expect("nextPageToken" in page).toBe(false);
    expect("error" in page.runs[0]!).toBe(false);
  });

  it("sends every filter: since as a Date or unix seconds, in ms", async () => {
    const t = new FakeTransport([{ runs: [], nextPageToken: "p2" }, { runs: [] }]);
    const page = await agents(t).runs({
      machine: "box",
      session: "s-1",
      org: "acme",
      since: new Date(1_700_000_000_123),
      limit: 10,
      pageToken: "p1",
      region: "nyc",
    });
    expect(t.calls[0]).toEqual({
      method: "ListAgentRuns",
      req: {
        org: "acme",
        vmId: "box",
        sessionId: "s-1",
        sinceMs: 1_700_000_000_123,
        limit: 10,
        pageToken: "p1",
      },
      opts: { region: "nyc" },
    });
    expect(page).toEqual({ runs: [], nextPageToken: "p2" });
    await agents(t).runs({ since: 1_700_000_000 });
    expect(t.calls[1]!.req.sinceMs).toBe(1_700_000_000_000);
  });

  it("is retried after a lost connection: it only reads", async () => {
    const t = new FlakyTransport([{ runs: [aRun()] }]);
    expect((await agents(t).runs({ machine: "box" })).runs).toHaveLength(1);
    expect(t.calls.map((c) => c.method)).toEqual(["ListAgentRuns", "ListAgentRuns"]);
  });

  it("maps an error, the reasons and how a turn started, unknown ones too", () => {
    const failed = toAgentRun(
      aRun({ reason: AgentFinishReason.AGENT_FINISH_REASON_FAILED, error: "overloaded", startedBy: "by_agent" }),
    );
    expect([failed.reason, failed.error, failed.startedBy]).toEqual(["failed", "overloaded", "by_agent"]);
    expect(toAgentRun(aRun({ startedBy: "queued" })).startedBy).toBe("queued");
    // From a newer server.
    expect(toAgentRun(aRun({ startedBy: "schedule" })).startedBy).toBe("unknown");
    expect(toAgentRun(aRun({ reason: 99 })).reason).toBe("unknown");
    // No usage on the wire: zeros.
    expect(toAgentRun(aRun({ usage: undefined })).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("runsIter reads page after page with the token, and stops on the last", async () => {
    const t = new FakeTransport([
      { runs: [aRun({ turn: 3 }), aRun({ turn: 2 })], nextPageToken: "p2" },
      { runs: [aRun({ turn: 1 })], nextPageToken: "" },
    ]);
    const turns: number[] = [];
    for await (const r of agents(t).runsIter({ machine: "box", limit: 2 })) turns.push(r.turn);
    expect(turns).toEqual([3, 2, 1]);
    expect(t.calls.map((c) => [c.req.vmId, c.req.limit, c.req.pageToken])).toEqual([
      ["box", 2, ""],
      ["box", 2, "p2"],
    ]);
  });

  it("runsIter reads no further than the caller", async () => {
    const t = new FakeTransport([
      { runs: [aRun({ turn: 3 }), aRun({ turn: 2 })], nextPageToken: "p2" },
      { runs: [aRun({ turn: 1 })] },
    ]);
    for await (const r of agents(t).runsIter()) {
      if (r.turn === 3) break;
    }
    expect(t.calls).toHaveLength(1);
  });
});

const aLogin = (fields: Record<string, unknown> = {}) => ({
  harness: "codex",
  signedIn: true,
  account: "ada@example.com",
  orgId: "org-1",
  updatedAtMs: 1_700_000_000_000,
  ...fields,
});

const aDeviceStart = (fields: Record<string, unknown> = {}) => ({
  method: AgentLoginMethod.AGENT_LOGIN_METHOD_DEVICE_CODE,
  url: "https://auth.openai.com/codex/device",
  userCode: "ABCD-1234",
  handle: "h-1",
  expiresAtMs: 1_700_000_900_000,
  intervalSecs: 5,
  ...fields,
});

/** A device-code start as `startLogin()` returns it, asking every `ms`. */
const deviceStart = (ms: number, expiresInMs = 60_000) => ({
  method: "device_code" as const,
  url: "https://auth.openai.com/codex/device",
  userCode: "ABCD-1234",
  handle: "h-1",
  expiresAt: new Date(Date.now() + expiresInMs),
  intervalSecs: ms / 1000,
});

const pending = (n: number) => Array.from({ length: n }, () => ({ pending: true }));

describe("machines.agents logins", () => {
  it("startLogin for Claude Code: a URL, and no device fields", async () => {
    const t = new FakeTransport([
      {
        method: AgentLoginMethod.AGENT_LOGIN_METHOD_PASTE_CODE,
        url: "https://claude.ai/oauth/authorize?x=1",
        userCode: "",
        handle: "",
        expiresAtMs: 0,
        intervalSecs: 0,
      },
    ]);
    const start = await agents(t).startLogin("box", "claude-code");
    expect(t.calls).toEqual([
      {
        method: "StartAgentLogin",
        req: { vmId: "box", harness: "claude-code", org: "" },
        opts: { region: undefined },
      },
    ]);
    expect(start).toEqual({ method: "paste_code", url: "https://claude.ai/oauth/authorize?x=1" });
    for (const k of ["userCode", "handle", "expiresAt", "intervalSecs"]) {
      expect(k in start).toBe(false);
    }
  });

  it("startLogin for Codex: the device code, its handle, expiry and interval", async () => {
    const t = new FakeTransport([aDeviceStart()]);
    const start = await agents(t).startLogin("box", "codex", { region: "nyc" });
    expect(t.calls[0]!.req).toEqual({ vmId: "box", harness: "codex", org: "" });
    expect(t.calls[0]!.opts).toEqual({ region: "nyc" });
    expect(start).toEqual({
      method: "device_code",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      handle: "h-1",
      expiresAt: new Date(1_700_000_900_000),
      intervalSecs: 5,
    });
    // From a newer server.
    expect(toAgentLoginStart(aDeviceStart({ method: 99 })).method).toBe("unknown");
  });

  it("completeLogin sends the pasted code and maps the login", async () => {
    const t = new FakeTransport([{ pending: false, login: aLogin({ harness: "claude-code" }) }]);
    const result = await agents(t).completeLogin("box", "claude-code", { code: "abc#state" });
    expect(t.calls).toEqual([
      {
        method: "CompleteAgentLogin",
        req: { vmId: "box", harness: "claude-code", org: "", code: "abc#state", handle: "" },
        opts: { region: undefined },
      },
    ]);
    expect(result).toEqual({
      pending: false,
      login: {
        harness: "claude-code",
        signedIn: true,
        account: "ada@example.com",
        orgId: "org-1",
        updatedAt: new Date(1_700_000_000_000),
      },
    });
  });

  it("completeLogin sends the handle; pending has no login", async () => {
    const t = new FakeTransport([{ pending: true }]);
    const result = await agents(t).completeLogin("box", "codex", { handle: "h-1", region: "lon" });
    expect(t.calls[0]!.req).toEqual({ vmId: "box", harness: "codex", org: "", code: "", handle: "h-1" });
    expect(t.calls[0]!.opts).toEqual({ region: "lon" });
    expect(result).toEqual({ pending: true });
    expect("login" in result).toBe(false);
  });

  it("getLogin maps a sign-in; an empty account and a zero time are left out", async () => {
    const t = new FakeTransport([
      aLogin({ account: "" }),
      aLogin({ signedIn: false, account: "", updatedAtMs: 0 }),
    ]);
    const signedIn = await agents(t).getLogin("box", "codex");
    expect(signedIn).toEqual({
      harness: "codex",
      signedIn: true,
      orgId: "org-1",
      updatedAt: new Date(1_700_000_000_000),
    });
    expect("account" in signedIn).toBe(false);
    const signedOut = await agents(t).getLogin("box", "codex", { region: "nyc" });
    expect(signedOut).toEqual({ harness: "codex", signedIn: false, orgId: "org-1" });
    expect("updatedAt" in signedOut).toBe(false);
    expect(t.calls.map((c) => [c.method, c.req, c.opts])).toEqual([
      ["GetAgentLogin", { vmId: "box", harness: "codex", org: "" }, { region: undefined }],
      ["GetAgentLogin", { vmId: "box", harness: "codex", org: "" }, { region: "nyc" }],
    ]);
  });

  it("logout calls DeleteAgentLogin", async () => {
    const t = new FakeTransport([{}]);
    expect(await agents(t).logout("box", "claude-code")).toBeUndefined();
    expect(t.calls).toEqual([
      {
        method: "DeleteAgentLogin",
        req: { vmId: "box", harness: "claude-code", org: "" },
        opts: { region: undefined },
      },
    ]);
  });

  it("waitForLogin asks with the handle until it's approved", async () => {
    const t = new FakeTransport([...pending(2), { pending: false, login: aLogin() }]);
    const login = await agents(t).waitForLogin("box", "codex", deviceStart(2), { region: "nyc" });
    expect(login).toEqual({
      harness: "codex",
      signedIn: true,
      account: "ada@example.com",
      orgId: "org-1",
      updatedAt: new Date(1_700_000_000_000),
    });
    expect(t.calls.map((c) => [c.method, c.req, c.opts])).toEqual(
      Array.from({ length: 3 }, () => [
        "CompleteAgentLogin",
        { vmId: "box", harness: "codex", org: "", code: "", handle: "h-1" },
        { region: "nyc" },
      ]),
    );
  });

  it("waitForLogin gives up once the code expires", async () => {
    const t = new FakeTransport(pending(1000));
    const err = await agents(t)
      .waitForLogin("box", "codex", deviceStart(5, 30))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BoxdError);
    expect(err.message).toBe(
      "the codex sign-in code expired before it was approved: start again with startLogin()",
    );
    expect(t.calls.length).toBeGreaterThan(1);
    expect(t.calls.length).toBeLessThan(20);
  });

  it("waitForLogin gives up after its timeout when that comes first", async () => {
    const t = new FakeTransport(pending(1000));
    const err = await agents(t)
      .waitForLogin("box", "codex", deviceStart(5), { timeout: 30 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BoxdError);
    expect(err.message).toBe("the codex sign-in wasn't approved within 30ms");
  });

  it("waitForLogin refuses a paste_code sign-in, and one without a handle", async () => {
    const t = new FakeTransport();
    const claude = { method: "paste_code" as const, url: "https://claude.ai/oauth/authorize" };
    await expect(agents(t).waitForLogin("box", "claude-code", claude)).rejects.toThrow(
      "a paste_code sign-in can't be waited on: pass the code its page shows you " +
        "after you approve to completeLogin()",
    );
    const { handle: _, ...noHandle } = deviceStart(5);
    await expect(agents(t).waitForLogin("box", "codex", noHandle)).rejects.toThrow(
      "the sign-in has no handle: pass what startLogin() returned",
    );
    await expect(
      agents(t).waitForLogin("box", "codex", { ...deviceStart(5), method: "unknown" }),
    ).rejects.toThrow("waitForLogin() waits on a device_code sign-in, not unknown");
    expect(t.calls).toHaveLength(0);
  });
});

/** A transport whose server streams are scripted one call at a time (the
 *  first `AgentEvents` call gets the first, a follow-again the next), and
 *  whose queued unary answers that are errors are thrown. */
class RunTransport extends FakeTransport {
  constructor(
    responses: unknown[],
    private readonly scripted: { chunks: unknown[]; error?: unknown; stayOpen?: boolean }[],
  ) {
    super(responses);
  }
  override async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req, opts?: UnaryOptions) {
    const r = await super.unary(method, req, opts);
    if (r instanceof Error) throw r;
    return r;
  }
  override serverStream<Req>(
    method: MethodDef<Req, unknown>,
    req: Req,
    opts?: CallOptions & { deadline?: boolean },
  ) {
    this.calls.push({ method: method.name, req: req as Record<string, unknown>, opts });
    const next = this.scripted.shift() ?? { chunks: [] };
    const s = new FakeStream(next.chunks, next.error, next.stayOpen);
    this.streams.push(s);
    return s;
  }
}

const sent = (turn: number, delivery = AgentDelivery.AGENT_DELIVERY_STARTED) => ({
  turn,
  delivery,
});
const onTurn = (turn: number, e: PbAgentEvent): PbAgentEvent => ({ ...e, turn });
const finished = (seq: number, reason = AgentFinishReason.AGENT_FINISH_REASON_DONE, error = "") =>
  ev(seq, { turnFinished: { reason, error } });

describe("machines.agents.run", () => {
  it("starts a session, sends the task, follows its turn and closes the session", async () => {
    const t = new RunTransport(
      [aSession({ lastSeq: 0 }), sent(1), {}],
      [
        {
          chunks: [
            ev(1, { turnStarted: {} }),
            ev(2, {
              userMessage: { text: "fix it", delivery: AgentDelivery.AGENT_DELIVERY_STARTED },
            }),
            ev(3, { messageDelta: { text: "Look" } }),
            ev(4, { message: { text: "Looking at it." } }),
            ev(5, {
              toolStarted: {
                callId: "c",
                kind: AgentToolKind.AGENT_TOOL_KIND_SHELL,
                name: "Bash",
                inputJson: "{}",
              },
            }),
            ev(6, { message: { text: "Fixed: 2 tests." } }),
            ev(7, {
              usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 },
            }),
            finished(8),
          ],
          stayOpen: true,
        },
      ],
    );
    const seen: string[] = [];
    const r = await agents(t).run("box", {
      harness: "codex",
      text: "fix it",
      model: "gpt-5",
      cwd: "/srv",
      instructions: "be brief",
      env: { A: "1" },
      timeoutSecs: 600,
      maxSteps: 20,
      region: "nyc",
      onEvent: (e) => seen.push(e.type),
    });
    expect(r).toEqual({
      sessionId: "s-1",
      machineId: "vm-1",
      turn: 1,
      reason: "done",
      reply: "Fixed: 2 tests.",
      usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 },
      kept: false,
    });
    expect("error" in r).toBe(false);
    expect(seen).toEqual([
      "turn.started",
      "user.message",
      "message.delta",
      "message",
      "tool.started",
      "message",
      "usage",
      "turn.finished",
    ]);
    expect(t.calls.map((c) => c.method)).toEqual([
      "StartAgentSession",
      "SendToAgent",
      "AgentEvents",
      "CloseAgentSession",
    ]);
    const [start, send, events, close] = t.calls;
    expect(start!.req).toMatchObject({
      vmId: "box",
      harness: "codex",
      model: "gpt-5",
      cwd: "/srv",
      instructions: "be brief",
      env: { A: "1" },
    });
    expect(start!.req.requestId).toMatch(UUID);
    expect(send!.req).toMatchObject({
      vmId: "box",
      sessionId: "s-1",
      text: "fix it",
      when: AgentSendWhen.AGENT_SEND_WHEN_NEXT,
      timeoutSecs: 600,
      maxSteps: 20,
    });
    expect(send!.req.requestId).toMatch(UUID);
    expect(events!.req).toEqual({ vmId: "box", sessionId: "s-1", afterSeq: 0, follow: true });
    expect(close!.req).toEqual({ vmId: "box", sessionId: "s-1" });
    expect(t.calls.map((c) => c.opts?.region)).toEqual(["nyc", "nyc", "nyc", "nyc"]);
    // The follow stream is ended once the turn has.
    expect(t.streams[0]!.cancelled).toBe(true);
  });

  it("keep leaves the session it started open", async () => {
    const t = new RunTransport([aSession(), sent(1)], [{ chunks: [finished(1)] }]);
    const r = await agents(t).run("box", { harness: "claude-code", text: "hi", keep: true });
    expect(r.kept).toBe(true);
    expect(t.calls.map((c) => c.method)).toEqual([
      "StartAgentSession",
      "SendToAgent",
      "AgentEvents",
    ]);
  });

  it("session: an open one, from its last event, other turns ignored, left open", async () => {
    const t = new RunTransport(
      [
        aSession({
          id: "s-7",
          harness: "codex",
          state: AgentSessionState.AGENT_SESSION_STATE_RUNNING,
          turn: 3,
          lastSeq: 40,
        }),
        sent(4, AgentDelivery.AGENT_DELIVERY_QUEUED),
      ],
      [
        {
          chunks: [
            onTurn(3, ev(41, { message: { text: "the turn before" } })),
            onTurn(3, finished(42, AgentFinishReason.AGENT_FINISH_REASON_FAILED, "not ours")),
            onTurn(4, ev(43, { message: { text: "ours" } })),
            onTurn(4, finished(44)),
          ],
        },
      ],
    );
    const seen: number[] = [];
    const r = await agents(t).run("box", {
      harness: "codex",
      text: "and then this",
      session: "s-7",
      onEvent: (e) => seen.push(e.seq),
    });
    expect(r).toEqual({
      sessionId: "s-7",
      machineId: "vm-1",
      turn: 4,
      reason: "done",
      reply: "ours",
      kept: true,
    });
    expect(seen).toEqual([43, 44]);
    expect(t.calls.map((c) => [c.method, c.req.afterSeq])).toEqual([
      ["GetAgentSession", undefined],
      ["SendToAgent", undefined],
      ["AgentEvents", 40],
    ]);
    expect(t.calls[0]!.req).toEqual({ vmId: "box", sessionId: "s-7" });
  });

  it("session: refuses another agent's, a closed or failed one, new-session options", async () => {
    const t = new RunTransport(
      [
        aSession({ harness: "claude-code" }),
        aSession({ harness: "codex", state: AgentSessionState.AGENT_SESSION_STATE_CLOSED }),
        aSession({ harness: "codex", state: AgentSessionState.AGENT_SESSION_STATE_FAILED }),
      ],
      [],
    );
    const a = agents(t);
    const run = (more: Partial<AgentRunParams> = {}) =>
      a.run("box", { harness: "codex", text: "x", session: "s-1", ...more });
    await expect(run()).rejects.toThrow("session s-1 runs claude-code, not codex");
    await expect(run()).rejects.toThrow(
      "session s-1 is closed: leave out session to start a new one",
    );
    await expect(run()).rejects.toThrow("session s-1 is failed");
    await expect(run({ cwd: "/srv" })).rejects.toThrow(
      "model, cwd, instructions and env are for a new session: leave them out with session",
    );
    expect(t.calls.map((c) => c.method)).toEqual([
      "GetAgentSession",
      "GetAgentSession",
      "GetAgentSession",
    ]);
  });

  it("the reply: the last whole message, or what an only-streaming agent's add up to", async () => {
    const reply = async (chunks: PbAgentEvent[]) => {
      const t = new RunTransport(
        [aSession(), sent(1), {}],
        [{ chunks: [...chunks, finished(99)] }],
      );
      return (await agents(t).run("box", { harness: "codex", text: "x" })).reply;
    };
    expect(
      await reply([
        ev(1, { message: { text: "first" } }),
        ev(2, { message: { text: "last" } }),
        ev(3, { messageDelta: { text: "  " } }), // only whitespace since: the message stands
      ]),
    ).toBe("last");
    expect(
      await reply([
        ev(1, { messageDelta: { text: "Hel" } }),
        ev(2, { messageDelta: { text: "lo" } }),
      ]),
    ).toBe("Hello");
    expect(
      await reply([
        ev(1, { message: { text: "earlier" } }),
        ev(2, { messageDelta: { text: "and " } }),
        ev(3, { messageDelta: { text: "later" } }),
      ]),
    ).toBe("and later");
    expect(await reply([])).toBe("");
  });

  it("a failed turn resolves with its reason and error, and the session is closed", async () => {
    const t = new RunTransport(
      [aSession(), sent(1), {}],
      [{ chunks: [finished(1, AgentFinishReason.AGENT_FINISH_REASON_FAILED, "overloaded")] }],
    );
    const r = await agents(t).run("box", { harness: "claude-code", text: "x" });
    expect(r).toEqual({
      sessionId: "s-1",
      machineId: "vm-1",
      turn: 1,
      reason: "failed",
      error: "overloaded",
      reply: "",
      kept: false,
    });
    expect("usage" in r).toBe(false);
    expect(t.calls.at(-1)!.method).toBe("CloseAgentSession");
  });

  it("a session it can't close afterwards is kept, and the reply isn't lost", async () => {
    const t = new RunTransport(
      [aSession(), sent(1), new APIConnectionError("connection reset")],
      [{ chunks: [ev(1, { message: { text: "done" } }), finished(2)] }],
    );
    const r = await agents(t).run("box", { harness: "claude-code", text: "x" });
    expect([r.reply, r.kept]).toEqual(["done", true]);
  });

  it("an abort interrupts the turn, closes the session it started and rejects", async () => {
    for (const keep of [false, true]) {
      const t = new RunTransport(
        [aSession(), sent(1), { turn: 1 }, {}],
        [{ chunks: [ev(1, { turnStarted: {} })], stayOpen: true }],
      );
      const ctl = new AbortController();
      const stop = new Error("stop");
      const err = await agents(t)
        .run("box", {
          harness: "claude-code",
          text: "x",
          keep,
          signal: ctl.signal,
          onEvent: () => setTimeout(() => ctl.abort(stop), 5),
        })
        .catch((e) => e);
      expect(err).toBe(stop);
      expect(t.calls.map((c) => c.method)).toEqual([
        "StartAgentSession",
        "SendToAgent",
        "AgentEvents",
        "InterruptAgent",
        ...(keep ? [] : ["CloseAgentSession"]),
      ]);
      expect(t.calls[3]!.req).toEqual({ vmId: "box", sessionId: "s-1", clearQueue: false });
      expect(t.streams[0]!.cancelled).toBe(true);
    }
  });

  it("an aborted signal starts nothing; an abort before the send closes the session", async () => {
    const t = new RunTransport([], []);
    const signal = AbortSignal.abort(new Error("never mind"));
    await expect(
      agents(t).run("box", { harness: "codex", text: "x", signal }),
    ).rejects.toThrow("never mind");
    expect(t.calls).toHaveLength(0);

    const ctl = new AbortController();
    const t2 = new RunTransport([aSession(), {}], []);
    const a = agents(t2);
    const started = a.start.bind(a);
    a.start = async (m, p) => {
      const s = await started(m, p);
      ctl.abort(new Error("too late"));
      return s;
    };
    await expect(a.run("box", { harness: "codex", text: "x", signal: ctl.signal })).rejects.toThrow(
      "too late",
    );
    // Nothing was sent, so nothing to interrupt.
    expect(t2.calls.map((c) => c.method)).toEqual(["StartAgentSession", "CloseAgentSession"]);
  });

  it("an error while following still closes the session; onEvent's isn't retried", async () => {
    const t = new RunTransport(
      [aSession(), sent(1), {}],
      [{ chunks: [], error: new Error("machine went away") }],
    );
    await expect(agents(t).run("box", { harness: "codex", text: "x" })).rejects.toThrow(
      "machine went away",
    );
    expect(t.calls.map((c) => c.method)).toEqual([
      "StartAgentSession",
      "SendToAgent",
      "AgentEvents",
      "CloseAgentSession",
    ]);

    const t2 = new RunTransport(
      [aSession(), sent(1), {}],
      [{ chunks: [ev(1, { turnStarted: {} }), finished(2)] }],
    );
    await expect(
      agents(t2).run("box", {
        harness: "codex",
        text: "x",
        onEvent: () => {
          throw new Error("callback broke");
        },
      }),
    ).rejects.toThrow("callback broke");
    expect(t2.calls.map((c) => c.method)).toEqual([
      "StartAgentSession",
      "SendToAgent",
      "AgentEvents",
      "CloseAgentSession",
    ]);
  });

  it("events that end before the turn finished reject, and the session is closed", async () => {
    const t = new RunTransport(
      [aSession(), sent(1), {}],
      [{ chunks: [ev(1, { turnStarted: {} })] }],
    );
    await expect(agents(t).run("box", { harness: "codex", text: "x" })).rejects.toThrow(
      "the session's events ended before turn 1 finished: it may have been closed",
    );
    expect(t.calls.at(-1)!.method).toBe("CloseAgentSession");
  });

  it("a stream that breaks is followed again from the last event seen", async () => {
    const t = new RunTransport(
      [aSession({ lastSeq: 3 }), sent(2), {}],
      [
        {
          chunks: [
            onTurn(2, ev(4, { turnStarted: {} })),
            onTurn(2, ev(5, { messageDelta: { text: "Hel" } })),
          ],
          error: new BoxdError("stream reset"),
        },
        { chunks: [onTurn(2, ev(6, { messageDelta: { text: "lo" } })), onTurn(2, finished(7))] },
      ],
    );
    const r = await agents(t).run("box", { harness: "codex", text: "x" });
    expect([r.reply, r.reason]).toEqual(["Hello", "done"]);
    const follows = t.calls.filter((c) => c.method === "AgentEvents");
    expect(follows.map((c) => c.req.afterSeq)).toEqual([3, 5]);
  });
});

describe("integrations", () => {
  const integrations = (t: FakeTransport) => new Integrations(t as Transport);

  it("connect, complete, get and disconnect name the org, never a machine", async () => {
    const t = new FakeTransport([
      aDeviceStart(),
      { pending: false, login: aLogin({ harness: "claude" }) },
      aLogin({ account: "", updatedAtMs: 0 }),
      {},
    ]);
    const i = integrations(t);
    const start = await i.connect("codex", { org: "acme" });
    expect(start).toMatchObject({ method: "device_code", userCode: "ABCD-1234", handle: "h-1" });
    const done = await i.complete("claude", { code: "abc#state" });
    expect(done.login?.harness).toBe("claude");
    expect(await i.get("codex")).toEqual({ harness: "codex", signedIn: true, orgId: "org-1" });
    await i.disconnect("claude", { org: "acme" });
    expect(t.calls.map((c) => [c.method, c.req])).toEqual([
      ["StartAgentLogin", { vmId: "", harness: "codex", org: "acme" }],
      [
        "CompleteAgentLogin",
        { vmId: "", harness: "claude", org: "", code: "abc#state", handle: "" },
      ],
      ["GetAgentLogin", { vmId: "", harness: "codex", org: "" }],
      ["DeleteAgentLogin", { vmId: "", harness: "claude", org: "acme" }],
    ]);
  });

  it("wait asks with the handle until it's approved", async () => {
    const t = new FakeTransport([...pending(2), { pending: false, login: aLogin() }]);
    const login = await integrations(t).wait("codex", deviceStart(2), { org: "acme" });
    expect(login.signedIn).toBe(true);
    expect(t.calls.map((c) => c.req)).toEqual(
      Array.from({ length: 3 }, () => ({
        vmId: "",
        harness: "codex",
        org: "acme",
        code: "",
        handle: "h-1",
      })),
    );
  });

  it("wait names its own methods when it can't wait", async () => {
    const t = new FakeTransport(pending(1000));
    const expired = await integrations(t)
      .wait("codex", deviceStart(5, 30))
      .catch((e) => e);
    expect(expired.message).toBe(
      "the codex sign-in code expired before it was approved: start again with connect()",
    );
    const paste = await integrations(new FakeTransport())
      .wait("claude", { method: "paste_code", url: "https://claude.ai/oauth" })
      .catch((e) => e);
    expect(paste.message).toContain("to complete()");
  });

  it("is on the client", () => {
    expect(new Boxd({ token: "t" }).integrations).toBeInstanceOf(Integrations);
  });
});
