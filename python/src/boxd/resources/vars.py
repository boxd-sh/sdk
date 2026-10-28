"""`boxd.env` and `boxd.secrets`.

Two namespaces over one wire family, keyed by kind. They are split because a
secret's value is write-only: merging them would force a `value` field whose
nullability is decided by a sibling field, which no type system enforces. An
:class:`~boxd.models.EnvVar` has a `value`; a :class:`~boxd.models.Secret`
does not, by construction.

Both get identical methods, including `move`.
"""

from __future__ import annotations

from collections.abc import Sequence

from .. import _mappers as m
from .. import _requests as req
from ..models import EnvVar, Secret, VarScope
from . import Namespace

_ENV = "env"
_SECRET = "secret"


class _VarsBase(Namespace):
    """Shared docs for the two namespaces.

    Scope decides which machines a name applies to:

    | Scope     | Applies to                         |
    |-----------|------------------------------------|
    | `private` | only your machines in that org     |
    | `shared`  | the org's shared machines          |
    | `all`     | every machine in the org           |
    | `unattached` | secrets only: just the machines whose spec lists it in `secrets` (the org's with `org`, else your own) |
    | `private-unattached` | secrets only: your own unattached secret in the org named by `org` |

    Leave `org` unset for your personal scope: your own private vars. With an
    API key minted in an organization those live in that organization (the key
    never reaches another one), so a key-authenticated client needs `org` only
    to address the organization's own `shared`/`all` vars. Env vars and secrets share one
    namespace within a scope, so an env var can block a secret of the same name
    — and vice versa.
    """


class Env(_VarsBase):
    """Environment variables injected into your machines. See :class:`_VarsBase`
    for how `scope` and `org` work."""

    def set(
        self,
        name: str,
        value: str,
        *,
        scope: VarScope | None = None,
        org: str | None = None,
    ) -> str:
        """Create or update an environment variable. Returns the server's
        human-readable confirmation."""
        return self._transport.call(
            "SetVar",
            req.set_var(kind=_ENV, name=name, value=value, scope=scope, org=org),
        ).message

    def list(self, *, org: str | None = None) -> list[EnvVar]:
        """List environment variables, with their values."""
        resp = self._transport.call("ListVars", req.list_vars(kind=_ENV, org=org))
        return [m.env_var(v) for v in resp.vars]

    def delete(
        self, name: str, *, scope: VarScope | None = None, org: str | None = None
    ) -> str:
        """Remove an environment variable from a scope. Returns the server's
        human-readable confirmation."""
        return self._transport.call(
            "RemoveVar", req.remove_var(kind=_ENV, name=name, scope=scope, org=org)
        ).message

    def move(
        self,
        name: str,
        *,
        from_scope: VarScope,
        to_scope: VarScope,
        org: str | None = None,
    ) -> str:
        """Move a variable between scopes. Returns the server's confirmation.

        `from_scope` is required because scope is part of a variable's identity:
        the same name can exist in several scopes at once. This is a move
        between two addresses, not a field update — calling it twice fails the
        second time.
        """
        return self._transport.call(
            "SetSecretScope",
            req.move_var(name=name, from_scope=from_scope, to_scope=to_scope, org=org),
        ).message


