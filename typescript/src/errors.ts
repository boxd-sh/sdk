/**
 * Standard gRPC status codes (the numbers the spec defines — identical to
 * `@grpc/grpc-js`'s `status` enum, reproduced here rather than imported so
 * this file has no grpc-js dependency: it's shared by both transports, and
 * the web transport (`@boxd-sh/sdk/web`) must never pull grpc-js in
 * — that import fails to load in a Cloudflare Worker.
 */
export const GrpcStatus = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

/** The trailer a failed call names its exact reason in (`machines.fs` calls:
 *  `not_found`, `is_a_directory`, ...). Both transports read it. */
export const ERROR_REASON_TRAILER = "x-boxd-error-reason";

/** The bits of grpc-js's `ServiceError` this module actually reads —
 *  reproduced locally (see `GrpcStatus`) so this file stays grpc-js-free. */
export interface RpcError {
  code?: number;
  details?: string;
  message: string;
  /** The call's trailers (grpc-js `ServiceError.metadata`). */
  metadata?: { get(key: string): unknown[] };
  /** The {@link ERROR_REASON_TRAILER} value, for a transport that parses
   *  trailers itself (grpc-web). */
  reason?: string;
}

/** What an error carries beyond its message and gRPC status. */
export interface BoxdErrorOptions {
  /** See {@link BoxdError.reason}. */
  reason?: string;
  /** See {@link BoxdError.httpStatus}. */
  httpStatus?: number;
  /** The underlying error, e.g. the network failure behind an
   *  {@link APIConnectionError}. */
  cause?: unknown;
}

/** Base class for everything the SDK throws. */
export class BoxdError extends Error {
  /** gRPC status code, when the error came off the wire. */
  readonly grpcCode?: number;
  /**
   * The exact reason for the failure, when one is known: the server's
   * ({@link ERROR_REASON_TRAILER}), or the SDK's own for an
   * {@link AuthenticationError}.
   */
  readonly reason?: string;
  /** The HTTP status, for a failure answered over plain HTTP (the API-key
   *  exchange, the in-machine metadata adapter) rather than gRPC. */
  readonly httpStatus?: number;
  constructor(message: string, grpcCode?: number, opts: BoxdErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "BoxdError";
    this.grpcCode = grpcCode;
    this.reason = opts.reason;
    this.httpStatus = opts.httpStatus;
  }
}

/** Why an {@link AuthenticationError} was thrown. */
export type AuthenticationErrorReason =
  /** No credential was passed, set in the environment, or available from the
   *  machine this code runs in. */
  | "missing_credentials"
  /** The API-key exchange refused the key: wrong, revoked or expired. */
  | "invalid_api_key"
  /** boxd refused the token a call carried. */
  | "invalid_token";

/**
 * boxd refused the credentials, or none were found — and only that. `reason`
 * says which; `grpcCode` is always `UNAUTHENTICATED`. Not reaching boxd is an
 * {@link APIConnectionError}, and a broken answer an {@link APIStatusError}.
 *
 * **Terminal.** Revoking a key takes effect immediately, so an
 * `AuthenticationError` part-way through a session means the credential is no
 * longer valid — the client never refreshes and retries, which would only
 * spin.
 */
export class AuthenticationError extends BoxdError {
  // A reason the server names that this SDK doesn't know yet passes through.
  declare readonly reason: AuthenticationErrorReason | (string & {});
  constructor(
    message: string,
    grpcCode: number = GrpcStatus.UNAUTHENTICATED,
    opts: BoxdErrorOptions = {},
  ) {
    super(message, grpcCode, { ...opts, reason: opts.reason ?? "invalid_token" });
    this.name = "AuthenticationError";
  }
}

/** `permission_denied` — authenticated, but not allowed to touch this. Also
 *  an account that may not use the API at all (e.g. a disabled one): HTTP 403
 *  from the API-key exchange or the in-machine metadata adapter. */
export class PermissionDeniedError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "PermissionDeniedError";
  }
}

/** `not_found`. */
export class NotFoundError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "NotFoundError";
  }
}

/**
 * `already_exists` / `failed_precondition` / `aborted` — the state is wrong
 * for this call, or it changed while the call ran (e.g. a machine's spec
 * changed during `updateSpec`, which then changes nothing: read it again and
 * retry).
 */
