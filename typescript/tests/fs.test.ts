/**
 * `machines.fs` against a fake transport: what goes on the wire, how streams
 * are checked, and how failures surface. The transports' own handling of the
 * error-reason trailer is pinned in `fsTransport.test.ts` (grpc-js, against a
 * real server) and `transportWeb.test.ts` (grpc-web).
 */
import { describe, expect, it } from "bun:test";
import {
  FsEntryType,
  FsMkdirRequest,
  FsWriteChunk,
  type FsEntry as WireFsEntry,
  type MessageFns,
} from "../src/_generated/definitions.js";
import type { MethodDef, ReadableCall, Transport, WritableCall } from "../src/_rpc.js";
import {
  AgentOutdatedError,
  BoxdError,
  FilesystemError,
  GrpcStatus,
  NotFoundError,
  fromGrpcError,
} from "../src/errors.js";
import { MachineFs } from "../src/fs.js";
import { Machines } from "../src/machines.js";

// ── the fake ──────────────────────────────────────────────────────────────

/** `open`: send the chunks, then neither end nor fail (a stream still in flight). */
type Script = { chunks: unknown[]; error?: unknown; open?: boolean };

class FakeReadCall implements ReadableCall<unknown> {
  cancelled = false;
  #handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  #script: Script;
  constructor(script: Script) {
    this.#script = script;
  }
  on(event: string, fn: (arg?: unknown) => void): void {
    (this.#handlers[event] ??= []).push(fn);
    // "end" is the last handler registered, so the call is fully wired.
    if (event === "end") queueMicrotask(() => this.#flush());
  }
  cancel(): void {
    this.cancelled = true;
  }
  #emit(event: string, arg?: unknown): void {
    for (const fn of this.#handlers[event] ?? []) fn(arg);
  }
  #flush(): void {
    for (const c of this.#script.chunks) {
      if (this.cancelled) return;
      this.#emit("data", c);
    }
    if (this.cancelled || this.#script.open) return;
    if (this.#script.error) this.#emit("error", this.#script.error);
    else this.#emit("end");
  }
}

class FakeWriteCall implements WritableCall<FsWriteChunk> {
  readonly written: FsWriteChunk[] = [];
  ended = false;
  cancelled = false;
  drains = 0;
  constructor(
    private readonly callback: (err: unknown, resp: unknown) => void,
    private readonly answer: { resp?: unknown; error?: unknown; afterChunks?: number },
  ) {}
  write(msg: FsWriteChunk): void {
    // Round-trip through the codec, as a real transport does.
    this.written.push(FsWriteChunk.decode(FsWriteChunk.encode(msg).finish()));
    if (this.answer.afterChunks === this.written.length) this.#settle();
  }
  end(): void {
    this.ended = true;
    if (this.answer.afterChunks === undefined) this.#settle();
  }
  cancel(): void {
    this.cancelled = true;
  }
  async drained(): Promise<void> {
    this.drains++;
  }
  #settle(): void {
    queueMicrotask(() => {
      if (this.answer.error) this.callback(this.answer.error, undefined);
      else this.callback(null, this.answer.resp);
    });
  }
}

class FakeTransport implements Transport {
  readonly calls: { method: string; req: unknown }[] = [];
  readonly reads: FakeReadCall[] = [];
  readonly writes: FakeWriteCall[] = [];
  readonly supportsInteractiveExec = true;
  constructor(
    private readonly opts: {
      unary?: unknown[];
      stream?: Script;
      write?: { resp?: unknown; error?: unknown; afterChunks?: number };
    } = {},
  ) {}
  async consoleOrigin(): Promise<string> {
    return "https://app.example.com";
  }
  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    this.calls.push({ method: method.name, req });
    const next = this.opts.unary?.shift();
    if (next instanceof Error) throw next;
    return (next ?? {}) as Resp;
  }
  serverStream<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): ReadableCall<Resp> {
    this.calls.push({ method: method.name, req });
    const call = new FakeReadCall(this.opts.stream ?? { chunks: [] });
    this.reads.push(call);
    return call as ReadableCall<Resp>;
  }
  duplex(): never {
    throw new Error("not used");
  }
  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
  ): WritableCall<Req> {
    this.calls.push({ method: method.name, req: undefined });
    const call = new FakeWriteCall(
      callback as (err: unknown, resp: unknown) => void,
      this.opts.write ?? {},
    );
    this.writes.push(call);
    return call as unknown as WritableCall<Req>;
  }
  close(): void {}
}

