"""Exception hierarchy for the boxd SDK.

One base (:class:`BoxdError`) and one subclass per gRPC status family. Anything
the server returns that isn't in the table below surfaces as
:class:`APIStatusError` with the raw code attached, so a new server-side status
never turns into an opaque ``Exception``.

`machines.fs` failures are also :class:`OSError`\\ s: the server names each one
in the ``x-boxd-error-reason`` trailer, and :func:`from_grpc_error` turns that
into the matching builtin (``FileNotFoundError``, ``IsADirectoryError``, ...)
with ``errno`` set, so code written for local files handles them unchanged.
"""

from __future__ import annotations

import errno as _errno
import os

import grpc

#: Trailer the server names a failure's exact reason in (`machines.fs`).
REASON_TRAILER = "x-boxd-error-reason"


class BoxdError(Exception):
    """Base exception for all boxd SDK errors."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        grpc_code: int | None = None,
        reason: str | None = None,
        http_status: int | None = None,
    ):
        super().__init__(message)
        self.message = message
        # Canonical gRPC status name ("not_found", "unavailable", ...), or None
        # for errors raised before a call was ever made.
        self.code = code
        self.grpc_code = grpc_code
        # A machine-readable name for the failure, when there is one: the
        # server's `x-boxd-error-reason` ("not_found", "is_a_directory",
        # "agent_outdated", ...), or for an AuthenticationError which
        # credential was refused ("missing_credentials", "invalid_api_key",
        # "invalid_token").
        self.reason = reason
        # The HTTP status, for a failure of one of the plain-HTTP endpoints
        # credentials come from (the API-key exchange, the in-machine
        # metadata adapter). None for gRPC calls.
        self.http_status = http_status


class AuthenticationError(BoxdError):
    """`unauthenticated` — no credential was found, or boxd refused it.

    Only that: failing to reach boxd is an :class:`APIConnectionError`, and an
    exchange that answered with an error of its own is an
    :class:`APIStatusError`. ``code`` is always ``"unauthenticated"`` and
    ``reason`` says which case it is:

    - ``"missing_credentials"``: no ``api_key``/``token``, no ``BOXD_API_KEY``
      or ``BOXD_TOKEN``, and not running inside a boxd machine.
    - ``"invalid_api_key"``: the API key was refused (revoked, expired or
      never valid).
    - ``"invalid_token"``: a request's token was refused.

    **Terminal.** An API-key session re-reads the key row on every request, so a
    mid-session rejection means the key is gone, not stale: refreshing and
    retrying would only spin against a revoked key.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        grpc_code: int | None = None,
        reason: str | None = None,
        http_status: int | None = None,
    ):
        super().__init__(
            message,
            code=code or "unauthenticated",
            grpc_code=grpc_code if grpc_code is not None else 16,
            reason=reason or "invalid_token",
            http_status=http_status,
        )


class PermissionDeniedError(BoxdError):
    """`permission_denied` — authenticated, but not allowed to do this (also
    an API key whose account is disabled)."""


class NotFoundError(BoxdError):
    """`not_found` — no such machine/snapshot/disk/…"""


class ConflictError(BoxdError):
    """`already_exists`, `failed_precondition` or `aborted` — the request fights
    the current state, or the state changed while it ran (e.g. a machine's spec
    changed during ``update_spec``, which then changes nothing: read it again
    and retry)."""


class RateLimitError(BoxdError):
    """`resource_exhausted` — rate limit or quota."""


class APIStatusError(BoxdError):
    """Any other non-OK gRPC status, or an error answer from the API-key
    exchange or the in-machine metadata adapter (a 5xx, or a body that isn't
    a token), with its ``http_status``."""


class APIConnectionError(BoxdError):
    """Transport failure — the request never got a status back. Also raised
    when the API-key exchange or the in-machine metadata adapter can't be
    reached; the underlying error is ``__cause__``."""


# ── machines.fs ──────────────────────────────────────────────────────


class MachineFilesystemError(BoxdError, OSError):
    """A `machines.fs` operation failed inside the machine.

    Also an :class:`OSError`, with ``errno``, ``strerror`` and ``filename`` set
    the way a local failure sets them (``errno`` is None for the two reasons
    with no errno: ``not_a_regular_file`` and ``size_mismatch``). The common
    ones raise a subclass that is also the matching builtin, e.g.
    :class:`MachineFileNotFoundError` is a ``FileNotFoundError``. ``reason`` is
    the server's name for the failure.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        grpc_code: int | None = None,
        reason: str | None = None,
        filename: str | None = None,
    ):
        super().__init__(message, code=code, grpc_code=grpc_code, reason=reason)
        number = _FS_ERRNO.get(reason or "")
        self.errno = number
        self.strerror = os.strerror(number) if number is not None else message
        self.filename = filename

    def __str__(self) -> str:
        return self.message

    def __reduce__(self):
        # OSError's own pickling rebuilds from (errno, strerror, filename),
        # which this __init__ doesn't take.
        return (
            _rebuild_fs_error,
            (
                type(self),
                self.message,
                self.code,
                self.grpc_code,
                self.reason,
                self.filename,
            ),
        )


def _rebuild_fs_error(cls, message, code, grpc_code, reason, filename):
    return cls(
        message, code=code, grpc_code=grpc_code, reason=reason, filename=filename
    )


class MachineFileNotFoundError(MachineFilesystemError, NotFoundError, FileNotFoundError):
    """`not_found` — no such file or directory inside the machine."""


class MachinePermissionError(
    MachineFilesystemError, PermissionDeniedError, PermissionError
):
    """`permission_denied` — the machine's user may not do this to the path."""


