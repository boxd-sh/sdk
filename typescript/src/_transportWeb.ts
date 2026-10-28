/**
 * @internal
 * The web wire layer: every RPC in `api.proto` over grpc-web
 * (`fetch`), including `Exec` and `UploadFileStream` — bidi/client-streaming
 * RPCs grpc-web doesn't restrict against (verified against `tonic-web`'s
 * source: it classifies purely by content-type and re-frames the body
 * through an incremental adapter, no unary-vs-streaming check at all), run
 * **half-duplex**: every `write()` buffers a frame, nothing is sent until
 * `end()`, and only then does the response start streaming back. That's a
 * genuine limitation for a caller that reacts to output (`streamExec()`,
 * gated on `supportsInteractiveExec` in `machines.ts` before it ever reaches
 * this class), but exactly what `exec()`'s and `files.ts`'s upload's own
 * call patterns already do (write everything, then `end()`). No
 * `@grpc/grpc-js`, no Node built-ins — everything here is `fetch` +
 * `TextDecoder`, so this loads in a Cloudflare Worker, a browser, or any
 * other fetch-capable runtime.
 *
 * Implements the same {@link Transport} interface `_transport.ts` (grpc-js)
 * does, dispatched off the same `MethodDef` table
 * (`_generated/definitions.ts`, itself grpc-js-free) — every namespace file
 * is written against the interface and runs unmodified under either.
 *
 * Only reachable via the separate `@boxd-sh/sdk/web` entry point
 * (`web.ts`) — never imported from the default `@boxd-sh/sdk` entry, and
 * never imports anything that imports `@grpc/grpc-js`.
 */
import { maybeNotifyUpdate, VERSION_REQUEST_HEADER, VERSION_RESPONSE_HEADER } from "./_versionCheck.js";
import { VERSION } from "./_version.js";
import type { Credentials } from "./auth.js";
import {
  APIConnectionError,
  APIStatusError,
  ERROR_REASON_TRAILER,
  GrpcStatus,
  fromGrpcError,
} from "./errors.js";
import { withRetries } from "./_retry.js";
import { consoleBaseUrl, resolveEndpoint } from "./utils.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import type {
  DuplexCall,
  MethodDef,
  ReadableCall,
  Transport as ITransport,
  WritableCall,
} from "./_rpc.js";

export interface WebTransportOptions {
  creds: Credentials;
  explicitBaseURL?: string;
  defaultBaseURL: string;
  timeoutMs: number;
  maxRetries: number;
}

// ── grpc-web framing ─────────────────────────────────────────────────────
// https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md
// One frame is `[flag:1][length:4 BE][payload]`. A DATA frame (flag bit 0x80
// clear) carries one protobuf message; a TRAILER frame (flag bit 0x80 set)
// carries HTTP/1.1-style `key: value\r\n` lines (at minimum `grpc-status`).

const TRAILER_FLAG = 0x80;

function grpcWebFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

/** `grpc-message` is percent-encoded per the gRPC spec — verified against
 *  `tonic::Status::to_header_map`, which both the initial-headers path and
 *  the grpc-web trailer-frame path go through. Decode defensively (a
 *  malformed sequence shouldn't crash parsing an error into another error). */
function decodeGrpcMessage(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseTrailerText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Concatenate many frames into one body in a single pass (rather than a
 *  `reduce(concatBytes, ...)`, which would reallocate+recopy the whole
 *  running total on every one of `duplex()`/`clientStream()`'s buffered
 *  writes — quadratic for a large chunked upload). */
function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** One complete frame parsed out of `buf`, plus what's left over — or
 *  `undefined` when `buf` doesn't yet hold a whole frame. */
function takeFrame(
  buf: Uint8Array,
): { flag: number; payload: Uint8Array; rest: Uint8Array } | undefined {
  if (buf.length < 5) return undefined;
  const flag = buf[0]!;
  const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
  if (buf.length < 5 + len) return undefined;
  return { flag, payload: buf.subarray(5, 5 + len), rest: buf.subarray(5 + len) };
}

function statusError(code: number, message: string, reason?: string): Error {
  return fromGrpcError({ code, message, details: message, reason });
}

/** The error a trailers-only response carries in its headers (a rejection
 *  before any message was written), or `undefined` when it carries none. */
function headerError(resp: Response): Error | undefined {
  const status = resp.headers.get("grpc-status");
  if (status === null || status === "0") return undefined;
  return statusError(
    Number(status),
    decodeGrpcMessage(resp.headers.get("grpc-message") ?? ""),
    resp.headers.get(ERROR_REASON_TRAILER) ?? undefined,
  );
}

function emit(handlers: Record<string, ((arg: unknown) => void)[]>, event: string, arg: unknown): void {
  for (const fn of handlers[event] ?? []) fn(arg);
}

/** One signal that aborts when either does. A runtime without
 *  `AbortSignal.any` keeps the deadline; a cancelled stream there is read to
 *  its end and dropped rather than aborted. */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : a;
}

