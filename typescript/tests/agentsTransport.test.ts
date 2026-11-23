/**
 * `machines.agents` over the default (grpc-js) transport against a real
 * in-process grpc-js server: a not-found on the event stream reaches the
 * reader of a `Boxd` client (grpc-js ends a failed stream after its error,
 * and the client's region router must not let that end past the error), and
 * a follow stream on a path that goes silent fails, by the channel's
 * keepalive, instead of waiting forever, so `run()` follows its turn again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import net from "node:net";
import {
  Server,
  ServerCredentials,
  status,
  type ServerWritableStream,
  type sendUnaryData,
} from "@grpc/grpc-js";
import {
  AgentDelivery,
  AgentFinishReason,
  AgentSessionState,
  BoxdApiService,
  type AgentEvent,
  type AgentEventsRequest,
  type AgentSession,
  type GetAgentSessionRequest,
} from "../src/_generated/api.js";
import { Transport } from "../src/_transport.js";
import { MachineAgents } from "../src/agents.js";
import { Credentials } from "../src/auth.js";
import { APIConnectionError, NotFoundError } from "../src/errors.js";
import { Boxd } from "../src/index.js";

/**
 * A machine with one session whose events the test appends. The machine
 * named `forgetful` knows no session when its events are asked for.
 */
async function startServer() {
  /** The calls the server got, in order. */
  const calls: string[] = [];
  const log: AgentEvent[] = [];
  const followers = new Set<ServerWritableStream<AgentEventsRequest, AgentEvent>>();
  /** The session's next event: logged, and sent to whoever follows. */
  const append = (kind: Partial<AgentEvent>) => {
    const event = { seq: log.length + 1, turn: 1, timeMs: 1_700_000_000_000, ...kind };
    log.push(event);
    for (const follower of followers) follower.write(event);
  };
  const session = (id: string): AgentSession => ({
    id,
    vmId: "vm-1",
    harness: "codex",
    harnessVersion: "0.159.2",
    model: "",
    cwd: "/home/boxd",
    state: AgentSessionState.AGENT_SESSION_STATE_IDLE,
    turn: 0,
    queued: 0,
    lastSeq: 0,
    createdAtMs: 1_700_000_000_000,
    error: "",
    effort: "",
  });
  const server = new Server();
  server.addService(
    {
      startAgentSession: BoxdApiService.startAgentSession,
      getAgentSession: BoxdApiService.getAgentSession,
      sendToAgent: BoxdApiService.sendToAgent,
      interruptAgent: BoxdApiService.interruptAgent,
      closeAgentSession: BoxdApiService.closeAgentSession,
      agentEvents: BoxdApiService.agentEvents,
    } as never,
    {
      startAgentSession(_call: unknown, cb: sendUnaryData<AgentSession>) {
        calls.push("start");
        cb(null, session("s-1"));
      },
      getAgentSession(call: { request: GetAgentSessionRequest }, cb: sendUnaryData<AgentSession>) {
        calls.push("get");
        cb(null, session(call.request.sessionId));
      },
      sendToAgent(_call: unknown, cb: sendUnaryData<unknown>) {
        calls.push("send");
        append({ turnStarted: {} });
        cb(null, { turn: 1, delivery: AgentDelivery.AGENT_DELIVERY_STARTED });
      },
      interruptAgent(_call: unknown, cb: sendUnaryData<unknown>) {
        calls.push("interrupt");
        cb(null, { turn: 1 });
      },
      closeAgentSession(_call: unknown, cb: sendUnaryData<unknown>) {
        calls.push("close");
        cb(null, {});
      },
      agentEvents(call: ServerWritableStream<AgentEventsRequest, AgentEvent>) {
        const { vmId, sessionId, afterSeq, follow } = call.request;
        calls.push(`events after ${afterSeq}`);
        if (vmId === "forgetful") {
          call.emit("error", {
            code: status.NOT_FOUND,
            details: `no session "${sessionId}" on this machine`,
          });
          return;
        }
        for (const event of log) if (event.seq > afterSeq) call.write(event);
        if (!follow) return call.end();
        followers.add(call);
        call.on("cancelled", () => followers.delete(call));
      },
    } as never,
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  return { server, port, calls, append };
}

/**
 * A TCP relay in front of `port` whose connections can go silent: nothing
 * passes either way any more and neither side is told (no FIN, no RST), as
 * when a NAT entry expires or a peer loses power. Connections made after
 * that work.
 */
async function startRelay(port: number) {
  const open: [net.Socket, net.Socket][] = [];
  const all: net.Socket[] = [];
  const relay = net.createServer((client) => {
    const upstream = net.connect(port, "127.0.0.1");
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on("error", () => {});
      all.push(socket);
    }
    open.push([client, upstream]);
  });
  await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
  return {
    port: (relay.address() as net.AddressInfo).port,
    goSilent() {
      for (const [client, upstream] of open.splice(0)) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close() {
      for (const socket of all) socket.destroy();
      relay.close();
    },
  };
}

/** A transport to `port` whose keepalive is short enough for a test. */
function quickKeepalive(port: number): Transport {
  return new Transport({
    creds: new Credentials({ token: "test-token", exchangeUrl: "https://example.invalid" }),
    explicitBaseURL: `http://127.0.0.1:${port}`,
    defaultBaseURL: `http://127.0.0.1:${port}`,
    timeoutMs: 5_000,
    maxRetries: 0,
    keepaliveTimeMs: 200,
    keepaliveTimeoutMs: 200,
  });
}

let running: Awaited<ReturnType<typeof startServer>> | undefined;
let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
let closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  relay?.close();
  relay = undefined;
  running?.server.forceShutdown();
  running = undefined;
});

