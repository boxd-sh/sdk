/**
 * Namespace wiring: the right RPC, the right request fields, the right model
 * out.
 *
 * Everything here runs against a fake transport, so it pins what would go on
 * the wire without needing a cluster. The mappers themselves are covered in
 * `models.test.ts`; this file covers the layer above them, which nothing did
 * before — the same gap that let `machines.list()` ship broken in the Python
 * SDK.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateVmFromSnapshotRequest,
  CreateVmRequest,
  ForkVmRequest,
  SetOrgIdleIgnoreOutboundDefaultRequest,
  type MessageFns,
} from "../src/_generated/definitions.js";
import { nodePlatform } from "../src/_platformNode.js";
import type { MethodDef, Transport } from "../src/_rpc.js";
import { BoxdError } from "../src/errors.js";
import {
  AccountNamespace,
  ApiKeys,
  Disks,
  Domains,
  EnvVars,
  Machines,
  Orgs,
  Secrets,
  Snapshots,
} from "../src/index.js";

// ── the fake ──────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  req: Record<string, unknown>;
}

/** A duplex/server-stream call that replays a script once handlers are on. */
class FakeCall {
  readonly written: Record<string, unknown>[] = [];
  ended = false;
  cancelled = false;
  #handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  #script: { chunks: unknown[]; error?: unknown };
  #flushed = false;

  constructor(script: { chunks: unknown[]; error?: unknown }) {
    this.#script = script;
  }

