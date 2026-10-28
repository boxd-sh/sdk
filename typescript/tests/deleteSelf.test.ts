/**
 * `machines.deleteSelf()`: posts the confirmation to the in-machine
 * metadata adapter, never to the public API, and surfaces its refusals.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Transport } from "../src/_rpc.js";
import { APIConnectionError, AuthenticationError, BoxdError } from "../src/errors.js";
import { Machines } from "../src/index.js";

// /proc/net/route with a default route via 192.0.2.1 (hex, little-endian).
const ROUTE = "Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010200C0\t0003\n";
const readFile = async (_p: string) => new TextEncoder().encode(ROUTE);
// Any RPC through the public API would be a bug here.
const noTransport = new Proxy({}, { get: () => () => { throw new Error("public API must not be used"); } }) as unknown as Transport;

const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];
const stubFetch = (status: number, body: unknown) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
};

describe("machines.deleteSelf", () => {
  beforeEach(() => {
    calls = [];
    process.env.BOXD_VM_NAME = "job-7";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BOXD_VM_NAME;
  });

  it("posts the confirmation to the metadata adapter and resolves before teardown", async () => {
    stubFetch(200, { name: "job-7", vm_id: "vm-7", status: "destroying", destroy_in_secs: 2 });
    const r = await new Machines(noTransport, { readFile }).deleteSelf({ confirm: "job-7" });
    expect(r).toEqual({ id: "vm-7", name: "job-7", deletesInSecs: 2 });
    expect(calls).toEqual([{ url: "http://192.0.2.1:9002/v1/self/destroy", body: { confirm_name: "job-7" } }]);
  });

  it("throws the adapter's refusal", async () => {
    stubFetch(400, { error: "self-deletion refused: confirm_name 'nope' is not this machine ('job-7')" });
    const err = await new Machines(noTransport, { readFile }).deleteSelf({ confirm: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(BoxdError);
    expect(String(err.message)).toContain("is not this machine");
  });

  it("an unreachable adapter is an APIConnectionError, not a generic failure", async () => {
    const boom = new TypeError("fetch failed");
    globalThis.fetch = (async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const err = await new Machines(noTransport, { readFile }).deleteSelf({ confirm: "job-7" }).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.cause).toBe(boom);
  });

  it("needs a name, and makes no request without one", async () => {
    stubFetch(200, {});
    for (const confirm of ["", "   "]) {
      const err = await new Machines(noTransport, { readFile }).deleteSelf({ confirm }).catch((e) => e);
      expect(String(err.message)).toContain("needs this machine's name");
    }
    expect(calls).toEqual([]);
  });

  it("outside a machine (or on the web entry) says where it works", async () => {
    stubFetch(200, {});
    delete process.env.BOXD_VM_NAME;
    const off = await new Machines(noTransport, { readFile }).deleteSelf({ confirm: "job-7" }).catch((e) => e);
    expect(off).toBeInstanceOf(AuthenticationError);
    expect(off.reason).toBe("missing_credentials");
    expect(String(off.message)).toContain("only works inside a boxd machine");
    process.env.BOXD_VM_NAME = "job-7";
    const web = await new Machines(noTransport, {}).deleteSelf({ confirm: "job-7" }).catch((e) => e);
    expect(web).toBeInstanceOf(AuthenticationError);
    expect(calls).toEqual([]);
  });
});
