/**
 * @internal
 * The Node wire layer: grpc-js, one channel, credentials, deadlines,
 * retries, error mapping.
 *
 * Namespaces receive a {@link Transport} (the interface, `_rpc.ts`), never
 * `Boxd` and never this concrete class — that keeps the plumbing off the
 * client's public surface, and is what lets `_transportWeb.ts`
 * stand in for this one without any namespace file knowing the difference.
 *
 * Every RPC is dispatched generically off a `MethodDef` (`BoxdApiDefinition
 * .methods.<x>`, see `_generated/definitions.ts`) via grpc-js's own
 * `Client.makeUnaryRequest` / `makeServerStreamRequest` /
 * `makeBidiStreamRequest` / `makeClientStreamRequest` — the same primitives
 * `makeGenericClientConstructor` uses to build the friendly per-method
 * wrappers on `BoxdApiClient`. That means adding an RPC never touches this
 * file: it only has to exist in the proto.
 *
 * Not exported from the package index; it is not part of the public API.
 */
import {
  Client,
  credentials,
  Metadata,
  type CallOptions,
  type ChannelCredentials,
  type ClientDuplexStream,
  type ClientOptions,
  type ClientWritableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { maybeNotifyUpdate, VERSION_REQUEST_HEADER, VERSION_RESPONSE_HEADER } from "./_versionCheck.js";
import { VERSION } from "./_version.js";
import type { Credentials } from "./auth.js";
import { fromGrpcError } from "./errors.js";
import { withRetries } from "./_retry.js";
import { consoleBaseUrl, resolveEndpoint } from "./utils.js";
import type {
  DuplexCall,
  MethodDef,
  ReadableCall,
  Transport as ITransport,
  WritableCall,
} from "./_rpc.js";

/**
 * gRPC-js defaults the receive limit to 4 MiB, which quietly caps
 * `machines.files.download()` and any other large unary response. Lift both
 * directions to 64 MiB — enough for realistic single-message file reads while
 * still bounding memory. Larger transfers should use the streaming file path.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface TransportOptions {
  creds: Credentials;
  /** Explicit endpoint. Unset lets the surrounding machine name its cluster. */
  explicitBaseURL?: string;
  defaultBaseURL: string;
  timeoutMs: number;
  maxRetries: number;
}

function methodPath(method: MethodDef<unknown, unknown>): string {
  return `/${BoxdApiDefinition.fullName}/${method.name}`;
}

function serializeFor<T>(method: MethodDef<T, unknown>): (v: T) => Buffer {
  return (v) => Buffer.from(method.requestType.encode(v).finish());
}

function deserializeFor<T>(method: MethodDef<unknown, T>): (v: Buffer) => T {
  return (v) => method.responseType.decode(v);
}

export class Transport implements ITransport {
  readonly #creds: Credentials;
  readonly #explicitBaseURL?: string;
  readonly #defaultBaseURL: string;
  readonly #timeout: number;
  readonly #maxRetries: number;
  #client?: Client;
  #connecting?: Promise<Client>;

  /** grpc-js's `duplex()` is a genuine bidi stream — no request/response
   *  ordering constraint at all. */
  readonly supportsInteractiveExec = true;

  constructor(opts: TransportOptions) {
    this.#creds = opts.creds;
    this.#explicitBaseURL = opts.explicitBaseURL;
    this.#defaultBaseURL = opts.defaultBaseURL;
    this.#timeout = opts.timeoutMs;
    this.#maxRetries = opts.maxRetries;
  }

