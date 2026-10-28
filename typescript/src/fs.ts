import type { ReadableCall, Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import type {
  FsReadChunk,
  FsWriteChunk,
  FsWriteResponse,
} from "./_generated/definitions.js";
import { BoxdError, FilesystemError } from "./errors.js";
import { decodeFsName, toFsEntry, type FsEntry } from "./models.js";

/** Bytes per write message: well under gRPC's 4 MiB message cap. */
const CHUNK_SIZE = 1024 * 1024;
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

/** A path inside the machine: a string (sent as UTF-8), or the exact bytes,
 *  for a name that isn't valid UTF-8 (`FsEntry.pathBytes`). A relative path
 *  starts in the machine user's home directory. */
export type FsPath = string | Uint8Array;

/** What `write` accepts: text (written as UTF-8), bytes, or a stream of
 *  byte chunks. */
export type FsWriteData =
  | string
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface FsReadOptions {
  /** First byte to read. Default 0. */
  offset?: number;
  /** Bytes to read from `offset`. Default: to the end of the file. */
  length?: number;
}

export interface FsWriteOptions {
  /** Permission bits, e.g. `0o600`. Default: an existing file keeps its
   *  mode, a new one gets `0o644`. */
  mode?: number;
}

export interface FsMkdirOptions {
  /** Permission bits for the directories it creates. Default `0o755`. */
  mode?: number;
}

export interface FsRemoveOptions {
  /** Remove a directory and everything in it. Without it a directory is
   *  refused (`EISDIR`). */
  recursive?: boolean;
}

export interface FsRenameOptions {
  /** Replace an existing destination. Default `true`; `false` fails with
   *  `EEXIST` instead. */
  overwrite?: boolean;
}

/**
 * Files inside a machine, as its user sees them: the same files `exec`
 * commands read and write. Every call wakes a sleeping machine first.
 *
 * A failure in the machine (missing file, a directory where a file was
 * expected, no permission, ...) throws {@link FilesystemError}, whose `code`
 * is the errno name Node's `fs` would use (`"ENOENT"`, `"EISDIR"`, ...). A
 * machine started before this API existed throws `AgentOutdatedError` until
 * it is rebooted.
 */
export class MachineFs {
  constructor(private readonly transport: Transport) {}

  /**
   * A file's contents. Only regular files can be read: a FIFO or device
   * fails with reason `not_a_regular_file`. A stream that ends before the
   * whole file arrived is an error, never a short result. The client's
   * `timeout` bounds the whole read.
   */
  async read(id: string, path: FsPath, opts: FsReadOptions = {}): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.readStream(id, path, opts)) {
      parts.push(chunk);
      total += chunk.length;
    }
    return concat(parts, total);
  }

  /**
   * `read`, as chunks while they arrive. Iteration throws at the end if the
   * stream was cut short; stopping early (`break`) cancels the transfer.
   */
  async *readStream(
    id: string,
    path: FsPath,
    opts: FsReadOptions = {},
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const display = displayPath(path);
    const offset = opts.offset ?? 0;
    checkCount("offset", offset);
    if (opts.length !== undefined) checkCount("length", opts.length);
    const call = this.transport.serverStream(BoxdApiDefinition.methods.fsRead, {
      vmId: id,
      path: toPathBytes(path),
      offset,
      length: opts.length,
    });
    let received = 0;
    let sent: number | undefined;
    try {
      for await (const chunk of events<FsReadChunk>(call)) {
        if (chunk.data && chunk.data.length > 0) {
          received += chunk.data.length;
          yield chunk.data;
        }
        if (chunk.eof) sent = chunk.bytesRead;
      }
    } catch (err) {
      throw withPath(err, display);
    }
    if (sent === undefined) {
      throw new BoxdError(
        `reading ${display} stopped before the end of the file (${received} bytes arrived)`,
      );
    }
    if (sent !== received) {
      throw new BoxdError(
        `reading ${display} lost data: the machine sent ${sent} bytes, ${received} arrived`,
      );
    }
  }

  /**
   * Replace a file's contents. Missing parent directories are created, a
   * symlink is written through to its target, and an existing file keeps
   * its mode and owner unless `mode` is given. Returns the file as written.
   *
   * Text and bytes are checked for size on arrival. A stream source is sent
   * as it is read; if it throws, the write is abandoned and the file is left
   * as it was.
   */
  async write(
    id: string,
    path: FsPath,
    data: FsWriteData,
    opts: FsWriteOptions = {},
  ): Promise<FsEntry> {
    const display = displayPath(path);
    const pathBytes = toPathBytes(path);
    checkMode(opts.mode);
    let expectedSize: number | undefined;
    let source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
    if (typeof data === "string") {
      const bytes = encoder.encode(data);
      expectedSize = bytes.length;
      source = [bytes];
    } else if (data instanceof Uint8Array) {
      expectedSize = data.length;
      source = [data];
    } else if (isIterable(data)) {
      source = data;
    } else {
      throw new TypeError("write: expected a string, a Uint8Array, or an iterable of Uint8Array");
    }

    let settled = false;
    let call!: ReturnType<Transport["clientStream"]>;
    const result = new Promise<FsWriteResponse>((resolve, reject) => {
      call = this.transport.clientStream(BoxdApiDefinition.methods.fsWrite, (err, resp) => {
        settled = true;
        if (err) reject(err);
        else resolve(resp);
      });
    });
    // Abandoning the call below must not also leave an unhandled rejection.
    result.catch(() => {});

    let first = true;
    const send = async (slice: Uint8Array) => {
      const chunk: FsWriteChunk = first
        ? { vmId: id, path: pathBytes, mode: opts.mode, expectedSize, data: slice }
        : { vmId: "", path: EMPTY, data: slice };
      first = false;
      call.write(chunk);
      if (call.drained) await call.drained();
    };
    try {
      outer: for await (const piece of source) {
        if (!(piece instanceof Uint8Array)) {
          throw new TypeError("write: a stream source must yield Uint8Array chunks");
        }
        for (let offset = 0; offset < piece.length; offset += CHUNK_SIZE) {
          // The machine already answered (a refusal): stop reading the source.
          if (settled) break outer;
          await send(piece.subarray(offset, offset + CHUNK_SIZE));
        }
      }
      // An empty file is one message with no data.
      if (first && !settled) await send(EMPTY);
    } catch (err) {
      call.cancel?.();
      throw err;
    }
    call.end();

    let resp: FsWriteResponse;
    try {
      resp = await result;
    } catch (err) {
      throw withPath(err, display);
    }
    if (!resp.entry) throw new BoxdError(`writing ${display}: the machine did not describe the file`);
    return toFsEntry(resp.entry);
  }

  /** A path's entry. A symlink is described by what it resolves to
   *  (`isSymlink` says it is one); a dangling one has `targetType: null`. */
  async stat(id: string, path: FsPath): Promise<FsEntry> {
    const display = displayPath(path);
    try {
      const resp = await this.transport.unary(BoxdApiDefinition.methods.fsStat, {
        vmId: id,
        path: toPathBytes(path),
      });
      if (!resp.entry) throw new BoxdError(`stat ${display}: the machine did not describe the path`);
      return toFsEntry(resp.entry);
    } catch (err) {
      throw withPath(err, display);
    }
  }

  /**
   * Whether the path exists, following symlinks like Node's `fs.existsSync`:
   * `false` for a dangling symlink, and for a path the machine user can't
   * look at. A missing machine, a failed connection and the like still
   * throw.
   */
  async exists(id: string, path: FsPath): Promise<boolean> {
    try {
      return (await this.stat(id, path)).targetType !== null;
    } catch (err) {
      if (err instanceof FilesystemError) return false;
      throw err;
    }
  }

  /** A directory's entries, one level, in no particular order. */
  async list(id: string, path: FsPath): Promise<FsEntry[]> {
    const out: FsEntry[] = [];
    for await (const entry of this.listIter(id, path)) out.push(entry);
    return out;
  }

  /** `list`, as entries arrive — for a directory too big to hold at once.
   *  Stopping early (`break`) cancels the listing. */
  async *listIter(id: string, path: FsPath): AsyncGenerator<FsEntry, void, undefined> {
    const display = displayPath(path);
    const call = this.transport.serverStream(BoxdApiDefinition.methods.fsList, {
      vmId: id,
      path: toPathBytes(path),
    });
    try {
      for await (const chunk of events(call)) {
        for (const entry of chunk.entries ?? []) yield toFsEntry(entry);
      }
    } catch (err) {
      throw withPath(err, display);
    }
  }

  /** Create a directory and any missing parents. An existing directory is
   *  fine; a file in the way is `EEXIST`. */
  async mkdir(id: string, path: FsPath, opts: FsMkdirOptions = {}): Promise<void> {
    checkMode(opts.mode);
    await this.#op(path, () =>
      this.transport.unary(BoxdApiDefinition.methods.fsMkdir, {
        vmId: id,
        path: toPathBytes(path),
        mode: opts.mode,
      }),
    );
  }

  /** Remove a file or a symlink (never its target), or with `recursive` a
   *  directory and everything in it. */
  async remove(id: string, path: FsPath, opts: FsRemoveOptions = {}): Promise<void> {
    await this.#op(path, () =>
      this.transport.unary(BoxdApiDefinition.methods.fsRemove, {
        vmId: id,
        path: toPathBytes(path),
        recursive: opts.recursive ?? false,
      }),
    );
  }

  /** Move or rename a file or directory. */
  async rename(
    id: string,
    oldPath: FsPath,
    newPath: FsPath,
    opts: FsRenameOptions = {},
  ): Promise<void> {
    await this.#op(oldPath, () =>
      this.transport.unary(BoxdApiDefinition.methods.fsRename, {
        vmId: id,
        oldPath: toPathBytes(oldPath),
        newPath: toPathBytes(newPath),
        noReplace: opts.overwrite === false,
      }),
    );
  }

  /**
   * The absolute path with every symlink, `.` and `..` resolved, like
   * Python's `os.path.realpath`: components that don't exist are kept as
   * written. A symlink loop is `ELOOP`. Decoded as UTF-8, like
   * `FsEntry.path`; {@link realpathBytes} has the exact bytes.
   */
  async realpath(id: string, path: FsPath): Promise<string> {
    return decodeFsName(await this.realpathBytes(id, path));
  }

  /** `realpath`, as the exact bytes — like `FsEntry.pathBytes`, for a path
   *  that may not be valid UTF-8. */
  async realpathBytes(id: string, path: FsPath): Promise<Uint8Array> {
    const resp = await this.#op(path, () =>
      this.transport.unary(BoxdApiDefinition.methods.fsRealpath, {
        vmId: id,
        path: toPathBytes(path),
      }),
    );
    // A copy: the decoded message's bytes are a view into the whole response.
    return resp.path.slice();
  }

  async #op<T>(path: FsPath, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw withPath(err, displayPath(path));
    }
  }
}

