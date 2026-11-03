/**
 * An API key sent as the bearer itself, with no exchange first, and the
 * fallback to the exchange when a server refuses it as one from before raw
 * keys does ("invalid token: …"). Both transports, each against a local
 * server that checks the bearer the way an old or a new server would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Metadata, Server, ServerCredentials, status, type sendUnaryData } from "@grpc/grpc-js";
import { BoxdApiService } from "../src/_generated/api.js";
import {
  BoxdApiDefinition,
  FsListChunk,
  FsListRequest,
  GetVmResponse,
  WhoamiResponse,
} from "../src/_generated/definitions.js";
import { Transport } from "../src/_transport.js";
import { WebTransport } from "../src/_transportWeb.js";
import { Credentials, refusesRawKey } from "../src/auth.js";
import {
  APIConnectionError,
  AuthenticationError,
  GrpcStatus,
  PermissionDeniedError,
} from "../src/errors.js";
import type { ReadableCall } from "../src/_rpc.js";
import { isLoopbackHost, rawKeyAllowed } from "../src/utils.js";

const KEY = "bxd_test-key";
const JWT = "jwt-1";
const EXCHANGE = "https://app.example.com/api/v1/auth/token";
const OLD_REFUSAL = "invalid token: InvalidToken";

const originalFetch = globalThis.fetch;
let exchanges = 0;

/** Answer the exchange; pass everything else (the grpc-web server) through. */
function mockExchange(): void {
  exchanges = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === EXCHANGE) {
      exchanges++;
      return new Response(JSON.stringify({ token: JWT, expires_at: Date.now() / 1000 + 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BOXD_TOKEN;
  delete process.env.BOXD_API_KEY;
});

/** What a server makes of a bearer: an old one takes only sessions. */
type Mode = "old" | "new";
function refusal(mode: Mode, bearer: string | undefined): string | undefined {
  if (bearer === `Bearer ${JWT}`) return undefined;
  if (bearer === `Bearer ${KEY}`) return mode === "old" ? OLD_REFUSAL : undefined;
  return "API key not recognized";
}

function collect<T>(call: ReadableCall<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const got: T[] = [];
    call.on("data", (m) => got.push(m));
    call.on("error", reject);
    call.on("end", () => resolve(got));
  });
}

describe("credentials", () => {
  it("an API key goes as itself over TLS or loopback, exchanged otherwise", async () => {
    mockExchange();
    const creds = new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE });
    expect(await creds.bearer(true)).toEqual({ token: KEY, rawKey: true });
    expect(exchanges).toBe(0);
    expect(await creds.bearer(false)).toEqual({ token: JWT, rawKey: false });
    expect(exchanges).toBe(1);
    // A refusal sticks for the client's life.
    creds.rawKeyRefused();
    expect(await creds.bearer(true)).toEqual({ token: JWT, rawKey: false });
    expect(exchanges).toBe(1);
  });

  it("a token is never replaced by anything", async () => {
    const creds = new Credentials({ token: "fixed", exchangeUrl: EXCHANGE });
    expect(await creds.bearer(true)).toEqual({ token: "fixed", rawKey: false });
  });

  it("only an old server's answer, or the plaintext one, means exchange", () => {
    const unauth = (msg: string) => new AuthenticationError(msg, GrpcStatus.UNAUTHENTICATED);
    expect(refusesRawKey(unauth(OLD_REFUSAL))).toBe(true);
    expect(refusesRawKey(unauth("API keys are accepted over TLS only: use https://"))).toBe(true);
    expect(refusesRawKey(unauth("API key not recognized"))).toBe(false);
    expect(refusesRawKey(unauth("API key expired"))).toBe(false);
    expect(refusesRawKey(new PermissionDeniedError(OLD_REFUSAL, GrpcStatus.PERMISSION_DENIED))).toBe(
      false,
    );
  });

  it("loopback and TLS endpoints", () => {
    expect(isLoopbackHost("localhost:9443")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:9443")).toBe(true);
    expect(isLoopbackHost("[::1]:9443")).toBe(true);
    expect(isLoopbackHost("192.0.2.1:9443")).toBe(false);
    expect(isLoopbackHost("localhost.example.com:9443")).toBe(false);
    expect(rawKeyAllowed("https://api.example.com:9443")).toBe(true);
    expect(rawKeyAllowed("api.example.com:9443")).toBe(true);
    expect(rawKeyAllowed("http://127.0.0.1:9443")).toBe(true);
    expect(rawKeyAllowed("http://api.example.com:9443")).toBe(false);
  });
});

// ── grpc-js ────────────────────────────────────────────────────────────