/**
 * Read `resp.body` as a sequence of grpc-web frames, calling `onData` for
 * each DATA frame's decoded payload and resolving once the TRAILER frame (or
 * the stream ending with none) settles the call. Shared by `serverStream()`
 * and `duplex()` — a server-streaming response and a half-duplex bidi
 * response are parsed identically; the only difference between the two RPCs
 * is how many request messages preceded it, which this function never sees.
 */
async function pumpGrpcWebResponse(
  resp: Response,
  onData: (payload: Uint8Array) => void,
): Promise<{ status: number; message: string; reason?: string }> {
  if (!resp.ok || !resp.body) {
    throw new APIConnectionError(`unexpected HTTP status ${resp.status}`);
  }
  const reader = resp.body.getReader();
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let trailerStatus: number | undefined;
  let trailerMessage = "";
  let trailerReason: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf = concatBytes(buf, value);
    for (;;) {
      const frame = takeFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      if (frame.flag & TRAILER_FLAG) {
        const t = parseTrailerText(frame.payload);
        trailerStatus = t["grpc-status"] !== undefined ? Number(t["grpc-status"]) : 0;
        trailerMessage = decodeGrpcMessage(t["grpc-message"] ?? "");
        trailerReason = t[ERROR_REASON_TRAILER];
      } else {
        onData(frame.payload);
      }
    }
    if (done) break;
  }
  return { status: trailerStatus ?? 0, message: trailerMessage, reason: trailerReason };
}

export class WebTransport implements ITransport {
  readonly #creds: Credentials;
  readonly #explicitBaseURL?: string;
  readonly #defaultBaseURL: string;
  readonly #timeout: number;
  readonly #maxRetries: number;

  /** grpc-web's request body must finish before the response can start
   *  streaming back — `duplex()` here only supports "write everything, then
   *  read" (see the class doc comment), never writes made in reaction to
   *  already-received data. */
  readonly supportsInteractiveExec = false;

  constructor(opts: WebTransportOptions) {
    this.#creds = opts.creds;
    this.#explicitBaseURL = opts.explicitBaseURL;
    this.#defaultBaseURL = opts.defaultBaseURL;
    this.#timeout = opts.timeoutMs;
    this.#maxRetries = opts.maxRetries;
  }