/**
 * A server stream's messages as an async iterator: buffered until read,
 * then its error (after every message that preceded it) or its end. Leaving
 * the loop early cancels the call.
 */
async function* events<T>(call: ReadableCall<T>): AsyncGenerator<T, void, undefined> {
  const buffered: T[] = [];
  let finished = false;
  let failure: { err: unknown } | undefined;
  let wake: (() => void) | undefined;
  const nudge = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  call.on("data", (msg) => {
    buffered.push(msg);
    nudge();
  });
  call.on("error", (err) => {
    failure = { err };
    finished = true;
    nudge();
  });
  call.on("end", () => {
    finished = true;
    nudge();
  });
  try {
    for (;;) {
      if (buffered.length > 0) {
        yield buffered.shift()!;
        continue;
      }
      if (failure) throw failure.err;
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (!finished) call.cancel?.();
  }
}

function toPathBytes(path: FsPath): Uint8Array {
  if (typeof path === "string") return encoder.encode(path);
  if (path instanceof Uint8Array) return path;
  throw new TypeError("a path is a string or a Uint8Array");
}

function displayPath(path: FsPath): string {
  return typeof path === "string" ? path : path instanceof Uint8Array ? decodeFsName(path) : String(path);
}

/** Name the path on a filesystem error that doesn't carry one yet. */
function withPath(err: unknown, path: string): unknown {
  if (err instanceof FilesystemError && err.path === undefined) err.path = path;
  return err;
}

function checkMode(mode: number | undefined): void {
  if (mode !== undefined && !(Number.isInteger(mode) && mode >= 0 && mode <= 0o7777)) {
    throw new RangeError(`mode must be permission bits between 0 and 0o7777, got ${mode}`);
  }
}

function checkCount(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${n}`);
  }
}

function isIterable(v: unknown): v is Iterable<Uint8Array> | AsyncIterable<Uint8Array> {
  return (
    v != null &&
    (typeof (v as Iterable<unknown>)[Symbol.iterator] === "function" ||
      typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function")
  );
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  // Always a fresh buffer: a chunk is a view into a larger response.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
