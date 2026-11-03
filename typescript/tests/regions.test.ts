/**
 * Regions: which endpoint each call goes to, the endpoint cache,
 * `list({ region: "all" })`, and the hint a not-found carries when the name
 * is in another region.
 *
 * The router (`_regions.ts`) is driven over fake endpoints, one per base URL,
 * so this pins what would be sent where without a cluster. The last blocks
 * run the web entry against local grpc-web servers and a scripted `fetch`, to
 * pin the wiring (one credential, a region's endpoint looked up when first
 * dialled, or derived from home's with an API key).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  GetVmRequest,
  GetVmResponse,
  ListRegionsRequest,
  ListRegionsResponse,
  SetOrgMachineDefaultsRequest,
  type FindElsewhereResponse,
  type Region as WireRegion,
} from "../src/_generated/definitions.js";
import { RegionRouter } from "../src/_regions.js";
import type { DuplexCall, MethodDef, Transport } from "../src/_rpc.js";
import { Transport as NodeTransport } from "../src/_transport.js";
import { Credentials } from "../src/auth.js";
import { directRouting } from "../src/client.js";
import {
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  BoxdError,
  MachineFileNotFoundError,
  NotFoundError,
  RegionNotEnabledError,
} from "../src/errors.js";
import { Boxd, Disks, Machines, Orgs, Regions, Snapshots } from "../src/index.js";
import { consoleBaseUrl, regionBaseURL } from "../src/utils.js";
import { Boxd as WebBoxd } from "../src/web.js";

const HOME = "https://boxd.example.com:9443";
const NYC = "https://nyc.boxd.example.com:9443";
const LON = "https://lon.boxd.example.com:9443";
const SEA = "https://sea.boxd.example.com:9443";

// ── the fake ──────────────────────────────────────────────────────────────

type Answer = unknown;
type Answers = Record<string, Answer>;

/** One scripted call: its chunks (an array), or the error it fails with. */
function scripted(answer: Promise<unknown>): DuplexCall<unknown, unknown> {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const emit = (event: string, arg?: unknown) => {
    for (const fn of handlers[event] ?? []) fn(arg);
  };
  void answer.then(
    (chunks) => {
      for (const c of (chunks as unknown[] | undefined) ?? []) emit("data", c);
      emit("end");
    },
    (err) => emit("error", err),
  );
  return {
    on(event: string, fn: (arg?: unknown) => void) {
      (handlers[event] ??= []).push(fn);
    },
    write() {},
    end() {},
    cancel() {},
  } as DuplexCall<unknown, unknown>;
}

/**
 * A transport for one base URL, which it learns from `where` the way a real
 * one does (a region's is looked up when first dialled). `book` maps a URL
 * to its answers: per method, a response, an `Error` to throw, a function of
 * the request, or an array of those (one per call, the last one repeating).
 */
class Endpoint implements Transport {
  readonly calls: Array<{ method: string; req: Record<string, unknown> }> = [];
  readonly supportsInteractiveExec = true;
  url?: string;
  closed = false;

  constructor(
    private readonly where: () => Promise<string>,
    private readonly book: Record<string, Answers>,
  ) {}

  async #answer(method: string, req: unknown): Promise<unknown> {
    this.url = await this.where();
    this.calls.push({ method, req: req as Record<string, unknown> });
    const answers = this.book[this.url] ?? {};
    let answer = answers[method];
    if (Array.isArray(answer) && !method.startsWith("Stream") && method !== "Exec") {
      answer = answer.length > 1 ? answer.shift() : answer[0];
    }
    if (typeof answer === "function") answer = (answer as (r: unknown) => unknown)(req);
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    return this.#answer(method.name, req) as Promise<Resp>;
  }
  serverStream<Req>(method: MethodDef<Req, unknown>, req: Req) {
    return scripted(this.#answer(method.name, req));
  }
  duplex<Req>(method: MethodDef<Req, unknown>) {
    return scripted(this.#answer(method.name, {}));
  }
  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
  ) {
    this.#answer(method.name, {}).then(
      (r) => callback(null, r as Resp),
      (e) => callback(e, undefined as never),
    );
    return { write() {}, end() {} };
  }
  async consoleOrigin(): Promise<string> {
    return consoleBaseUrl(await this.where());
  }
  close(): void {
    this.closed = true;
  }
}

function make(book: Record<string, Answers>, region?: string) {
  const home = new Endpoint(async () => HOME, book);
  const made: Endpoint[] = [];
  const router = new RegionRouter(home, {
    region,
    connect: (where) => {
      const endpoint = new Endpoint(where, book);
      made.push(endpoint);
      return endpoint;
    },
  });
  return { router, home, made, at: (url: string) => made.find((e) => e.url === url) };
}

// ── fixtures ──────────────────────────────────────────────────────────────

function region(fields: Partial<WireRegion>): WireRegion {
  return {
    id: "",
    name: "",
    zone: "",
    apiEndpoint: "",
    consoleEndpoint: "",
    latitude: 0,
    longitude: 0,
    home: false,
    orgState: "available",
    ...fields,
  };
}

function listing(
  opts: { nyc?: string; lon?: string; thisRegion?: string; extra?: WireRegion[] } = {},
): ListRegionsResponse {
  return {
    regions: [
      region({
        id: "fra",
        name: "Frankfurt",
        apiEndpoint: HOME,
        consoleEndpoint: "https://app.boxd.example.com",
        home: true,
        orgState: "enabled",
      }),
      region({
        id: "nyc",
        name: "New York",
        apiEndpoint: NYC,
        consoleEndpoint: "https://app.nyc.boxd.example.com",
        orgState: opts.nyc ?? "enabled",
      }),
      region({ id: "lon", name: "London", apiEndpoint: LON, orgState: opts.lon ?? "available" }),
      ...(opts.extra ?? []),
    ],
    orgId: "org-1",
    thisRegion: opts.thisRegion ?? "fra",
  };
}

