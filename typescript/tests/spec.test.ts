/**
 * Machine specs: the builder, the pieces, the merge rules (against the
 * fixtures the server and the Python SDK share, when this checkout has
 * them) and how `machines.create()` sends a spec.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import type { Transport } from "../src/_rpc.js";
import type { GetVmResponse } from "../src/_generated/definitions.js";
import { BoxdError, ConflictError, GrpcStatus, fromGrpcError } from "../src/errors.js";
import {
  Machine,
  MachineSpecBuilder,
  Machines,
  asana,
  claude,
  codex,
  github,
  jira,
  mergeSpecs,
  secrets,
  slack,
  snapshot,
  specPatch,
  team,
  type MachineSpec,
  type MachineSpecPatch,
  type MachineSpecPiece,
} from "../src/index.js";
import { toMachine, toMachineSpecUpdate } from "../src/models.js";
import { applySpecPatch, checkSpecPatch } from "../src/spec.js";

// The merge cases the server and both SDKs run. This is a copy of the
// server's file, kept identical to it by a test on the server side.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/machine_spec_merge.json");

interface Case {
  name: string;
  pieces: MachineSpecPiece[];
  expect?: MachineSpec;
  error?: string;
}

describe("shared merge fixtures", () => {
  const cases: Case[] = JSON.parse(readFileSync(FIXTURES, "utf8")).cases;
  for (const c of cases) {
    it(c.name, () => {
      if (c.error !== undefined) {
        expect(() => mergeSpecs(...c.pieces)).toThrow(c.error);
        // And through the builder, which checks as it goes.
        expect(() => Machine.spec().with(...c.pieces).resolve()).toThrow(c.error);
      } else {
        expect(mergeSpecs(...c.pieces)).toEqual(c.expect!);
        expect(Machine.spec().with(...c.pieces).resolve()).toEqual(c.expect!);
      }
    });
  }
});

describe("assignTo", () => {
  it("is set by the builder and kept in the resolved spec", () => {
    const base = Machine.spec().from(team("eng"));
    expect(base.assignTo("usr_mike").resolve()).toEqual({
      version: 1,
      base: { team: "eng" },
      assignTo: "usr_mike",
    });
    // The same user twice is fine; a second, different one throws.
    expect(base.assignTo("usr_mike").assignTo("usr_mike").resolve().assignTo).toBe("usr_mike");
    expect(() => base.assignTo("usr_mike").assignTo("usr_ana")).toThrow(
      'spec.assignTo: set twice to different values: "usr_mike" and "usr_ana"',
    );
  });
});

describe("secrets", () => {
  it("is a piece listing names, combined in order without duplicates", () => {
    expect(secrets("NPM_TOKEN", "SENTRY_DSN")).toEqual({ secrets: ["NPM_TOKEN", "SENTRY_DSN"] });
    const s = Machine.spec()
      .with(secrets("NPM_TOKEN"))
      .with(secrets("GH_PAT", "NPM_TOKEN"))
      .resolve();
    expect(s).toEqual({ version: 1, secrets: ["NPM_TOKEN", "GH_PAT"] });
  });

  it("throws when a name is also in env, wherever it was written", () => {
    const message =
      'spec.secrets: "NPM_TOKEN" is also in env; a name is either a plain value (env) or a secret (secrets), not both';
    expect(() => Machine.spec().with(secrets("NPM_TOKEN")).env("NPM_TOKEN", "x")).toThrow(message);
    expect(() => mergeSpecs({ env: { NPM_TOKEN: "x" }, secrets: ["NPM_TOKEN"] })).toThrow(message);
  });

  it("goes over the wire and comes back", async () => {
    const { transport, sent } = fakeTransport({
      spec: { version: 1, secrets: ["NPM_TOKEN", "GH_PAT"] },
    } as unknown as GetVmResponse);
    const m = await new Machines(transport).create({
      name: "mike-dev",
      org: "acme",
      spec: Machine.spec().with(secrets("NPM_TOKEN", "GH_PAT")),
    });
    expect((sent[0]!.req as { spec: { secrets: string[] } }).spec.secrets).toEqual([
      "NPM_TOKEN",
      "GH_PAT",
    ]);
    expect(m.spec).toEqual({ version: 1, secrets: ["NPM_TOKEN", "GH_PAT"] });
  });
});

describe("Machine.spec()", () => {
  it("builds the plan's example", () => {
    const engineering = Machine.spec()
      .from(team("eng"))
      .network("eng")
      .label("team", "eng")
      .env("NODE_ENV", "development")
      .with(github({ shared: "eng-bot" }), claude());
    const mike = engineering.size("2x8").with(slack(), jira({ shared: "jira" }), asana(), codex());
    expect(mike.resolve()).toEqual({
      version: 1,
      base: { team: "eng" },
      size: "2x8",
      labels: { team: "eng" },
      networks: ["eng"],
      env: { NODE_ENV: "development" },
      connections: {
        github: "shared:eng-bot",
        slack: "personal",
        jira: "shared:jira",
        asana: "personal",
      },
      agents: ["claude", "codex"],
    });
    // Builders are immutable: the shared base is untouched.
    expect(engineering.resolve().size).toBeUndefined();
  });

  it("takes label and env maps, egress, isolation and other builders", () => {
    const tools = Machine.spec().egress("github.com", "*.atlassian.net");
    const s = Machine.spec()
      .from(snapshot("eng-base"))
      .label({ a: "1", b: "2" })
      .env({ A: "1" })
      .isolated()
      .with(tools)
      .resolve();
    expect(s).toEqual({
      version: 1,
      base: { snapshot: "eng-base" },
      labels: { a: "1", b: "2" },
      isolated: true,
      egress: ["github.com", "*.atlassian.net"],
      env: { A: "1" },
    });
  });

  it("throws where a conflict is written, naming the field", () => {
    const base = Machine.spec().from(team("eng"));
    expect(() => base.from(snapshot("x"))).toThrow(
      'spec.base: set twice to different values: team("eng") and snapshot("x")',
    );
    expect(() => base.size("2x8").size("4x16")).toThrow(BoxdError);
  });

  it("refuses unknown keys, in pieces and in a spec passed as a value", () => {
    const typo = { sise: "2x8" } as unknown as MachineSpecPiece;
    expect(() => Machine.spec().with(typo)).toThrow("spec.sise: unknown field");
    expect(() => mergeSpecs({ version: 1, image: "x" } as unknown as MachineSpec)).toThrow(
      "spec.image: unknown field",
    );
  });

  it("keeps the model type importable as Machine", () => {
    const m: Machine = toMachine({} as GetVmResponse);
    expect(m.spec).toBeNull();
  });
});

/** A transport that answers create and get, and records what it was sent. */
function fakeTransport(row: Partial<GetVmResponse>, reply: Record<string, unknown> = {}) {
  const sent: { method: string; req: unknown }[] = [];
  const transport = {
    async unary(method: { name: string }, req: unknown) {
      sent.push({ method: method.name, req });
      if (method.name in reply) return reply[method.name];
      if (method.name === "CreateVm" || method.name === "CreateVmFromSnapshot") {
        return { vmId: "vm-1", name: "mike-dev", publicIp: "", url: "", image: "", status: "running", bootTimeMs: 0, pausedAutomations: 0 };
      }
      if (method.name === "GetVm") return { vmId: "vm-1", name: "mike-dev", status: "running", ...row };
      throw new Error(`unexpected ${method.name}`);
    },
    async consoleOrigin() {
      return "";
    },
  } as unknown as Transport;
  return { transport, sent };
}

