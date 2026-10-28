import { afterEach, describe, expect, it, mock } from "bun:test";
import { nodePlatform } from "../src/_platformNode.js";
import { Credentials, detectGateway } from "../src/auth.js";
import {
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  GrpcStatus,
  PermissionDeniedError,
  RateLimitError,
  isRetryable,
} from "../src/errors.js";

const originalFetch = globalThis.fetch;
const ENV_KEYS = ["BOXD_TOKEN", "BOXD_API_KEY", "BOXD_VM_ID", "BOXD_IDENTITY"] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

const EXCHANGE = "https://app.boxd.sh/api/v1/auth/token";

/** A fetch that answers the exchange endpoint and nothing else. */
function exchangeOk(token = "jwt-1", ttl = 3600) {
  return mock(async () =>
    new Response(JSON.stringify({ token, expires_at: Date.now() / 1000 + ttl }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("credential resolution order", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearEnv();
  });

  it("explicit token wins and is never exchanged", async () => {
    const fetchMock = exchangeOk();
    globalThis.fetch = fetchMock as never;
    process.env.BOXD_API_KEY = "bxd_env";
    const creds = new Credentials({ token: "fixed", apiKey: "bxd_x", exchangeUrl: EXCHANGE });
    expect(await creds.source()).toBe("token");
    expect(await creds.getToken()).toBe("fixed");
    expect(await creds.getToken()).toBe("fixed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explicit apiKey beats BOXD_TOKEN", async () => {
    globalThis.fetch = exchangeOk("from-key") as never;
    process.env.BOXD_TOKEN = "env-token";
    const creds = new Credentials({ apiKey: "bxd_x", exchangeUrl: EXCHANGE });
    expect(await creds.source()).toBe("apiKey");
    expect(await creds.getToken()).toBe("from-key");
  });

  it("BOXD_TOKEN beats BOXD_API_KEY", async () => {
    const fetchMock = exchangeOk();
    globalThis.fetch = fetchMock as never;
    process.env.BOXD_TOKEN = "env-token";
    process.env.BOXD_API_KEY = "bxd_env";
    const creds = new Credentials({ exchangeUrl: EXCHANGE });
    expect(await creds.source()).toBe("token");
    expect(await creds.getToken()).toBe("env-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("BOXD_API_KEY is the last credentialed rung", async () => {
    globalThis.fetch = exchangeOk("from-env-key") as never;
    process.env.BOXD_API_KEY = "bxd_env";
    const creds = new Credentials({ exchangeUrl: EXCHANGE });
    expect(await creds.source()).toBe("apiKey");
    expect(await creds.getToken()).toBe("from-env-key");
  });

  it("no credentials and not in a machine → AuthenticationError(missing_credentials)", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 404 })) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.grpcCode).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(err.reason).toBe("missing_credentials");
  });

  it("BOXD_VM_ID alone is not enough — the environment must also answer", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    // Nothing listening: every probe fails.
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile: nodePlatform.readFile });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.reason).toBe("missing_credentials");
  });

  it("no route table to find the adapter: the plain message, still asked again", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      throw new TypeError("connect ETIMEDOUT");
    }) as never;
    const noRoute = async (_p: string): Promise<Uint8Array> => {
      throw new Error("ENOENT");
    };
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile: noRoute });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.reason).toBe("missing_credentials");
    expect(err.message).not.toContain("metadata adapter at");
    expect(err.message).toContain("only inside a boxd machine");
    await creds.source().catch(() => {});
    expect(calls).toBe(2);
  });

  it("no hint in the environment: settled once, never probed", async () => {
    const fetchMock = mock(async () => new Response("", { status: 404 }));
    globalThis.fetch = fetchMock as never;
    const readFile = mock(async (_p: string) => new Uint8Array());
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const first = await creds.source().catch((e) => e);
    const second = await creds.source().catch((e) => e);
    expect(first).toBeInstanceOf(AuthenticationError);
    expect(second).toBe(first);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("in a machine without a file reader (the web entry) → names the Node entry, no probe", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    const fetchMock = mock(async () => new Response("", { status: 404 }));
    globalThis.fetch = fetchMock as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE });
    await expect(creds.source()).rejects.toThrow(AuthenticationError);
    await expect(creds.source()).rejects.toThrow(/inside a boxd machine needs the Node entry/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("in-machine auth needs no configuration and reports its own cluster", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          token: "vm-jwt",
          expires_at: Date.now() / 1000 + 900,
          api_url: "http://staging.example.com:9443",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as never;

    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile: nodePlatform.readFile });
    expect(await creds.source()).toBe("vm");
    expect(await creds.getToken()).toBe("vm-jwt");
    expect(await creds.clusterUrl()).toBe("http://staging.example.com:9443");
    // The session identity is relayed when present.
  });

  it("resolution happens once, not per call", async () => {
    process.env.BOXD_TOKEN = "env-token";
    const creds = new Credentials({ exchangeUrl: EXCHANGE });
    const [a, b] = await Promise.all([creds.source(), creds.source()]);
    expect(a).toBe("token");
    expect(b).toBe("token");
  });
});