// ── fixtures ──────────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function wireEntry(fields: Partial<WireFsEntry> = {}): WireFsEntry {
  return {
    name: enc("a.txt"),
    path: enc("/home/boxd/a.txt"),
    type: FsEntryType.FS_ENTRY_TYPE_FILE,
    targetType: FsEntryType.FS_ENTRY_TYPE_FILE,
    size: 4,
    mode: 0o644,
    mtimeNs: 1_700_000_000_123,
    uid: 1000,
    gid: 1000,
    symlinkTarget: new Uint8Array(),
    ...fields,
  };
}

/** A status error as a transport hands it over, with the reason trailer. */
function statusError(code: number, message: string, reason?: string): Error {
  return fromGrpcError({ code, message, details: message, reason });
}

function onTheWire<T>(codec: MessageFns<T>, req: unknown): T {
  return codec.decode(codec.encode(req as T).finish());
}

const fsOver = (t: FakeTransport) => new MachineFs(t);

// ── read ──────────────────────────────────────────────────────────────────

describe("fs.read", () => {
  it("reassembles the chunks once the end marker confirms the count", async () => {
    const t = new FakeTransport({
      stream: {
        chunks: [
          { entry: wireEntry(), data: enc("ab"), eof: false, bytesRead: 0 },
          { data: enc("cd"), eof: false, bytesRead: 0 },
          { data: new Uint8Array(), eof: true, bytesRead: 4 },
        ],
      },
    });
    expect(dec(await fsOver(t).read("m1", "/home/boxd/a.txt"))).toBe("abcd");
    expect(t.calls[0]!.method).toBe("FsRead");
    const req = t.calls[0]!.req as { vmId: string; path: Uint8Array; offset: number; length?: number };
    expect(req.vmId).toBe("m1");
    expect(dec(req.path)).toBe("/home/boxd/a.txt");
    expect(req.offset).toBe(0);
    expect(req.length).toBeUndefined();
  });

  it("passes a range through", async () => {
    const t = new FakeTransport({ stream: { chunks: [{ data: enc("x"), eof: true, bytesRead: 1 }] } });
    await fsOver(t).read("m1", "f", { offset: 10, length: 1 });
    expect(t.calls[0]!.req).toMatchObject({ offset: 10, length: 1 });
  });

  it("a stream that ends without the end marker is an error, not a short file", async () => {
    const t = new FakeTransport({ stream: { chunks: [{ data: enc("ab"), eof: false, bytesRead: 0 }] } });
    const err = await fsOver(t).read("m1", "/f").catch((e) => e);
    expect(err).toBeInstanceOf(BoxdError);
    expect(err.message).toContain("stopped before the end");
  });

  it("an end marker that counts more bytes than arrived is an error", async () => {
    const t = new FakeTransport({ stream: { chunks: [{ data: enc("ab"), eof: true, bytesRead: 3 }] } });
    const err = await fsOver(t).read("m1", "/f").catch((e) => e);
    expect(err).toBeInstanceOf(BoxdError);
    expect(err.message).toContain("sent 3 bytes, 2 arrived");
  });

  it("a filesystem failure throws FilesystemError naming the path", async () => {
    const t = new FakeTransport({
      stream: { chunks: [], error: statusError(GrpcStatus.FAILED_PRECONDITION, "is a dir", "is_a_directory") },
    });
    const err = await fsOver(t).read("m1", "/home/boxd").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EISDIR");
    expect(err.reason).toBe("is_a_directory");
    expect(err.path).toBe("/home/boxd");
  });

  it("readStream yields as chunks arrive and cancels when the reader stops", async () => {
    const t = new FakeTransport({
      stream: {
        chunks: [
          { data: enc("a"), eof: false, bytesRead: 0 },
          { data: enc("b"), eof: false, bytesRead: 0 },
        ],
        open: true,
      },
    });
    const seen: string[] = [];
    for await (const chunk of fsOver(t).readStream("m1", "/f")) {
      seen.push(dec(chunk));
      break;
    }
    expect(seen).toEqual(["a"]);
    expect(t.reads[0]!.cancelled).toBe(true);
  });

  it("refuses a negative offset before calling", async () => {
    const t = new FakeTransport();
    await expect(fsOver(t).read("m1", "/f", { offset: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(t.calls).toEqual([]);
  });
});

// ── write ─────────────────────────────────────────────────────────────────

describe("fs.write", () => {
  const ok = { resp: { bytesWritten: 0, entry: wireEntry() } };

  it("text goes as UTF-8 in one chunk that carries the target and the size", async () => {
    const t = new FakeTransport({ write: ok });
    const entry = await fsOver(t).write("m1", "/home/boxd/a.txt", "héllo");
    expect(entry.name).toBe("a.txt");
    const [first, ...rest] = t.writes[0]!.written;
    expect(rest).toEqual([]);
    expect(first!.vmId).toBe("m1");
    expect(dec(first!.path)).toBe("/home/boxd/a.txt");
    expect(dec(first!.data)).toBe("héllo");
    expect(first!.expectedSize).toBe(6);
    // No mode asked for: unset on the wire, so an existing file keeps its own.
    expect(first!.mode).toBeUndefined();
    expect(t.writes[0]!.ended).toBe(true);
  });

  it("splits large bytes into 1 MiB chunks; only the first names the target", async () => {
    const t = new FakeTransport({ write: ok });
    const data = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => i % 251);
    await fsOver(t).write("m1", "/big", data, { mode: 0o600 });
    const chunks = t.writes[0]!.written;
    expect(chunks.map((c) => c.data.length)).toEqual([1024 * 1024, 1024 * 1024, 512 * 1024]);
    expect(chunks[0]!).toMatchObject({ vmId: "m1", mode: 0o600, expectedSize: data.length });
    for (const c of chunks.slice(1)) {
      expect(c.vmId).toBe("");
      expect(c.path.length).toBe(0);
      expect(c.mode).toBeUndefined();
      expect(c.expectedSize).toBeUndefined();
    }
    const back = new Uint8Array(data.length);
    let off = 0;
    for (const c of chunks) {
      back.set(c.data, off);
      off += c.data.length;
    }
    expect(back).toEqual(data);
    // Backpressure is respected between chunks.
    expect(t.writes[0]!.drains).toBe(3);
  });

  it("an empty file is one chunk with no data, and mode 0 is sent as 0", async () => {
    const t = new FakeTransport({ write: ok });
    await fsOver(t).write("m1", "/empty", new Uint8Array(), { mode: 0 });
    const chunks = t.writes[0]!.written;
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.data.length).toBe(0);
    expect(chunks[0]!.expectedSize).toBe(0);
    expect(chunks[0]!.mode).toBe(0);
  });

  it("a stream source is sent as read, without a size, and empty still sends one chunk", async () => {
    async function* gen() {
      yield enc("one ");
      yield new Uint8Array(1024 * 1024 + 1).fill(120);
      yield enc("");
    }
    const t = new FakeTransport({ write: ok });
    await fsOver(t).write("m1", "/s", gen());
    const chunks = t.writes[0]!.written;
    expect(chunks.map((c) => c.data.length)).toEqual([4, 1024 * 1024, 1]);
    expect(chunks[0]!.expectedSize).toBeUndefined();

    const t2 = new FakeTransport({ write: ok });
    await fsOver(t2).write("m1", "/s", (async function* () {})());
    expect(t2.writes[0]!.written.length).toBe(1);
    expect(t2.writes[0]!.written[0]!.data.length).toBe(0);
  });

  it("a source that throws abandons the write: cancelled, never ended", async () => {
    async function* broken() {
      yield enc("partial");
      throw new Error("disk read failed");
    }
    const t = new FakeTransport({ write: ok });
    const err = await fsOver(t).write("m1", "/f", broken()).catch((e) => e);
    expect(err.message).toBe("disk read failed");
    expect(t.writes[0]!.cancelled).toBe(true);
    expect(t.writes[0]!.ended).toBe(false);
  });

  it("a refusal mid-write stops reading the source and names the path", async () => {
    let pulled = 0;
    function* many() {
      for (let i = 0; i < 10; i++) {
        pulled++;
        yield new Uint8Array(10);
      }
    }
    const t = new FakeTransport({
      write: {
        afterChunks: 1,
        error: statusError(GrpcStatus.PERMISSION_DENIED, "denied", "permission_denied"),
      },
    });
    const err = await fsOver(t).write("m1", "/etc/shadow", many()).catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EACCES");
    expect(err.path).toBe("/etc/shadow");
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a mode outside the permission bits before calling", async () => {
    const t = new FakeTransport({ write: ok });
    await expect(fsOver(t).write("m1", "/f", "x", { mode: 0o10000 })).rejects.toBeInstanceOf(RangeError);
    expect(t.calls).toEqual([]);
  });
});

// ── stat / exists / list ──────────────────────────────────────────────────

describe("fs.stat and fs.exists", () => {
  it("maps the entry, following a symlink for isDir/isFile", async () => {
    const t = new FakeTransport({
      unary: [
        {
          entry: wireEntry({
            name: enc("link"),
            path: enc("/home/boxd/link"),
            type: FsEntryType.FS_ENTRY_TYPE_SYMLINK,
            targetType: FsEntryType.FS_ENTRY_TYPE_DIRECTORY,
            symlinkTarget: enc("target"),
          }),
        },
      ],
    });
    const e = await fsOver(t).stat("m1", "/home/boxd/link");
    expect(t.calls[0]!.method).toBe("FsStat");
    expect(e).toMatchObject({
      name: "link",
      path: "/home/boxd/link",
      type: "symlink",
      targetType: "directory",
      isDir: true,
      isFile: false,
      isSymlink: true,
      symlinkTarget: "target",
      size: 4,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    });
    expect(e.mtime.getTime()).toBe(1_700_000);
  });

  it("exists: true for a file, false for a dangling symlink", async () => {
    const t = new FakeTransport({
      unary: [
        { entry: wireEntry() },
        {
          entry: wireEntry({
            type: FsEntryType.FS_ENTRY_TYPE_SYMLINK,
            targetType: FsEntryType.FS_ENTRY_TYPE_UNSPECIFIED,
          }),
        },
      ],
    });
    expect(await fsOver(t).exists("m1", "/a")).toBe(true);
    expect(await fsOver(t).exists("m1", "/dangling")).toBe(false);
  });

  it("exists: false on any filesystem failure", async () => {
    for (const [code, reason] of [
      [GrpcStatus.NOT_FOUND, "not_found"],
      [GrpcStatus.FAILED_PRECONDITION, "not_a_directory"],
      [GrpcStatus.PERMISSION_DENIED, "permission_denied"],
      [GrpcStatus.FAILED_PRECONDITION, "symlink_loop"],
    ] as const) {
      const t = new FakeTransport({ unary: [statusError(code, reason, reason)] });
      expect(await fsOver(t).exists("m1", "/x")).toBe(false);
    }
  });

  it("exists still throws when the machine, not the path, is the problem", async () => {
    const missingMachine = new FakeTransport({
      unary: [statusError(GrpcStatus.NOT_FOUND, "VM not found")],
    });
    const err = await fsOver(missingMachine).exists("nope", "/x").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(FilesystemError);

    const outdated = new FakeTransport({
      unary: [statusError(GrpcStatus.FAILED_PRECONDITION, "agent too old", "agent_outdated")],
    });
    await expect(fsOver(outdated).exists("m1", "/x")).rejects.toBeInstanceOf(AgentOutdatedError);
  });

  it("list collects every batch; listIter yields lazily", async () => {
    const t = new FakeTransport({
      stream: {
        chunks: [
          { entries: [wireEntry({ name: enc("a") }), wireEntry({ name: enc("b") })] },
          { entries: [wireEntry({ name: enc("c") })] },
        ],
      },
    });
    const names = (await fsOver(t).list("m1", "/d")).map((e) => e.name);
    expect(names).toEqual(["a", "b", "c"]);
    expect(t.calls[0]!.method).toBe("FsList");

    const inFlight = new FakeTransport({
      stream: { chunks: [{ entries: [wireEntry({ name: enc("a") })] }], open: true },
    });
    const lazy = fsOver(inFlight).listIter("m1", "/d");
    expect(inFlight.calls.length).toBe(0); // nothing sent until iterated
    const first = await lazy.next();
    expect(first.value?.name).toBe("a");
    await lazy.return(undefined);
    expect(inFlight.reads[0]!.cancelled).toBe(true);
  });

  it("listing a file names the path on the error", async () => {
    const t = new FakeTransport({
      stream: {
        chunks: [],
        error: statusError(GrpcStatus.FAILED_PRECONDITION, "not a dir", "not_a_directory"),
      },
    });
    const err = await fsOver(t).list("m1", "/f").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("ENOTDIR");
    expect(err.path).toBe("/f");
  });
});

// ── mkdir / remove / rename / realpath ────────────────────────────────────

describe("fs mutations", () => {
  it("mkdir sends mode only when asked", async () => {
    const t = new FakeTransport();
    await fsOver(t).mkdir("m1", "/a/b");
    await fsOver(t).mkdir("m1", "/a/c", { mode: 0o700 });
    expect(t.calls.map((c) => c.method)).toEqual(["FsMkdir", "FsMkdir"]);
    expect(onTheWire(FsMkdirRequest, t.calls[0]!.req).mode).toBeUndefined();
    expect(onTheWire(FsMkdirRequest, t.calls[1]!.req).mode).toBe(0o700);
  });

  it("remove is not recursive unless asked", async () => {
    const t = new FakeTransport();
    await fsOver(t).remove("m1", "/f");
    await fsOver(t).remove("m1", "/d", { recursive: true });
    expect(t.calls.map((c) => (c.req as { recursive: boolean }).recursive)).toEqual([false, true]);
  });

  it("rename replaces by default; overwrite: false asks for no-replace", async () => {
    const t = new FakeTransport();
    await fsOver(t).rename("m1", "/a", "/b");
    await fsOver(t).rename("m1", "/a", "/b", { overwrite: false });
    const reqs = t.calls.map((c) => c.req as { oldPath: Uint8Array; newPath: Uint8Array; noReplace: boolean });
    expect(reqs.map((r) => r.noReplace)).toEqual([false, true]);
    expect(dec(reqs[0]!.oldPath)).toBe("/a");
    expect(dec(reqs[0]!.newPath)).toBe("/b");
  });

  it("rename failure names the source path", async () => {
    const t = new FakeTransport({
      unary: [statusError(GrpcStatus.ALREADY_EXISTS, "exists", "file_exists")],
    });
    const err = await fsOver(t).rename("m1", "/a", "/b", { overwrite: false }).catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EEXIST");
    expect(err.path).toBe("/a");
  });

  it("realpath decodes the resolved path", async () => {
    const t = new FakeTransport({ unary: [{ path: enc("/home/boxd/target/missing") }] });
    expect(await fsOver(t).realpath("m1", "link/missing")).toBe("/home/boxd/target/missing");
  });

  it("realpathBytes keeps a path that isn't UTF-8 exact", async () => {
    const raw = new Uint8Array([0x2f, 0x74, 0x2f, 0x66, 0xff]); // "/t/f\xff"
    const t = new FakeTransport({ unary: [{ path: raw }, { path: raw }] });
    const bytes = await fsOver(t).realpathBytes("m1", "link");
    expect(t.calls[0]!.method).toBe("FsRealpath");
    expect(bytes).toEqual(raw);
    bytes[0] = 0;
    expect(raw[0]).toBe(0x2f);
    expect(await fsOver(t).realpath("m1", "link")).toBe("/t/f\uFFFD");
  });

  it("realpathBytes failure names the path", async () => {
    const t = new FakeTransport({
      unary: [statusError(GrpcStatus.FAILED_PRECONDITION, "loop", "symlink_loop")],
    });
    const err = await fsOver(t).realpathBytes("m1", "/loop").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("ELOOP");
    expect(err.path).toBe("/loop");
  });
});

// ── paths ─────────────────────────────────────────────────────────────────

describe("paths are bytes", () => {
  it("a name that isn't UTF-8 round-trips through nameBytes/pathBytes", async () => {
    const raw = new Uint8Array([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x66, 0xff, 0x0a, 0x09]); // "/tmp/f\xff\n\t"
    const name = raw.subarray(5);
    const t = new FakeTransport({
      stream: { chunks: [{ entries: [wireEntry({ name, path: raw })] }] },
      unary: [{}],
    });
    const [entry] = await fsOver(t).list("m1", "/tmp");
    expect(entry!.nameBytes).toEqual(name);
    expect(entry!.pathBytes).toEqual(raw);
    expect(entry!.name).toBe("f�\n\t");
    await fsOver(t).remove("m1", entry!.pathBytes);
    expect((t.calls[1]!.req as { path: Uint8Array }).path).toEqual(raw);
  });

  it("refuses a path that is neither a string nor bytes", async () => {
    const t = new FakeTransport();
    await expect(fsOver(t).stat("m1", 42 as never)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("wiring", () => {
  it("machines.fs is a MachineFs on the client's transport", async () => {
    const t = new FakeTransport({ unary: [{ entry: wireEntry() }] });
    const machines = new Machines(t);
    expect(machines.fs).toBeInstanceOf(MachineFs);
    await machines.fs.stat("m1", "/a");
    expect(t.calls[0]!.method).toBe("FsStat");
  });
});