describe("machines.create({ spec })", () => {
  const spec = {
    version: 1,
    base: { team: "eng" },
    labels: { team: "eng" },
    connections: { slack: "personal" },
  };

  it("sends the resolved spec and nothing it covers, and reads it back", async () => {
    const { transport, sent } = fakeTransport({ spec, createdSpec: spec } as unknown as GetVmResponse);
    const m = await new Machines(transport).create({
      name: "mike-dev",
      org: "acme",
      spec: Machine.spec().from(team("eng")).label("team", "eng").with(slack()),
    });
    const req = sent[0]!.req as Record<string, unknown>;
    expect(sent[0]!.method).toBe("CreateVm");
    expect(req.spec).toEqual({
      version: 1,
      base: { team: "eng" },
      size: "",
      assignTo: "",
      labels: { team: "eng" },
      networks: [],
      isolated: false,
      egress: [],
      env: {},
      secrets: [],
      connections: { slack: "personal" },
      agents: [],
      packages: [],
    });
    expect([req.labels, req.team, req.networks, req.isolated]).toEqual([{}, "", [], false]);
    expect(m.spec).toEqual({
      version: 1,
      base: { team: "eng" },
      labels: { team: "eng" },
      connections: { slack: "personal" },
    });
    expect(m.createdSpec).toEqual(m.spec);
  });

  it("restores a snapshot with a spec on top", async () => {
    const { transport, sent } = fakeTransport({});
    await new Machines(transport).create({
      fromSnapshot: "eng-base",
      spec: Machine.spec().env("A", "1"),
    });
    expect(sent[0]!.method).toBe("CreateVmFromSnapshot");
    const req = sent[0]!.req as { snapshot: string; spec: { env: Record<string, string> } };
    expect(req.snapshot).toBe("eng-base");
    expect(req.spec.env).toEqual({ A: "1" });
  });

  it("refuses an unknown key before calling the server", async () => {
    const { transport, sent } = fakeTransport({});
    const bad = { version: 1, ports: [8080] } as unknown as MachineSpec;
    await expect(new Machines(transport).create({ spec: bad })).rejects.toThrow(
      "spec.ports: unknown field",
    );
    expect(sent).toEqual([]);
  });

  it("sends assignTo and reads who created the machine", async () => {
    const { transport, sent } = fakeTransport({
      createdBy: "usr_admin",
      createdByName: "Ana Admin",
    } as unknown as GetVmResponse);
    const m = await new Machines(transport).create({
      name: "mike-dev",
      org: "acme",
      spec: Machine.spec().size("2x8").assignTo("usr_mike"),
    });
    expect((sent[0]!.req as { spec: { assignTo: string } }).spec.assignTo).toBe("usr_mike");
    expect([m.createdBy, m.createdByName]).toEqual(["usr_admin", "Ana Admin"]);
    expect(toMachine({ vmId: "v", name: "n", status: "running" } as GetVmResponse).createdBy).toBeNull();
  });

  it("refuses deleteAfter on a machine for someone else before calling the server", async () => {
    const { transport, sent } = fakeTransport({});
    await expect(
      new Machines(transport).create({
        org: "acme",
        spec: Machine.spec().assignTo("usr_mike"),
        deleteAfter: 3600,
      }),
    ).rejects.toThrow("spec.assignTo: a machine created for someone else is theirs to manage");
    expect(sent).toEqual([]);
  });

  it("a machine without a spec reads as null", () => {
    expect(toMachine({ vmId: "v", name: "n", status: "running" } as GetVmResponse).spec).toBeNull();
  });

  it("reads the requirements the server computed", () => {
    const m = toMachine({
      vmId: "v",
      name: "n",
      status: "running",
      requirements: [
        { kind: "connection", name: "jira", scope: "shared", tag: "jira", met: false, canFix: true, reason: "" },
        { kind: "connection", name: "slack", scope: "personal", tag: "", met: true, canFix: false, reason: "" },
        {
          kind: "agent",
          name: "claude",
          scope: "personal",
          tag: "",
          met: false,
          canFix: false,
          reason: "an isolated machine gets no integrations or agent logins",
        },
      ],
    } as unknown as GetVmResponse);
    expect(m.requirements).toEqual([
      { kind: "connection", name: "jira", scope: "shared", tag: "jira", met: false, canFix: true, reason: null },
      { kind: "connection", name: "slack", scope: "personal", tag: null, met: true, canFix: false, reason: null },
      {
        kind: "agent",
        name: "claude",
        scope: "personal",
        tag: null,
        met: false,
        canFix: false,
        reason: "an isolated machine gets no integrations or agent logins",
      },
    ]);
    expect(toMachine({ vmId: "v", name: "n", status: "running" } as GetVmResponse).requirements).toEqual([]);
  });

  it("sends packages in order without duplicates", async () => {
    const { transport, sent } = fakeTransport({});
    const base = Machine.spec().packages("apt-get update", "apt-get install -y nginx");
    await new Machines(transport).create({
      name: "p",
      spec: base.packages("echo ok", "apt-get update"),
    });
    const req = sent[0]!.req as { spec: { packages: string[] } };
    expect(req.spec.packages).toEqual(["apt-get update", "apt-get install -y nginx", "echo ok"]);
    expect(base.resolve().packages).toEqual(["apt-get update", "apt-get install -y nginx"]);
  });

  it("reads how each package went", () => {
    const m = toMachine({
      vmId: "v",
      name: "n",
      status: "running",
      packages: [
        { command: "apt-get update", state: "done", exitCode: 0, outputTail: "ok", reason: "", startedAtMs: 1000, finishedAtMs: 2000 },
        { command: "false", state: "failed", exitCode: 1, outputTail: "", reason: "", startedAtMs: 2000, finishedAtMs: 2001 },
        { command: "echo after", state: "pending", outputTail: "", reason: "", startedAtMs: 0, finishedAtMs: 0 },
      ],
    } as unknown as GetVmResponse);
    expect(m.packages).toEqual([
      {
        command: "apt-get update",
        state: "done",
        exitCode: 0,
        outputTail: "ok",
        reason: null,
        startedAt: new Date(1000),
        finishedAt: new Date(2000),
      },
      {
        command: "false",
        state: "failed",
        exitCode: 1,
        outputTail: "",
        reason: null,
        startedAt: new Date(2000),
        finishedAt: new Date(2001),
      },
      {
        command: "echo after",
        state: "pending",
        exitCode: null,
        outputTail: "",
        reason: null,
        startedAt: null,
        finishedAt: null,
      },
    ]);
    expect(toMachine({ vmId: "v", name: "n", status: "running" } as GetVmResponse).packages).toEqual([]);
  });

  it("reads a skipped command, and what an update skips and un-skips", () => {
    const m = toMachine({
      vmId: "v",
      name: "n",
      status: "running",
      packages: [
        {
          command: "exit 3",
          state: "skipped",
          exitCode: 3,
          outputTail: "boom",
          reason: "removed from the spec after it failed",
          startedAtMs: 1000,
          finishedAtMs: 2000,
        },
      ],
    } as unknown as GetVmResponse);
    expect(m.packages[0]).toMatchObject({
      state: "skipped",
      exitCode: 3,
      outputTail: "boom",
      reason: "removed from the spec after it failed",
    });
    const u = toMachineSpecUpdate({
      changes: [
        {
          field: "packages",
          apply: "live",
          added: ["echo fixed", "echo back"],
          removed: ["exit 3"],
          changed: [],
          before: "",
          after: "",
          note: "n",
          warnings: [],
          skipped: ["exit 3"],
          unskipped: ["echo back"],
        },
      ],
      rebootRequired: false,
      rebootRecommended: false,
      applied: true,
      rebooted: false,
      resizeError: "",
    });
    expect(u.changes[0]).toMatchObject({ skipped: ["exit 3"], unskipped: ["echo back"] });
  });
});