export class ConflictError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "ConflictError";
  }
}

/** `resource_exhausted` — quota or rate limit (also HTTP 429 from the
 *  API-key exchange or the in-machine metadata adapter). */
export class RateLimitError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "RateLimitError";
  }
}

/** Any other non-OK gRPC status, or an HTTP answer the SDK can't use (a 5xx
 *  or a malformed body from the API-key exchange or the in-machine metadata
 *  adapter; `httpStatus` says which). */
export class APIStatusError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "APIStatusError";
  }
}

/**
 * Transport failure — the request never got a status back, or the server was
 * `unavailable`. Also: the API-key exchange or the in-machine metadata adapter
 * could not be reached (`cause` holds the network error). The only class the
 * client retries.
 */
export class APIConnectionError extends BoxdError {
  constructor(message: string, grpcCode?: number, opts?: BoxdErrorOptions) {
    super(message, grpcCode, opts);
    this.name = "APIConnectionError";
  }
}

/**
 * The machine's agent predates the call (`machines.fs` on a machine started
 * before the filesystem API existed). Rebooting the machine updates it.
 */
export class AgentOutdatedError extends ConflictError {
  constructor(message: string, grpcCode?: number, opts: BoxdErrorOptions = {}) {
    super(
      /reboot/i.test(message)
        ? message
        : `${message || "this machine's agent is too old for this call"}; reboot the machine to update it`,
      grpcCode,
      { ...opts, reason: opts.reason ?? "agent_outdated" },
    );
    this.name = "AgentOutdatedError";
  }
}

/** Every reason a `machines.fs` call can fail with, as the server names it. */
export type FilesystemErrorReason =
  | "not_found"
  | "permission_denied"
  | "file_exists"
  | "is_a_directory"
  | "not_a_directory"
  | "directory_not_empty"
  | "not_a_regular_file"
  | "symlink_loop"
  | "name_too_long"
  | "invalid_path"
  | "no_space"
  | "read_only"
  | "busy"
  | "cross_device"
  | "size_mismatch"
  | "io_error";

/** Each reason's errno name, as Node's `fs` reports it in `err.code`. */
const FS_ERRNO: Record<FilesystemErrorReason, string | undefined> = {
  not_found: "ENOENT",
  permission_denied: "EACCES",
  file_exists: "EEXIST",
  is_a_directory: "EISDIR",
  not_a_directory: "ENOTDIR",
  directory_not_empty: "ENOTEMPTY",
  not_a_regular_file: undefined,
  symlink_loop: "ELOOP",
  name_too_long: "ENAMETOOLONG",
  invalid_path: "EINVAL",
  no_space: "ENOSPC",
  read_only: "EROFS",
  busy: "EBUSY",
  cross_device: "EXDEV",
  size_mismatch: undefined,
  io_error: "EIO",
};

function isFilesystemReason(reason: string): reason is FilesystemErrorReason {
  return Object.prototype.hasOwnProperty.call(FS_ERRNO, reason);
}

/**
 * A `machines.fs` call failed inside the machine: the file is missing, is a
 * directory, can't be written, ... `code` is the errno name Node's own `fs`
 * would use (`err.code === "ENOENT"`), and `reason` the server's exact name
 * for the failure.
 *
 * The five most common reasons throw a subclass, so a `catch` can test the
 * class instead of the string: {@link MachineFileNotFoundError},
 * {@link MachinePermissionError}, {@link MachineFileExistsError},
 * {@link MachineIsADirectoryError} and {@link MachineNotADirectoryError}.
 * Every other reason throws `FilesystemError` itself.
 *
 * Not a {@link NotFoundError}/{@link ConflictError}: those mean the machine
 * or the request is wrong, this means the path is.
 */
export class FilesystemError extends BoxdError {
  declare readonly reason: FilesystemErrorReason;
  /** `"ENOENT"`, `"EISDIR"`, ...; undefined for `not_a_regular_file` and
   *  `size_mismatch`, which have no errno of their own. */
  readonly code?: string;
  /** The path the call was about, as given. */
  path?: string;
  constructor(message: string, reason: FilesystemErrorReason, grpcCode?: number, path?: string) {
    super(message, grpcCode, { reason });
    this.name = "FilesystemError";
    this.code = FS_ERRNO[reason];
    this.path = path;
  }
}

