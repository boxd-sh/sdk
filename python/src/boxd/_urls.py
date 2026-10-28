"""Base-URL resolution and the derived API-key exchange URL.

There is no environment preset table: `base_url` selects the cluster and
everything else is derived from it. Keeping `api_url` and `exchange_url` in
lockstep by hand is what made presets necessary in the first place.
"""

from __future__ import annotations

import ipaddress
import os
from typing import NamedTuple

# gRPC front door, over TLS. The proxy still accepts plain HTTP/2 on the same
# port for older clients, so an explicit http:// base_url keeps working against
# any cluster.
DEFAULT_BASE_URL = "https://boxd.sh:9443"

EXCHANGE_PATH = "/api/v1/auth/token"


def resolve_base_url(explicit: str | None) -> str | None:
    """Pick the gRPC base URL: explicit arg > `BOXD_BASE_URL` > `BOXD_API_URL`.

    Returns ``None`` when nothing is configured — the caller may still learn one
    from the in-VM metadata adapter, and only falls back to
    :data:`DEFAULT_BASE_URL` once that path is ruled out.
    """
    for candidate in (
        explicit,
        os.environ.get("BOXD_BASE_URL"),
        # Deprecated alias, kept because every pre-2.0 script sets it.
        os.environ.get("BOXD_API_URL"),
    ):
        if candidate:
            return candidate
    return None


def console_base_url(base_url: str) -> str:
    """Map a gRPC base URL to the web-console origin that fronts `/api/v1/...`.

    Same mapping as the `boxd` CLI uses, with one
    deliberate difference: the port is dropped. The CLI's input is a bare
    `https://boxd.sh`, but the SDK's default carries the gRPC port
    (`:9443`) — preserving it would aim the exchange at the gRPC listener. A
    deployed console is always TLS on 443 at `app.<zone>`, hence the forced
    `https://`.

    Left exactly as given: `localhost` (the combined `just dev` binary serves
    both surfaces from one host), a raw IP, and an already-`app.` host.
    """
    url = base_url.rstrip("/")
    # Only rewrite when the scheme is explicit; never invent one.
    if url.startswith("https://"):
        scheme, rest = "https://", url[len("https://") :]
    elif url.startswith("http://"):
        scheme, rest = "http://", url[len("http://") :]
    else:
        return url

    host = rest.split("/", 1)[0]  # strip any path
    bare = host.split(":", 1)[0]  # strip any port
    if bare == "localhost" or _is_ip(bare) or host.startswith("app."):
        return f"{scheme}{host}"
    return f"https://app.{bare}"


def exchange_url_for(base_url: str) -> str:
    """The API-key → JWT exchange endpoint derived from `base_url`."""
    return console_base_url(base_url) + EXCHANGE_PATH


class Endpoint(NamedTuple):
    """Resolved gRPC endpoint: bare ``host:port`` and whether to use TLS."""

    target: str
    use_tls: bool


def resolve_endpoint(base_url: str) -> Endpoint:
    """Split a base URL into the ``host:port`` gRPC dials and a TLS flag.

    - ``http://…``  → plaintext, scheme stripped
    - ``https://…`` → TLS, scheme stripped
    - bare ``host:port`` → TLS, except ``localhost``/``127.*`` which stay plaintext
    """
    if base_url.startswith("http://"):
        return Endpoint(target=base_url[len("http://") :].rstrip("/"), use_tls=False)
    if base_url.startswith("https://"):
        return Endpoint(target=base_url[len("https://") :].rstrip("/"), use_tls=True)
    is_local = base_url.startswith("localhost") or base_url.startswith("127.")
    return Endpoint(target=base_url.rstrip("/"), use_tls=not is_local)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False