// Builders are classes; a resolved spec is plain data.
describe("size", () => {
  for (const size of ["2X8", " 2x8 ", "2 x 8", "02x08"]) {
    it(`${JSON.stringify(size)} compares and is kept as the server stores it`, () => {
      expect(Machine.spec().size(size).resolve()).toEqual({ version: 1, size: "2x8" });
      expect(Machine.spec().with({ size: "2x8" }).size(size).resolve().size).toBe("2x8");
      expect(specPatch({ version: 1, size: "2x8" }, { version: 1, size })).toEqual({});
      expect(specPatch({ version: 1, size }, { version: 1, size: "4X16" })).toEqual({ size: "4x16" });
    });
  }
});

it("resolve() returns plain JSON", () => {
  const s = new MachineSpecBuilder().size("1x4").resolve();
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});

// The updateSpec patch cases the server and both SDKs run (a copy of the
// server's file, kept identical to it by a test on the server side).
const PATCH_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/machine_spec_patch.json",
);

interface PatchCase {
  name: string;
  current: MachineSpec;
  patch: MachineSpecPatch;
  result?: MachineSpec;
  error?: string;
  minimal?: boolean;
  sdk?: boolean;
}

describe("shared patch fixtures", () => {
  const cases: PatchCase[] = JSON.parse(readFileSync(PATCH_FIXTURES, "utf8")).cases;
  for (const c of cases.filter((c) => c.minimal || c.sdk)) {
    it(c.name, () => {
      if (c.error !== undefined) {
        expect(() => checkSpecPatch(c.patch)).toThrow(c.error);
        return;
      }
      // What the SDK sends for a builder is what the server would compute,
      // and applying it gives the result.
      expect(specPatch(c.current, c.result!)).toEqual(c.patch);
      expect(applySpecPatch(c.current, c.patch)).toEqual(c.result!);
    });
  }
});

