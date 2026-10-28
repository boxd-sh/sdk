/**
 * @internal
 * Transport-agnostic RPC contract.
 *
 * Every namespace file (`machines.ts`, `files.ts`, `orgs.ts`, ...) is written
 * against this interface and never touches grpc-js or `fetch` directly. Two
 * implementations exist:
 *
 *  - `_transport.ts` — grpc-js, the default (`@boxd-sh/sdk`).
 *  - `_transportWeb.ts` — every RPC over grpc-web (`fetch`), `Exec`/
 *    `UploadFileStream` included, run half-duplex. Used by the separate
 *    `@boxd-sh/sdk/web` entry point, which never imports `@grpc/grpc-js` —
 *    that import fails to load in a Cloudflare Worker.
 *
 * `MethodDef` matches the shape ts-proto's `generic-definitions` output
 * emits for `BoxdApiDefinition.methods.<x>` exactly (see
 * `_generated/definitions.ts`), so a definition entry is assignable here with
 * no casts — the method table IS the contract between a namespace call site
 * and a transport, not just documentation of it.
 */
import type { MessageFns } from "./_generated/definitions.js";

export interface MethodDef<Req, Resp> {
  name: string;
  requestType: MessageFns<Req>;
  requestStream: boolean;
  responseType: MessageFns<Resp>;
  responseStream: boolean;
}

/** A server-streaming or bidi response half. Mirrors grpc-js's own call
 *  event shape (`on("data" | "error" | "end", ...)`) — the Node transport's
 *  calls already satisfy this natively; the web transport adapts a WS/fetch
 *  stream to it. */
export interface ReadableCall<Out> {
  on(event: "data", fn: (msg: Out) => void): void;
  on(event: "error", fn: (err: unknown) => void): void;
  on(event: "end", fn: () => void): void;
  /** Stop the call early (a reader that is done with a stream). Nothing is
   *  emitted after it. Optional: without it the rest of the stream is read
   *  and dropped. */
  cancel?(): void;
}

export interface WritableCall<In> {
  write(msg: In): void;
  end(): void;
  /** Abandon the call without finishing it: the server sees a cancelled
   *  stream, never a complete one, and the callback is not called. */
  cancel?(): void;
  /** Resolves once the transport has room for more writes (or the call is
   *  over). A transport that buffers the whole request anyway leaves it
   *  out. */
  drained?(): Promise<void>;
}

/** A bidi call: writable in, readable out, cancellable. Only `Exec` uses
 *  this — `DesktopTunnel` is out of scope (the web transport doesn't bridge it). */
export interface DuplexCall<In, Out> extends ReadableCall<Out> {
  write(msg: In): void;
  end(): void;
  cancel(): void;
}

export interface Transport {
  /** Unary call: request in, response out. Every simple RPC (create/get/
   *  list/...) goes through this — it is reachable over grpc-web, so this
   *  one method is what makes the whole non-streaming SDK surface work
   *  unmodified under the web transport. */
  unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp>;
  /**
   * Server-streaming call: one request, many responses (`DownloadFileStream`,
   * `StreamLogs`). Also grpc-web-reachable.
   *
   * `deadline` defaults to `true` (the client's normal per-call timeout).
   * `logs({ follow: true })` passes `false` — a follow stream is meant to
   * stay open indefinitely, so the default deadline would silently kill it
   * after `timeoutMs`.
   */
  serverStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts?: { deadline?: boolean },
  ): ReadableCall<Resp>;
  /**
   * Bidi call (`Exec`). The web transport carries this over grpc-web as
   * half-duplex: every `write()` buffers a frame, and the request isn't
   * actually sent until `end()` — only then does the response start
   * streaming back. That satisfies a caller that writes everything up
   * front (`machines.ts`'s `exec()`), but never one that writes in
   * reaction to already-received `"data"` (`streamExec()`) — see
   * `supportsInteractiveExec`, which callers must check first.
   */
  duplex<Req, Resp>(method: MethodDef<Req, Resp>): DuplexCall<Req, Resp>;
  /** Client-streaming call (`UploadFileStream`). Same half-duplex-over-
   *  grpc-web shape as `duplex` on the web transport — every chunk is
   *  buffered until `end()`, which is also genuinely half-duplex-shaped
   *  for the Node transport already (a client-streaming RPC has no
   *  interactive counterpart to worry about). */
  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
  ): WritableCall<Req>;
  /**
   * Whether `duplex()` supports genuine interactive use — writes made in
   * reaction to already-received `"data"` events, indefinite sessions,
   * `resize`. True for the Node transport. False for the web transport:
   * grpc-web's request body must finish before the response can start, so
   * `streamExec()` (`machines.ts`) must check this and fail synchronously
   * rather than call `duplex()` and hang waiting for a request that will
   * never be sent (nothing ever calls `end()` on an interactive session
   * up front).
   */
  readonly supportsInteractiveExec: boolean;
  /** The web console's origin for whichever cluster this client talks to. */
  consoleOrigin(): Promise<string>;
  close(): void;
}