describe("API-key exchange", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearEnv();
  });

  it("POSTs the key to the derived exchange URL", async () => {
    const fetchMock = exchangeOk();
    globalThis.fetch = fetchMock as never;
    const creds = new Credentials({ apiKey: "bxd_abc", exchangeUrl: EXCHANGE });
    expect(await creds.getToken()).toBe("jwt-1");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(EXCHANGE);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ api_key: "bxd_abc" });
  });

  it("401 → AuthenticationError(invalid_api_key)", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 401 })) as never;
    const creds = new Credentials({ apiKey: "bad", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.grpcCode).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(err.reason).toBe("invalid_api_key");
    expect(err.httpStatus).toBe(401);
    expect(isRetryable(err)).toBe(false);
  });

  it("unreachable exchange → APIConnectionError carrying the network error, retryable", async () => {
    const boom = new TypeError("fetch failed");
    globalThis.fetch = mock(async () => {
      throw boom;
    }) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err.cause).toBe(boom);
    expect(err.grpcCode).toBeUndefined();
    expect(err.reason).toBeUndefined();
    expect(err.message).toContain(EXCHANGE);
    expect(isRetryable(err)).toBe(true);
    // Not sticky: the next attempt exchanges again.
    globalThis.fetch = exchangeOk("jwt-later") as never;
    expect(await creds.getToken()).toBe("jwt-later");
  });

  it("5xx from the exchange → APIStatusError with the HTTP status", async () => {
    globalThis.fetch = mock(async () => new Response("upstream down", { status: 503 })) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err.httpStatus).toBe(503);
    expect(err.grpcCode).toBeUndefined();
    expect(err.reason).toBeUndefined();
    expect(err.message).toContain("503");
  });

  it("403 (the account may not use the API) → PermissionDeniedError, not AuthenticationError", async () => {
    globalThis.fetch = mock(async () => new Response("account disabled", { status: 403 })) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err.grpcCode).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(err.httpStatus).toBe(403);
    expect(err.reason).toBeUndefined();
    expect(err.message).toContain("account disabled");
    expect(isRetryable(err)).toBe(false);
  });

  it("any other refusal but 401/403/429 is not an AuthenticationError either", async () => {
    globalThis.fetch = mock(async () => new Response("bad request", { status: 400 })) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.httpStatus).toBe(400);
  });

  it("429 twice → RateLimitError, after one Retry-After wait", async () => {
    const fetchMock = mock(
      async () => new Response("", { status: 429, headers: { "retry-after": "0" } }),
    );
    globalThis.fetch = fetchMock as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.grpcCode).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
    expect(err.httpStatus).toBe(429);
    expect(err.reason).toBeUndefined();
    // One retry: the initial call plus one after honouring Retry-After.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("429 then 200 → recovers without throwing", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(
        JSON.stringify({ token: "jwt-after-429", expires_at: Date.now() / 1000 + 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    expect(await creds.getToken()).toBe("jwt-after-429");
  });

  it("malformed response → APIStatusError, not AuthenticationError", async () => {
    for (const body of [JSON.stringify({ token: "jwt" }), "<html>not json</html>"]) {
      globalThis.fetch = mock(
        async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      ) as never;
      const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
      const err = await creds.getToken().catch((e) => e);
      expect(err).toBeInstanceOf(APIStatusError);
      expect(err).not.toBeInstanceOf(AuthenticationError);
      expect(err.httpStatus).toBe(200);
      expect(err.grpcCode).toBeUndefined();
      expect(err.reason).toBeUndefined();
      expect(err.message).toContain("malformed");
    }
  });

  it("re-exchanges inside the refresh window", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      // First token expires in 100s — inside the 300s refresh skew.
      const ttl = calls === 1 ? 100 : 3600;
      return new Response(
        JSON.stringify({ token: `jwt-${calls}`, expires_at: Date.now() / 1000 + ttl }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    expect(await creds.getToken()).toBe("jwt-1");
    expect(await creds.getToken()).toBe("jwt-2");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent refreshes into one exchange", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ token: "jwt-1", expires_at: Date.now() / 1000 + 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as never;
    const creds = new Credentials({ apiKey: "x", exchangeUrl: EXCHANGE });
    const results = await Promise.all([
      creds.getToken(),
      creds.getToken(),
      creds.getToken(),
      creds.getToken(),
    ]);
    expect(results).toEqual(["jwt-1", "jwt-1", "jwt-1", "jwt-1"]);
    expect(calls).toBe(1);
  });
});

