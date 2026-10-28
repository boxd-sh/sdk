import { describe, expect, it } from "bun:test";
import { Metadata, status } from "@grpc/grpc-js";
import {
  AgentOutdatedError,
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  BoxdError,
  ConflictError,
  FilesystemError,
  MachineFileExistsError,
  MachineFileNotFoundError,
  MachineIsADirectoryError,
  MachineNotADirectoryError,
  MachinePermissionError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  fromGrpcError,
  isRetryable,
} from "../src/errors.js";

const mk = (code: number, details = "err") =>
  ({ code, details, message: details }) as never;

describe("error hierarchy", () => {
  it("BoxdError is an Error", () => {
    const err = new BoxdError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("BoxdError");
  });

  it("every class descends from BoxdError", () => {
    for (const e of [
      new AuthenticationError("x"),
      new PermissionDeniedError("x"),
      new NotFoundError("x"),
      new ConflictError("x"),
      new RateLimitError("x"),
      new APIStatusError("x"),
      new APIConnectionError("x"),
    ]) {
      expect(e).toBeInstanceOf(BoxdError);
    }
  });
});

describe("fromGrpcError", () => {
  it("UNAUTHENTICATED → AuthenticationError(invalid_token)", () => {
    const e = fromGrpcError(mk(status.UNAUTHENTICATED, "token expired"));
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.grpcCode).toBe(status.UNAUTHENTICATED);
    expect(e.reason).toBe("invalid_token");
  });
  it("an AuthenticationError always carries UNAUTHENTICATED and a reason", () => {
    const e = new AuthenticationError("x");
    expect(e.grpcCode).toBe(status.UNAUTHENTICATED);
    expect(e.reason).toBe("invalid_token");
  });
  it("PERMISSION_DENIED → PermissionDeniedError", () =>
    expect(fromGrpcError(mk(status.PERMISSION_DENIED))).toBeInstanceOf(PermissionDeniedError));
  it("NOT_FOUND → NotFoundError", () =>
    expect(fromGrpcError(mk(status.NOT_FOUND))).toBeInstanceOf(NotFoundError));
  it("ALREADY_EXISTS → ConflictError", () =>
    expect(fromGrpcError(mk(status.ALREADY_EXISTS))).toBeInstanceOf(ConflictError));
  it("FAILED_PRECONDITION → ConflictError", () =>
    expect(fromGrpcError(mk(status.FAILED_PRECONDITION))).toBeInstanceOf(ConflictError));
  // e.g. updateSpec when the spec changed while it was applied.
  it("ABORTED → ConflictError", () => {
    const e = fromGrpcError(mk(status.ABORTED, "the machine's spec changed"));
    expect(e).toBeInstanceOf(ConflictError);
    expect(e.grpcCode).toBe(status.ABORTED);
  });
  it("RESOURCE_EXHAUSTED → RateLimitError", () =>
    expect(fromGrpcError(mk(status.RESOURCE_EXHAUSTED))).toBeInstanceOf(RateLimitError));
  it("UNAVAILABLE → APIConnectionError", () =>
    expect(fromGrpcError(mk(status.UNAVAILABLE))).toBeInstanceOf(APIConnectionError));

  it("anything else → APIStatusError", () => {
    for (const c of [
      status.INVALID_ARGUMENT,
      status.INTERNAL,
      status.UNKNOWN,
      status.DEADLINE_EXCEEDED,
      status.DATA_LOSS,
    ]) {
      const e = fromGrpcError(mk(c));
      expect(e).toBeInstanceOf(APIStatusError);
      expect(e).not.toBeInstanceOf(APIConnectionError);
    }
  });

  it("carries the code and the server's detail message", () => {
    const e = fromGrpcError(mk(status.NOT_FOUND, "machine xyz not found"));
    expect(e.message).toBe("machine xyz not found");
    expect(e.grpcCode).toBe(status.NOT_FOUND);
  });
});

describe("retry policy", () => {
  it("connection failures are retryable", () => {
    expect(isRetryable(fromGrpcError(mk(status.UNAVAILABLE)))).toBe(true);
    expect(isRetryable(new APIConnectionError("socket hang up"))).toBe(true);
  });

  it("auth failures are terminal, never retried", () => {
    expect(isRetryable(fromGrpcError(mk(status.UNAUTHENTICATED)))).toBe(false);
    expect(isRetryable(new AuthenticationError("revoked"))).toBe(false);
  });

  it("a timeout is not retried — the call may have been applied", () => {
    expect(isRetryable(fromGrpcError(mk(status.DEADLINE_EXCEEDED)))).toBe(false);
  });

  it("nothing else is retried either", () => {
    for (const c of [status.NOT_FOUND, status.ALREADY_EXISTS, status.ABORTED, status.RESOURCE_EXHAUSTED]) {
      expect(isRetryable(fromGrpcError(mk(c)))).toBe(false);
    }
  });
});

