/**
 * `machines.fs` over the default (grpc-js) transport against a real
 * in-process grpc-js server: the error-reason trailer becomes the right
 * error, a stream that fails part-way fails the read, and writes stream with
 * backpressure and can be abandoned.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  Metadata,
  Server,
  ServerCredentials,
  status,
  type ServerReadableStream,
  type ServerWritableStream,
  type sendUnaryData,
} from "@grpc/grpc-js";
import {
  BoxdApiService,
  FsEntryType,
  type FsEntry,
  type FsListChunk,
  type FsListRequest,
  type FsReadChunk,
  type FsReadRequest,
  type FsStatRequest,
  type FsStatResponse,
  type FsWriteChunk,
  type FsWriteResponse,
} from "../src/_generated/api.js";
import { Transport } from "../src/_transport.js";
import { Credentials } from "../src/auth.js";
import { AgentOutdatedError, ConflictError, FilesystemError } from "../src/errors.js";
import { MachineFs } from "../src/fs.js";

const enc = (s: string) => new TextEncoder().encode(s);

function entry(path: string, size: number): FsEntry {
  return {
    name: enc(path.split("/").pop()!),
    path: enc(path),
    type: FsEntryType.FS_ENTRY_TYPE_FILE,
    targetType: FsEntryType.FS_ENTRY_TYPE_FILE,
    size,
    mode: 0o644,
    mtimeNs: 0,
    uid: 1000,
    gid: 1000,
    symlinkTarget: new Uint8Array(),
  };
}

function failure(code: number, details: string, reason: string) {
  const metadata = new Metadata();
  metadata.set("x-boxd-error-reason", reason);
  return { code, details, metadata };
}

/** What the fake machine holds, and what the last write did. */
interface FakeMachine {
  files: Map<string, Uint8Array>;
  writes: { chunks: FsWriteChunk[]; outcome: "ended" | "cancelled" | "pending" }[];
}