function vm(name = "alpha", where = ""): GetVmResponse {
  return GetVmResponse.fromPartial({ vmId: `vm-${name}`, name, status: "running", region: where });
}

function elsewhere(
  exact: Array<[string, string]> = [],
  close: Array<[string, string]> = [],
): FindElsewhereResponse {
  const item = ([r, name]: [string, string]) => ({
    region: r,
    name,
    orgId: "org-1",
    id: `id-${name}`,
  });
  return { exact: exact.map(item), close: close.map(item), unavailable: [] };
}

// ── where a call goes ─────────────────────────────────────────────────────

describe("routing", () => {
  it("no region goes home without asking for regions", async () => {
    const { router, home, made } = make({ [HOME]: { GetVm: vm() } });
    await new Machines(router).get("alpha");
    expect(home.methods()).toEqual(["GetVm"]);
    expect(made).toEqual([]);
  });

  it("the client region routes machine calls there", async () => {
    const { router, home, at } = make(
      { [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm("alpha", "nyc") } },
      "nyc",
    );
    const machine = await new Machines(router).get("alpha");
    expect(machine.region).toBe("nyc");
    expect(at(NYC)?.methods()).toEqual(["GetVm"]);
    expect(home.methods()).toEqual(["ListRegions"]);
    expect(machine.access.desktopUrl).toBe("https://app.nyc.boxd.example.com/desktop/alpha");
  });

  it("caches the endpoint for the client's life", async () => {
    const { router, home, at } = make(
      { [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm(), StartVm: {} } },
      "nyc",
    );
    const machines = new Machines(router);
    await machines.get("alpha");
    await machines.start("alpha");
    await machines.get("alpha");
    expect(home.methods()).toEqual(["ListRegions"]);
    expect(at(NYC)?.methods()).toEqual(["GetVm", "StartVm", "GetVm"]);
  });

  it("concurrent first calls share one ListRegions", async () => {
    const { router, home } = make(
      { [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm() } },
      "nyc",
    );
    const machines = new Machines(router);
    await Promise.all([machines.get("a"), machines.get("b"), machines.get("c")]);
    expect(home.methods()).toEqual(["ListRegions"]);
  });

  it("a call's region overrides the client's", async () => {
    const { router, made, at } = make(
      {
        [HOME]: { ListRegions: listing({ lon: "enabled" }) },
        [NYC]: { GetVm: vm() },
        [LON]: { GetVm: vm() },
      },
      "nyc",
    );
    await new Machines(router).get("alpha", { region: "lon" });
    expect(made.length).toBe(1);
    expect(at(LON)?.methods()).toEqual(["GetVm"]);
  });

  it("naming the region home serves uses the home connection", async () => {
    const { router, home, made } = make({ [HOME]: { ListRegions: listing(), GetVm: vm() } });
    await new Machines(router).get("alpha", { region: " FRA" });
    expect(home.methods()).toEqual(["ListRegions", "GetVm"]);
    expect(made).toEqual([]);
  });

  it("account and org calls always go home", async () => {
    const { router, home, made } = make({ [HOME]: { GetOrgMachineDefaults: {} } }, "nyc");
    await new Orgs(router).getDefaultRegion();
    expect(home.methods()).toEqual(["GetOrgMachineDefaults"]);
    expect(made).toEqual([]);
  });

  it('refuses "all" outside list()', async () => {
    const { router } = make({ [HOME]: { ListRegions: listing() } });
    await expect(new Machines(router).get("alpha", { region: "all" })).rejects.toThrow("list");
  });

  it("streams go to the region too: exec, logs", async () => {
    const { router, at } = make(
      {
        [HOME]: { ListRegions: listing() },
        [NYC]: { Exec: [{ data: new TextEncoder().encode("hi"), exitCode: 0 }], StreamLogs: [] },
      },
      "nyc",
    );
    const machines = new Machines(router);
    const result = await machines.exec("alpha", { command: "echo hi" });
    expect(result.stdout).toBe("hi");
    for await (const _ of machines.logs("alpha")) {
      /* drain */
    }
    expect(at(NYC)?.methods()).toEqual(["Exec", "StreamLogs"]);
  });

  it("close closes every region", async () => {
    const { router, home, at } = make(
      { [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm() } },
      "nyc",
    );
    await new Machines(router).get("alpha");
    router.close();
    expect(home.closed).toBe(true);
    expect(at(NYC)?.closed).toBe(true);
  });
});