describe("machines.updateSpec()", () => {
  const current = {
    version: 1,
    labels: { team: "eng" },
    networks: ["eng"],
    env: { A: "1" },
  };
  const reply = {
    UpdateMachineSpec: {
      changes: [
        { field: "networks", apply: "live", added: ["ops"], removed: [], changed: [], before: "", after: "", note: "the machine's peers change now", warnings: [] },
        { field: "env", apply: "reboot_recommended", added: ["X"], removed: [], changed: [], before: "", after: "", note: "n", warnings: [] },
      ],
      rebootRequired: false,
      rebootRecommended: true,
      spec: { ...current, networks: ["eng", "ops"], env: { A: "1", X: "1" } },
      applied: true,
      rebooted: false,
    },
  };

  it("sends a patch as JSON, with the options", async () => {
    const { transport, sent } = fakeTransport({}, reply);
    const res = await new Machines(transport).updateSpec(
      "vm-1",
      { labels: { team: null, owner: "mike" }, size: "4x16" },
      { dryRun: true, reboot: true },
    );
    expect(sent.map((s) => s.method)).toEqual(["UpdateMachineSpec"]);
    const req = sent[0]!.req as Record<string, unknown>;
    expect(req.vm).toBe("vm-1");
    expect(JSON.parse(req.patch as string)).toEqual({
      labels: { team: null, owner: "mike" },
      size: "4x16",
    });
    expect([req.dryRun, req.reboot]).toEqual([true, true]);
    expect(res.changes.map((c) => [c.field, c.apply])).toEqual([
      ["networks", "live"],
      ["env", "reboot_recommended"],
    ]);
    expect(res.changes[0]!.before).toBeNull();
    expect(res.rebootRecommended).toBe(true);
    expect(res.spec.networks).toEqual(["eng", "ops"]);
  });

  it("retries packages with an empty patch, and not unless asked", async () => {
    const { transport, sent } = fakeTransport({}, reply);
    const m = new Machines(transport);
    await m.updateSpec("vm-1", {}, { retryPackages: true });
    const req = sent[0]!.req as Record<string, unknown>;
    expect(JSON.parse(req.patch as string)).toEqual({});
    expect([req.retryPackages, req.dryRun, req.reboot]).toEqual([true, false, false]);
    await m.updateSpec("vm-1", { labels: { x: "1" } });
    expect((sent[1]!.req as { retryPackages: boolean }).retryPackages).toBe(false);
  });

  it("with a builder, reads the spec and sends only the difference", async () => {
    const { transport, sent } = fakeTransport(
      { spec: current, createdSpec: current } as unknown as GetVmResponse,
      reply,
    );
    await new Machines(transport).updateSpec("vm-1", (s) => s.network("ops").env("X", "1"));
    expect(sent.map((s) => s.method)).toEqual(["GetVm", "UpdateMachineSpec"]);
    expect(JSON.parse((sent[1]!.req as { patch: string }).patch)).toEqual({
      networks: ["eng", "ops"],
      env: { X: "1" },
    });
    expect((sent[1]!.req as { dryRun: boolean }).dryRun).toBe(false);
  });

  it("a builder can't replace what the spec already names", async () => {
    const { transport, sent } = fakeTransport(
      { spec: { ...current, size: "2x8" } } as unknown as GetVmResponse,
      reply,
    );
    await expect(
      new Machines(transport).updateSpec("vm-1", (s) => s.size("4x16")),
    ).rejects.toThrow('spec.size: set twice to different values: "2x8" and "4x16"');
    expect(sent.map((s) => s.method)).toEqual(["GetVm"]);
  });

  it("refuses a builder, a Map or a class instance instead of sending {}", async () => {
    const { transport, sent } = fakeTransport({}, reply);
    const m = new Machines(transport);
    await expect(
      m.updateSpec("vm-1", Machine.spec().label("x", "1") as unknown as MachineSpecPatch),
    ).rejects.toThrow(
      "spec: a patch is a JSON object, not a builder: pass builder.resolve() to set the " +
        'fields it names, or a function (s => s.network("ops")) to add to the ' +
        "machine's current spec",
    );
    for (const bad of [new Map([["labels", { x: "1" }]]), new Date(0), new (class Patch {})(), [], "x"]) {
      await expect(m.updateSpec("vm-1", bad as unknown as MachineSpecPatch)).rejects.toThrow(
        'spec: a patch is a JSON object, e.g. {"labels": {"team": "ops"}}',
      );
    }
    expect(sent).toEqual([]);
    // A null-prototype object is still a plain object.
    const bare = Object.assign(Object.create(null), { labels: { x: "1" } }) as MachineSpecPatch;
    await m.updateSpec("vm-1", bare);
    expect(JSON.parse((sent[0]!.req as { patch: string }).patch)).toEqual({ labels: { x: "1" } });
  });

  it("a builder's size matches the spec's however it is written", async () => {
    const { transport, sent } = fakeTransport(
      { spec: { ...current, size: "2x8" } } as unknown as GetVmResponse,
      reply,
    );
    await new Machines(transport).updateSpec("vm-1", (s) => s.size("2X8").network("ops"));
    expect(JSON.parse((sent[1]!.req as { patch: string }).patch)).toEqual({
      networks: ["eng", "ops"],
    });
  });

  it("a spec that changed meanwhile is a ConflictError", async () => {
    const transport = {
      async unary() {
        throw fromGrpcError({
          code: GrpcStatus.ABORTED,
          details:
            "the machine's spec changed while this update was being applied, so nothing " +
            "was changed: read it again and retry",
          message: "",
        });
      },
    } as unknown as Transport;
    const e = await new Machines(transport)
      .updateSpec("vm-1", { labels: { x: "1" } })
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).message).toContain("read it again and retry");
  });

  // The spec read travels with the update, and the function form
  // tries again on a conflict.
  const scripted = (specs: object[], outcomes: (number | null)[]) => {
    const sent: { method: string; req: Record<string, unknown> }[] = [];
    let gets = 0;
    let updates = 0;
    const transport = {
      async unary(method: { name: string }, req: Record<string, unknown>) {
        sent.push({ method: method.name, req });
        if (method.name === "GetVm") {
          const spec = specs[Math.min(gets++, specs.length - 1)];
          return { vmId: "vm-1", name: "mike-dev", status: "running", spec, createdSpec: spec };
        }
        const code = outcomes[Math.min(updates++, outcomes.length - 1)];
        if (code !== null && code !== undefined) {
          throw fromGrpcError({ code, details: `refused (${code})`, message: "" });
        }
        return reply.UpdateMachineSpec;
      },
      async consoleOrigin() {
        return "";
      },
    } as unknown as Transport;
    return { transport, sent };
  };

  it("a builder sends the spec it read, and reads again after a conflict", async () => {
    const moved = { ...current, networks: ["eng", "ci"] };
    const { transport, sent } = scripted([current, moved], [GrpcStatus.ABORTED, null]);
    await new Machines(transport).updateSpec("vm-1", (s) => s.network("ops"));
    expect(sent.map((s) => s.method)).toEqual([
      "GetVm",
      "UpdateMachineSpec",
      "GetVm",
      "UpdateMachineSpec",
    ]);
    expect(JSON.parse(sent[1]!.req.expectedSpec as string)).toEqual(current);
    // The second try is made on the spec as it is now: "ci" stays.
    expect(JSON.parse(sent[3]!.req.expectedSpec as string)).toEqual(moved);
    expect(JSON.parse(sent[3]!.req.patch as string)).toEqual({ networks: ["eng", "ci", "ops"] });
  });

  it("a builder gives up after 3 retries, and never retries another refusal", async () => {
    const { transport, sent } = scripted([current], [GrpcStatus.ABORTED]);
    const e = await new Machines(transport)
      .updateSpec("vm-1", (s) => s.network("ops"))
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ConflictError);
    expect(sent.filter((s) => s.method === "UpdateMachineSpec").length).toBe(4);

    // failed_precondition is a ConflictError too, but it would refuse again.
    const once = scripted([current], [GrpcStatus.FAILED_PRECONDITION]);
    await expect(
      new Machines(once.transport).updateSpec("vm-1", (s) => s.network("ops")),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(once.sent.filter((s) => s.method === "UpdateMachineSpec").length).toBe(1);
  });

  it("a patch sends expectedSpec when given, and isn't retried", async () => {
    const { transport, sent } = scripted([current], [null]);
    const m = new Machines(transport);
    await m.updateSpec("vm-1", { networks: ["eng", "ops"] }, { expectedSpec: current });
    expect(JSON.parse(sent[0]!.req.expectedSpec as string)).toEqual(current);
    await m.updateSpec("vm-1", { labels: { x: "1" } });
    expect(sent[1]!.req.expectedSpec).toBe("");

    const aborted = scripted([current], [GrpcStatus.ABORTED]);
    await expect(
      new Machines(aborted.transport).updateSpec(
        "vm-1",
        { networks: ["eng", "ops"] },
        { expectedSpec: current },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(aborted.sent.map((s) => s.method)).toEqual(["UpdateMachineSpec"]);
  });

  it("a resize that failed after the rest applied is in the answer", async () => {
    const partial = {
      UpdateMachineSpec: {
        ...reply.UpdateMachineSpec,
        spec: { ...current, size: "2x8" },
        resizeError: "spec.size: the rest of the patch was applied, but the resize failed: x",
      },
    };
    const { transport } = fakeTransport({}, partial);
    const res = await new Machines(transport).updateSpec("vm-1", { size: "4x16" }, { reboot: true });
    expect(res.applied).toBe(true);
    expect(res.resizeError).toContain("the resize failed");
    expect(res.spec.size).toBe("2x8");
    const ok = await new Machines(fakeTransport({}, reply).transport).updateSpec("vm-1", {});
    expect(ok.resizeError).toBeNull();
  });

  it("refuses an unknown field and a machine without a spec before sending", async () => {
    const { transport, sent } = fakeTransport({}, reply);
    const m = new Machines(transport);
    await expect(
      m.updateSpec("vm-1", { ports: [1] } as unknown as MachineSpecPatch),
    ).rejects.toThrow("spec.ports: unknown field");
    await expect(m.updateSpec("vm-1", (s) => s.network("ops"))).rejects.toThrow(
      "wasn't created from a spec",
    );
    expect(sent.map((s) => s.method)).toEqual(["GetVm"]);
  });
});
