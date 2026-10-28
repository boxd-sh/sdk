import { describe, expect, it } from "bun:test";
import { AsyncByteQueue, ExecStream } from "../src/exec.js";
import { BoxdError } from "../src/errors.js";

describe("AsyncByteQueue", () => {
  it("yields pushed chunks in order", async () => {
    const q = new AsyncByteQueue();
    q.push(new Uint8Array([1]));
    q.push(new Uint8Array([2]));
    q.close();

    const out: number[] = [];
    for await (const c of q) out.push(...c);
    expect(out).toEqual([1, 2]);
  });

  it("a push resolves a pending read", async () => {
    const q = new AsyncByteQueue();
    const iter = q[Symbol.asyncIterator]();
    const read = iter.next();
    queueMicrotask(() => {
      q.push(new Uint8Array([42]));
      q.close();
    });
    const r = await read;
    expect(Array.from(r.value as Uint8Array)).toEqual([42]);
    expect((await iter.next()).done).toBe(true);
  });

  it("close with no data yields immediate done", async () => {
    const q = new AsyncByteQueue();
    q.close();
    const out: Uint8Array[] = [];
    for await (const c of q) out.push(c);
    expect(out).toEqual([]);
  });

  it("fail rejects the first read", async () => {
    const q = new AsyncByteQueue();
    q.fail(new Error("boom"));
    await expect(q[Symbol.asyncIterator]().next()).rejects.toThrow("boom");
  });

  it("fail rejects a pending read", async () => {
    const q = new AsyncByteQueue();
    const iter = q[Symbol.asyncIterator]();
    const read = iter.next();
    queueMicrotask(() => q.fail(new Error("stream died")));
    await expect(read).rejects.toThrow("stream died");
  });

  it("buffered chunks drain before the error surfaces", async () => {
    const q = new AsyncByteQueue();
    q.push(new Uint8Array([1]));
    q.push(new Uint8Array([2]));
    q.fail(new Error("late"));
    const iter = q[Symbol.asyncIterator]();
    expect(Array.from((await iter.next()).value as Uint8Array)).toEqual([1]);
    expect(Array.from((await iter.next()).value as Uint8Array)).toEqual([2]);
    await expect(iter.next()).rejects.toThrow("late");
  });
});

describe("ExecStream", () => {
  const transport = () => {
    const log: string[] = [];
    return {
      log,
      t: {
        write: (d: Uint8Array) => log.push(`write:${new TextDecoder().decode(d)}`),
        end: () => log.push("end"),
        resize: (c: number, r: number) => log.push(`resize:${c}x${r}`),
        cancel: () => log.push("cancel"),
      },
    };
  };

  it("forwards writes, half-close, resize and cancel", () => {
    const { log, t } = transport();
    const s = new ExecStream(t);
    s.write("ls\n");
    s.resize(120, 40);
    s.end();
    s.close();
    expect(log).toEqual(["write:ls\n", "resize:120x40", "end", "cancel"]);
  });

  it("iterates stdout and resolves wait() with the exit code", async () => {
    const { t } = transport();
    const s = new ExecStream(t);
    s.stdout.push(new TextEncoder().encode("hi"));
    s.stdout.close();
    s._setExit(0);

    const chunks: string[] = [];
    for await (const c of s) chunks.push(new TextDecoder().decode(c));
    expect(chunks).toEqual(["hi"]);
    expect(await s.wait()).toBe(0);
    expect(s.exitCode).toBe(0);
  });

  it("wait() rejects when the stream errors", async () => {
    const { t } = transport();
    const s = new ExecStream(t);
    const waiting = s.wait();
    s._setError(new BoxdError("stream died"));
    await expect(waiting).rejects.toThrow("stream died");
  });

  it("disposal cancels the call", async () => {
    const { log, t } = transport();
    {
      await using s = new ExecStream(t);
      void s;
    }
    expect(log).toEqual(["cancel"]);
  });
});