describe("the client's region", () => {
  const saved = process.env.BOXD_REGION;
  afterEach(() => {
    if (saved === undefined) delete process.env.BOXD_REGION;
    else process.env.BOXD_REGION = saved;
  });

  it("comes from the option, then BOXD_REGION, else none", () => {
    delete process.env.BOXD_REGION;
    expect(new Boxd({ token: "t" }).region).toBeUndefined();
    process.env.BOXD_REGION = "nyc";
    expect(new Boxd({ token: "t" }).region).toBe("nyc");
    expect(new WebBoxd({ token: "t", region: "LON" }).region).toBe("lon");
  });

  it('can\'t be "all"', () => {
    expect(() => new Boxd({ token: "t", region: "all" })).toThrow(BoxdError);
  });

  it("a region's Node transport dials the endpoint it looks up", async () => {
    const t = new NodeTransport({
      creds: new Credentials({ token: "t", exchangeUrl: "https://example.invalid" }),
      resolveBaseURL: async () => NYC,
      defaultBaseURL: HOME,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    expect(await t.consoleOrigin()).toBe("https://app.nyc.boxd.example.com");
    t.close();
  });
});

// ── unknown and not-enabled regions ───────────────────────────────────────

describe("unknown and not-enabled regions", () => {
  it("an unknown region is asked for again once", async () => {
    const sea = region({ id: "sea", apiEndpoint: SEA, orgState: "enabled" });
    const { router, home } = make({
      [HOME]: { ListRegions: [listing(), listing(), listing({ extra: [sea] })] },
      [NYC]: { GetVm: vm() },
      [SEA]: { GetVm: vm() },
    });
    const machines = new Machines(router);
    await machines.get("alpha", { region: "nyc" });
    const err = await machines.get("alpha", { region: "sea" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.reason).toBe("unknown_region");
    expect(err.message).toContain('no region "sea"');
    expect(home.methods()).toEqual(["ListRegions", "ListRegions"]);
    // A region added since is found by the next refresh.
    await machines.get("alpha", { region: "sea" });
    expect(home.methods()).toEqual(["ListRegions", "ListRegions", "ListRegions"]);
  });

  it("a region the org has not enabled says how to ask for it", async () => {
    const { router, made } = make({ [HOME]: { ListRegions: listing({ nyc: "available" }) } });
    const err = await new Machines(router).create({ name: "a", region: "nyc" }).catch((e) => e);
    expect(err).toBeInstanceOf(RegionNotEnabledError);
    expect(err.message).toContain('orgs.requestRegion("nyc")');
    expect(err.orgState).toBe("available");
    expect(err.grpcCode).toBe(7);
    expect(made).toEqual([]);
  });

  it("a requested region says it waits for boxd", async () => {
    const { router } = make({ [HOME]: { ListRegions: listing({ nyc: "requested" }) } });
    const err = await new Machines(router).list({ region: "nyc" }).catch((e) => e);
    expect(err).toBeInstanceOf(RegionNotEnabledError);
    expect(err.orgState).toBe("requested");
  });

  it("a region enabled since is picked up", async () => {
    const { router, home, at } = make({
      [HOME]: { ListRegions: [listing({ nyc: "requested" }), listing()] },
      [NYC]: { ListVms: { vms: [] } },
    });
    await new Regions(router).list(); // the cache says: requested
    await new Machines(router).list({ region: "nyc" }); // asked again once: enabled now
    expect(home.methods()).toEqual(["ListRegions", "ListRegions"]);
    expect(at(NYC)?.methods()).toEqual(["ListVms"]);
  });

  it("the org check uses the org the call names", async () => {
    const { router, home } = make({
      [HOME]: {
        ListRegions: (r: { orgId: string }) =>
          listing({ nyc: r.orgId === "acme" ? "enabled" : "available" }),
      },
      [NYC]: { ListVms: { vms: [] } },
    });
    await new Machines(router).list({ org: "acme", region: "nyc" });
    expect(home.calls[0]!.req.orgId).toBe("acme");
    await expect(new Machines(router).list({ region: "nyc" })).rejects.toBeInstanceOf(
      RegionNotEnabledError,
    );
  });

  it("a call on a machine by name is not org-checked", async () => {
    const { router, at } = make({
      [HOME]: { ListRegions: listing({ nyc: "available" }) },
      [NYC]: { GetVm: vm() },
    });
    await new Machines(router).get("alpha", { region: "nyc" });
    expect(at(NYC)?.methods()).toEqual(["GetVm"]);
  });

  it("regions.list() refreshes the cache", async () => {
    const { router, home } = make({ [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm() } });
    const regions = await new Regions(router).list();
    expect(regions.map((r) => r.id)).toEqual(["fra", "nyc", "lon"]);
    expect(regions[0]!.home).toBe(true);
    await new Machines(router).get("alpha", { region: "nyc" });
    expect(home.methods()).toEqual(["ListRegions"]);
  });
});

// ── list({ region: "all" }) and elsewhere ─────────────────────────────────

describe("lists", () => {
  it('"all" merges every enabled region', async () => {
    const { router, home, made } = make({
      [HOME]: { ListRegions: listing(), ListVms: { vms: [vm("a", "fra")] } },
      [NYC]: { ListVms: { vms: [vm("b", "nyc"), vm("c")] } },
    });
    const machines = await new Machines(router).list({ region: "all" });
    expect(machines.map((m) => [m.name, m.region])).toEqual([
      ["a", "fra"],
      ["b", "nyc"],
      ["c", "nyc"], // a server that doesn't say: where it was listed
    ]);
    expect(machines.unavailable).toEqual([]);
    expect(made.map((e) => e.url)).toEqual([NYC]); // lon: not enabled for the org
    expect(home.calls[1]!.req.withElsewhere).toBe(false);
    expect(machines[1]!.access.desktopUrl.startsWith("https://app.nyc.boxd.example.com/")).toBe(
      true,
    );
  });

  it('"all" names a region it could not reach', async () => {
    const { router } = make({
      [HOME]: { ListRegions: listing(), ListVms: { vms: [vm("a")] } },
      [NYC]: { ListVms: new APIConnectionError("down") },
    });
    const machines = await new Machines(router).list({ region: "all" });
    expect(machines.map((m) => m.name)).toEqual(["a"]);
    expect(machines.unavailable).toEqual(["nyc"]);
  });

  it('"all" outside a federation is the home list', async () => {
    const { router, home } = make({
      [HOME]: {
        ListRegions: { regions: [], orgId: "", thisRegion: "" },
        ListVms: { vms: [vm("a")] },
      },
    });
    const machines = await new Machines(router).list({ region: "all" });
    expect(machines.map((m) => [m.name, m.region])).toEqual([["a", null]]);
    expect(home.methods()).toEqual(["ListRegions", "ListVms"]);
  });

  it("a plain list asks for the counts elsewhere", async () => {
    const { router, home } = make({
      [HOME]: { ListVms: { vms: [vm("a", "fra")], elsewhere: [{ region: "nyc", count: 2 }] } },
    });
    const machines = await new Machines(router).list();
    expect(home.calls[0]!.req.withElsewhere).toBe(true);
    expect(Array.isArray(machines)).toBe(true);
    expect(machines.elsewhere).toEqual([{ region: "nyc", count: 2 }]);
    expect(machines[0]!.region).toBe("fra");
  });

  it("snapshots and disks carry elsewhere, and take all", async () => {
    const { router, home } = make({
      [HOME]: {
        ListRegions: listing(),
        ListSnapshots: { snapshots: [{ name: "s1" }], elsewhere: [{ region: "nyc", count: 1 }] },
        ListDisks: {
          disks: [{ name: "d1", region: "fra" }],
          elsewhere: [{ region: "lon", count: 3 }],
        },
      },
      [NYC]: { ListSnapshots: { snapshots: [{ name: "s2" }] } },
    });
    const snaps = await new Snapshots(router).list();
    const disks = await new Disks(router).list();
    expect(home.calls.map((c) => c.req.withElsewhere)).toEqual([true, true]);
    expect(snaps.elsewhere[0]!.region).toBe("nyc");
    expect(disks[0]!.region).toBe("fra");
    expect(disks.elsewhere[0]!.count).toBe(3);
    const every = await new Snapshots(router).list({ region: "all" });
    expect(every.map((s) => [s.name, s.region])).toEqual([
      ["s1", "fra"],
      ["s2", "nyc"],
    ]);
  });
});

// ── a call that names no org ──────────────────────────────────────────────

describe("the default org", () => {
  it("a region other than home is sent the org home resolved", async () => {
    const { router, home, at } = make({
      [HOME]: { ListRegions: listing(), ListVms: { vms: [] } },
      [NYC]: {
        CreateVm: { vmId: "vm-a", name: "a" },
        GetVm: vm("a", "nyc"),
        ListVms: { vms: [] },
      },
    });
    const machines = new Machines(router);
    await machines.create({ name: "a", region: "nyc" });
    await machines.list({ region: "nyc" });
    await machines.list({ region: "all" });
    await machines.list({ org: "acme", region: "nyc" }); // an org the caller set is kept
    expect(at(NYC)?.calls.map((c) => [c.method, c.req.org])).toEqual([
      ["CreateVm", "org-1"],
      ["GetVm", undefined],
      ["ListVms", "org-1"],
      ["ListVms", "org-1"],
      ["ListVms", "acme"],
    ]);
    // Home resolves "" itself, in "all" too.
    expect(home.calls.filter((c) => c.method === "ListVms").map((c) => c.req.org)).toEqual([""]);
  });

  it("home is sent the empty org as it is", async () => {
    const { router, home, made } = make({
      [HOME]: {
        ListRegions: listing(),
        CreateVm: { vmId: "vm-a", name: "a" },
        GetVm: vm("a", "fra"),
        ListVms: { vms: [] },
      },
    });
    const machines = new Machines(router);
    await machines.create({ name: "a", region: "fra" });
    await machines.list({ region: "fra" });
    expect(home.calls.map((c) => [c.method, c.req.org])).toEqual([
      ["ListRegions", undefined],
      ["CreateVm", ""],
      ["GetVm", undefined],
      ["ListVms", ""],
    ]);
    expect(made).toEqual([]);
  });

  it("an answer that names no org leaves it empty", async () => {
    const { router, at } = make({
      [HOME]: { ListRegions: { ...listing(), orgId: "" } },
      [NYC]: { ListVms: { vms: [] } },
    });
    await new Machines(router).list({ region: "nyc" });
    expect(at(NYC)?.calls[0]!.req.org).toBe("");
  });
});

// ── not found here, found elsewhere ───────────────────────────────────────

describe("not found elsewhere", () => {
  it("says where the name is", async () => {
    const { router, home } = make({
      [HOME]: {
        GetVm: new NotFoundError("machine not found: foo", 5),
        FindElsewhere: elsewhere([["nyc", "foo"]]),
      },
    });
    const err = await new Machines(router).get("foo").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe(
      'machine not found: foo; there is a machine "foo" in nyc: pass { region: "nyc" }',
    );
    expect(err.elsewhere).toEqual([{ region: "nyc", name: "foo", orgId: "org-1", id: "id-foo" }]);
    expect(err.close).toEqual([]);
    expect(home.calls[1]).toEqual({
      method: "FindElsewhere",
      req: { kind: "machine", name: "foo", org: "" },
    });
  });

  it("lists close names", async () => {
    const { router } = make({
      [HOME]: {
        DeleteSnapshot: new NotFoundError("no such snapshot", 5),
        FindElsewhere: elsewhere([], [["lon", "fooo"]]),
      },
    });
    const err = await new Snapshots(router).delete("foo", { org: "acme" }).catch((e) => e);
    expect(err.message).toContain('"fooo" in lon');
    expect(err.close[0].name).toBe("fooo");
  });

  it("looks up an empty snapshot answer too", async () => {
    const { router, home } = make({
      [HOME]: { GetSnapshot: {}, FindElsewhere: elsewhere([["nyc", "base"]]) },
    });
    const err = await new Snapshots(router).get("base", { org: "acme" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('pass { region: "nyc" }');
    expect(home.calls[1]!.req).toEqual({ kind: "snapshot", name: "base", org: "acme" });
  });

  it("a failed lookup never replaces the error", async () => {
    const { router } = make({
      [HOME]: {
        GetVm: new NotFoundError("machine not found: foo", 5),
        FindElsewhere: new APIStatusError("unimplemented", 12),
      },
    });
    const err = await new Machines(router).get("foo").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("machine not found: foo");
    expect(err.elsewhere).toEqual([]);
  });

  it("nothing elsewhere leaves the message alone", async () => {
    const { router } = make({
      [HOME]: { DestroyVm: new NotFoundError("gone", 5), FindElsewhere: elsewhere() },
    });
    const err = await new Machines(router).delete("foo").catch((e) => e);
    expect(err.message).toBe("gone");
  });

  it("a missing file is not a machine elsewhere", async () => {
    const { router, home } = make({
      [HOME]: { FsStat: new MachineFileNotFoundError("no such file", 5) },
    });
    await expect(new Machines(router).fs.stat("foo", "/x")).rejects.toBeInstanceOf(
      MachineFileNotFoundError,
    );
    expect(home.methods()).toEqual(["FsStat"]);
  });

  it("a not-found on something inside a machine is not looked up", async () => {
    const { router, home } = make({
      [HOME]: { DeleteCheckpoint: new NotFoundError("no checkpoint", 5) },
    });
    await expect(new Machines(router).checkpoints.delete("foo", "cp1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(home.methods()).toEqual(["DeleteCheckpoint"]);
  });

  it("asks the region that said not found", async () => {
    const { router, at } = make(
      {
        [HOME]: { ListRegions: listing() },
        [NYC]: {
          GetVm: new NotFoundError("machine not found: foo", 5),
          FindElsewhere: elsewhere([["fra", "foo"]]),
        },
      },
      "nyc",
    );
    const err = await new Machines(router).get("foo").catch((e) => e);
    expect(err.message).toContain('pass { region: "fra" }');
    expect(at(NYC)?.methods()).toEqual(["GetVm", "FindElsewhere"]);
  });

  it("exec says where the machine is", async () => {
    const { router } = make({
      [HOME]: {
        Exec: new NotFoundError("machine not found: foo", 5),
        FindElsewhere: elsewhere([["nyc", "foo"]]),
      },
    });
    const err = await new Machines(router).exec("foo", { command: "true" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('pass { region: "nyc" }');
  });

  it("logs say where the machine is", async () => {
    const { router } = make({
      [HOME]: {
        StreamLogs: new NotFoundError("machine not found: foo", 5),
        FindElsewhere: elsewhere([["lon", "foo"]]),
      },
    });
    const drain = async () => {
      for await (const _ of new Machines(router).logs("foo")) {
        /* drain */
      }
    };
    const err = await drain().catch((e) => e);
    expect(err.message).toContain('pass { region: "lon" }');
  });
});

// ── the org's regions ─────────────────────────────────────────────────────

describe("orgs", () => {
  it("regions, requestRegion and the default region", async () => {
    const { router, home } = make({
      [HOME]: {
        ListRegions: listing(),
        RequestOrgRegion: { state: "requested" },
        SetOrgMachineDefaults: {},
        GetOrgMachineDefaults: [{ region: "nyc" }, { region: "" }],
      },
    });
    const orgs = new Orgs(router);
    expect((await orgs.regions("acme")).map((r) => r.id)).toEqual(["fra", "nyc", "lon"]);
    expect(await orgs.requestRegion("lon", "acme")).toBe("requested");
    await orgs.setDefaultRegion("nyc", "acme");
    await orgs.clearDefaultRegion("acme");
    expect(await orgs.getDefaultRegion()).toBe("nyc");
    expect(await orgs.getDefaultRegion()).toBeNull();
    await expect(orgs.setDefaultRegion("")).rejects.toThrow("clearDefaultRegion");

    expect(home.calls[0]!.req).toEqual({ orgId: "acme" });
    expect(home.calls[1]!.req).toEqual({ orgId: "acme", region: "lon" });
    // The region alone: the default size is left as it is.
    const set = SetOrgMachineDefaultsRequest.decode(
      SetOrgMachineDefaultsRequest.encode(home.calls[2]!.req as never).finish(),
    );
    expect(set).toEqual({ orgId: "acme", region: "nyc" } as never);
    const clear = SetOrgMachineDefaultsRequest.decode(
      SetOrgMachineDefaultsRequest.encode(home.calls[3]!.req as never).finish(),
    );
    expect(clear.region).toBe("");
    expect(clear.vcpu).toBeUndefined();
  });

  it("org domain calls go to the region they name", async () => {
    const { router, home, at } = make({
      [HOME]: { ListRegions: listing() },
      [NYC]: {
        SetOrgDomain: {
          domain: { orgId: "o", domain: "d.example.com", status: "pending", region: "nyc" },
        },
        GetOrgDomain: {},
      },
    });
    const orgs = new Orgs(router);
    expect((await orgs.setDomain("o", "d.example.com", { region: "nyc" })).region).toBe("nyc");
    expect(await orgs.getDomain("o", { region: "nyc" })).toBeNull();
    expect(at(NYC)?.methods()).toEqual(["SetOrgDomain", "GetOrgDomain"]);
    // Org-scoped: checked against the org the call names.
    expect(home.calls[0]!.req).toEqual({ orgId: "o" });
  });
});

// ── the web entry, end to end ─────────────────────────────────────────────

function frame(payload: Uint8Array, flag = 0): Uint8Array {
  const f = new Uint8Array(5 + payload.length);
  f[0] = flag;
  new DataView(f.buffer).setUint32(1, payload.length, false);
  f.set(payload, 5);
  return f;
}

function grpcWebOk(payload: Uint8Array): Response {
  const trailer = frame(new TextEncoder().encode("grpc-status:0\r\n"), 0x80);
  const body = new Uint8Array(payload.length + 5 + trailer.length);
  body.set(frame(payload), 0);
  body.set(trailer, payload.length + 5);
  return new Response(body, { headers: { "content-type": "application/grpc-web+proto" } });
}

function firstFrame(buf: Uint8Array): Uint8Array {
  const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
  return buf.subarray(5, 5 + len);
}

describe("web entry", () => {
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  it("one credential reaches home and the region it looks up", async () => {
    const seen: Array<[string, string, string | null]> = [];
    const nyc = Bun.serve({
      port: 0,
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop()!;
        seen.push(["nyc", method, req.headers.get("authorization")]);
        const r = GetVmRequest.decode(firstFrame(new Uint8Array(await req.arrayBuffer())));
        return grpcWebOk(GetVmResponse.encode(vm(r.vmId, "nyc")).finish());
      },
    });
    servers.push(nyc);
    const nycOrigin = `http://127.0.0.1:${nyc.port}`;
    const home = Bun.serve({
      port: 0,
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop()!;
        seen.push(["home", method, req.headers.get("authorization")]);
        const regions = listing();
        regions.regions[1]!.apiEndpoint = nycOrigin;
        return grpcWebOk(ListRegionsResponse.encode(regions).finish());
      },
    });
    servers.push(home);

    const boxd = new WebBoxd({
      token: "t",
      baseURL: `http://127.0.0.1:${home.port}`,
      region: "nyc",
      maxRetries: 0,
    });
    const machine = await boxd.machines.get("alpha");
    expect(machine.name).toBe("alpha");
    expect(machine.region).toBe("nyc");
    expect(seen).toEqual([
      ["home", "ListRegions", "Bearer t"],
      ["nyc", "GetVm", "Bearer t"],
    ]);
  });
});

// ── direct mode: an API key skips asking home ─────────────────────────────

const KEY = "bxd_test-key";
const EXCHANGE = "https://app.example.com/api/v1/auth/token";
/** Where home's answer puts nyc when a test needs it apart from the derived
 *  name (on the platform the two are the same). */
const NYC_LISTED = "https://nyc-api.example.net:9443";
const NOT_IN_REGION =
  "API key not recognized in region nyc: it was deleted, or its org doesn't use this region " +
  "(`boxd manage regions` lists your org's regions)";

function keyCreds(): Credentials {
  return new Credentials({ apiKey: KEY, exchangeUrl: EXCHANGE });
}

/** `listing()` with nyc at {@link NYC_LISTED}. */
function listedApart(opts: { nyc?: string } = {}): ListRegionsResponse {
  const l = listing(opts);
  l.regions[1]!.apiEndpoint = NYC_LISTED;
  return l;
}

/** A router with direct mode wired the way the entries wire it. */
function makeDirect(
  book: Record<string, Answers>,
  opts: { region?: string; home?: string; creds?: Credentials } = {},
) {
  const homeURL = opts.home ?? HOME;
  const creds = opts.creds ?? keyCreds();
  const home = new Endpoint(async () => homeURL, book);
  const made: Array<Endpoint & { derived: boolean }> = [];
  const router = new RegionRouter(home, {
    region: opts.region,
    connect: (where, o) => {
      const endpoint = Object.assign(new Endpoint(where, book), { derived: o?.derived ?? false });
      made.push(endpoint);
      return endpoint;
    },
    direct: directRouting({ creds, explicitBaseURL: homeURL, defaultBaseURL: homeURL }),
  });
  return {
    router,
    home,
    made,
    derived: () => made.find((e) => e.derived),
    listed: () => made.find((e) => !e.derived),
  };
}

describe("direct mode", () => {
  it("names a region after home's host, on its scheme and port", () => {
    expect(regionBaseURL("https://boxd.example.com:9443", "nyc")).toBe(NYC);
    expect(regionBaseURL("https://boxd.example.com:9443/", "lon")).toBe(LON);
    expect(regionBaseURL("boxd.example.com:9443", "nyc")).toBe("nyc.boxd.example.com:9443");
    expect(regionBaseURL("https://Boxd.Example.com", "nyc")).toBe("https://nyc.boxd.example.com");
    for (const home of [
      "https://192.0.2.10:9443",
      "https://[2001:db8::1]:9443",
      "http://localhost:9443",
      "https://api.localhost:9443",
      "http://127.0.0.1:9443",
      "https://boxd:9443",
      "https://boxd.example.com:9443/api",
    ]) {
      expect(regionBaseURL(home, "nyc")).toBeUndefined();
    }
    expect(regionBaseURL(HOME, "n.yc")).toBeUndefined();
  });

  it("an API key goes straight to the region, its request as it is", async () => {
    const { router, home, made, derived } = makeDirect(
      {
        [NYC]: {
          CreateVm: { vmId: "vm-a", name: "a" },
          GetVm: vm("a", "nyc"),
          ListVms: { vms: [vm("a", "nyc")] },
        },
      },
      { region: "nyc" },
    );
    const machines = new Machines(router);
    const created = await machines.create({ name: "a" });
    const listed = await machines.list();
    expect(home.calls).toEqual([]);
    expect(made.length).toBe(1);
    expect(derived()?.url).toBe(NYC);
    // No org filled in: the key's org applies.
    expect(derived()?.calls.map((c) => [c.method, c.req.org])).toEqual([
      ["CreateVm", ""],
      ["GetVm", undefined],
      ["ListVms", ""],
    ]);
    // The console is named like the API, so home isn't asked for it either.
    expect(created.access.desktopUrl).toBe("https://app.nyc.boxd.example.com/desktop/a");
    expect(listed[0]!.access.desktopUrl).toBe("https://app.nyc.boxd.example.com/desktop/a");
  });

  it("a call's region goes straight there too; account calls stay home", async () => {
    const { router, home, derived } = makeDirect({
      [HOME]: { GetOrgMachineDefaults: {} },
      [LON]: { GetVm: vm("a", "lon") },
    });
    await new Machines(router).get("a", { region: "lon" });
    await new Orgs(router).getDefaultRegion();
    expect(derived()?.url).toBe(LON);
    expect(home.methods()).toEqual(["GetOrgMachineDefaults"]);
  });

  it("a call that names an org asks home", async () => {
    const { router, home, derived, listed } = makeDirect({
      [HOME]: { ListRegions: listedApart() },
      [NYC_LISTED]: { ListVms: { vms: [] } },
    });
    await new Machines(router).list({ org: "acme", region: "nyc" });
    expect(home.calls).toEqual([{ method: "ListRegions", req: { orgId: "acme" } }]);
    expect(listed()?.calls.map((c) => c.req.org)).toEqual(["acme"]);
    expect(derived()).toBeUndefined();
  });

  it('"all" asks home', async () => {
    const { router, home, derived } = makeDirect({
      [HOME]: { ListRegions: listing(), ListVms: { vms: [] } },
      [NYC]: { ListVms: { vms: [] } },
    });
    await new Machines(router).list({ region: "all" });
    expect(home.methods()).toEqual(["ListRegions", "ListVms"]);
    expect(derived()).toBeUndefined();
  });

  it("a connection error goes through home, for the client's life", async () => {
    const { router, home, derived, listed } = makeDirect(
      {
        [HOME]: { ListRegions: listedApart() },
        [NYC]: { GetVm: new APIConnectionError("getaddrinfo ENOTFOUND nyc.boxd.example.com") },
        [NYC_LISTED]: { GetVm: vm("alpha", "nyc"), ListVms: { vms: [] } },
      },
      { region: "nyc" },
    );
    const machines = new Machines(router);
    const machine = await machines.get("alpha");
    expect(machine.region).toBe("nyc");
    await machines.list();
    expect(derived()?.methods()).toEqual(["GetVm"]);
    expect(home.methods()).toEqual(["ListRegions"]);
    // Through home, the region is sent the org home names, as before.
    expect(listed()?.calls.map((c) => [c.method, c.req.org])).toEqual([
      ["GetVm", undefined],
      ["ListVms", "org-1"],
    ]);
    expect(listed()?.url).toBe(NYC_LISTED);
  });

  it("a region that doesn't hold the key: home says why", async () => {
    const { router, home, derived, made } = makeDirect({
      [HOME]: { ListRegions: listing({ nyc: "available" }) },
      [NYC]: { CreateVm: new AuthenticationError(NOT_IN_REGION, 16) },
    });
    const err = await new Machines(router)
      .create({ name: "a", region: "nyc" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RegionNotEnabledError);
    expect(err.message).toContain('orgs.requestRegion("nyc")');
    expect(derived()?.methods()).toEqual(["CreateVm"]);
    expect(home.methods()).toEqual(["ListRegions"]);
    expect(made.length).toBe(1);
  });

  it("a region that doesn't hold the key yet is asked again through home", async () => {
    const { router, derived, listed } = makeDirect({
      [HOME]: { ListRegions: listedApart() },
      [NYC]: { ListVms: new AuthenticationError(NOT_IN_REGION, 16) },
      [NYC_LISTED]: { ListVms: { vms: [vm("b", "nyc")] } },
    });
    const machines = await new Machines(router).list({ region: "nyc" });
    expect(machines.map((m) => m.name)).toEqual(["b"]);
    expect(derived()?.methods()).toEqual(["ListVms"]);
    expect(listed()?.calls.map((c) => c.req.org)).toEqual(["org-1"]);
  });

  it("an unknown region is reported by home", async () => {
    const { router, home } = makeDirect({
      [HOME]: { ListRegions: listing() },
      ["https://sea.boxd.example.com:9443"]: { GetVm: new APIConnectionError("no such host") },
    });
    const err = await new Machines(router).get("a", { region: "sea" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.reason).toBe("unknown_region");
    expect(home.methods()).toEqual(["ListRegions"]);
  });

  it("any other error is the call's own", async () => {
    const { router, home, derived } = makeDirect(
      {
        [NYC]: {
          GetVm: new NotFoundError("machine not found: foo", 5),
          FindElsewhere: elsewhere([["fra", "foo"]]),
          StartVm: new AuthenticationError("API key expired", 16),
        },
      },
      { region: "nyc" },
    );
    const machines = new Machines(router);
    const err = await machines.get("foo").catch((e) => e);
    expect(err.message).toContain('pass { region: "fra" }');
    await expect(machines.start("foo")).rejects.toThrow("API key expired");
    expect(derived()?.methods()).toEqual(["GetVm", "FindElsewhere", "StartVm"]);
    expect(home.calls).toEqual([]);
  });

  it("a token, and a key that is exchanged, ask home", async () => {
    const exchanged = keyCreds();
    exchanged.rawKeyRefused();
    for (const creds of [new Credentials({ token: "t", exchangeUrl: EXCHANGE }), exchanged]) {
      const { router, home, derived } = makeDirect(
        { [HOME]: { ListRegions: listing() }, [NYC]: { GetVm: vm() } },
        { region: "nyc", creds },
      );
      await new Machines(router).get("alpha");
      expect(home.methods()).toEqual(["ListRegions"]);
      expect(derived()).toBeUndefined();
    }
  });

  it("a home that is an address, localhost, one label or plaintext asks home", async () => {
    for (const homeURL of [
      "https://192.0.2.10:9443",
      "https://[2001:db8::1]:9443",
      "http://localhost:9443",
      "http://127.0.0.1:9443",
      "https://boxd:9443",
      "http://boxd.example.com:9443",
    ]) {
      const { router, home, derived } = makeDirect(
        { [homeURL]: { ListRegions: listing() }, [NYC]: { GetVm: vm() } },
        { region: "nyc", home: homeURL },
      );
      await new Machines(router).get("alpha");
      expect(home.methods()).toEqual(["ListRegions"]);
      expect(derived()).toBeUndefined();
    }
  });

  it("a stream goes there only after a unary call there was answered", async () => {
    const exec = [{ data: new TextEncoder().encode("hi"), exitCode: 0 }];
    const { router, home, derived, listed } = makeDirect(
      {
        [HOME]: { ListRegions: listedApart() },
        [NYC]: { GetVm: vm(), Exec: exec, StreamLogs: [] },
        [NYC_LISTED]: { Exec: exec, StreamLogs: [] },
      },
      { region: "nyc" },
    );
    const machines = new Machines(router);
    const drain = async () => {
      for await (const _ of machines.logs("alpha")) {
        /* drain */
      }
    };
    // Nothing confirmed the derived name yet: through home, as before.
    expect((await machines.exec("alpha", { command: "echo hi" })).stdout).toBe("hi");
    await drain();
    expect(home.methods()).toEqual(["ListRegions"]);
    expect(listed()?.methods()).toEqual(["Exec", "StreamLogs"]);
    // A unary call answered there: streams follow it.
    await machines.get("alpha");
    expect((await machines.exec("alpha", { command: "echo hi" })).stdout).toBe("hi");
    await drain();
    expect(derived()?.methods()).toEqual(["GetVm", "Exec", "StreamLogs"]);
    expect(listed()?.methods()).toEqual(["Exec", "StreamLogs"]);
  });

  it("a region that fell back takes its streams through home too", async () => {
    const { router, derived, listed } = makeDirect(
      {
        [HOME]: { ListRegions: listedApart() },
        [NYC]: { GetVm: [vm(), new APIConnectionError("reset")], StreamLogs: [] },
        [NYC_LISTED]: { GetVm: vm(), StreamLogs: [] },
      },
      { region: "nyc" },
    );
    const machines = new Machines(router);
    await machines.get("alpha"); // confirmed
    await machines.get("alpha"); // fails there: off
    for await (const _ of machines.logs("alpha")) {
      /* drain */
    }
    expect(derived()?.methods()).toEqual(["GetVm", "GetVm"]);
    expect(listed()?.methods()).toEqual(["GetVm", "StreamLogs"]);
  });

  it("close closes the derived transports", async () => {
    const { router, derived } = makeDirect({ [NYC]: { GetVm: vm() } }, { region: "nyc" });
    await new Machines(router).get("alpha");
    router.close();
    expect(derived()?.closed).toBe(true);
  });
});

// ── direct mode through the web entry, over a scripted fetch ──────────────

describe("direct mode, web entry", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer grpc-web calls by origin and method; record each one. */
  function script(answers: Record<string, (body: Uint8Array) => Response | Promise<Response>>) {
    const seen: Array<[string, string, string | null]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      const method = url.pathname.split("/").pop()!;
      const auth = new Headers(init?.headers).get("authorization");
      seen.push([url.origin, method, auth]);
      const answer = answers[`${url.origin} ${method}`];
      if (!answer) throw new TypeError(`fetch failed: no route to ${url.host}`);
      return answer(firstFrame(new Uint8Array(init!.body as Uint8Array)));
    }) as typeof fetch;
    return seen;
  }

  const getVm = (body: Uint8Array) =>
    grpcWebOk(GetVmResponse.encode(vm(GetVmRequest.decode(body).vmId, "nyc")).finish());

  it("a key reaches the region with no ListRegions", async () => {
    const seen = script({ [`${NYC} GetVm`]: getVm });
    const boxd = new WebBoxd({ apiKey: KEY, baseURL: HOME, region: "nyc", maxRetries: 2 });
    const machine = await boxd.machines.get("alpha");
    expect(machine.access.desktopUrl).toBe("https://app.nyc.boxd.example.com/desktop/alpha");
    expect(seen).toEqual([[NYC, "GetVm", `Bearer ${KEY}`]]);
  });

  it("a name that leads nowhere: one try, then home, then the region it names", async () => {
    let asked: ListRegionsRequest | undefined;
    const seen = script({
      [`${HOME} ListRegions`]: (body) => {
        asked = ListRegionsRequest.decode(body);
        return grpcWebOk(ListRegionsResponse.encode(listedApart()).finish());
      },
      [`${NYC_LISTED} GetVm`]: getVm,
    });
    const boxd = new WebBoxd({ apiKey: KEY, baseURL: HOME, region: "nyc", maxRetries: 2 });
    expect((await boxd.machines.get("alpha")).name).toBe("alpha");
    expect((await boxd.machines.get("beta")).name).toBe("beta");
    expect(asked?.orgId).toBe("");
    expect(seen).toEqual([
      [NYC, "GetVm", `Bearer ${KEY}`], // not retried: home is asked instead
      [HOME, "ListRegions", `Bearer ${KEY}`],
      [NYC_LISTED, "GetVm", `Bearer ${KEY}`],
      [NYC_LISTED, "GetVm", `Bearer ${KEY}`],
    ]);
  });
});