/** `not_found` (`ENOENT`): no such file or directory. */
export class MachineFileNotFoundError extends FilesystemError {
  declare readonly reason: "not_found";
  constructor(message: string, grpcCode?: number, path?: string) {
    super(message, "not_found", grpcCode, path);
    this.name = "MachineFileNotFoundError";
  }
}

/** `permission_denied` (`EACCES`): the machine's user may not do this to the
 *  path. */
export class MachinePermissionError extends FilesystemError {
  declare readonly reason: "permission_denied";
  constructor(message: string, grpcCode?: number, path?: string) {
    super(message, "permission_denied", grpcCode, path);
    this.name = "MachinePermissionError";
  }
}

/** `file_exists` (`EEXIST`): something is already there. */
export class MachineFileExistsError extends FilesystemError {
  declare readonly reason: "file_exists";
  constructor(message: string, grpcCode?: number, path?: string) {
    super(message, "file_exists", grpcCode, path);
    this.name = "MachineFileExistsError";
  }
}

/** `is_a_directory` (`EISDIR`): a directory where a file was expected. */
export class MachineIsADirectoryError extends FilesystemError {
  declare readonly reason: "is_a_directory";
  constructor(message: string, grpcCode?: number, path?: string) {
    super(message, "is_a_directory", grpcCode, path);
    this.name = "MachineIsADirectoryError";
  }
}

/** `not_a_directory` (`ENOTDIR`): a file where a directory was expected. */
export class MachineNotADirectoryError extends FilesystemError {
  declare readonly reason: "not_a_directory";
  constructor(message: string, grpcCode?: number, path?: string) {
    super(message, "not_a_directory", grpcCode, path);
    this.name = "MachineNotADirectoryError";
  }
}

/** The reasons with a class of their own; the rest are a plain
 *  {@link FilesystemError}. */
const FS_CLASSES: Partial<
  Record<FilesystemErrorReason, new (msg: string, code?: number, path?: string) => FilesystemError>
> = {
  not_found: MachineFileNotFoundError,
  permission_denied: MachinePermissionError,
  file_exists: MachineFileExistsError,
  is_a_directory: MachineIsADirectoryError,
  not_a_directory: MachineNotADirectoryError,
};

const STATUS_MAP: Record<
  number,
  new (msg: string, code?: number, opts?: BoxdErrorOptions) => BoxdError
> = {
  [GrpcStatus.UNAUTHENTICATED]: AuthenticationError,
  [GrpcStatus.PERMISSION_DENIED]: PermissionDeniedError,
  [GrpcStatus.NOT_FOUND]: NotFoundError,
  [GrpcStatus.ALREADY_EXISTS]: ConflictError,
  [GrpcStatus.FAILED_PRECONDITION]: ConflictError,
  [GrpcStatus.ABORTED]: ConflictError,
  [GrpcStatus.RESOURCE_EXHAUSTED]: RateLimitError,
  // UNAVAILABLE is a transport failure wearing a status code: the channel
  // never reached a healthy server. Mapping it here (rather than to
  // APIStatusError) is what makes `isRetryable` a single instanceof check.
  [GrpcStatus.UNAVAILABLE]: APIConnectionError,
};

export function fromGrpcError(
  err: Pick<RpcError, "code" | "details" | "message" | "metadata" | "reason">,
): BoxdError {
  const code = err.code;
  const msg = err.details || err.message || "grpc error";
  const reason = err.reason || reasonFromMetadata(err.metadata);
  if (reason === "agent_outdated") return new AgentOutdatedError(msg, code);
  if (reason && isFilesystemReason(reason)) {
    const fsCls = FS_CLASSES[reason];
    return fsCls ? new fsCls(msg, code) : new FilesystemError(msg, reason, code);
  }
  const cls = (code !== undefined ? STATUS_MAP[code] : undefined) ?? APIStatusError;
  return new cls(msg, code, { reason });
}

function reasonFromMetadata(metadata: RpcError["metadata"]): string | undefined {
  try {
    const value = metadata?.get(ERROR_REASON_TRAILER)?.[0];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Retry policy: connection failures only.
 *
 * Notably not a timeout — the request may have been applied, and the client
 * cannot tell a read from a write at this layer. Notably not an
 * {@link AuthenticationError} either.
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof APIConnectionError;
}