async function startGrpc(mode: Mode) {
  const seen: { method: string; bearer: string | undefined }[] = [];
  const check = (method: string, md: Metadata): string | undefined => {
    const bearer = md.get("authorization")[0] as string | undefined;
    seen.push({ method, bearer });
    return refusal(mode, bearer);
  };
  const server = new Server();
  server.addService(
    { whoami: BoxdApiService.whoami, getVm: BoxdApiService.getVm, fsList: BoxdApiService.fsList } as never,
    {
      whoami(call: { metadata: Metadata }, cb: sendUnaryData<WhoamiResponse>) {
        const refused = check("whoami", call.metadata);
        if (refused) return cb({ code: status.UNAUTHENTICATED, details: refused }, null);
        cb(null, WhoamiResponse.fromPartial({ userId: "alice" }));
      },
      getVm(call: { metadata: Metadata }, cb: sendUnaryData<GetVmResponse>) {
        const refused = check("getVm", call.metadata);
        if (refused) return cb({ code: status.UNAUTHENTICATED, details: refused }, null);
        cb(null, GetVmResponse.fromPartial({ name: "alpha" }));
      },
      fsList(call: {
        metadata: Metadata;
        write(m: FsListChunk): void;
        end(): void;
        emit(e: string, err: unknown): void;
      }) {
        const refused = check("fsList", call.metadata);
        if (refused) {
          call.emit("error", { code: status.UNAUTHENTICATED, details: refused, metadata: new Metadata() });
          return;
        }
        call.write(FsListChunk.fromPartial({ entries: [] }));
        call.end();
      },
    } as never,
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  return { server, transport: grpcTransport(port, KEY), seen, port };
}

function grpcTransport(port: number, apiKey: string): Transport {
  return new Transport({
    creds: new Credentials({ apiKey, exchangeUrl: EXCHANGE }),
    explicitBaseURL: `http://127.0.0.1:${port}`,
    defaultBaseURL: `http://127.0.0.1:${port}`,
    timeoutMs: 5_000,
    maxRetries: 0,
  });
}

let grpcServer: Awaited<ReturnType<typeof startGrpc>> | undefined;
afterEach(() => {
  grpcServer?.transport.close();
  grpcServer?.server.forceShutdown();
  grpcServer = undefined;
});

const getVm = BoxdApiDefinition.methods.getVm;
const fsList = BoxdApiDefinition.methods.fsList;
const listReq = FsListRequest.fromPartial({ vmId: "m1", path: new TextEncoder().encode("/") });

describe("grpc-js transport", () => {
  it("a server that takes keys gets the key itself, and no exchange happens", async () => {
    mockExchange();
    grpcServer = await startGrpc("new");
    const t = grpcServer.transport;
    expect((await t.unary(getVm, { vmId: "alpha" })).name).toBe("alpha");
    await collect(t.serverStream(fsList, listReq));
    expect(exchanges).toBe(0);
    expect(grpcServer.seen.map((s) => s.bearer)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  it("an old server's refusal: the call runs again on the exchanged session, which sticks", async () => {
    mockExchange();
    grpcServer = await startGrpc("old");
    const t = grpcServer.transport;
    expect((await t.unary(getVm, { vmId: "alpha" })).name).toBe("alpha");
    expect((await t.unary(getVm, { vmId: "alpha" })).name).toBe("alpha");
    expect(exchanges).toBe(1);
    expect(grpcServer.seen.map((s) => s.bearer)).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${JWT}`,
      `Bearer ${JWT}`,
    ]);
  });

  it("a stream first: a Whoami settles the bearer, the stream is never refused", async () => {
    mockExchange();
    grpcServer = await startGrpc("old");
    await collect(grpcServer.transport.serverStream(fsList, listReq));
    expect(grpcServer.seen).toEqual([
      { method: "whoami", bearer: `Bearer ${KEY}` },
      { method: "whoami", bearer: `Bearer ${JWT}` },
      { method: "fsList", bearer: `Bearer ${JWT}` },
    ]);
  });

  it("a stream first on a server that takes keys: one Whoami, then the key", async () => {
    mockExchange();
    grpcServer = await startGrpc("new");
    const t = grpcServer.transport;
    await collect(t.serverStream(fsList, listReq));
    await collect(t.serverStream(fsList, listReq));
    expect(exchanges).toBe(0);
    expect(grpcServer.seen.map((s) => s.method)).toEqual(["whoami", "fsList", "fsList"]);
  });

  it("a region's derived name: an old server's refusal is thrown, not exchanged", async () => {
    mockExchange();
    grpcServer = await startGrpc("old");
    const creds = new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE });
    const base = `http://127.0.0.1:${grpcServer.port}`;
    const t = new Transport({
      creds,
      explicitBaseURL: base,
      defaultBaseURL: base,
      timeoutMs: 5_000,
      maxRetries: 2,
      derived: true,
    });
    const err = await t.unary(getVm, { vmId: "alpha" }).catch((e) => e);
    t.close();
    // The router asks home instead, and every endpoint exchanges from now on.
    expect(refusesRawKey(err)).toBe(true);
    expect(exchanges).toBe(0);
    expect(grpcServer.seen.map((s) => s.bearer)).toEqual([`Bearer ${KEY}`]);
    expect(await creds.sendsRawKey(true)).toBe(false);
  });

  it("a region's derived name that refuses connections is tried once", async () => {
    const t = new Transport({
      creds: new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE }),
      explicitBaseURL: "http://127.0.0.1:1",
      defaultBaseURL: "http://127.0.0.1:1",
      timeoutMs: 5_000,
      maxRetries: 2,
      derived: true,
    });
    const started = Date.now();
    const err = await t.unary(getVm, { vmId: "alpha" }).catch((e) => e);
    t.close();
    expect(err).toBeInstanceOf(APIConnectionError);
    // Two retries would wait 250 + 500 ms between the tries.
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("a key the server doesn't know is refused, not exchanged", async () => {
    mockExchange();
    grpcServer = await startGrpc("new");
    const t = grpcTransport(grpcServer.port, "bxd_unknown");
    const err = await t.unary(getVm, { vmId: "alpha" }).catch((e) => e);
    t.close();
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).toContain("not recognized");
    expect(exchanges).toBe(0);
  });
});

// ── grpc-web ───────────────────────────────────────────────────────────

function frame(payload: Uint8Array, flag = 0): Uint8Array {
  const f = new Uint8Array(5 + payload.length);
  f[0] = flag;
  new DataView(f.buffer).setUint32(1, payload.length, false);
  f.set(payload, 5);
  return f;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function ok(...messages: Uint8Array[]): Response {
  const trailer = frame(new TextEncoder().encode("grpc-status:0\r\ngrpc-message:\r\n"), 0x80);
  return new Response(concat(...messages.map((m) => frame(m)), trailer), {
    headers: { "content-type": "application/grpc-web+proto" },
  });
}
function refused(message: string): Response {
  return new Response(null, {
    status: 200,
    headers: { "grpc-status": "16", "grpc-message": encodeURIComponent(message) },
  });
}

function startWeb(mode: Mode) {
  const seen: { method: string; bearer: string | undefined }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop()!;
      const bearer = req.headers.get("authorization") ?? undefined;
      seen.push({ method, bearer });
      await req.arrayBuffer();
      const why = refusal(mode, bearer);
      if (why) return refused(why);
      switch (method) {
        case "Whoami":
          return ok(WhoamiResponse.encode(WhoamiResponse.fromPartial({ userId: "alice" })).finish());
        case "GetVm":
          return ok(GetVmResponse.encode(GetVmResponse.fromPartial({ name: "alpha" })).finish());
        case "FsList":
          return ok(FsListChunk.encode(FsListChunk.fromPartial({ entries: [] })).finish());
        default:
          return refused(`unimplemented: ${method}`);
      }
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const transport = new WebTransport({
    creds: new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE }),
    explicitBaseURL: origin,
    defaultBaseURL: origin,
    timeoutMs: 5_000,
    maxRetries: 0,
  });
  return { stop: () => server.stop(true), transport, seen, origin };
}

let web: ReturnType<typeof startWeb> | undefined;
afterEach(() => {
  web?.stop();
  web = undefined;
});

describe("grpc-web transport", () => {
  it("a server that takes keys gets the key itself", async () => {
    mockExchange();
    web = startWeb("new");
    expect((await web.transport.unary(getVm, { vmId: "alpha" })).name).toBe("alpha");
    await collect(web.transport.serverStream(fsList, listReq));
    expect(exchanges).toBe(0);
    expect(web.seen.map((s) => s.bearer)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  it("an old server's refusal falls back to the exchange, once", async () => {
    mockExchange();
    web = startWeb("old");
    expect((await web.transport.unary(getVm, { vmId: "alpha" })).name).toBe("alpha");
    await collect(web.transport.serverStream(fsList, listReq));
    expect(exchanges).toBe(1);
    expect(web.seen).toEqual([
      { method: "GetVm", bearer: `Bearer ${KEY}` },
      { method: "GetVm", bearer: `Bearer ${JWT}` },
      { method: "FsList", bearer: `Bearer ${JWT}` },
    ]);
  });

  it("a region's derived name: an old server's refusal is thrown, not exchanged", async () => {
    mockExchange();
    web = startWeb("old");
    const creds = new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE });
    const t = new WebTransport({
      creds,
      explicitBaseURL: web.origin,
      defaultBaseURL: web.origin,
      timeoutMs: 5_000,
      maxRetries: 2,
      derived: true,
    });
    const err = await t.unary(getVm, { vmId: "alpha" }).catch((e) => e);
    expect(refusesRawKey(err)).toBe(true);
    expect(exchanges).toBe(0);
    expect(web.seen).toEqual([{ method: "GetVm", bearer: `Bearer ${KEY}` }]);
    expect(await creds.sendsRawKey(true)).toBe(false);
  });

  it("a stream first: a Whoami settles the bearer", async () => {
    mockExchange();
    web = startWeb("old");
    await collect(web.transport.serverStream(fsList, listReq));
    expect(web.seen).toEqual([
      { method: "Whoami", bearer: `Bearer ${KEY}` },
      { method: "Whoami", bearer: `Bearer ${JWT}` },
      { method: "FsList", bearer: `Bearer ${JWT}` },
    ]);
  });
});