describe("machines.agents over grpc-js: a not-found on the event stream", () => {
  const client = (port: number) => {
    const baseURL = `http://127.0.0.1:${port}`;
    const boxd = new Boxd({ token: "test-token", baseURL, maxRetries: 0 });
    closers.push(() => boxd.close());
    return boxd.machines.agents;
  };

  it("events() for a session the machine doesn't have rejects with NotFoundError", async () => {
    running = await startServer();
    const agents = client(running.port);
    for (const follow of [false, true]) {
      const seen: unknown[] = [];
      const err = await (async () => {
        for await (const ev of agents.events("forgetful", "s-9", { follow })) seen.push(ev);
      })().catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.message).toBe('no session "s-9" on this machine');
      expect(seen).toEqual([]);
    }
  });

  it("run() rejects with it, not with events that ended", async () => {
    running = await startServer();
    const agents = client(running.port);
    // A session it was given: left alone.
    const given = await agents
      .run("forgetful", { harness: "codex", text: "x", session: "s-9" })
      .catch((e) => e);
    expect(given).toBeInstanceOf(NotFoundError);
    expect(given.message).toBe('no session "s-9" on this machine');
    expect(running.calls).toEqual(["get", "send", "events after 0"]);
    // One it started: closed, and not followed again.
    running.calls.length = 0;
    const started = await agents.run("forgetful", { harness: "codex", text: "x" }).catch((e) => e);
    expect(started).toBeInstanceOf(NotFoundError);
    expect(started.message).toBe('no session "s-1" on this machine');
    expect(running.calls).toEqual(["start", "send", "events after 0", "close"]);
  });
});

describe("machines.agents over grpc-js: a path that goes silent", () => {
  it("a follow stream fails as a lost connection instead of waiting forever", async () => {
    running = await startServer();
    relay = await startRelay(running.port);
    const transport = quickKeepalive(relay.port);
    closers.push(() => transport.close());
    running.append({ turnStarted: {} });
    const events = new MachineAgents(transport).events("box", "s-1", { follow: true });
    closers.push(() => events.return(undefined));
    expect((await events.next()).value?.seq).toBe(1);
    relay.goSilent();
    // Nothing more comes and nothing says so: only the PING that isn't
    // answered ends the wait.
    const err = await events.next().catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
  }, 15_000);

  it("run() follows its turn again on a new connection, from the last event it saw", async () => {
    running = await startServer();
    relay = await startRelay(running.port);
    const { append, calls } = running;
    const transport = quickKeepalive(relay.port);
    closers.push(() => transport.close());
    const seen: string[] = [];
    const result = await new MachineAgents(transport).run("box", {
      harness: "codex",
      text: "fix it",
      onEvent: (ev) => {
        seen.push(ev.type);
        if (ev.type !== "turn.started") return;
        // The path dies under the stream; the turn goes on in the machine.
        relay!.goSilent();
        append({ message: { text: "Fixed." } });
        append({
          turnFinished: { reason: AgentFinishReason.AGENT_FINISH_REASON_DONE, error: "" },
        });
      },
    });
    expect([result.reason, result.reply, result.kept]).toEqual(["done", "Fixed.", false]);
    expect(seen).toEqual(["turn.started", "message", "turn.finished"]);
    expect(calls).toEqual(["start", "send", "events after 0", "events after 1", "close"]);
  }, 15_000);
});
