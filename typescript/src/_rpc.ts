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
import type { NotFoundError } from "./errors.js";

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

/**
 * What every call can carry besides its request. A single-endpoint transport
 * (`_transport.ts`, `_transportWeb.ts`) ignores it; the region router
 * (`_regions.ts`), which is what the namespaces are given, sends the call to
 * that region's endpoint.
 */
export interface CallOptions {
  /** The region the call goes to. Default: the client's. */
  region?: string;
}

/** Per-call adjustments to a {@link Transport.unary} call. */
export interface UnaryOptions extends CallOptions {
  /** Added to the client's per-call deadline, for a call that takes longer
   *  by design (a computer action that waits, holds a key or types a lot). */
  extraTimeoutMs?: number;
  /** `false` never repeats the call, not even after a connection failure:
   *  for a call that must not run twice (a click, typing). Default `true`. */
  retry?: boolean;
}

/** One answer per region, from {@link Transport.eachRegion}. */
export interface RegionPages<Resp> {
  /** `region` is undefined outside a federation (one answer, from home). */
  pages: Array<{ region: string | undefined; resp: Resp }>;
  /** Regions that could not be reached just now. */
  unavailable: string[];
}

export interface Transport {
  /** Unary call: request in, response out. Every simple RPC (create/get/
   *  list/...) goes through this — it is reachable over grpc-web, so this
   *  one method is what makes the whole non-streaming SDK surface work
   *  unmodified under the web transport. */
  unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req, opts?: UnaryOptions): Promise<Resp>;
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
    opts?: CallOptions & { deadline?: boolean },
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
  duplex<Req, Resp>(
    method: MethodDef<Req, Resp>,
    opts?: CallOptions & {
      /** The machine the stream is about (`Exec`), for a not-found's hint. */
      machine?: string;
    },
  ): DuplexCall<Req, Resp>;
  /** Client-streaming call (`UploadFileStream`). Same half-duplex-over-
   *  grpc-web shape as `duplex` on the web transport — every chunk is
   *  buffered until `end()`, which is also genuinely half-duplex-shaped
   *  for the Node transport already (a client-streaming RPC has no
   *  interactive counterpart to worry about). */
  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
    opts?: CallOptions,
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
  /** The web console's origin for whichever cluster this client talks to
   *  (for the router: the region's). */
  consoleOrigin(region?: string): Promise<string>;
  /**
   * The region router only (`_regions.ts`): make one call in every region the
   * org has enabled. A namespace given a plain transport makes the one call
   * (`eachRegion()` in `_regions.ts` does that).
   */
  eachRegion?<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts: { org?: string },
  ): Promise<RegionPages<Resp>>;
  /**
   * The region router only: look up elsewhere a not-found the SDK throws
   * itself (an answer that carries nothing, rather than a not-found status).
   */
  findElsewhere?<Req>(
    err: NotFoundError,
    method: MethodDef<Req, unknown>,
    req: Req,
    opts?: CallOptions,
  ): Promise<NotFoundError>;
  close(): void;
}