  write(chunk: Record<string, unknown>): void {
    this.written.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
  cancel(): void {
    this.cancelled = true;
  }

  on(event: string, fn: (arg?: unknown) => void): void {
    (this.#handlers[event] ??= []).push(fn);
    // "end" is the last handler every caller registers, so by the time we see
    // it the call is fully wired and the script can run.
    if (event === "end" && !this.#flushed) {
      this.#flushed = true;
      queueMicrotask(() => this.#flush());
    }
  }

  #emit(event: string, arg?: unknown): void {
    for (const fn of this.#handlers[event] ?? []) fn(arg);
  }

  #flush(): void {
    if (this.cancelled) return;
    for (const c of this.#script.chunks) this.#emit("data", c);
    if (this.#script.error) this.#emit("error", this.#script.error);
    else this.#emit("end");
  }
}

/**
 * Records `(method, request)` and replays queued responses. A queued item that
 * is an `Error` is thrown instead of returned.
 *
 * Implements the real `Transport` interface directly (`_rpc.ts`) rather than
 * mocking a grpc-js client shape — the namespaces are written against that
 * interface now and never touch grpc-js themselves, so a fake only
 * needs to speak the same four verbs (`unary`/`serverStream`/`duplex`/
 * `clientStream`) any real transport (Node or web) does.
 */
class FakeTransport implements Transport {
  readonly calls: Recorded[] = [];
  /** The streaming calls handed out, in order (`duplex`/`serverStream`). */
  readonly streams: FakeCall[] = [];
  /** Stands in for the Node transport here — these tests pin namespace-level
   *  wiring, not transport capability, and `streamExec`'s own web-transport
   *  restriction is covered directly in `transportWeb.test.ts`. */
  readonly supportsInteractiveExec = true;
  #responses: unknown[];
  #script: { chunks: unknown[]; error?: unknown };

  constructor(responses: unknown[] = [], script: { chunks: unknown[]; error?: unknown } = { chunks: [] }) {
    this.#responses = [...responses];
    this.#script = script;
  }

  /** What a real client derives from its endpoint; `machines` fills
   *  `access.desktopUrl` from it. */
  async consoleOrigin(): Promise<string> {
    return "https://app.boxd.sh";
  }

  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    this.calls.push({ method: method.name, req: req as Record<string, unknown> });
    const next = this.#responses.shift();
    if (next instanceof Error) throw next;
    return (next ?? {}) as Resp;
  }

  serverStream<Req>(method: MethodDef<Req, unknown>, req: Req) {
    this.calls.push({ method: method.name, req: req as Record<string, unknown> });
    const call = new FakeCall(this.#script);
    this.streams.push(call);
    return call;
  }

  duplex<Req>(method: MethodDef<Req, unknown>) {
    this.calls.push({ method: method.name, req: {} });
    const call = new FakeCall(this.#script);
    this.streams.push(call);
    return call;
  }

  clientStream<Req, Resp>(method: MethodDef<Req, Resp>, callback: (err: unknown, resp: Resp) => void) {
    this.calls.push({ method: method.name, req: {} });
    const call = new FakeCall(this.#script);
    this.streams.push(call);
    // Client-streaming calls settle via callback, not "data"/"end" events —
    // reuse FakeCall's own script replay, just routed to `callback` instead.
    call.on("data", (chunk) => callback(null, chunk as Resp));
    call.on("error", (err) => callback(err, undefined as never));
    call.on("end", () => {
      /* no terminal response queued beyond the script's chunks/error */
    });
    return { write: (msg: Req) => call.write(msg as Record<string, unknown>), end: () => call.end() };
  }

  close(): void {}
}

const asTransport = (f: FakeTransport): Transport => f;

// ── fixtures ──────────────────────────────────────────────────────────────

/** A `GetVmResponse` with only the fields a test cares about. */
function aVm(name = "alpha"): Record<string, unknown> {
  return {
    vmId: "vm-1",
    name,
    status: "running",
    imageRef: "debian:12",
    sshPort: 10001,
    accessDomain: "boxd.sh",
    vcpu: 2,
    memoryBytes: 8 * 1024 ** 3,
  };
}

const chunk = (fields: Record<string, unknown>) => ({
  data: new Uint8Array(),
  isStderr: false,
  exitCode: 0,
  ...fields,
});

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * What the server decodes from a recorded request: both transports send
 * `requestType.encode(req)`, so this tells an `optional` field left unset
 * apart from one sent as its zero value.
 */
function onTheWire<T>(codec: MessageFns<T>, req: Record<string, unknown>): T {
  return codec.decode(codec.encode(req as T).finish());
}

// ── machines ──────────────────────────────────────────────────────────────

describe("machines", () => {
  it("get calls GetVm and maps the response", async () => {
    const t = new FakeTransport([aVm()]);
    const machine = await new Machines(asTransport(t)).get("alpha");
    expect(t.calls[0]!.method).toBe("GetVm");
    expect(t.calls[0]!.req.vmId).toBe("alpha");
    expect(machine.id).toBe("vm-1");
    expect(machine.access.sshPort).toBe(10001);
    expect(machine.access.desktopUrl).toBe(`https://app.boxd.sh/desktop/${machine.name}`);
  });

  it("setDeleteAfter sends seconds and returns the deadline, null when cleared", async () => {
    const t = new FakeTransport([{ deleteAtMs: 1_800_000_000_000 }, { deleteAtMs: 0 }]);
    const machines = new Machines(asTransport(t));
    const at = await machines.setDeleteAfter("alpha", 7200);
    expect(t.calls[0]!.method).toBe("SetDeleteAfter");
    expect(t.calls[0]!.req).toEqual({ vmId: "alpha", deleteAfterSecs: 7200, deleteAfterCron: "" });
    expect(at?.getTime()).toBe(1_800_000_000_000);
    expect(await machines.setDeleteAfter("alpha", 0)).toBeNull();
  });

  it("create and fork set deleteAfter before the re-read; omitted sends nothing", async () => {
    const t = new FakeTransport([
      { vmId: "vm-1", name: "alpha" },
      { deleteAtMs: 1 },
      aVm(),
      { vmId: "vm-2", name: "beta" },
      { deleteAtMs: 1 },
      aVm("beta"),
      { vmId: "vm-3", name: "gamma" },
      aVm("gamma"),
    ]);
    const machines = new Machines(asTransport(t));
    await machines.create({ name: "alpha", deleteAfter: 1800 });
    await machines.fork("alpha", { name: "beta", deleteAfter: 60 });
    await machines.create({ name: "gamma" });
    expect(t.calls.map((c) => c.method)).toEqual([
      "CreateVm", "SetDeleteAfter", "GetVm",
      "ForkVm", "SetDeleteAfter", "GetVm",
      "CreateVm", "GetVm",
    ]);
    expect(t.calls[1]!.req).toEqual({ vmId: "vm-1", deleteAfterSecs: 1800, deleteAfterCron: "" });
    expect(t.calls[4]!.req).toEqual({ vmId: "vm-2", deleteAfterSecs: 60, deleteAfterCron: "" });
  });

  it("setDeleteAfterCron and deleteAfterCron on create send the expression", async () => {
    const t = new FakeTransport([
      { deleteAtMs: 1_800_000_000_000 },
      { vmId: "vm-1", name: "alpha" },
      { deleteAtMs: 1 },
      aVm(),
    ]);
    const machines = new Machines(asTransport(t));
    expect((await machines.setDeleteAfterCron("alpha", "0 18 * * *"))?.getTime()).toBe(1_800_000_000_000);
    expect(t.calls[0]!.req).toEqual({ vmId: "alpha", deleteAfterSecs: 0, deleteAfterCron: "0 18 * * *" });
    await machines.create({ name: "alpha", deleteAfterCron: "0 9 * * 1" });
    expect(t.calls.slice(1).map((c) => c.method)).toEqual(["CreateVm", "SetDeleteAfter", "GetVm"]);
    expect(t.calls[2]!.req.deleteAfterCron).toBe("0 9 * * 1");
  });

  it("list returns a plain array", async () => {
    // The Python twin of this method once returned a malformed wrapper and
    // nothing caught it, because nothing called the method at all.
    const t = new FakeTransport([{ vms: [aVm("alpha"), aVm("beta")] }]);
    const machines = await new Machines(asTransport(t)).list();
    expect(t.calls[0]!.method).toBe("ListVms");
    expect(Array.isArray(machines)).toBe(true);
    expect(machines.map((m) => m.name)).toEqual(["alpha", "beta"]);
  });

  it("list is empty when the account has none", async () => {
    const t = new FakeTransport([{ vms: [] }]);
    expect(await new Machines(asTransport(t)).list()).toEqual([]);
  });

  it("setEgressAllow sends the full set and returns what is in effect", async () => {
    const t = new FakeTransport([{ entries: ["1.1.1.1", "api.example.com"] }]);
    const got = await new Machines(asTransport(t)).setEgressAllow("alpha", [
      "api.example.com",
      "1.1.1.1",
    ]);
    expect(t.calls[0]!.method).toBe("SetVmEgressAllow");
    expect(t.calls[0]!.req).toEqual({ vm: "alpha", entries: ["api.example.com", "1.1.1.1"] });
    expect(got).toEqual(["1.1.1.1", "api.example.com"]);
  });

  it("list passes org and allContexts through", async () => {
    const t = new FakeTransport([{ vms: [] }]);
    await new Machines(asTransport(t)).list({ org: "acme", allContexts: true });
    expect(t.calls[0]!.req).toEqual({ org: "acme", allContexts: true, labelSelector: [] });
  });

  it("list filters by labels, as selector strings or an object", async () => {
    const t = new FakeTransport([{ vms: [] }, { vms: [] }]);
    const machines = new Machines(asTransport(t));
    await machines.list({ labels: ["env=prod", "gpu"] });
    await machines.list({ labels: { env: "prod", team: "" } });
    expect(t.calls.map((c) => c.req.labelSelector)).toEqual([
      ["env=prod", "gpu"],
      ["env=prod", "team="],
    ]);
  });

  it("list checks the labels again: an older server's unfiltered list matches nothing", async () => {
    const everything = {
      vms: [
        { ...aVm("prod"), labels: { env: "prod", gpu: "" } },
        { ...aVm("dev"), labels: { env: "dev" } },
        aVm("old"),
      ],
    };
    const t = new FakeTransport([everything, everything, everything]);
    const machines = new Machines(asTransport(t));
    const names = (ms: { name: string }[]) => ms.map((m) => m.name);
    expect(names(await machines.list({ labels: { env: "prod" } }))).toEqual(["prod"]);
    expect(names(await machines.list({ labels: ["gpu"] }))).toEqual(["prod"]);
    expect(names(await machines.list())).toEqual(["prod", "dev", "old"]);
  });

  it("create, fork and create(fromSnapshot) send labels; omitted sends none", async () => {
    const created = (name: string) => [{ vmId: `vm-${name}`, name }, aVm(name)];
    const t = new FakeTransport(["a", "b", "c", "d"].flatMap(created));
    const machines = new Machines(asTransport(t));
    await machines.create({ name: "a", labels: { env: "prod", team: "" } });
    await machines.fork("a", { name: "b", labels: { run: "nightly" } });
    await machines.create({ fromSnapshot: "base", name: "c", labels: { env: "staging" } });
    await machines.create({ name: "d" });
    const creates = t.calls.filter((c) => c.method === "CreateVm");
    expect(onTheWire(CreateVmRequest, creates[0]!.req).labels).toEqual({ env: "prod", team: "" });
    expect(onTheWire(CreateVmRequest, creates[1]!.req).labels).toEqual({});
    const fork = t.calls.find((c) => c.method === "ForkVm")!;
    expect(onTheWire(ForkVmRequest, fork.req).labels).toEqual({ run: "nightly" });
    const restore = t.calls.find((c) => c.method === "CreateVmFromSnapshot")!;
    expect(onTheWire(CreateVmFromSnapshotRequest, restore.req).labels).toEqual({ env: "staging" });
  });

  it("updateLabels sends the edit and returns the labels in effect", async () => {
    const t = new FakeTransport([{ labels: { env: "prod" } }, { labels: { only: "this" } }]);
    const m = new Machines(asTransport(t));
    expect(await m.updateLabels("alpha", { set: { env: "prod" }, remove: ["old"] })).toEqual({
      env: "prod",
    });
    expect(await m.updateLabels("alpha", { set: { only: "this" }, replaceAll: true })).toEqual({
      only: "this",
    });
    expect(t.calls.map((c) => c.method)).toEqual(["UpdateVmLabels", "UpdateVmLabels"]);
    expect(t.calls[0]!.req).toEqual({
      vm: "alpha",
      set: { env: "prod" },
      remove: ["old"],
      replaceAll: false,
    });
    expect(t.calls[1]!.req).toEqual({
      vm: "alpha",
      set: { only: "this" },
      remove: [],
      replaceAll: true,
    });
  });

  it("updateLabels refuses remove with replaceAll before the wire", async () => {
    const t = new FakeTransport();
    await expect(
      new Machines(asTransport(t)).updateLabels("alpha", { remove: ["x"], replaceAll: true }),
    ).rejects.toThrow(BoxdError);
    expect(t.calls).toEqual([]);
  });

  it("get reports the machine's labels, empty when it has none", async () => {
    const t = new FakeTransport([{ ...aVm(), labels: { env: "prod" } }, aVm()]);
    const machines = new Machines(asTransport(t));
    expect((await machines.get("alpha")).labels).toEqual({ env: "prod" });
    expect((await machines.get("alpha")).labels).toEqual({});
  });

  it("create uses CreateVm and then re-reads the machine", async () => {
    const t = new FakeTransport([{ vmId: "vm-1", name: "alpha" }, aVm()]);
    const machine = await new Machines(asTransport(t)).create({
      name: "alpha",
      config: { vcpu: 4 },
    });
    expect(t.calls.map((c) => c.method)).toEqual(["CreateVm", "GetVm"]);
    expect(t.calls[0]!.req.name).toBe("alpha");
    expect((t.calls[0]!.req.config as { vcpu: number }).vcpu).toBe(4);
    // Fields only GetVm carries.
    expect(machine.access.domain).toBe("boxd.sh");
    expect(machine.resources.vcpu).toBe(2);
  });

  it("create falls back to the partial mapping when the re-read fails", async () => {
    const t = new FakeTransport([
      { vmId: "vm-1", name: "alpha", status: "pending", image: "debian:12" },
      new BoxdError("not visible yet"),
    ]);
    const machine = await new Machines(asTransport(t)).create({ name: "alpha" });
    expect(machine.id).toBe("vm-1");
    expect(machine.status).toBe("pending");
    expect(machine.access.sshPort).toBeNull();
  });

  it("create(fromSnapshot) switches to the snapshot RPC", async () => {
    const t = new FakeTransport([{ vmId: "vm-1", name: "alpha" }, aVm()]);
    await new Machines(asTransport(t)).create({ fromSnapshot: "base", name: "alpha" });
    expect(t.calls[0]!.method).toBe("CreateVmFromSnapshot");
    expect(t.calls[0]!.req.snapshot).toBe("base");
    expect(t.calls[0]!.req.name).toBe("alpha");
  });

  // The types already make each of these a compile error; this is the backstop
  // for a plain-JavaScript caller, who has no compiler.
  const incompatible: Array<[string, Record<string, unknown>]> = [
    ["image", { image: "debian:12" }],
    ["env", { env: { A: "b" } }],
    ["cmd", { cmd: ["sleep", "1"] }],
    ["restartPolicy", { restartPolicy: "never" }],
    ["shared", { shared: true }],
  ];
  for (const [label, extra] of incompatible) {
    it(`create(fromSnapshot) refuses ${label}`, async () => {
      const t = new FakeTransport([]);
      await expect(
        new Machines(asTransport(t)).create({ fromSnapshot: "base", ...extra } as never),
      ).rejects.toThrow(`does not accept ${label}`);
      expect(t.calls).toEqual([]);
    });
  }

  it("create(fromSnapshot) accepts the isolated override", async () => {
    // Unlike the rest, `isolated` is a legal one-way override on a restore.
    const t = new FakeTransport([{ vmId: "vm-1", name: "alpha" }, aVm()]);
    await new Machines(asTransport(t)).create({ fromSnapshot: "base", isolated: true });
    expect(t.calls[0]!.method).toBe("CreateVmFromSnapshot");
    expect(t.calls[0]!.req.isolated).toBe(true);
  });

  it("fork carries the isolated override", async () => {
    const t = new FakeTransport([{ vmId: "vm-2", name: "beta" }, aVm("beta")]);
    await new Machines(asTransport(t)).fork("alpha", { name: "beta", isolated: true });
    expect(t.calls[0]!.method).toBe("ForkVm");
    expect(t.calls[0]!.req.isolated).toBe(true);
  });

  it("create(fromSnapshot) ignores options that ask for nothing", async () => {
    const t = new FakeTransport([{ vmId: "vm-1", name: "alpha" }, aVm()]);
    await new Machines(asTransport(t)).create({
      fromSnapshot: "base",
      env: {},
      cmd: [],
      shared: false,
    } as never);
    expect(t.calls[0]!.method).toBe("CreateVmFromSnapshot");
  });

  it("fork re-reads too", async () => {
    const t = new FakeTransport([{ vmId: "vm-2", name: "beta" }, aVm("beta")]);
    const fork = await new Machines(asTransport(t)).fork("alpha", { name: "beta" });
    expect(t.calls.map((c) => c.method)).toEqual(["ForkVm", "GetVm"]);
    expect(t.calls[0]!.req.sourceVmId).toBe("alpha");
    expect(fork.access.domain).toBe("boxd.sh");
  });

  it("fork reports the automations it inherited paused, and says so", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => void warned.push(String(msg));
    try {
      const machines = (responses: unknown[]) => new Machines(asTransport(new FakeTransport(responses)));
      const fork = await machines([{ vmId: "vm-2", name: "beta", pausedAutomations: 2 }, aVm("beta")]).fork("alpha");
      expect(fork.pausedAutomations).toBe(2);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("2 automations are paused in beta");
      expect(warned[0]).toContain("run restart <id>");

      // A source without automations: nothing to report, nothing printed.
      const quiet = await machines([{ vmId: "vm-3", name: "gamma", pausedAutomations: 0 }, aVm("gamma")]).fork("alpha");
      expect(quiet.pausedAutomations).toBe(0);
      expect(warned).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });

  it("a machine from a snapshot reports the automations it came with paused", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => void warned.push(String(msg));
    try {
      const t = new FakeTransport([{ vmId: "vm-2", name: "beta", pausedAutomations: 1 }, aVm("beta")]);
      const m = await new Machines(asTransport(t)).create({ name: "beta", fromSnapshot: "golden" });
      expect(t.calls[0]!.method).toBe("CreateVmFromSnapshot");
      expect(m.pausedAutomations).toBe(1);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("1 automation from the snapshot is paused in beta");

      const snaps = new Snapshots(
        asTransport(new FakeTransport([{ snapshotId: "s-1", name: "golden", version: 1, status: "pending", pausedAutomations: 2 }])),
      );
      const snap = await snaps.create("alpha", "golden");
      expect(snap.pausedAutomations).toBe(2);
      expect(warned).toHaveLength(2);
      expect(warned[1]).toContain("2 automations captured");
    } finally {
      console.warn = original;
    }
  });

  it("rename returns the new name", async () => {
    const t = new FakeTransport([{ name: "beta" }]);
    expect(await new Machines(asTransport(t)).rename("alpha", "beta")).toBe("beta");
    expect(t.calls[0]!.req.newName).toBe("beta");
  });

  it("delete uses DestroyVm", async () => {
    const t = new FakeTransport([{}]);
    await new Machines(asTransport(t)).delete("alpha");
    expect(t.calls[0]!.method).toBe("DestroyVm");
    expect(t.calls[0]!.req.vmId).toBe("alpha");
  });

  it("the plain lifecycle verbs each hit their own RPC", async () => {
    const t = new FakeTransport([{}, {}, {}, {}, {}, {}]);
    const m = new Machines(asTransport(t));
    await m.start("alpha");
    await m.stop("alpha");
    await m.reboot("alpha");
    await m.hibernate("alpha");
    await m.wake("alpha");
    await m.suggestName();
    expect(t.calls.map((c) => c.method)).toEqual([
      "StartVm",
      "StopVm",
      "RebootVm",
      "HibernateVm",
      "WakeVm",
      "SuggestVmName",
    ]);
    expect(t.calls.slice(0, 5).every((c) => c.req.vmId === "alpha")).toBe(true);
  });

  it("suggestName returns the name", async () => {
    const t = new FakeTransport([{ name: "brave-otter" }]);
    expect(await new Machines(asTransport(t)).suggestName()).toBe("brave-otter");
  });

  it("pause and resume report their timings", async () => {
    const t = new FakeTransport([{ suspendUs: 1234 }, { resumeUs: 99 }]);
    const m = new Machines(asTransport(t));
    expect((await m.pause("alpha")).suspendUs).toBe(1234);
    expect((await m.resume("alpha")).resumeUs).toBe(99);
  });

  it("resize names a size class and reports the reboot", async () => {
    const t = new FakeTransport([{ vcpu: 2, memoryBytes: 8 * 1024 ** 3, rebooted: true }]);
    const result = await new Machines(asTransport(t)).resize("alpha", { memory: "8G" });
    expect(t.calls[0]!.method).toBe("ResizeVm");
    // Naming memory alone leaves vcpu at 0 — the server resolves the class.
    expect(t.calls[0]!.req).toEqual({ vmId: "alpha", vcpu: 0, memoryBytes: 8 * 1024 ** 3 });
    expect(result).toEqual({ vcpu: 2, memoryBytes: 8 * 1024 ** 3, rebooted: true });
  });

  it("resize without a size is refused before the wire", async () => {
    // Both zero would leave the server nothing to resolve, so it never gets sent.
    const t = new FakeTransport([]);
    await expect(new Machines(asTransport(t)).resize("alpha", {})).rejects.toThrow(BoxdError);
    expect(t.calls).toEqual([]);
  });

  it("share and unshare hit their own RPCs", async () => {
    const t = new FakeTransport([{}, {}]);
    const m = new Machines(asTransport(t));
    await m.share("alpha");
    await m.unshare("alpha");
    expect(t.calls.map((c) => c.method)).toEqual(["ShareVm", "UnshareVm"]);
  });

  it("waitUntilReady returns once the machine runs and exec round-trips", async () => {
    // Status alone is not enough — it also proves an exec gets through.
    const t = new FakeTransport([aVm()], { chunks: [chunk({ exitCode: 0 })] });
    const machine = await new Machines(asTransport(t)).waitUntilReady("alpha");
    expect(machine.status).toBe("running");
    expect(t.calls.map((c) => c.method)).toEqual(["GetVm", "Exec"]);
  });

  it("waitUntilReady gives up immediately on a terminal state", async () => {
    const t = new FakeTransport([{ ...aVm(), status: "failed" }]);
    await expect(
      new Machines(asTransport(t)).waitUntilReady("alpha"),
    ).rejects.toThrow("terminal state 'failed'");
  });

  it("the idle timeouts send 0 to disable", async () => {
    const t = new FakeTransport([{}, {}]);
    const m = new Machines(asTransport(t));
    await m.setAutoSuspendTimeout("alpha", 0);
    await m.setAutoHibernateTimeout("alpha", 300);
    expect(t.calls[0]!.req.timeoutSecs).toBe(0);
    expect(t.calls[1]!.req.timeoutSecs).toBe(300);
  });

  it("create sends idleIgnoreOutbound only when asked, and false as false", async () => {
    // `optional` on the wire: unset lets a new machine take its
    // org's default, so a defaulted false must never go out.
    const created = (name: string) => [{ vmId: `vm-${name}`, name }, aVm(name)];
    const t = new FakeTransport(["a", "b", "c", "d"].flatMap(created));
    const machines = new Machines(asTransport(t));
    await machines.create({ name: "a" });
    await machines.create({ name: "b", config: { vcpu: 4 } });
    await machines.create({ name: "c", config: { idleIgnoreOutbound: false } });
    await machines.create({ name: "d", config: { idleIgnoreOutbound: true } });

    const sent = t.calls.filter((c) => c.method === "CreateVm");
    expect(sent[0]!.req.config).toBeUndefined();
    expect((sent[1]!.req.config as { idleIgnoreOutbound?: boolean }).idleIgnoreOutbound).toBeUndefined();
    expect(sent.map((c) => onTheWire(CreateVmRequest, c.req).config?.idleIgnoreOutbound)).toEqual([
      undefined,
      undefined,
      false,
      true,
    ]);
  });

  it("fork and create(fromSnapshot) carry idleIgnoreOutbound the same way", async () => {
    // Unset keeps the source's value, so only an explicit true or false is sent.
    const created = (name: string) => [{ vmId: `vm-${name}`, name }, aVm(name)];
    const t = new FakeTransport(["a", "b", "c", "d", "e", "f"].flatMap(created));
    const machines = new Machines(asTransport(t));
    await machines.fork("alpha", { name: "a" });
    await machines.fork("alpha", { name: "b", config: { idleIgnoreOutbound: false } });
    await machines.fork("alpha", { name: "c", config: { idleIgnoreOutbound: true } });
    await machines.create({ fromSnapshot: "base", name: "d" });
    await machines.create({ fromSnapshot: "base", name: "e", config: { idleIgnoreOutbound: false } });
    await machines.create({ fromSnapshot: "base", name: "f", config: { idleIgnoreOutbound: true } });

    const forks = t.calls.filter((c) => c.method === "ForkVm");
    expect(forks.map((c) => onTheWire(ForkVmRequest, c.req).config?.idleIgnoreOutbound)).toEqual([
      undefined,
      false,
      true,
    ]);
    const restores = t.calls.filter((c) => c.method === "CreateVmFromSnapshot");
    expect(
      restores.map((c) => onTheWire(CreateVmFromSnapshotRequest, c.req).config?.idleIgnoreOutbound),
    ).toEqual([undefined, false, true]);
  });

  it("setIdleIgnoreOutbound sends the flag either way", async () => {
    const t = new FakeTransport([{}, {}]);
    const m = new Machines(asTransport(t));
    await m.setIdleIgnoreOutbound("alpha", true);
    await m.setIdleIgnoreOutbound("alpha", false);
    expect(t.calls.map((c) => c.method)).toEqual(["SetIdleIgnoreOutbound", "SetIdleIgnoreOutbound"]);
    expect(t.calls[0]!.req).toEqual({ vmId: "alpha", enabled: true });
    expect(t.calls[1]!.req).toEqual({ vmId: "alpha", enabled: false });
  });

  it("get reports the machine's idleIgnoreOutbound", async () => {
    const t = new FakeTransport([{ ...aVm(), idleIgnoreOutbound: true }, aVm()]);
    const machines = new Machines(asTransport(t));
    expect((await machines.get("alpha")).idleIgnoreOutbound).toBe(true);
    expect((await machines.get("alpha")).idleIgnoreOutbound).toBe(false);
  });

  it("create sends ssh only when asked, and false as false", async () => {
    // `optional` on the wire: unset gives a new machine SSH, so a defaulted
    // true must never go out, not even next to proxies.
    const created = (name: string) => [{ vmId: `vm-${name}`, name }, aVm(name)];
    const t = new FakeTransport(["a", "b", "c", "d"].flatMap(created));
    const machines = new Machines(asTransport(t));
    await machines.create({ name: "a", config: { vcpu: 4 } });
    await machines.create({ name: "b", config: { proxies: [{ name: "web", port: 3000 }] } });
    await machines.create({ name: "c", config: { ssh: false } });
    await machines.create({ name: "d", config: { ssh: true } });

    const sent = t.calls.filter((c) => c.method === "CreateVm");
    expect((sent[0]!.req.config as { network?: unknown }).network).toBeUndefined();
    expect((sent[1]!.req.config as { network?: { ssh?: boolean } }).network!.ssh).toBeUndefined();
    expect(sent.map((c) => onTheWire(CreateVmRequest, c.req).config?.network?.ssh)).toEqual([
      undefined,
      undefined,
      false,
      true,
    ]);
  });

  it("fork and create(fromSnapshot) carry ssh the same way", async () => {
    // Unset keeps the source's setting (a fork of a machine with SSH off
    // stays off), so only an explicit true or false is sent.
    const created = (name: string) => [{ vmId: `vm-${name}`, name }, aVm(name)];
    const t = new FakeTransport(["a", "b", "c", "d", "e", "f"].flatMap(created));
    const machines = new Machines(asTransport(t));
    const proxies = [{ name: "web", port: 3000 }];
    await machines.fork("alpha", { name: "a", config: { proxies } });
    await machines.fork("alpha", { name: "b", config: { ssh: false } });
    await machines.fork("alpha", { name: "c", config: { ssh: true } });
    await machines.create({ fromSnapshot: "base", name: "d", config: { proxies } });
    await machines.create({ fromSnapshot: "base", name: "e", config: { ssh: false } });
    await machines.create({ fromSnapshot: "base", name: "f", config: { ssh: true } });

    const forks = t.calls.filter((c) => c.method === "ForkVm");
    expect(forks.map((c) => onTheWire(ForkVmRequest, c.req).config?.network?.ssh)).toEqual([
      undefined,
      false,
      true,
    ]);
    const restores = t.calls.filter((c) => c.method === "CreateVmFromSnapshot");
    expect(
      restores.map((c) => onTheWire(CreateVmFromSnapshotRequest, c.req).config?.network?.ssh),
    ).toEqual([undefined, false, true]);
  });

  it("setSsh sends the flag either way", async () => {
    const t = new FakeTransport([{}, {}]);
    const m = new Machines(asTransport(t));
    expect(await m.setSsh("alpha", false)).toBeUndefined();
    await m.setSsh("alpha", true);
    expect(t.calls.map((c) => c.method)).toEqual(["SetSsh", "SetSsh"]);
    expect(t.calls[0]!.req).toEqual({ vmId: "alpha", enabled: false });
    expect(t.calls[1]!.req).toEqual({ vmId: "alpha", enabled: true });
  });

  it("get reports the machine's ssh", async () => {
    const t = new FakeTransport([{ ...aVm(), sshDisabled: true }, aVm()]);
    const machines = new Machines(asTransport(t));
    expect((await machines.get("alpha")).ssh).toBe(false);
    expect((await machines.get("alpha")).ssh).toBe(true);
  });
});

// ── exec & logs ───────────────────────────────────────────────────────────

describe("machines.exec", () => {
  it("folds the stream into one result", async () => {
    const t = new FakeTransport([], {
      chunks: [
        chunk({ data: enc("hello ") }),
        chunk({ data: enc("oops"), isStderr: true }),
        chunk({ data: enc("world"), exitCode: 0 }),
      ],
    });
    const result = await new Machines(asTransport(t)).exec("alpha", {
      command: ["echo", "hi"],
    });
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("oops");
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    // The command travels as one shell line on the first chunk.
    const init = t.streams[0]!.written[0]!;
    expect(init.command).toBe("echo hi");
    expect(init.vmId).toBe("alpha");
  });

  it("prefixes env assignments onto the command line", async () => {
    const t = new FakeTransport([], { chunks: [chunk({ exitCode: 0 })] });
    await new Machines(asTransport(t)).exec("alpha", {
      command: "env",
      env: { MODE: "a b" },
    });
    expect(t.streams[0]!.written[0]!.command).toBe("MODE='a b' env");
  });

  it("default encoding corrupts invalid UTF-8", async () => {
    const raw = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
    const t = new FakeTransport([], { chunks: [chunk({ data: raw, exitCode: 0 })] });
    const result = await new Machines(asTransport(t)).exec("alpha", { command: "cat" });
    expect(typeof result.stdout).toBe("string");
    expect(result.stdout).toBe(" ��");
  });

  it("encoding: buffer is byte-exact", async () => {
    const raw = new Uint8Array(256).map((_, i) => i);
    const t = new FakeTransport([], { chunks: [chunk({ data: raw, exitCode: 0 })] });
    const result = await new Machines(asTransport(t)).exec("alpha", {
      command: "cat",
      encoding: "buffer",
    });
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect(result.stdout).toEqual(raw);
  });

  it("prepends a cd onto the command line for cwd", async () => {
    const t = new FakeTransport([], { chunks: [chunk({ exitCode: 0 })] });
    await new Machines(asTransport(t)).exec("alpha", {
      command: "pwd",
      cwd: "/opt/my app",
    });
    expect(t.streams[0]!.written[0]!.command).toBe("cd '/opt/my app' && pwd");
  });

  it("reports a non-zero exit as unsuccessful", async () => {
    const t = new FakeTransport([], { chunks: [chunk({ exitCode: 3 })] });
    const result = await new Machines(asTransport(t)).exec("alpha", { command: "false" });
    expect(result.exitCode).toBe(3);
    expect(result.success).toBe(false);
  });

  it("carries tty and its geometry on the first chunk", async () => {
    const t = new FakeTransport([], { chunks: [chunk({ exitCode: 0 })] });
    await new Machines(asTransport(t)).exec("alpha", {
      command: "top",
      tty: true,
      cols: 120,
      rows: 40,
    });
    const init = t.streams[0]!.written[0]!;
    expect(init.tty).toBe(true);
    expect(init.cols).toBe(120);
    expect(init.rows).toBe(40);
  });

  it("streamExec sends the init chunk and refuses closeStdin with a tty", () => {
    const t = new FakeTransport([], { chunks: [] });
    expect(() =>
      new Machines(asTransport(t)).streamExec("alpha", {
        command: "bash",
        tty: true,
        closeStdin: true,
      }),
    ).toThrow("incompatible with `tty`");
  });

  it("logs yields the raw chunks", async () => {
    const t = new FakeTransport([], {
      chunks: [{ data: enc("line one\n") }, { data: enc("line two\n") }],
    });
    const out: string[] = [];
    for await (const c of new Machines(asTransport(t)).logs("alpha", { follow: true })) {
      out.push(new TextDecoder().decode(c));
    }
    expect(out).toEqual(["line one\n", "line two\n"]);
  });
});

// ── machine sub-namespaces ────────────────────────────────────────────────

describe("machines.files", () => {
  it("uploads small payloads in one message and reports the confirmed count", async () => {
    const t = new FakeTransport([{ bytesWritten: 5 }]);
    const n = await new Machines(asTransport(t)).files.upload("alpha", "/tmp/x", "hello");
    expect(t.calls[0]!.method).toBe("UploadFile");
    expect(t.calls[0]!.req.path).toBe("/tmp/x");
    expect(n).toBe(5);
  });

  it("falls back to the sent size when the server does not confirm one", async () => {
    const t = new FakeTransport([{ bytesWritten: 0 }]);
    expect(await new Machines(asTransport(t)).files.upload("alpha", "/tmp/x", "hello")).toBe(5);
  });

  it("downloads bytes over the stream and concatenates", async () => {
    const t = new FakeTransport([], {
      chunks: [
        { totalSize: 7, data: new Uint8Array() },
        { totalSize: 0, data: enc("pay") },
        { totalSize: 0, data: enc("load") },
      ],
    });
    const data = await new Machines(asTransport(t)).files.download("alpha", "/tmp/x");
    expect(t.calls[0]!.method).toBe("DownloadFileStream");
    expect(new TextDecoder().decode(data)).toBe("payload");
  });

  it("rejects a truncated download", async () => {
    const t = new FakeTransport([], {
      chunks: [
        { totalSize: 100, data: new Uint8Array() },
        { totalSize: 0, data: enc("short") },
      ],
    });
    await expect(
      new Machines(asTransport(t)).files.download("alpha", "/tmp/x"),
    ).rejects.toThrow(/truncated/);
  });

  it("reads a { fromPath } source from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-sdk-"));
    try {
      const file = join(dir, "payload.bin");
      writeFileSync(file, new Uint8Array([0, 1, 2, 255]));
      const t = new FakeTransport([{ bytesWritten: 4 }]);
      const files = new Machines(asTransport(t), nodePlatform).files;
      expect(await files.upload("alpha", "/tmp/payload.bin", { fromPath: file })).toBe(4);
      expect(t.calls[0]!.method).toBe("UploadFile");
      expect(Array.from(t.calls[0]!.req.data as Uint8Array)).toEqual([0, 1, 2, 255]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses { fromPath } without a file reader (the web entry)", async () => {
    const t = new FakeTransport();
    const upload = new Machines(asTransport(t)).files.upload("alpha", "/tmp/x", {
      fromPath: "/never/read",
    });
    await expect(upload).rejects.toThrow(BoxdError);
    await expect(upload).rejects.toThrow(/use the Node entry/);
    expect(t.calls).toHaveLength(0);
  });
});

describe("machines.ports", () => {
  it("exposes a port", async () => {
    const t = new FakeTransport([
      { vmId: "vm-1", vmName: "alpha", vmPort: 8080, publicPort: 31000, protocol: "both" },
    ]);
    const fwd = await new Machines(asTransport(t)).ports.expose("alpha", 8080, {
      protocol: "both",
    });
    expect(t.calls[0]!.req.protocol).toBe("both");
    expect(fwd.machinePort).toBe(8080);
    expect(fwd.publicPort).toBe(31000);
  });

  it("unexpose echoes back what was removed", async () => {
    const t = new FakeTransport([{ forward: { vmName: "alpha", vmPort: 8080 } }]);
    const fwd = await new Machines(asTransport(t)).ports.unexpose("alpha", 8080);
    expect(fwd.machinePort).toBe(8080);
  });

  it("list narrows to one machine, or stays account-wide", async () => {
    const t = new FakeTransport([{ forwards: [] }, { forwards: [] }]);
    const ports = new Machines(asTransport(t)).ports;
    await ports.list("vm-1");
    await ports.list();
    expect(t.calls[0]!.req.vm).toBe("vm-1");
    expect(t.calls[1]!.req.vm).toBe("");
  });
});

describe("machines.proxies", () => {
  it("create confirms the subdomain and the port it points at", async () => {
    const t = new FakeTransport([{ name: "web", port: 3000 }]);
    const created = await new Machines(asTransport(t)).proxies.create("alpha", "web", 3000);
    expect(t.calls[0]!.req).toEqual({ name: "web", vm: "alpha", vmName: "", port: 3000 });
    // Nothing else: the create answer is not a route description.
    expect(created).toEqual({ name: "web", port: 3000 });
  });

  it("addresses the machine by id or name, never the deprecated field", async () => {
    for (const ref of ["alpha", "vm-0f3a91"]) {
      const t = new FakeTransport([{ proxies: [] }]);
      await new Machines(asTransport(t)).proxies.list(ref);
      expect(t.calls[0]!.req.vm).toBe(ref);
      expect(t.calls[0]!.req.vmName).toBe("");
    }
  });

  it("list maps the effective port, not the stored one", async () => {
    const t = new FakeTransport([
      {
        proxies: [
          {
            name: "",
            vmId: "vm-1",
            vmName: "alpha",
            isDefault: true,
            portMode: "auto",
            port: 0,
            effectivePort: 8000,
            domain: "alpha.boxd.sh",
          },
        ],
      },
    ]);
    const [route] = await new Machines(asTransport(t)).proxies.list("alpha");
    expect(route!.isDefault).toBe(true);
    expect(route!.machineId).toBe("vm-1");
    expect(route!.port).toBe(8000);
    expect(route!.portMode).toBe("auto");
    // The default route reports no name.
    expect(route!.name).toBeNull();
  });

  it("delete names the route", async () => {
    const t = new FakeTransport([{}]);
    await new Machines(asTransport(t)).proxies.delete("alpha", "web");
    expect(t.calls[0]!.method).toBe("DeleteProxy");
    expect(t.calls[0]!.req.name).toBe("web");
  });

  it("setPort stringifies a pinned port", async () => {
    const t = new FakeTransport([{}]);
    await new Machines(asTransport(t)).proxies.setPort("alpha", 3000, { name: "web" });
    expect(t.calls[0]!.req.port).toBe("3000");
    expect(t.calls[0]!.req.name).toBe("web");
  });

  it("setPort accepts auto for the default route", async () => {
    const t = new FakeTransport([{}]);
    await new Machines(asTransport(t)).proxies.setPort("alpha", "auto");
    expect(t.calls[0]!.req.port).toBe("auto");
    // No name = the machine's default route, the only one auto works on.
    expect(t.calls[0]!.req.name).toBe("");
  });
});

describe("machines.checkpoints", () => {
  it("round-trips create, list, restore and delete", async () => {
    const t = new FakeTransport([
      { checkpointId: "cp-1", name: "pre", status: "pending" },
      { checkpoints: [{ checkpointId: "cp-1", name: "pre", available: true, createdAt: 1 }] },
      {},
      {},
    ]);
    const cps = new Machines(asTransport(t)).checkpoints;
    expect((await cps.create("alpha", "pre")).id).toBe("cp-1");
    expect((await cps.list("alpha"))[0]!.available).toBe(true);
    await cps.restore("alpha", "pre");
    await cps.delete("alpha", "pre");
    expect(t.calls.map((c) => c.method)).toEqual([
      "CreateCheckpoint",
      "ListCheckpoints",
      "RestoreCheckpoint",
      "DeleteCheckpoint",
    ]);
  });

  it("reports an unrecorded author as null, not an empty string", async () => {
    const t = new FakeTransport([
      { checkpoints: [{ checkpointId: "cp-1", name: "pre", createdAt: 1, createdBy: "" }] },
    ]);
    const [cp] = await new Machines(asTransport(t)).checkpoints.list("alpha");
    expect(cp!.createdBy).toBeNull();
    expect(cp!.createdAt).toBeInstanceOf(Date);
  });
});

// ── snapshots ─────────────────────────────────────────────────────────────

describe("snapshots", () => {
  it("create takes the machine and the name positionally", async () => {
    const t = new FakeTransport([
      { snapshotId: "s1", name: "base", version: 1, status: "pending" },
    ]);
    const created = await new Snapshots(asTransport(t)).create("alpha", "base");
    expect(t.calls[0]!.req).toEqual({ vm: "alpha", name: "base" });
    expect(created).toEqual({ id: "s1", name: "base", version: 1, status: "pending", pausedAutomations: 0 });
  });

  it("get unwraps the response", async () => {
    const t = new FakeTransport([{ snapshot: { snapshotId: "s1", name: "base", version: 3 } }]);
    const snap = await new Snapshots(asTransport(t)).get("base");
    expect(snap.id).toBe("s1");
    expect(snap.version).toBe(3);
  });

  it("list and delete pass the org through", async () => {
    const t = new FakeTransport([{ snapshots: [] }, {}]);
    const snaps = new Snapshots(asTransport(t));
    expect(await snaps.list({ org: "acme" })).toEqual([]);
    await snaps.delete("base", { org: "acme" });
    expect(t.calls.map((c) => c.method)).toEqual(["ListSnapshots", "DeleteSnapshot"]);
    expect(t.calls[0]!.req.org).toBe("acme");
    expect(t.calls[1]!.req.org).toBe("acme");
  });
});

// ── disks ─────────────────────────────────────────────────────────────────

describe("disks", () => {
  it("create parses a human size and answers with the created disk", async () => {
    const t = new FakeTransport([
      { diskId: "d1", name: "data", sizeBytes: 10 * 1024 ** 3, status: "creating" },
    ]);
    const disk = await new Disks(asTransport(t)).create("data", "10G");
    expect(t.calls[0]!.req.sizeBytes).toBe(10 * 1024 ** 3);
    // A brand-new disk has no attachments to describe, so it is its own shape.
    expect(disk).toEqual({
      id: "d1",
      name: "data",
      sizeBytes: 10 * 1024 ** 3,
      status: "creating",
    });
  });

  it("create takes a byte count too", async () => {
    const t = new FakeTransport([{ diskId: "d1", name: "data" }]);
    await new Disks(asTransport(t)).create("data", 1024);
    expect(t.calls[0]!.req.sizeBytes).toBe(1024);
  });

  it("list reports attachments", async () => {
    const t = new FakeTransport([
      {
        disks: [
          {
            diskId: "d1",
            name: "data",
            sizeBytes: 1024,
            status: "ready",
            createdAt: 1,
            attachments: [
              { vmId: "vm-1", vmName: "alpha", mountPath: "/data", mountMode: "rw" },
            ],
          },
        ],
      },
    ]);
    const [disk] = await new Disks(asTransport(t)).list();
    expect(disk!.attachments[0]!.mountPath).toBe("/data");
    expect(disk!.createdAt).toBeInstanceOf(Date);
  });

  it("attach, detach and delete address the disk by id", async () => {
    const t = new FakeTransport([{}, {}, {}]);
    const disks = new Disks(asTransport(t));
    await disks.attach("d1", "alpha", "/data", { readOnly: true });
    await disks.detach("d1", "alpha");
    await disks.delete("d1");
    expect(t.calls.map((c) => c.method)).toEqual(["AttachDisk", "DetachDisk", "DestroyDisk"]);
    expect(t.calls[0]!.req).toEqual({
      diskId: "d1",
      vmId: "alpha",
      mountPath: "/data",
      readOnly: true,
    });
  });

  it("attach defaults to writable", async () => {
    const t = new FakeTransport([{}]);
    await new Disks(asTransport(t)).attach("d1", "alpha", "/data");
    expect(t.calls[0]!.req.readOnly).toBe(false);
  });
});

// ── env & secrets ─────────────────────────────────────────────────────────

describe("env and secrets", () => {
  it("differ only by kind", async () => {
    const envT = new FakeTransport([{ message: "set MODE" }]);
    expect(await new EnvVars(asTransport(envT)).set("MODE", "prod")).toBe("set MODE");
    expect(envT.calls[0]!.req.kind).toBe("env");

    const secT = new FakeTransport([{ message: "set TOKEN" }]);
    expect(await new Secrets(asTransport(secT)).set("TOKEN", "s3cr3t")).toBe("set TOKEN");
    expect(secT.calls[0]!.req.kind).toBe("secret");
  });

  it("scope and org default to empty", async () => {
    const t = new FakeTransport([{ message: "removed" }]);
    await new EnvVars(asTransport(t)).delete("MODE");
    expect(t.calls[0]!.req.scope).toBe("");
    expect(t.calls[0]!.req.org).toBe("");
  });

  it("delete returns the server's confirmation", async () => {
    const t = new FakeTransport([{ message: "removed MODE" }]);
    expect(await new EnvVars(asTransport(t)).delete("MODE")).toBe("removed MODE");
    expect(t.calls[0]!.method).toBe("RemoveVar");
  });

  it("env list keeps the value; secret list has none", async () => {
    const envT = new FakeTransport([
      { vars: [{ name: "MODE", kind: "env", scope: "all", value: "prod" }] },
    ]);
    expect((await new EnvVars(asTransport(envT)).list())[0]!.value).toBe("prod");

    const secT = new FakeTransport([
      { vars: [{ name: "TOKEN", kind: "secret", scope: "all", value: "" }] },
    ]);
    const [secret] = await new Secrets(asTransport(secT)).list();
    expect(secret).toEqual({ name: "TOKEN", scope: "all", domains: [], boundMachines: 0 });
    expect("value" in secret!).toBe(false);
  });

  it("an unattached secret is set with its scope and lists how many machines use it", async () => {
    const setT = new FakeTransport([{ message: "set NPM_TOKEN" }]);
    await new Secrets(asTransport(setT)).set("NPM_TOKEN", "v", { scope: "unattached", org: "acme" });
    expect(setT.calls[0]!.req.scope).toBe("unattached");
    expect(setT.calls[0]!.req.org).toBe("acme");

    const listT = new FakeTransport([
      {
        vars: [
          { name: "NPM_TOKEN", kind: "secret", scope: "unattached", value: "", boundMachines: 3 },
          { name: "GH_PAT", kind: "secret", scope: "private-unattached", value: "", boundMachines: 0 },
        ],
      },
    ]);
    const listed = await new Secrets(asTransport(listT)).list({ org: "acme" });
    expect(listed.map((s) => [s.scope, s.boundMachines])).toEqual([
      ["unattached", 3],
      ["private-unattached", 0],
    ]);
  });

  it("secrets.set forwards domains; env.set never sends any", async () => {
    const secT = new FakeTransport([{ message: "ok" }]);
    await new Secrets(asTransport(secT)).set("TOKEN", "v", { domains: ["api.example.com"] });
    expect(secT.calls[0]!.req.domains).toEqual(["api.example.com"]);

    const envT = new FakeTransport([{ message: "ok" }]);
    await new EnvVars(asTransport(envT)).set("MODE", "prod");
    expect(envT.calls[0]!.req.domains).toEqual([]);
  });

  it("move requires both ends and returns the confirmation", async () => {
    const t = new FakeTransport([{ message: "moved" }]);
    const out = await new Secrets(asTransport(t)).move("TOKEN", {
      from: "private",
      to: "shared",
      org: "acme",
    });
    expect(t.calls[0]!.method).toBe("SetSecretScope");
    expect(t.calls[0]!.req.from).toBe("private");
    expect(t.calls[0]!.req.to).toBe("shared");
    expect(out).toBe("moved");
  });

  it("env move goes through the same RPC", async () => {
    // SetSecretScope is misnamed — it moves env vars too.
    const t = new FakeTransport([{ message: "moved" }]);
    await new EnvVars(asTransport(t)).move("MODE", { from: "all", to: "shared" });
    expect(t.calls[0]!.method).toBe("SetSecretScope");
  });
});

// ── orgs, api keys, account ───────────────────────────────────────────────

describe("orgs", () => {
  it("marks the default org with a flag rather than a wrapper field", async () => {
    const t = new FakeTransport([
      {
        orgs: [
          { id: "o1", name: "Acme", slug: "acme", isAdmin: true },
          { id: "o2", name: "Other", slug: "other", isAdmin: false },
        ],
        defaultOrgId: "o1",
      },
    ]);
    const orgs = await new Orgs(asTransport(t)).list();
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs.map((o) => o.isDefault)).toEqual([true, false]);
  });

  it("set/get/clear domain", async () => {
    const t = new FakeTransport([
      { domain: { orgId: "o1", domain: "preview.example.com", status: "pending" } },
      {},
      {},
    ]);
    const orgs = new Orgs(asTransport(t));
    const set = await orgs.setDomain("o1", "preview.example.com");
    expect(set.status).toBe("pending");
    expect(t.calls[0]!.req).toEqual({ orgId: "o1", domain: "preview.example.com" });
    expect(await orgs.getDomain("o1")).toBeNull();
    await orgs.clearDomain("o1");
    expect(t.calls.map((c) => c.method)).toEqual(["SetOrgDomain", "GetOrgDomain", "ClearOrgDomain"]);
  });

  it("set/get/clear machine defaults", async () => {
    const t = new FakeTransport([
      {},
      {
        set: true,
        vcpu: 2,
        memoryBytes: 8 * 1024 ** 3,
        ceilingVcpu: 4,
        ceilingMemoryBytes: 16 * 1024 ** 3,
      },
      {},
    ]);
    const orgs = new Orgs(asTransport(t));

    await orgs.setMachineDefaults("o1", { vcpu: 2 });
    expect(t.calls[0]!.req).toEqual({ orgId: "o1", vcpu: 2, memoryBytes: undefined });

    const defaults = await orgs.getMachineDefaults("o1");
    // `set` on the wire is `isSet` here.
    expect(defaults.isSet).toBe(true);
    expect(defaults.ceilingMemoryBytes).toBe(16 * 1024 ** 3);

    // Clearing is the same RPC with both fields ABSENT, not zeroed.
    await orgs.clearMachineDefaults("o1");
    const cleared = t.calls[2]!.req;
    expect(cleared.vcpu).toBeUndefined();
    expect(cleared.memoryBytes).toBeUndefined();
    expect(t.calls.map((c) => c.method)).toEqual([
      "SetOrgMachineDefaults",
      "GetOrgMachineDefaults",
      "SetOrgMachineDefaults",
    ]);
  });

  it("set/get/clear bot protection default", async () => {
    const t = new FakeTransport([
      { machinesChanged: 3, snapshotsChanged: 2, machinesOff: 1, machinesSkipped: 4 },
      { machinesChanged: 0, snapshotsChanged: 0, machinesOff: 0, machinesSkipped: 0 },
      { set: true, mode: "sleep_only", platformMode: "on" },
      {},
      { set: false, mode: "on", platformMode: "" },
    ]);
    const orgs = new Orgs(asTransport(t));

    // By default existing machines are changed too.
    const applied = await orgs.setBotProtectionDefault("o1", "sleep_only");
    expect(t.calls[0]!.req).toEqual({ orgId: "o1", mode: "sleep_only", newMachinesOnly: false });
    expect(applied).toEqual({ machinesChanged: 3, snapshotsChanged: 2, machinesOff: 1, machinesSkipped: 4 });

    await orgs.setBotProtectionDefault("o1", "on", { newMachinesOnly: true });
    expect(t.calls[1]!.req).toEqual({ orgId: "o1", mode: "on", newMachinesOnly: true });

    // `set` on the wire is `isSet` here.
    expect(await orgs.getBotProtectionDefault("o1")).toEqual({ isSet: true, mode: "sleep_only", platformMode: "on" });

    // Clearing is the same RPC with an EMPTY mode.
    await orgs.clearBotProtectionDefault("o1");
    expect(t.calls[3]!.req).toEqual({ orgId: "o1", mode: "", newMachinesOnly: false });

    // Unset: `mode` is what the platform gives new machines meanwhile.
    // A server that predates `platformMode` sends "": null here.
    expect(await orgs.getBotProtectionDefault("o1")).toEqual({ isSet: false, mode: "on", platformMode: null });
    expect(t.calls.map((c) => c.method)).toEqual([
      "SetOrgBotProtectionDefault",
      "SetOrgBotProtectionDefault",
      "GetOrgBotProtectionDefault",
      "SetOrgBotProtectionDefault",
      "GetOrgBotProtectionDefault",
    ]);
  });

  it("setBotProtectionDefault refuses what would clear it", async () => {
    // An empty mode clears on the wire, so `set` never sends one.
    const t = new FakeTransport([]);
    const orgs = new Orgs(asTransport(t));
    for (const bad of ["", "maybe", undefined]) {
      await expect(orgs.setBotProtectionDefault("o1", bad as never)).rejects.toThrow(/clearBotProtectionDefault/);
    }
    expect(t.calls).toEqual([]);
  });

  it("setMachineDefaults without a size points at clear", async () => {
    // Sending both absent would silently clear the default, so `set` refuses it.
    const t = new FakeTransport([]);
    await expect(new Orgs(asTransport(t)).setMachineDefaults("o1")).rejects.toThrow(
      /clearMachineDefaults/,
    );
    expect(t.calls).toEqual([]);
  });

  it("set/get/clear idleIgnoreOutbound default", async () => {
    const t = new FakeTransport([
      { machinesChanged: 3, snapshotsChanged: 2, machinesSkipped: 1 },
      { machinesChanged: 0, snapshotsChanged: 0, machinesSkipped: 0 },
      { machinesChanged: 0, snapshotsChanged: 0, machinesSkipped: 0 },
      { set: true, enabled: true, platformEnabled: false },
      { set: false, enabled: true, platformEnabled: true },
      {},
    ]);
    const orgs = new Orgs(asTransport(t));

    // Existing machines change by default. `applyExisting` rides
    // along as the opposite of `newMachinesOnly`, so a server that predates
    // `newMachinesOnly` does the same.
    const applied = await orgs.setIdleIgnoreOutboundDefault("o1", { enabled: true });
    expect(t.calls[0]!.method).toBe("SetOrgIdleIgnoreOutboundDefault");
    expect(t.calls[0]!.req).toEqual({ orgId: "o1", enabled: true, newMachinesOnly: false, applyExisting: true });
    expect(applied).toEqual({ machinesChanged: 3, snapshotsChanged: 2, machinesSkipped: 1 });

    // An explicit false is a default too; newMachinesOnly leaves existing
    // machines alone.
    const plain = await orgs.setIdleIgnoreOutboundDefault("o1", { enabled: false, newMachinesOnly: true });
    expect(t.calls[1]!.req).toEqual({ orgId: "o1", enabled: false, newMachinesOnly: true, applyExisting: false });
    const wire = onTheWire(SetOrgIdleIgnoreOutboundDefaultRequest, t.calls[1]!.req);
    expect([wire.enabled, wire.newMachinesOnly, wire.applyExisting]).toEqual([false, true, false]);
    expect(plain).toEqual({ machinesChanged: 0, snapshotsChanged: 0, machinesSkipped: 0 });

    // `applyExisting` from code written against 0.2.16 is accepted and is
    // what happens anyway.
    await orgs.setIdleIgnoreOutboundDefault("o1", { enabled: true, applyExisting: true });
    expect(t.calls[2]!.req).toEqual({ orgId: "o1", enabled: true, newMachinesOnly: false, applyExisting: true });

    // `set` on the wire is `isSet` here; with no org default, `enabled` is the
    // platform's setting.
    expect(await orgs.getIdleIgnoreOutboundDefault("o1")).toEqual({
      isSet: true,
      enabled: true,
      platformEnabled: false,
    });
    expect(t.calls[3]!.method).toBe("GetOrgIdleIgnoreOutboundDefault");
    expect(t.calls[3]!.req).toEqual({ orgId: "o1" });
    expect(await orgs.getIdleIgnoreOutboundDefault()).toEqual({
      isSet: false,
      enabled: true,
      platformEnabled: true,
    });
    expect(t.calls[4]!.req).toEqual({ orgId: "" });

    // Clearing is the same RPC with `enabled` ABSENT, not false, and asks for
    // nothing to be applied (an older server refuses that).
    await orgs.clearIdleIgnoreOutboundDefault("o1");
    const cleared = t.calls[5]!;
    expect(cleared.method).toBe("SetOrgIdleIgnoreOutboundDefault");
    expect(cleared.req.enabled).toBeUndefined();
    expect(cleared.req.applyExisting).toBe(false);
    expect(cleared.req.newMachinesOnly).toBe(false);
    expect(onTheWire(SetOrgIdleIgnoreOutboundDefaultRequest, cleared.req).enabled).toBeUndefined();
  });

  it("setIdleIgnoreOutboundDefault refuses applyExisting with newMachinesOnly", async () => {
    const t = new FakeTransport([]);
    await expect(
      new Orgs(asTransport(t)).setIdleIgnoreOutboundDefault("o1", {
        enabled: true,
        newMachinesOnly: true,
        applyExisting: true,
      }),
    ).rejects.toThrow(/newMachinesOnly/);
    expect(t.calls).toEqual([]);
  });

  it("setIdleIgnoreOutboundDefault without enabled points at clear", async () => {
    // Sending it absent would silently clear the default, so `set` refuses it.
    const t = new FakeTransport([]);
    await expect(
      new Orgs(asTransport(t)).setIdleIgnoreOutboundDefault("o1", {} as never),
    ).rejects.toThrow(/clearIdleIgnoreOutboundDefault/);
    expect(t.calls).toEqual([]);
  });
});

describe("usage and billing activity", () => {
  const vmUsage = {
    vmId: "vm-1",
    name: "alpha",
    owner: "usr_1",
    ownerName: "",
    sharing: "shared",
    status: "running",
    vcpu: 2,
    memoryBytes: 8 * 1024 ** 3,
    diskBytes: 100 * 1024 ** 3,
    seconds: { running: 3600, standby: 60, hibernated: 0, stopped: 0 },
    vcpuHours: 2,
    ramGibHours: 1.5,
    diskGibHours: 20,
    costMicro: 1_230_000,
    complete: true,
  };
  const rates = { vcpuHourMicro: 49_000, ramGibHourMicro: 15_000, diskGibHourMicro: 100 };

  it("machines.usage sends the window as unix seconds and flattens the report", async () => {
    const t = new FakeTransport([
      { periodStart: 1_000, periodEnd: 2_000, currency: "eur", rates, usage: vmUsage },
    ]);
    const u = await new Machines(asTransport(t)).usage("alpha", { since: new Date(1_500_000) });
    expect(t.calls[0]).toEqual({
      method: "GetVmUsage",
      req: { vmId: "alpha", since: 1_500, until: 0, org: "" },
    });
    expect(u.machineId).toBe("vm-1");
    expect(u.ownerId).toBe("usr_1");
    expect(u.ownerName).toBeNull();
    expect(u.shared).toBe(true);
    expect(u.seconds.running).toBe(3600);
    expect(u.costMicro).toBe(1_230_000);
    expect(u.complete).toBe(true);
    expect(u.currency).toBe("eur");
    expect(u.period).toEqual({ start: new Date(1_000_000), end: new Date(2_000_000) });
    expect(u.rates).toEqual(rates);
  });

  it("orgs.usage maps every machine and the total", async () => {
    const t = new FakeTransport([
      {
        orgId: "o1",
        org: "team",
        periodStart: 1_000,
        periodEnd: 2_000,
        currency: "usd",
        rates,
        totalCostMicro: 1_230_000,
        vms: [vmUsage],
      },
    ]);
    const r = await new Orgs(asTransport(t)).usage({ org: "team", since: 1_000 });
    expect(t.calls[0]).toEqual({
      method: "GetOrgUsage",
      req: { org: "team", since: 1_000, until: 0 },
    });
    expect(r.totalCostMicro).toBe(1_230_000);
    expect(r.machines.map((m) => m.name)).toEqual(["alpha"]);
  });

  it("orgs.billingActivity walks every page", async () => {
    const entry = (id: string) => ({ entryId: id, kind: "usage_charge", amountMicro: -5, createdAt: 1_000 });
    const t = new FakeTransport([
      { currency: "eur", balanceMicro: 10, entries: [entry("a"), entry("b")], nextPageToken: "tok" },
      { currency: "eur", balanceMicro: 10, entries: [entry("c")], nextPageToken: "" },
    ]);
    const ids: string[] = [];
    for await (const e of new Orgs(asTransport(t)).billingActivity({ pageSize: 2 })) ids.push(e.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(t.calls.map((c) => c.req.pageToken)).toEqual(["", "tok"]);
    expect(t.calls[0].req.pageSize).toBe(2);
  });
});

describe("domains", () => {
  it("create binds a domain and starts verification immediately", async () => {
    const t = new FakeTransport([
      { domain: { domain: "app.example.com", vmId: "alpha", vmName: "alpha", status: "pending" } },
    ]);
    const ns = new Domains(asTransport(t));
    const created = await ns.create({ domain: "app.example.com", machine: "alpha" });
    expect(created.status).toBe("pending");
    expect(t.calls[0]!.req).toEqual({ domain: "app.example.com", vmId: "alpha" });
  });

  it("dnsInstructions is local (no network call)", async () => {
    const { dnsInstructions } = await import("../src/domains.js");
    const text = dnsInstructions("app.example.com", {
      machineName: "alpha",
      machineIp: "1.2.3.4",
      zone: "boxd.sh",
    });
    expect(text).toContain("1.2.3.4");
    expect(text).toContain("alpha.boxd.sh");
  });

  it("list and delete", async () => {
    const t = new FakeTransport([
      { domains: [{ domain: "app.example.com", vmId: "alpha", vmName: "alpha", status: "active" }] },
      {},
    ]);
    const domains = new Domains(asTransport(t));
    expect((await domains.list())[0]!.domain).toBe("app.example.com");
    await domains.delete("app.example.com");
    expect(t.calls.map((c) => c.method)).toEqual(["ListCustomDomains", "RemoveCustomDomain"]);
    expect(t.calls[1]!.req.domain).toBe("app.example.com");
  });
});

describe("apiKeys", () => {
  it("create returns the raw key once", async () => {
    const t = new FakeTransport([{ id: "k1", apiKey: "bxd_live", expiresAt: 0 }]);
    const created = await new ApiKeys(asTransport(t)).create({
      name: "ci",
      org: "acme",
      kind: "org",
    });
    expect(created.apiKey).toBe("bxd_live");
    expect(created.expiresAt).toBeNull();
    expect(t.calls[0]!.req.kind).toBe("org");
  });

  it("create defaults to no expiry and the caller's own org", async () => {
    const t = new FakeTransport([{ id: "k1", apiKey: "bxd_live" }]);
    await new ApiKeys(asTransport(t)).create({ name: "ci" });
    expect(t.calls[0]!.req).toEqual({ name: "ci", expiresInSecs: 0, org: "", kind: "" });
  });

  it("list and delete", async () => {
    const t = new FakeTransport([
      { keys: [{ id: "k1", name: "ci", keyPrefix: "bxd_a", createdAt: 1, org: "acme", kind: "member" }] },
      {},
    ]);
    const keys = new ApiKeys(asTransport(t));
    expect((await keys.list())[0]!.id).toBe("k1");
    await keys.delete("k1");
    expect(t.calls.map((c) => c.method)).toEqual(["ListApiKeys", "DeleteApiKey"]);
    expect(t.calls[1]!.req.id).toBe("k1");
  });
});

describe("account", () => {
  it("get maps the caller and their billing", async () => {
    const t = new FakeTransport([
      {
        userId: "u1",
        displayName: "ada",
        pubkeyFingerprints: ["SHA256:aaa"],
        billing: { subscriptionStatus: "active", maxVms: 10, vcpu: 2, memoryBytes: 8 },
      },
    ]);
    const account = await new AccountNamespace(asTransport(t)).get();
    expect(t.calls[0]!.method).toBe("Whoami");
    expect(account.userId).toBe("u1");
    expect(account.sshKeyFingerprints).toEqual(["SHA256:aaa"]);
    expect(account.billing.subscriptionStatus).toBe("active");
  });

  it("reports never having subscribed as null, not an empty string", async () => {
    const t = new FakeTransport([{ userId: "u1", displayName: "", billing: {} }]);
    const account = await new AccountNamespace(asTransport(t)).get();
    expect(account.billing.subscriptionStatus).toBeNull();
    expect(account.displayName).toBeNull();
  });

  it("linkSshKey sends empty strings for what was not given", async () => {
    const t = new FakeTransport([{}]);
    await new AccountNamespace(asTransport(t)).linkSshKey({ pubkey: "ssh-ed25519 AAAA" });
    expect(t.calls[0]!.req).toEqual({
      pubkey: "ssh-ed25519 AAAA",
      deviceId: "",
      label: "",
    });
  });

  it("config reports the cluster defaults", async () => {
    const t = new FakeTransport([{ defaultImage: "debian:12", zone: "boxd.sh" }]);
    const config = await new AccountNamespace(asTransport(t)).config();
    expect(config).toEqual({ defaultImage: "debian:12", zone: "boxd.sh" });
  });
});

describe("orgs machine limit", () => {
  it("reads the limit and the open request, and asks for more", async () => {
    const t = new FakeTransport([
      { orgId: "org-1", orgName: "acme", maxVms: 50, vmCount: 48, isOwner: true, requestedAt: 0, requestedMaxVms: 0 },
      { requestedAt: 1_790_000_000, requestedMaxVms: 80 },
      { orgId: "org-1", orgName: "acme", maxVms: 50, vmCount: 48, isOwner: false, requestedAt: 1_790_000_000, requestedMaxVms: 80 },
    ]);
    const orgs = new Orgs(asTransport(t));

    const before = await orgs.getMachineLimit("acme");
    expect(t.calls[0]).toEqual({ method: "GetOrgMachineLimit", req: { orgId: "acme" } });
    expect(before).toEqual({ orgId: "org-1", orgName: "acme", maxVms: 50, vmCount: 48, isOwner: true, request: null });

    const opened = await orgs.requestMachineLimit(80, { message: "CI runners" });
    expect(t.calls[1]).toEqual({
      method: "RequestOrgMachineLimit",
      req: { orgId: "", maxVms: 80, message: "CI runners" },
    });
    expect(opened).toEqual({ requestedAt: new Date(1_790_000_000 * 1000), maxVms: 80 });

    // Every member sees the open request; only the owner is told they own it.
    const after = await orgs.getMachineLimit();
    expect(after.isOwner).toBe(false);
    expect(after.request).toEqual(opened);
  });

  it("refuses a limit that isn't a whole number above 0 without a call", async () => {
    const t = new FakeTransport([]);
    const orgs = new Orgs(asTransport(t));
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(orgs.requestMachineLimit(bad)).rejects.toThrow(/maxVms/);
    }
    expect(t.calls).toEqual([]);
  });
});
