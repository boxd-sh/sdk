/**
 * `machines.exec()` runs a command again when the server couldn't reach the
 * machine's agent (the command never started), and only then.
 */
import { describe, expect, it } from "bun:test";
import { ExecChunk } from "../src/_generated/definitions.js";
import type { DuplexCall, Transport } from "../src/_rpc.js";
import { APIConnectionError, GrpcStatus } from "../src/errors.js";
import { Machines } from "../src/machines.js";

type Outcome =
  | { error: Error }
  | { exitCode: number; stdout?: string };

/** A transport whose exec calls end with `outcomes`, one per call, in order. */
function fakeExec(outcomes: Outcome[]): { transport: Transport; calls: () => number } {
  let calls = 0;
  const duplex = (): DuplexCall<ExecChunk, ExecChunk> => {
    const outcome = outcomes[calls++];
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      on(event: string, fn: (arg?: never) => void) {
        handlers[event] = fn as (arg?: unknown) => void;
      },
      write() {},
      end() {
        queueMicrotask(() => {
          if (!outcome) throw new Error("more exec calls than outcomes");
          if ("error" in outcome) {
            handlers.error?.(outcome.error);
            return;
          }
          if (outcome.stdout) {
            handlers.data?.(
              ExecChunk.fromPartial({ data: new TextEncoder().encode(outcome.stdout) }),
            );
          }
          handlers.data?.(ExecChunk.fromPartial({ exitCode: outcome.exitCode }));
          handlers.end?.();
        });
      },
      cancel() {},
    } as DuplexCall<ExecChunk, ExecChunk>;
  };
  const transport = {
    duplex,
    supportsInteractiveExec: true,
  } as unknown as Transport;
  return { transport, calls: () => calls };
}

const unreachable = () =>
  new APIConnectionError(
    "cannot connect to VM agent: agent at 10.42.0.7:57073 did not answer within 15s " +
      "(last error: transport error). The command did not start; it is safe to retry",
    GrpcStatus.UNAVAILABLE,
  );

describe("machines.exec retries a command that never started", () => {
  it("runs it again when the agent didn't answer", async () => {
    const fake = fakeExec([{ error: unreachable() }, { exitCode: 0, stdout: "hi" }]);
    const r = await new Machines(fake.transport).exec("alpha", { command: "echo hi" });
    expect(r.stdout).toBe("hi");
    expect(fake.calls()).toBe(2);
  });

  it("gives up after its retries", async () => {
    const fake = fakeExec([{ error: unreachable() }, { error: unreachable() }, { error: unreachable() }]);
    await expect(new Machines(fake.transport).exec("alpha", { command: "true" })).rejects.toThrow(
      /cannot connect to VM agent/,
    );
    expect(fake.calls()).toBe(3);
  });

  it("doesn't run again after any other failure: the command may have run", async () => {
    const dropped = new APIConnectionError(
      "the machine was rebooted while the command ran",
      GrpcStatus.UNAVAILABLE,
    );
    const fake = fakeExec([{ error: dropped }, { exitCode: 0 }]);
    await expect(new Machines(fake.transport).exec("alpha", { command: "true" })).rejects.toThrow(
      /rebooted/,
    );
    expect(fake.calls()).toBe(1);
  });

  it("doesn't retry past the caller's timeout", async () => {
    const fake = fakeExec([{ error: unreachable() }, { exitCode: 0 }]);
    await expect(
      new Machines(fake.transport).exec("alpha", { command: "true", timeout: 500 }),
    ).rejects.toThrow(/cannot connect to VM agent/);
    expect(fake.calls()).toBe(1);
  });
});
