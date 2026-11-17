/**
 * `machines.agents`: the right RPC and request for each call, the models out,
 * and the event stream (every kind, unknown kinds skipped, no deadline on a
 * follow stream, the call ended when the reader stops early).
 */
import { describe, expect, it } from "bun:test";
import {
  AgentDelivery,
  AgentFinishReason,
  AgentSendWhen,
  AgentSessionState,
  AgentToolKind,
  type AgentEvent as PbAgentEvent,
} from "../src/_generated/definitions.js";
import type { CallOptions, MethodDef, Transport, UnaryOptions } from "../src/_rpc.js";
import { withRetries } from "../src/_retry.js";
import { APIConnectionError } from "../src/errors.js";
import { toAgentEvent } from "../src/agents.js";
import { MachineAgents, Machines, type AgentEvent } from "../src/index.js";

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
