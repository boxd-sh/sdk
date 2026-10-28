"""`boxd.domains` — custom domains pointed at a machine.

`create()` binds the domain and starts verification immediately — call it
only after DNS is actually in place (an A record at the machine's public IP,
plus a wildcard CNAME at `<machine>.<zone>`). Checking before the records
exist risks a public resolver caching the "no records" answer, delaying
propagation once you do set them. `dns_instructions()` is a pure, local
helper (no network call) for rendering those records to show a user before
calling `create()` — mirrors what the CLI and console show inline. From
`pending` a control loop verifies DNS and issues certs, then flips the
binding to `active`.
"""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import CustomDomain
from . import Namespace


def dns_instructions(domain: str, *, machine_name: str, machine_ip: str, zone: str) -> str:
    """Records to point at a machine before calling `create(domain, machine_id)`."""
    return f"A     {domain}        {machine_ip}\nCNAME *.{domain}      {machine_name}.{zone}"


class Domains(Namespace):
    """Bind, list, and remove custom domains on your machines."""

    def create(self, domain: str, machine_id: str) -> CustomDomain:
        """Point `domain` at a machine. DNS must already be set — see module docs."""
        resp = self._transport.call(
            "AddCustomDomain",
            api_pb2.AddCustomDomainRequest(domain=domain, vm_id=machine_id),
        )
        return m.custom_domain(resp.domain)

    def list(self) -> list[CustomDomain]:
        """List custom domains bound to machines you own."""
        resp = self._transport.call("ListCustomDomains", api_pb2.ListCustomDomainsRequest())
        return [m.custom_domain(d) for d in resp.domains]

    def delete(self, domain: str) -> None:
        """Remove a domain binding."""
        self._transport.call(
            "RemoveCustomDomain", api_pb2.RemoveCustomDomainRequest(domain=domain)
        )


class AsyncDomains(Namespace):
    """Async twin of :class:`Domains`."""

    async def create(self, domain: str, machine_id: str) -> CustomDomain:
        """Point `domain` at a machine. DNS must already be set — see module docs."""
        resp = await self._transport.call(
            "AddCustomDomain",
            api_pb2.AddCustomDomainRequest(domain=domain, vm_id=machine_id),
        )
        return m.custom_domain(resp.domain)

    async def list(self) -> list[CustomDomain]:
        """List custom domains bound to machines you own."""
        resp = await self._transport.call(
            "ListCustomDomains", api_pb2.ListCustomDomainsRequest()
        )
        return [m.custom_domain(d) for d in resp.domains]

    async def delete(self, domain: str) -> None:
        """Remove a domain binding."""
        await self._transport.call(
            "RemoveCustomDomain", api_pb2.RemoveCustomDomainRequest(domain=domain)
        )