  /** Same resolution order as the Node transport: explicit > the machine's
   *  own cluster > the compiled-in default. */
  async #baseURL(): Promise<string> {
    return (
      this.#explicitBaseURL ?? (await this.#creds.clusterUrl()) ?? this.#defaultBaseURL
    );
  }

  async #httpOrigin(): Promise<string> {
    const { host, useTls } = resolveEndpoint(await this.#baseURL());
    return `${useTls ? "https" : "http"}://${host}`;
  }

  async consoleOrigin(): Promise<string> {
    return consoleBaseUrl(await this.#baseURL());
  }

  close(): void {
    // Nothing to release — `fetch` doesn't hold a channel.
  }

  // ── unary / server-streaming: grpc-web over fetch ──────────────────────

  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    return withRetries(this.#maxRetries, () => this.#invokeUnary(method, req));
  }

  async #headers(): Promise<Headers> {
    const token = await this.#creds.getToken();
    const headers = new Headers();
    headers.set("content-type", "application/grpc-web+proto");
    headers.set("x-grpc-web", "1");
    headers.set("authorization", `Bearer ${token}`);
    headers.set(VERSION_REQUEST_HEADER, VERSION);
    return headers;
  }

  async #post(
    method: MethodDef<unknown, unknown>,
    req: unknown,
    deadline: boolean,
    cancel?: AbortSignal,
  ): Promise<Response> {
    const origin = await this.#httpOrigin();
    const url = `${origin}/${BoxdApiDefinition.fullName}/${method.name}`;
    const body = grpcWebFrame(method.requestType.encode(req).finish());
    const headers = await this.#headers();
    const timeout = deadline ? AbortSignal.timeout(this.#timeout) : undefined;
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: anySignal(timeout, cancel),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        // `AbortSignal.timeout()` fired: the deadline passed with no
        // response, not a network failure — the request may already have
        // been applied server-side (e.g. `machines.create`). Map it to the
        // same non-retryable bucket grpc-js's `DEADLINE_EXCEEDED` lands in
        // (see `errors.ts`'s `isRetryable`) instead of falling into the
        // generic `APIConnectionError` below, which `withRetries` DOES
        // retry and would replay a non-idempotent call. `fetch` reserves
        // `"TimeoutError"` for exactly this case (spec-defined, verified
        // against Node/undici and workerd) — a real network drop or DNS
        // failure surfaces a different `err.name` and still falls through.
        throw statusError(GrpcStatus.DEADLINE_EXCEEDED, `deadline exceeded after ${this.#timeout}ms`);
      }
      throw new APIConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async #invokeUnary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    const resp = await this.#post(method, req, true);
    maybeNotifyUpdate(resp.headers.get(VERSION_RESPONSE_HEADER) ?? undefined);

    // A rejection before any message is written arrives as trailers-only
    // HEADERS (no frame in the body at all) — verified against the real
    // proxy, not assumed; the server's own grpc-web tests pin the same shape.
    const rejected = headerError(resp);
    if (rejected) throw rejected;
    if (!resp.ok) throw new APIConnectionError(`unexpected HTTP status ${resp.status}`);

    let rest: Uint8Array<ArrayBufferLike> = new Uint8Array(await resp.arrayBuffer());
    let message: Uint8Array | undefined;
    let trailerStatus = 0;
    let trailerMessage = "";
    let trailerReason: string | undefined;
    for (;;) {
      const frame = takeFrame(rest);
      if (!frame) break;
      rest = frame.rest;
      if (frame.flag & TRAILER_FLAG) {
        const t = parseTrailerText(frame.payload);
        trailerStatus = t["grpc-status"] !== undefined ? Number(t["grpc-status"]) : 0;
        trailerMessage = decodeGrpcMessage(t["grpc-message"] ?? "");
        trailerReason = t[ERROR_REASON_TRAILER];
      } else {
        message = frame.payload;
      }
    }
    if (trailerStatus !== 0) throw statusError(trailerStatus, trailerMessage, trailerReason);
    if (!message) throw new APIStatusError("grpc-web: response carried no message frame");
    return method.responseType.decode(message);
  }

  serverStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts?: { deadline?: boolean },
  ): ReadableCall<Resp> {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const abort = new AbortController();
    let cancelled = false;
    const proxy: ReadableCall<Resp> = {
      on(event, fn) {
        (handlers[event] ??= []).push(fn as (arg: unknown) => void);
      },
      cancel() {
        cancelled = true;
        abort.abort();
      },
    };
    void (async () => {
      try {
        const resp = await this.#post(method, req, opts?.deadline !== false, abort.signal);
        maybeNotifyUpdate(resp.headers.get(VERSION_RESPONSE_HEADER) ?? undefined);
        const rejected = headerError(resp);
        if (rejected) throw rejected;
        const { status, message, reason } = await pumpGrpcWebResponse(resp, (payload) => {
          if (!cancelled) emit(handlers, "data", method.responseType.decode(payload));
        });
        if (cancelled) return;
        if (status !== 0) {
          emit(handlers, "error", statusError(status, message, reason));
        } else {
          emit(handlers, "end", undefined);
        }
      } catch (err) {
        // A `cancel()` aborts the fetch; the caller asked for that.
        if (!cancelled) emit(handlers, "error", err);
      }
    })();
    return proxy;
  }

  // ── exec / uploadFileStream: grpc-web, half-duplex ─────────────────────
  //
  // Neither RPC is unary or server-streaming, but `GrpcWebLayer` doesn't
  // care (see the class doc comment) — so both run over the exact same
  // `fetch` POST machinery as `#post()`/unary above, just with a
  // caller-assembled multi-frame body instead of one frame. `write()` only
  // buffers; nothing is sent until `end()`, since the whole request has to
  // finish before grpc-web can start streaming the response back.

  async #sendFrames(path: string, frames: Uint8Array[], signal?: AbortSignal): Promise<Response> {
    const origin = await this.#httpOrigin();
    const url = `${origin}${path}`;
    const headers = await this.#headers();
    const body = concatAll(frames);
    try {
      return await fetch(url, { method: "POST", headers, body, signal });
    } catch (err) {
      throw new APIConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  duplex<Req, Resp>(method: MethodDef<Req, Resp>): DuplexCall<Req, Resp> {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const frames: Uint8Array[] = [];
    const abort = new AbortController();
    let sent = false;
    let cancelled = false;

    const send = () => {
      if (sent || cancelled) return;
      sent = true;
      void (async () => {
        try {
          const path = `/${BoxdApiDefinition.fullName}/${method.name}`;
          const resp = await this.#sendFrames(path, frames, abort.signal);
          maybeNotifyUpdate(resp.headers.get(VERSION_RESPONSE_HEADER) ?? undefined);
          const rejected = headerError(resp);
          if (rejected) throw rejected;
          const { status, message, reason } = await pumpGrpcWebResponse(resp, (payload) =>
            emit(handlers, "data", method.responseType.decode(payload)),
          );
          if (status !== 0) {
            emit(handlers, "error", statusError(status, message, reason));
          } else {
            emit(handlers, "end", undefined);
          }
        } catch (err) {
          // A deliberate `cancel()` aborts the fetch, which rejects with an
          // `AbortError` here — the caller already knows (that's what
          // triggered the cancel; `machines.ts`'s `exec()` rejects its own
          // promise from the timeout handler that calls `cancel()`), so
          // there's nothing productive to report. Any other failure is
          // real and gets reported same as before.
          if (cancelled) return;
          emit(handlers, "error", err);
        }
      })();
    };

    return {
      write(msg) {
        frames.push(grpcWebFrame(method.requestType.encode(msg).finish()));
      },
      end() {
        send();
      },
      cancel() {
        cancelled = true;
        abort.abort();
      },
      on(event, fn) {
        (handlers[event] ??= []).push(fn as (arg: unknown) => void);
      },
    };
  }

  clientStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    callback: (err: unknown, resp: Resp) => void,
  ): WritableCall<Req> {
    const frames: Uint8Array[] = [];
    let sent = false;
    let settled = false;
    const settle = (err: unknown, resp?: Resp) => {
      if (settled) return;
      settled = true;
      callback(err, resp as Resp);
    };

    // A plain arrow function (not object-literal method shorthand) so
    // `this` stays the `WebTransport` instance — `end()` below is called as
    // `call.end()` on the returned plain object, which would otherwise
    // rebind `this` to that object and break `this.#sendFrames`.
    const send = () => {
      if (sent) return;
      sent = true;
      void (async () => {
        try {
          const path = `/${BoxdApiDefinition.fullName}/${method.name}`;
          const resp = await this.#sendFrames(path, frames);
          maybeNotifyUpdate(resp.headers.get(VERSION_RESPONSE_HEADER) ?? undefined);
          const rejected = headerError(resp);
          if (rejected) throw rejected;
          let message: Uint8Array | undefined;
          const {
            status,
            message: trailerMessage,
            reason,
          } = await pumpGrpcWebResponse(resp, (payload) => {
            message = payload;
          });
          if (status !== 0) throw statusError(status, trailerMessage, reason);
          if (!message) throw new APIStatusError("grpc-web: response carried no message frame");
          settle(null, method.responseType.decode(message));
        } catch (err) {
          settle(err);
        }
      })();
    };

    return {
      write(msg) {
        frames.push(grpcWebFrame(method.requestType.encode(msg).finish()));
      },
      end() {
        send();
      },
      // Nothing has been sent before `end()`, so abandoning the call before
      // it is just never sending it.
      cancel() {
        sent = true;
        settled = true;
      },
    };
  }
}
