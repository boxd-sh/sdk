"""`boxd.regions` — the regions boxd runs in, and which ones your org can use."""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import Region
from . import Namespace


class Regions(Namespace):
    """The regions boxd runs in.

    Each region has its own API endpoint, and a machine, snapshot or disk
    lives in one of them. Pass a region's ``id`` as ``region=`` to the client
    or to a call. An org can use its home region and the regions enabled for
    it; ``org_state`` says which (``orgs.request_region`` asks for another).
    """

    def list(self, *, org: str = "") -> list[Region]:
        """Every region, and where `org` stands with each (default: your
        default org, or an API key's org)."""
        resp = self._transport.call(
            "ListRegions", api_pb2.ListRegionsRequest(org_id=org)
        )
        return [m.region(r) for r in resp.regions]


class AsyncRegions(Namespace):
    """Async twin of :class:`Regions`."""

    async def list(self, *, org: str = "") -> list[Region]:
        """Every region, and where `org` stands with each."""
        resp = await self._transport.call(
            "ListRegions", api_pb2.ListRegionsRequest(org_id=org)
        )
        return [m.region(r) for r in resp.regions]