class MachineFileExistsError(MachineFilesystemError, ConflictError, FileExistsError):
    """`file_exists` — something is already at the path (e.g. a file where
    ``mkdir`` wanted a directory)."""


class MachineIsADirectoryError(
    MachineFilesystemError, ConflictError, IsADirectoryError
):
    """`is_a_directory` — the path is a directory where a file was needed."""


class MachineNotADirectoryError(
    MachineFilesystemError, ConflictError, NotADirectoryError
):
    """`not_a_directory` — the path, or one of its parents, is not a directory."""


class MachineAgentOutdatedError(ConflictError):
    """`agent_outdated` — the machine was started before `machines.fs` existed.

    Rebooting it (`machines.reboot`) updates it. Not an :class:`OSError`: no
    filesystem operation ran.
    """


# reason → errno, for the OSError side of MachineFilesystemError.
_FS_ERRNO: dict[str, int] = {
    "not_found": _errno.ENOENT,
    "permission_denied": _errno.EACCES,
    "file_exists": _errno.EEXIST,
    "is_a_directory": _errno.EISDIR,
    "not_a_directory": _errno.ENOTDIR,
    "directory_not_empty": _errno.ENOTEMPTY,
    "symlink_loop": _errno.ELOOP,
    "name_too_long": _errno.ENAMETOOLONG,
    "invalid_path": _errno.EINVAL,
    "no_space": _errno.ENOSPC,
    "read_only": _errno.EROFS,
    "busy": _errno.EBUSY,
    "cross_device": _errno.EXDEV,
    "io_error": _errno.EIO,
}

# reason → class. Every filesystem reason the server sends is here; the ones
# without a builtin of their own raise the base class.
_FS_REASONS: dict[str, type[MachineFilesystemError]] = {
    "not_found": MachineFileNotFoundError,
    "permission_denied": MachinePermissionError,
    "file_exists": MachineFileExistsError,
    "is_a_directory": MachineIsADirectoryError,
    "not_a_directory": MachineNotADirectoryError,
    **{
        reason: MachineFilesystemError
        for reason in (
            "directory_not_empty",
            "not_a_regular_file",
            "symlink_loop",
            "name_too_long",
            "invalid_path",
            "no_space",
            "read_only",
            "busy",
            "cross_device",
            "size_mismatch",
            "io_error",
        )
    },
}


# gRPC status → exception class. Codes absent here fall through to
# APIStatusError; UNAVAILABLE is a transport failure by another name, so it
# lands on APIConnectionError (and is the one status we retry).
_STATUS_MAP: dict[grpc.StatusCode, type[BoxdError]] = {
    grpc.StatusCode.UNAUTHENTICATED: AuthenticationError,
    grpc.StatusCode.PERMISSION_DENIED: PermissionDeniedError,
    grpc.StatusCode.NOT_FOUND: NotFoundError,
    grpc.StatusCode.ALREADY_EXISTS: ConflictError,
    grpc.StatusCode.FAILED_PRECONDITION: ConflictError,
    grpc.StatusCode.ABORTED: ConflictError,
    grpc.StatusCode.RESOURCE_EXHAUSTED: RateLimitError,
    grpc.StatusCode.UNAVAILABLE: APIConnectionError,
}


def from_grpc_error(err: grpc.RpcError) -> BoxdError:
    """Convert a gRPC error (sync or aio) into the matching BoxdError."""
    code = err.code() if callable(getattr(err, "code", None)) else None
    details = err.details() if callable(getattr(err, "details", None)) else None
    reason = _reason(err)
    cls = _STATUS_MAP.get(code, APIStatusError) if code is not None else APIConnectionError
    name = code.name.lower() if code is not None else None
    numeric = code.value[0] if code is not None else None
    message = details or str(err)
    if reason == "agent_outdated":
        if "reboot" not in message.lower():
            message += "; reboot the machine (machines.reboot) to update it"
        return MachineAgentOutdatedError(
            message, code=name, grpc_code=numeric, reason=reason
        )
    fs_cls = _FS_REASONS.get(reason or "")
    if fs_cls is not None:
        return fs_cls(message, code=name, grpc_code=numeric, reason=reason)
    if cls is AuthenticationError and reason is None:
        # The API refuses a request's credential only one way: its token.
        reason = "invalid_token"
    return cls(message, code=name, grpc_code=numeric, reason=reason)


def _reason(err: grpc.RpcError) -> str | None:
    """The `x-boxd-error-reason` trailer, if the server sent one."""
    trailing = getattr(err, "trailing_metadata", None)
    if not callable(trailing):
        return None
    try:
        metadata = trailing()
    except Exception:  # noqa: BLE001 — a missing trailer is not an error
        return None
    for item in metadata or ():
        try:
            key, value = item
        except (TypeError, ValueError):
            continue
        if key == REASON_TRAILER:
            return value.decode() if isinstance(value, bytes) else str(value)
    return None


def is_retryable(err: grpc.RpcError) -> bool:
    """Retry only transport failures.

    `unavailable` is the sole retryable status. `deadline_exceeded` is
    deliberately *not* here: the server may already have applied a mutation, and
    the SDK can't tell a mutation from a read at this layer.
    """
    code = err.code() if callable(getattr(err, "code", None)) else None
    return code == grpc.StatusCode.UNAVAILABLE