  /**
   * Dial lazily. Async because resolving the credential can also resolve which
   * cluster to talk to. Memoised on the promise so concurrent first calls
   * share one channel.
   */
  #ensureClient(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<Client> {
    // An explicit baseURL always wins; otherwise the surrounding machine
    // names its own cluster; otherwise production.
    const baseURL =
      this.#explicitBaseURL ?? (await this.#creds.clusterUrl()) ?? this.#defaultBaseURL;
    const endpoint = resolveEndpoint(baseURL);
    // Credentials travel per-call in metadata; channel creds only pick
    // plaintext vs TLS.
    const channelCreds: ChannelCredentials = endpoint.useTls
      ? credentials.createSsl()
      : credentials.createInsecure();
    const opts: ClientOptions = {
      "grpc.max_receive_message_length": MAX_MESSAGE_BYTES,
      "grpc.max_send_message_length": MAX_MESSAGE_BYTES,
    };
    this.#client = new Client(endpoint.host, channelCreds, opts);
    return this.#client;
  }

  /**
   * The web console's origin for whichever cluster this client talks to.
   * Same resolution order as `#connect`, so the two can never disagree.
   */
  async consoleOrigin(): Promise<string> {
    const baseURL =
      this.#explicitBaseURL ?? (await this.#creds.clusterUrl()) ?? this.#defaultBaseURL;
    return consoleBaseUrl(baseURL);
  }

  async #metadata(): Promise<Metadata> {
    const md = new Metadata();
    md.add("authorization", `Bearer ${await this.#creds.getToken()}`);
    md.add(VERSION_REQUEST_HEADER, VERSION);
    return md;
  }

  #callOptions(): CallOptions {
    return { deadline: new Date(Date.now() + this.#timeout) };
  }

  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    return withRetries(this.#maxRetries, () => this.#invokeUnary(method, req));
  }

  async #invokeUnary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req): Promise<Resp> {
    const client = await this.#ensureClient();
    const md = await this.#metadata();
    return new Promise<Resp>((resolve, reject) => {
      const call = client.makeUnaryRequest<Req, Resp>(
        methodPath(method),
        serializeFor(method),
        deserializeFor(method),
        req,
        md,
        this.#callOptions(),
        (err, resp) => {
          if (err) return reject(fromGrpcError(err));
          resolve(resp as Resp);
        },
      );
      // Initial response metadata carries the latest published SDK version.
      call.on("metadata", (initialMd: Metadata) => {
        maybeNotifyUpdate(initialMd.get(VERSION_RESPONSE_HEADER).map(String));
      });
    });
  }

  serverStream<Req, Resp>(
    method: MethodDef<Req, Resp>,
    req: Req,
    opts?: { deadline?: boolean },
  ): ReadableCall<Resp> {
    // Dialling + metadata are async; the caller wants a call handle
    // synchronously (matches grpc-js's own shape), so proxy events until the
    // real stream is up.
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    let live: { cancel(): void } | undefined;
    let cancelled = false;
    const proxy: ReadableCall<Resp> = {
      on(event, fn) {
        (handlers[event] ??= []).push(fn as (arg: unknown) => void);
      },
      cancel() {
        cancelled = true;
        live?.cancel();
      },
    };
    void (async () => {
      try {
        const client = await this.#ensureClient();
        const md = await this.#metadata();
        if (cancelled) return;
        const call = client.makeServerStreamRequest<Req, Resp>(
          methodPath(method),
          serializeFor(method),
          deserializeFor(method),
          req,
          md,
          opts?.deadline === false ? {} : this.#callOptions(),
        );
        live = call;
        call.on("metadata", (initialMd: Metadata) => {
          maybeNotifyUpdate(initialMd.get(VERSION_RESPONSE_HEADER).map(String));
        });
        call.on("data", (msg: Resp) => {
          if (!cancelled) emit(handlers, "data", msg);
        });
        call.on("error", (err: ServiceError) => {
          if (!cancelled) emit(handlers, "error", fromGrpcError(err));
        });
        call.on("end", () => {
          if (!cancelled) emit(handlers, "end", undefined);
        });
      } catch (err) {
        if (!cancelled) emit(handlers, "error", err);
      }
    })();
    return proxy;
  }

  duplex<Req, Resp>(method: MethodDef<Req, Resp>): DuplexCall<Req, Resp> {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const pending: Array<(c: ClientDuplexStream<Req, Resp>) => void> = [];
    let live: ClientDuplexStream<Req, Resp> | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const client = await this.#ensureClient();
        const md = await this.#metadata();
        if (cancelled) return;
        // No deadline: matches the earlier behaviour of the raw
        // `grpc.exec(md)` call this replaces (no `CallOptions` at all) — the
        // only caller (`machines.ts`'s `exec()`) is a long-lived interactive
        // session that must not be killed by the client's default per-call
        // timeout. `serverStream`'s `opts.deadline` is the general opt-out;
        // `duplex` only ever carries `Exec`, so it's unconditional here
        // rather than plumbed through as an option nothing else would use.
        const call = client.makeBidiStreamRequest<Req, Resp>(
          methodPath(method),
          serializeFor(method),
          deserializeFor(method),
          md,
          {},
        );
        call.on("metadata", (initialMd: Metadata) => {
          maybeNotifyUpdate(initialMd.get(VERSION_RESPONSE_HEADER).map(String));
        });
        call.on("data", (msg: Resp) => emit(handlers, "data", msg));
        call.on("error", (err: ServiceError) => emit(handlers, "error", fromGrpcError(err)));
        call.on("end", () => emit(handlers, "end", undefined));
        live = call;
        for (const fn of pending.splice(0)) fn(call);
      } catch (err) {
        emit(handlers, "error", err);
      }
    })();

    return {
      write(msg) {
        if (live) live.write(msg);
        else pending.push((c) => c.write(msg));
      },
      end() {
        if (live) live.end();
        else pending.push((c) => c.end());
      },
      cancel() {
        cancelled = true;
        live?.cancel();
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
    const pending: Array<(c: ClientWritableStream<Req>) => void> = [];
    let live: ClientWritableStream<Req> | undefined;
    let cancelled = false;
    // Backpressure: grpc-js's `write()` returns false once its buffer is past
    // the high-water mark, then emits "drain". `drained()` waits for that,
    // and for the call to exist at all (writes before then only queue).
    let full = false;
    let over = false;
    const waiters: Array<() => void> = [];
    const wake = () => {
      for (const w of waiters.splice(0)) w();
    };
    const writeTo = (c: ClientWritableStream<Req>, msg: Req) => {
      if (!c.write(msg)) full = true;
    };

    void (async () => {
      try {
        const client = await this.#ensureClient();
        const md = await this.#metadata();
        if (cancelled) return;
        // No deadline: matches the earlier `grpc.uploadFileStream(...)`
        // call this replaces (no `CallOptions`) — the only callers
        // (`files.ts`'s upload, `fs.ts`'s write) can run well past the
        // client's default per-call timeout for a large file. Same
        // reasoning as `duplex` above.
        const call = client.makeClientStreamRequest<Req, Resp>(
          methodPath(method),
          serializeFor(method),
          deserializeFor(method),
          md,
          {},
          (err, resp) => {
            over = true;
            wake();
            if (cancelled) return;
            if (err) return callback(fromGrpcError(err), undefined as never);
            callback(null, resp as Resp);
          },
        );
        call.on("metadata", (initialMd: Metadata) => {
          maybeNotifyUpdate(initialMd.get(VERSION_RESPONSE_HEADER).map(String));
        });
        call.on("drain", () => {
          full = false;
          wake();
        });
        live = call;
        for (const fn of pending.splice(0)) fn(call);
        if (!full) wake();
      } catch (err) {
        over = true;
        wake();
        if (!cancelled) callback(err, undefined as never);
      }
    })();

    return {
      write(msg) {
        if (live) writeTo(live, msg);
        else pending.push((c) => writeTo(c, msg));
      },
      end() {
        if (live) live.end();
        else pending.push((c) => c.end());
      },
      cancel() {
        cancelled = true;
        over = true;
        wake();
        live?.cancel();
      },
      drained() {
        if (over || (live && !full)) return Promise.resolve();
        return new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      },
    };
  }

  close(): void {
    if (this.#client) {
      this.#client.close();
      this.#client = undefined;
    }
  }
}

function emit(
  handlers: Record<string, ((arg: unknown) => void)[]>,
  event: string,
  arg: unknown,
): void {
  for (const fn of handlers[event] ?? []) fn(arg);
}