async function startServer(machine: FakeMachine) {
  const server = new Server();
  server.addService(
    {
      fsStat: BoxdApiService.fsStat,
      fsRead: BoxdApiService.fsRead,
      fsWrite: BoxdApiService.fsWrite,
      fsList: BoxdApiService.fsList,
    } as never,
    {
      fsStat(
        call: { request: FsStatRequest },
        cb: sendUnaryData<FsStatResponse>,
      ) {
        const path = new TextDecoder().decode(call.request.path);
        if (path === "/outdated") {
          return cb(failure(status.FAILED_PRECONDITION, "agent too old; reboot the machine", "agent_outdated"), null);
        }
        const data = machine.files.get(path);
        if (!data) return cb(failure(status.NOT_FOUND, `no such file: ${path}`, "not_found"), null);
        cb(null, { entry: entry(path, data.length) });
      },
      fsRead(call: ServerWritableStream<FsReadRequest, FsReadChunk>) {
        const path = new TextDecoder().decode(call.request.path);
        if (path === "/fails-midway") {
          call.write({ entry: entry(path, 10), data: enc("part"), eof: false, bytesRead: 0 });
          call.emit("error", failure(status.INTERNAL, "input/output error", "io_error"));
          return;
        }
        const data = machine.files.get(path);
        if (!data) {
          call.emit("error", failure(status.NOT_FOUND, `no such file: ${path}`, "not_found"));
          return;
        }
        const step = 1024 * 1024;
        call.write({ entry: entry(path, data.length), data: new Uint8Array(), eof: false, bytesRead: 0 });
        for (let off = 0; off < data.length; off += step) {
          call.write({ data: data.subarray(off, off + step), eof: false, bytesRead: 0 });
        }
        call.write({ data: new Uint8Array(), eof: true, bytesRead: data.length });
        call.end();
      },
      fsWrite(call: ServerReadableStream<FsWriteChunk, FsWriteResponse>, cb: sendUnaryData<FsWriteResponse>) {
        const record = { chunks: [] as FsWriteChunk[], outcome: "pending" as const } as FakeMachine["writes"][number];
        machine.writes.push(record);
        call.on("data", (c: FsWriteChunk) => record.chunks.push(c));
        call.on("cancelled", () => {
          if (record.outcome === "pending") record.outcome = "cancelled";
        });
        // grpc-js's server emits "end" and then "cancelled" for a client that
        // cancels, so commit only once the same tick has shown which it was.
        call.on("end", () => setTimeout(() => commit(), 0));
        const commit = () => {
          if (call.cancelled) {
            record.outcome = "cancelled";
            return;
          }
          record.outcome = "ended";
          const first = record.chunks[0]!;
          const path = new TextDecoder().decode(first.path);
          const total = record.chunks.reduce((n, c) => n + c.data.length, 0);
          const data = new Uint8Array(total);
          let off = 0;
          for (const c of record.chunks) {
            data.set(c.data, off);
            off += c.data.length;
          }
          if (first.expectedSize !== undefined && first.expectedSize !== total) {
            return cb(failure(status.ABORTED, "size mismatch", "size_mismatch"), null);
          }
          machine.files.set(path, data);
          cb(null, { bytesWritten: total, entry: entry(path, total) });
        };
      },
      fsList(call: ServerWritableStream<FsListRequest, FsListChunk>) {
        const names = Array.from({ length: 2500 }, (_, i) => `/d/f${i}`);
        for (let i = 0; i < names.length; i += 1000) {
          call.write({ entries: names.slice(i, i + 1000).map((n) => entry(n, 0)) });
        }
        call.end();
      },
    } as never,
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  const transport = new Transport({
    creds: new Credentials({ token: "test-token", exchangeUrl: "https://example.invalid" }),
    explicitBaseURL: `http://127.0.0.1:${port}`,
    defaultBaseURL: `http://127.0.0.1:${port}`,
    timeoutMs: 10_000,
    maxRetries: 0,
  });
  return { server, transport, fs: new MachineFs(transport) };
}

let running: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(() => {
  running?.transport.close();
  running?.server.forceShutdown();
  running = undefined;
});

const machine = (): FakeMachine => ({ files: new Map(), writes: [] });

describe("machines.fs over grpc-js", () => {
  it("the reason trailer becomes a FilesystemError with the errno name", async () => {
    running = await startServer(machine());
    const err = await running.fs.stat("m1", "/missing").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("ENOENT");
    expect(err.reason).toBe("not_found");
    expect(err.grpcCode).toBe(status.NOT_FOUND);
    expect(err.path).toBe("/missing");
    expect(await running.fs.exists("m1", "/missing")).toBe(false);
  });

  it("agent_outdated becomes AgentOutdatedError, a ConflictError", async () => {
    running = await startServer(machine());
    const err = await running.fs.stat("m1", "/outdated").catch((e) => e);
    expect(err).toBeInstanceOf(AgentOutdatedError);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("reboot");
  });

  it("write then read round-trips 5 MiB in 1 MiB chunks", async () => {
    const m = machine();
    running = await startServer(m);
    const data = new Uint8Array(5 * 1024 * 1024 + 7).map((_, i) => (i * 31) % 256);
    const written = await running.fs.write("m1", "/big.bin", data);
    expect(written.size).toBe(data.length);
    expect(m.writes[0]!.outcome).toBe("ended");
    expect(m.writes[0]!.chunks.length).toBe(6);
    expect(m.writes[0]!.chunks[0]!.expectedSize).toBe(data.length);
    expect(await running.fs.read("m1", "/big.bin")).toEqual(data);
  });

  it("a read that fails part-way throws, after the data that arrived", async () => {
    running = await startServer(machine());
    const seen: number[] = [];
    const err = await (async () => {
      for await (const chunk of running!.fs.readStream("m1", "/fails-midway")) seen.push(chunk.length);
    })().catch((e) => e);
    expect(seen).toEqual([4]);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EIO");
    expect(err.path).toBe("/fails-midway");
  });

  it("a stream source that throws cancels the call; the server never sees an end", async () => {
    const m = machine();
    running = await startServer(m);
    async function* broken() {
      yield enc("half of it");
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("source failed");
    }
    const err = await running.fs.write("m1", "/partial", broken()).catch((e) => e);
    expect(err.message).toBe("source failed");
    await new Promise((r) => setTimeout(r, 100));
    expect(m.writes[0]!.outcome).toBe("cancelled");
    expect(m.files.has("/partial")).toBe(false);
  });

  it("list gathers every batch", async () => {
    running = await startServer(machine());
    const entries = await running.fs.list("m1", "/d");
    expect(entries.length).toBe(2500);
    expect(entries[2499]!.name).toBe("f2499");
  });
});
