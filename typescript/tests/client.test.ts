import { describe, expect, it } from "bun:test";
import { Boxd } from "../src/index.js";
import { withRetries } from "../src/_retry.js";
import { GrpcStatus, fromGrpcError } from "../src/errors.js";
import { APIConnectionError, AuthenticationError, ConflictError, NotFoundError } from "../src/errors.js";

/**
 * A client that never touches the network: constructing the gRPC client does
 * not dial, and every test below supplies its own fake call.
 */
const inert = (opts: Record<string, unknown> = {}) =>
  new Boxd({ token: "dummy.token.value", baseURL: "http://127.0.0.1:1", ...opts });

/**
 * Retry policy is `withRetries` (`_retry.ts`), shared verbatim by both
 * transports (grpc-js and grpc-web/WS) — testing it directly
 * means these tests don't need a real network, a real transport, or a
 * grpc-js-shaped fake call at all.
 */
function failing(code: number, counter: { calls: number }) {
  return async () => {
    counter.calls++;
    throw fromGrpcError({ code, details: "nope", message: "nope" });
  };
}

describe("Boxd construction", () => {
  it("exposes every namespace", () => {
    const boxd = inert();
    for (const ns of [
      "machines",
      "snapshots",
      "disks",
      "env",
      "secrets",
      "orgs",
      "apiKeys",
      "account",
    ] as const) {
      expect(boxd[ns]).toBeDefined();
    }
  });

  it("nests the machine sub-namespaces one level deep", () => {
    const boxd = inert();
    expect(boxd.machines.files).toBeDefined();
    expect(boxd.machines.ports).toBeDefined();
    expect(boxd.machines.proxies).toBeDefined();
    expect(boxd.machines.checkpoints).toBeDefined();
  });

  it("spells the CRUD verb `delete`, never `del`", () => {
    const boxd = inert();
    const withDelete: Array<Record<string, unknown>> = [
      boxd.machines as never,
      boxd.snapshots as never,
      boxd.disks as never,
      boxd.env as never,
      boxd.secrets as never,
      boxd.apiKeys as never,
      boxd.machines.proxies as never,
      boxd.machines.checkpoints as never,
    ];
    for (const ns of withDelete) {
      expect(typeof ns["delete"]).toBe("function");
      expect(ns["del"]).toBeUndefined();
    }
  });

  it("takes no `environment` argument — one baseURL selects a cluster", () => {
    // A compile-time guarantee too; this asserts nothing leaked at runtime.
    expect(Object.keys(inert())).not.toContain("environment");
  });

  it("construction does not require credentials up front", () => {
    // Resolution is deferred to the first request, so this must not throw.
    expect(() => new Boxd({ baseURL: "http://127.0.0.1:1" })).not.toThrow();
  });
});

describe("retries", () => {
  it("unauthenticated is terminal — one attempt, no retry", async () => {
    const counter = { calls: 0 };
    await expect(
      withRetries(3, failing(GrpcStatus.UNAUTHENTICATED, counter)),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(counter.calls).toBe(1);
  });

  it("not-found is terminal too", async () => {
    const counter = { calls: 0 };
    await expect(withRetries(3, failing(GrpcStatus.NOT_FOUND, counter))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(counter.calls).toBe(1);
  });

  it("aborted (a conflict) is not retried as a connection failure", async () => {
    const counter = { calls: 0 };
    await expect(withRetries(3, failing(GrpcStatus.ABORTED, counter))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(counter.calls).toBe(1);
  });

  it("a timeout is not retried — the call may already have been applied", async () => {
    const counter = { calls: 0 };
    await expect(withRetries(3, failing(GrpcStatus.DEADLINE_EXCEEDED, counter))).rejects.toThrow();
    expect(counter.calls).toBe(1);
  });

  it("connection failures are retried maxRetries times", async () => {
    const counter = { calls: 0 };
    await expect(withRetries(2, failing(GrpcStatus.UNAVAILABLE, counter))).rejects.toBeInstanceOf(
      APIConnectionError,
    );
    expect(counter.calls).toBe(3); // initial + 2 retries
  });

  it("maxRetries: 0 disables retrying", async () => {
    const counter = { calls: 0 };
    await expect(withRetries(0, failing(GrpcStatus.UNAVAILABLE, counter))).rejects.toThrow();
    expect(counter.calls).toBe(1);
  });

  it("a retry that succeeds resolves normally", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw fromGrpcError({ code: GrpcStatus.UNAVAILABLE, message: "down" });
      return { ok: true };
    };
    expect(await withRetries(2, flaky)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe("lifecycle", () => {
  it("close() is idempotent", async () => {
    const boxd = inert();
    await boxd.close();
    await boxd.close();
  });

  it("supports `await using`", async () => {
    let disposed = 0;
    class Tracked extends Boxd {
      override async [Symbol.asyncDispose]() {
        disposed++;
        await super[Symbol.asyncDispose]();
      }
    }
    {
      await using boxd = new Tracked({ token: "t", baseURL: "http://127.0.0.1:1" });
      void boxd;
    }
    expect(disposed).toBe(1);
  });
});
