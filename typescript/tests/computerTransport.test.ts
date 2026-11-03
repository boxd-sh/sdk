/**
 * `machines.computer` over the default (grpc-js) transport against a real
 * in-process grpc-js server: a click is never repeated after a connection
 * failure while a screenshot is, and an action that takes long by design
 * (a wait) gets a deadline to match. The grpc-web twin of these is in
 * `transportWeb.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Server, ServerCredentials, status, type sendUnaryData } from "@grpc/grpc-js";
import {
  BoxdApiService,
  type ComputerActionRequest,
  type ComputerActionResponse,
} from "../src/_generated/api.js";
import { Transport } from "../src/_transport.js";
import { Credentials } from "../src/auth.js";
import { MachineComputer } from "../src/computer.js";
import { APIConnectionError, APIStatusError } from "../src/errors.js";

async function startServer(opts: { timeoutMs: number; maxRetries: number }) {
  const seen = { calls: 0 };
  const server = new Server();
  server.addService({ computerAction: BoxdApiService.computerAction } as never, {
    async computerAction(
      call: { request: ComputerActionRequest },
      cb: sendUnaryData<ComputerActionResponse>,
    ) {
      seen.calls++;
      const r = call.request;
      if (r.vmId === "agent-asleep" && seen.calls === 1) {
        return cb(
          { code: status.UNAVAILABLE, details: "cannot connect to VM agent: agent did not answer within 15s" },
          null,
        );
      }
      if (r.vmId === "desktop-down") {
        return cb({ code: status.UNAVAILABLE, details: "the desktop service did not start" }, null);
      }
      if (r.key?.keys === "Foo") {
        return cb({ code: status.INVALID_ARGUMENT, details: "No such key name 'Foo'" }, null);
      }
      if (r.wait) await new Promise((done) => setTimeout(done, r.wait!.ms));
      cb(null, {
        screenWidth: 1600,
        screenHeight: 900,
        cursor: { x: 1, y: 2 },
        screenshot:
          r.screenshot || r.returnScreenshot
            ? { data: new Uint8Array([9, 9]), mimeType: "image/png", width: 1280, height: 720 }
            : undefined,
      });
    },
  } as never);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  const transport = new Transport({
    creds: new Credentials({ token: "test-token", exchangeUrl: "https://example.invalid" }),
    explicitBaseURL: `http://127.0.0.1:${port}`,
    defaultBaseURL: `http://127.0.0.1:${port}`,
    ...opts,
  });
  return { server, transport, seen };
}

let running: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(() => {
  running?.transport.close();
  running?.server.forceShutdown();
  running = undefined;
});

describe("machines.computer over grpc-js", () => {
  it("a screenshot round-trips", async () => {
    running = await startServer({ timeoutMs: 5_000, maxRetries: 0 });
    const r = await new MachineComputer(running.transport).screenshot("m");
    expect(r.screenshot.data).toEqual(new Uint8Array([9, 9]));
    expect([r.screenWidth, r.screenHeight, r.screenshot.width, r.screenshot.height]).toEqual([1600, 900, 1280, 720]);
  });

  it("repeats a screenshot after a connection failure, never a click", async () => {
    running = await startServer({ timeoutMs: 5_000, maxRetries: 2 });
    const computer = new MachineComputer(running.transport);
    await expect(computer.click("desktop-down", { x: 1, y: 1 })).rejects.toBeInstanceOf(APIConnectionError);
    expect(running.seen.calls).toBe(1);
    await expect(computer.screenshot("desktop-down")).rejects.toBeInstanceOf(APIConnectionError);
    expect(running.seen.calls).toBe(4);
  });

  it("sends a click again when the server couldn't reach the machine's agent", async () => {
    running = await startServer({ timeoutMs: 5_000, maxRetries: 0 });
    const r = await new MachineComputer(running.transport).click("agent-asleep", { x: 1, y: 1 });
    expect(r.cursor).toEqual({ x: 1, y: 2 });
    expect(running.seen.calls).toBe(2);
  });

  it("sends a click again when no connection to the server was made", async () => {
    const transport = new Transport({
      creds: new Credentials({ token: "test-token", exchangeUrl: "https://example.invalid" }),
      // Nothing listens on port 1.
      explicitBaseURL: "http://127.0.0.1:1",
      defaultBaseURL: "http://127.0.0.1:1",
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const started = Date.now();
    const err = await new MachineComputer(transport).click("m").catch((e) => e);
    transport.close();
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toMatch(/^No connection established/);
    // Two backoffs (1 s, 3 s) before giving up.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
  });

  it("a refused action carries the server's message", async () => {
    running = await startServer({ timeoutMs: 5_000, maxRetries: 2 });
    const err = await new MachineComputer(running.transport).key("m", "Foo").catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.message).toBe("No such key name 'Foo'");
    expect(running.seen.calls).toBe(1);
  });

  it("a wait longer than the client's timeout still gets its answer", async () => {
    running = await startServer({ timeoutMs: 200, maxRetries: 0 });
    const r = await new MachineComputer(running.transport).wait("m", 400);
    expect(r.cursor).toEqual({ x: 1, y: 2 });
  });
});