describe("in-machine credential failures", () => {
  // /proc/net/route with a default route via 192.0.2.1 (hex, little-endian).
  const ROUTE = "Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010200C0\t0003\n";
  const readFile = async (_p: string) => new TextEncoder().encode(ROUTE);
  const vmToken = (ttl: number, token = "vm-jwt") =>
    new Response(JSON.stringify({ token, expires_at: Date.now() / 1000 + ttl }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearEnv();
  });

  it("an adapter that stops answering on renewal → APIConnectionError, retryable", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    let calls = 0;
    const boom = new TypeError("connect ECONNREFUSED");
    globalThis.fetch = mock(async () => {
      calls++;
      // The machine answers once (it is one); that credential is already
      // inside the re-mint skew, so the first token request renews it.
      if (calls === 1) return vmToken(30);
      throw boom;
    }) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    expect(await creds.source()).toBe("vm");
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.cause).toBe(boom);
    expect(err.message).toContain("http://192.0.2.1:9002");
    expect(isRetryable(err)).toBe(true);
  });

  it("an adapter that answers with an error → APIStatusError; resolution is asked again", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) return new Response("internal error", { status: 500 });
      return vmToken(900, "vm-jwt-2");
    }) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const err = await creds.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.httpStatus).toBe(500);
    expect(await creds.getToken()).toBe("vm-jwt-2");
  });

  it("an adapter that doesn't answer on first contact → missing_credentials, asked again next call", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    let calls = 0;
    const boom = new TypeError("connect ECONNREFUSED");
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) throw boom;
      return vmToken(900, "vm-jwt-later");
    }) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const err = await creds.source().catch((e) => e);
    // An isolated machine looks exactly like this, so it stays terminal...
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.reason).toBe("missing_credentials");
    expect(isRetryable(err)).toBe(false);
    expect(err.message).toContain("metadata adapter at http://192.0.2.1:9002 did not answer");
    expect(err.message).toContain("isolated machines have none");
    expect(err.message).toContain("BOXD_API_KEY / BOXD_TOKEN");
    expect(err.cause).toBeInstanceOf(APIConnectionError);
    expect(err.cause.cause).toBe(boom);
    // ...but isn't remembered: the next call probes again.
    expect(await creds.source()).toBe("vm");
    expect(await creds.getToken()).toBe("vm-jwt-later");
    expect(calls).toBe(2);
  });

  it("403 from the adapter → PermissionDeniedError", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    globalThis.fetch = mock(async () => new Response("account disabled", { status: 403 })) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err.grpcCode).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(err.httpStatus).toBe(403);
    expect(err.reason).toBeUndefined();
    expect(err.message).toContain("account disabled");
  });

  it("429 from the adapter → RateLimitError", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    globalThis.fetch = mock(async () => new Response("slow down", { status: 429 })) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.grpcCode).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
    expect(err.httpStatus).toBe(429);
    expect(err.reason).toBeUndefined();
    expect(isRetryable(err)).toBe(false);
  });

  it("a malformed credential from the adapter → APIStatusError", async () => {
    process.env.BOXD_VM_ID = "vm-123";
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ token: 7 }), { status: 200 }),
    ) as never;
    const creds = new Credentials({ exchangeUrl: EXCHANGE, readFile });
    const err = await creds.source().catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.httpStatus).toBe(200);
  });
});

describe("detectGateway", () => {
  it("returns a dotted quad, or nothing where there is no route table", async () => {
    const gw = await detectGateway(nodePlatform.readFile);
    if (gw !== undefined) expect(gw).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });
});