class Secrets(_VarsBase):
    """Secrets injected into your machines. Values are never readable back."""

    def set(
        self,
        name: str,
        value: str,
        *,
        scope: VarScope | None = None,
        org: str | None = None,
        domains: Sequence[str] | None = None,
    ) -> str:
        """Create or update a secret. Returns the server's human-readable
        confirmation.

        ``domains`` binds the secret to the hosts it may be sent to
        (``api.example.com`` or ``*.example.com``). The machine then only
        ever holds an opaque ``bxds_…`` placeholder in its environment; the
        real value is substituted into HTTPS requests to exactly these hosts
        on the way out (the URL, headers, Basic auth and body; never over
        plain HTTP), is scrubbed back to the placeholder in their responses,
        and never lands inside the machine. Nothing to configure in the machine. The
        placeholder is stable across value rotations. ``domains`` is the
        full desired set: omit it to make (or keep) the secret a plain one
        that injects its real value.
        """
        return self._transport.call(
            "SetVar",
            req.set_var(
                kind=_SECRET,
                name=name,
                value=value,
                scope=scope,
                org=org,
                domains=domains,
            ),
        ).message

    def list(self, *, org: str | None = None) -> list[Secret]:
        """List secret names and scopes. Values are write-only and never returned."""
        resp = self._transport.call("ListVars", req.list_vars(kind=_SECRET, org=org))
        return [m.secret(v) for v in resp.vars]

    def delete(
        self, name: str, *, scope: VarScope | None = None, org: str | None = None
    ) -> str:
        """Remove a secret from a scope. Returns the server's human-readable
        confirmation."""
        return self._transport.call(
            "RemoveVar", req.remove_var(kind=_SECRET, name=name, scope=scope, org=org)
        ).message

    def move(
        self,
        name: str,
        *,
        from_scope: VarScope,
        to_scope: VarScope,
        org: str | None = None,
    ) -> str:
        """Move a secret between scopes. Returns the server's confirmation.

        `from_scope` is required because scope is part of a secret's identity:
        the same name can exist in several scopes at once. Calling it twice
        fails the second time.
        """
        return self._transport.call(
            "SetSecretScope",
            req.move_var(name=name, from_scope=from_scope, to_scope=to_scope, org=org),
        ).message


class AsyncEnv(_VarsBase):
    """Async twin of :class:`Env`."""

    async def set(
        self,
        name: str,
        value: str,
        *,
        scope: VarScope | None = None,
        org: str | None = None,
    ) -> str:
        """Create or update an environment variable. Returns the server's
        human-readable confirmation."""
        resp = await self._transport.call(
            "SetVar",
            req.set_var(kind=_ENV, name=name, value=value, scope=scope, org=org),
        )
        return resp.message

    async def list(self, *, org: str | None = None) -> list[EnvVar]:
        """List environment variables, with their values."""
        resp = await self._transport.call("ListVars", req.list_vars(kind=_ENV, org=org))
        return [m.env_var(v) for v in resp.vars]

    async def delete(
        self, name: str, *, scope: VarScope | None = None, org: str | None = None
    ) -> str:
        """Remove an environment variable from a scope. Returns the server's
        human-readable confirmation."""
        resp = await self._transport.call(
            "RemoveVar", req.remove_var(kind=_ENV, name=name, scope=scope, org=org)
        )
        return resp.message

    async def move(
        self,
        name: str,
        *,
        from_scope: VarScope,
        to_scope: VarScope,
        org: str | None = None,
    ) -> str:
        """Move a variable between scopes. Returns the server's confirmation.

        Calling it twice fails the second time.
        """
        return await self._transport.call(
            "SetSecretScope",
            req.move_var(name=name, from_scope=from_scope, to_scope=to_scope, org=org),
        ).message


class AsyncSecrets(_VarsBase):
    """Async twin of :class:`Secrets`."""

    async def set(
        self,
        name: str,
        value: str,
        *,
        scope: VarScope | None = None,
        org: str | None = None,
        domains: Sequence[str] | None = None,
    ) -> str:
        """Create or update a secret. See :meth:`Secrets.set` for
        ``domains``."""
        resp = await self._transport.call(
            "SetVar",
            req.set_var(
                kind=_SECRET,
                name=name,
                value=value,
                scope=scope,
                org=org,
                domains=domains,
            ),
        )
        return resp.message

    async def list(self, *, org: str | None = None) -> list[Secret]:
        """List secret names and scopes. Values are write-only and never returned."""
        resp = await self._transport.call(
            "ListVars", req.list_vars(kind=_SECRET, org=org)
        )
        return [m.secret(v) for v in resp.vars]

    async def delete(
        self, name: str, *, scope: VarScope | None = None, org: str | None = None
    ) -> str:
        """Remove a secret from a scope. Returns the server's human-readable
        confirmation."""
        resp = await self._transport.call(
            "RemoveVar", req.remove_var(kind=_SECRET, name=name, scope=scope, org=org)
        )
        return resp.message

    async def move(
        self,
        name: str,
        *,
        from_scope: VarScope,
        to_scope: VarScope,
        org: str | None = None,
    ) -> str:
        """Move a secret between scopes. Returns the server's confirmation.

        Calling it twice fails the second time.
        """
        return await self._transport.call(
            "SetSecretScope",
            req.move_var(name=name, from_scope=from_scope, to_scope=to_scope, org=org),
        ).message