describe("the error-reason trailer", () => {
  /** A grpc-js ServiceError: the reason rides in its trailers. */
  const withTrailer = (code: number, reason: string) => {
    const metadata = new Metadata();
    metadata.set("x-boxd-error-reason", reason);
    return { code, details: "failed", message: "failed", metadata };
  };

  it("each filesystem reason becomes a FilesystemError with Node's errno name", () => {
    const table: [string, number, string | undefined][] = [
      ["not_found", status.NOT_FOUND, "ENOENT"],
      ["permission_denied", status.PERMISSION_DENIED, "EACCES"],
      ["file_exists", status.ALREADY_EXISTS, "EEXIST"],
      ["is_a_directory", status.FAILED_PRECONDITION, "EISDIR"],
      ["not_a_directory", status.FAILED_PRECONDITION, "ENOTDIR"],
      ["directory_not_empty", status.FAILED_PRECONDITION, "ENOTEMPTY"],
      ["not_a_regular_file", status.FAILED_PRECONDITION, undefined],
      ["symlink_loop", status.FAILED_PRECONDITION, "ELOOP"],
      ["name_too_long", status.INVALID_ARGUMENT, "ENAMETOOLONG"],
      ["invalid_path", status.INVALID_ARGUMENT, "EINVAL"],
      ["no_space", status.FAILED_PRECONDITION, "ENOSPC"],
      ["read_only", status.FAILED_PRECONDITION, "EROFS"],
      ["busy", status.FAILED_PRECONDITION, "EBUSY"],
      ["cross_device", status.FAILED_PRECONDITION, "EXDEV"],
      ["size_mismatch", status.ABORTED, undefined],
      ["io_error", status.INTERNAL, "EIO"],
    ];
    for (const [reason, code, errno] of table) {
      const e = fromGrpcError(withTrailer(code, reason));
      expect(e).toBeInstanceOf(FilesystemError);
      expect((e as FilesystemError).code).toBe(errno);
      expect(e.reason).toBe(reason);
      expect(e.grpcCode).toBe(code);
      expect(isRetryable(e)).toBe(false);
    }
  });

  it("the common reasons get a class of their own, still a FilesystemError", () => {
    const table: [string, number, Function, string][] = [
      ["not_found", status.NOT_FOUND, MachineFileNotFoundError, "ENOENT"],
      ["permission_denied", status.PERMISSION_DENIED, MachinePermissionError, "EACCES"],
      ["file_exists", status.ALREADY_EXISTS, MachineFileExistsError, "EEXIST"],
      ["is_a_directory", status.FAILED_PRECONDITION, MachineIsADirectoryError, "EISDIR"],
      ["not_a_directory", status.FAILED_PRECONDITION, MachineNotADirectoryError, "ENOTDIR"],
    ];
    for (const [reason, code, cls, errno] of table) {
      const e = fromGrpcError(withTrailer(code, reason));
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(FilesystemError);
      expect(e.name).toBe(cls.name);
      expect(e.reason).toBe(reason);
      expect((e as FilesystemError).code).toBe(errno);
      expect(e.grpcCode).toBe(code);
      // Not the status's own class: the path is wrong, not the machine.
      expect(e).not.toBeInstanceOf(NotFoundError);
      expect(e).not.toBeInstanceOf(PermissionDeniedError);
      expect(e).not.toBeInstanceOf(ConflictError);
    }
  });

  it("every other filesystem reason is a plain FilesystemError", () => {
    const e = fromGrpcError(withTrailer(status.FAILED_PRECONDITION, "directory_not_empty"));
    expect(e.constructor).toBe(FilesystemError);
    expect(e.name).toBe("FilesystemError");
  });

  it("grpc-web hands the reason over already parsed", () => {
    const e = fromGrpcError({ code: status.NOT_FOUND, message: "x", reason: "not_found" });
    expect(e).toBeInstanceOf(MachineFileNotFoundError);
  });

  it("agent_outdated becomes AgentOutdatedError, still a ConflictError, telling you to reboot", () => {
    const e = fromGrpcError(withTrailer(status.FAILED_PRECONDITION, "agent_outdated"));
    expect(e).toBeInstanceOf(AgentOutdatedError);
    expect(e).toBeInstanceOf(ConflictError);
    expect(e.reason).toBe("agent_outdated");
    expect(e.message).toContain("reboot");
  });

  it("a reason this SDK doesn't know keeps the status's class and passes through", () => {
    const e = fromGrpcError(withTrailer(status.FAILED_PRECONDITION, "something_new"));
    expect(e).toBeInstanceOf(ConflictError);
    expect(e).not.toBeInstanceOf(FilesystemError);
    expect(e.reason).toBe("something_new");
  });

  it("no trailer: no reason, same classes as before", () => {
    const e = fromGrpcError(mk(status.NOT_FOUND));
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.reason).toBeUndefined();
  });
});
