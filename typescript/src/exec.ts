import type { BoxdError } from "./errors.js";

type Waiter = {
  resolve: (v: IteratorResult<Uint8Array>) => void;
  reject: (e: unknown) => void;
};

/** A push queue that reads as an async iterable. Backs stdout/stderr. */
export class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private buffer: Uint8Array[] = [];
  private waiting?: Waiter;
  private closed = false;
  private error?: unknown;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve({ value: chunk, done: false });
      return;
    }
    this.buffer.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const next = this.buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

/** What `ExecStream` needs from the underlying bidi call. @internal */
export interface ExecTransport {
  write(data: Uint8Array): void;
  /** Half-close the client side — the subprocess sees stdin EOF. */
  end(): void;
  resize(cols: number, rows: number): void;
  cancel(): void;
}

/**
 * A live interactive/PTY exec.
 *
 * The one handle in the SDK, and unavoidable: a bidi stream is genuinely
 * stateful. Iterating the stream yields stdout; `stderr` is its own iterable
 * (PTY execs merge the two at the kernel level, so everything arrives on
 * stdout there).
 *
 * ```ts
 * await using stream = boxd.machines.streamExec(id, { command: "bash", tty: true });
 * stream.write("ls\n");
 * for await (const chunk of stream) process.stdout.write(chunk);
 * await stream.wait();
 * ```
 */
export class ExecStream implements AsyncIterable<Uint8Array> {
  readonly stdout = new AsyncByteQueue();
  readonly stderr = new AsyncByteQueue();
  #transport: ExecTransport;
  #exitCode?: number;
  #error?: BoxdError;
  #done = false;
  #resolvers: Array<(v: number) => void> = [];
  #rejecters: Array<(e: BoxdError) => void> = [];

  constructor(transport: ExecTransport) {
    this.#transport = transport;
  }

  /** Feed the subprocess's stdin. */
  write(data: Uint8Array | string): void {
    this.#transport.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  /** Half-close stdin. Headless one-shot consumers need this to stop blocking. */
  end(): void {
    this.#transport.end();
  }

  /**
   * Update the PTY geometry mid-session. Wire it to the local terminal's
   * SIGWINCH (`process.stdout.on("resize", …)`) so the remote re-renders.
   * A no-op for non-PTY execs — the server ignores it.
   */
  resize(cols: number, rows: number): void {
    this.#transport.resize(cols, rows);
  }

  /** Exit code once the process is done, `undefined` while still running. */
  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /** Resolve with the exit code when the process exits. */
  async wait(): Promise<number> {
    if (this.#done) {
      if (this.#error) throw this.#error;
      return this.#exitCode ?? -1;
    }
    return new Promise<number>((resolve, reject) => {
      this.#resolvers.push(resolve);
      this.#rejecters.push(reject);
    });
  }

  /**
   * Cancel the call. The server kills the remote process's whole process
   * group (SIGTERM, then SIGKILL after a short grace period if it hasn't
   * exited) rather than leaving it running unattended. Safe to call twice.
   */
  close(): void {
    this.#transport.cancel();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.stdout[Symbol.asyncIterator]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  /** @internal */
  _setExit(code: number): void {
    if (this.#done) return;
    this.#exitCode = code;
    this.#done = true;
    for (const r of this.#resolvers) r(code);
    this.#resolvers = [];
    this.#rejecters = [];
  }

  /** @internal */
  _setError(err: BoxdError): void {
    if (this.#done) return;
    this.#error = err;
    this.#done = true;
    for (const r of this.#rejecters) r(err);
    this.#resolvers = [];
    this.#rejecters = [];
  }
}
