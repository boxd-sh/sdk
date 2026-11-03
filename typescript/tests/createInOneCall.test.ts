/**
 * `machines.create()` and `machines.fork()` with a delete-after timer: the
 * timer rides in the create request and a server that knows it answers with
 * the whole machine, so the call is one round trip. A server from before the
 * fields ignores them and answers without `machine`; the SDK then sets the
 * timer and reads the machine back itself, as it always did.
 */
import { describe, expect, it } from "bun:test";
import type { Transport } from "../src/_rpc.js";
import type { GetVmResponse } from "../src/_generated/definitions.js";
import { Machines } from "../src/index.js";

const DEADLINE = Date.UTC(2030, 0, 1, 18);

function machineRow(over: Partial<GetVmResponse> = {}): GetVmResponse {
  return {
    vmId: "vm-1",
    name: "web",
    status: "running",
    deleteAtMs: 0,
    deleteAfterCron: "",
    ...over,
  } as GetVmResponse;
}

/**
 * A transport whose create, restore and fork answer with `machine` when
 * given one (a current server) and without it otherwise (an older one).
 */
function server(machine: GetVmResponse | undefined) {
  const sent: { method: string; req: Record<string, unknown> }[] = [];
  const transport = {
    async unary(method: { name: string }, req: Record<string, unknown>) {
      sent.push({ method: method.name, req });
      switch (method.name) {
        case "CreateVm":
        case "CreateVmFromSnapshot":
        case "ForkVm":
          return {
            vmId: "vm-1",
            name: "web",
            publicIp: "",
            url: "",
            image: "",
            status: "running",
            bootTimeMs: 0,
            pausedAutomations: 0,
            forkedFrom: "src",
            machine,
          };
        case "SetDeleteAfter":
          return { deleteAtMs: DEADLINE };
        case "GetVm":
          return machineRow({ deleteAtMs: DEADLINE });
      }
      throw new Error(`unexpected ${method.name}`);
    },
    async consoleOrigin() {
      return "https://app.example.com";
    },
  } as unknown as Transport;
  return { machines: new Machines(transport), sent };
}

describe("a create with a delete-after timer", () => {
  it("is one call to a server that writes the timer with the machine", async () => {
    const { machines, sent } = server(machineRow({ deleteAtMs: DEADLINE }));
    const m = await machines.create({ name: "web", deleteAfter: 3600 });
    expect(sent.map((s) => s.method)).toEqual(["CreateVm"]);
    expect([sent[0]!.req.deleteAfterSecs, sent[0]!.req.deleteAfterCron]).toEqual([3600, undefined]);
    expect(m.deleteAt).toEqual(new Date(DEADLINE));
    expect(m.access.desktopUrl).toContain("app.example.com");
  });

  it("sets the timer and reads the machine back on a server from before it", async () => {
    const { machines, sent } = server(undefined);
    const m = await machines.create({ name: "web", deleteAfter: 3600 });
    expect(sent.map((s) => s.method)).toEqual(["CreateVm", "SetDeleteAfter", "GetVm"]);
    expect(sent[1]!.req).toEqual({ vmId: "vm-1", deleteAfterSecs: 3600, deleteAfterCron: "" });
    expect(m.deleteAt).toEqual(new Date(DEADLINE));
  });

  it("restores a snapshot with a cron timer in one call", async () => {
    const { machines, sent } = server(
      machineRow({ deleteAtMs: DEADLINE, deleteAfterCron: "0 18 * * *" }),
    );
    const m = await machines.create({ fromSnapshot: "base", deleteAfterCron: "0 18 * * *" });
    expect(sent.map((s) => s.method)).toEqual(["CreateVmFromSnapshot"]);
    expect(sent[0]!.req.deleteAfterCron).toBe("0 18 * * *");
    expect(m.deleteAfterCron).toBe("0 18 * * *");
  });

  it("sets it again when the machine that came back doesn't show it", async () => {
    const { machines, sent } = server(machineRow());
    await machines.create({ fromSnapshot: "base", deleteAfterCron: "0 18 * * *" });
    expect(sent.map((s) => s.method)).toEqual(["CreateVmFromSnapshot", "SetDeleteAfter", "GetVm"]);
    expect(sent[1]!.req).toEqual({ vmId: "vm-1", deleteAfterSecs: 0, deleteAfterCron: "0 18 * * *" });
  });

  it("is refused with both a duration and a cron before anything is sent", async () => {
    const { machines, sent } = server(machineRow());
    await expect(
      machines.create({ name: "web", deleteAfter: 60, deleteAfterCron: "0 18 * * *" }),
    ).rejects.toThrow("pass deleteAfter or deleteAfterCron, not both");
    expect(sent).toEqual([]);
  });

  it("a plain create sends no timer and takes the machine it gets back", async () => {
    const { machines, sent } = server(machineRow());
    const m = await machines.create({ name: "web" });
    expect(sent.map((s) => s.method)).toEqual(["CreateVm"]);
    expect([sent[0]!.req.deleteAfterSecs, sent[0]!.req.deleteAfterCron]).toEqual([
      undefined,
      undefined,
    ]);
    expect(m.deleteAt).toBeNull();
  });
});

describe("a fork's delete-after timer", () => {
  it("unset: nothing is sent, so the fork keeps its source's", async () => {
    const { machines, sent } = server(machineRow({ deleteAtMs: DEADLINE }));
    const m = await machines.fork("src");
    expect(sent.map((s) => s.method)).toEqual(["ForkVm"]);
    expect([sent[0]!.req.deleteAfterSecs, sent[0]!.req.deleteAfterCron]).toEqual([
      undefined,
      undefined,
    ]);
    expect(m.deleteAt).toEqual(new Date(DEADLINE));
  });

  it("0 drops the inherited one, in the fork itself", async () => {
    const { machines, sent } = server(machineRow());
    const m = await machines.fork("src", { deleteAfter: 0 });
    expect(sent.map((s) => s.method)).toEqual(["ForkVm"]);
    expect(sent[0]!.req.deleteAfterSecs).toBe(0);
    expect(m.deleteAt).toBeNull();
  });

  it("on a server from before it: the fork, then the timer, then the read", async () => {
    const { machines, sent } = server(undefined);
    await machines.fork("src", { deleteAfter: 0 });
    expect(sent.map((s) => s.method)).toEqual(["ForkVm", "SetDeleteAfter", "GetVm"]);
  });
});
