"""Resource namespaces.

Each module holds a sync class and its async twin. The two share every request
builder (`_requests.py`) and every mapper (`_mappers.py`); what differs is only
whether the call is awaited.
"""

from __future__ import annotations


class Namespace:
    """Base for every resource namespace — holds nothing but the transport."""

    def __init__(self, transport) -> None:
        self._transport = transport
