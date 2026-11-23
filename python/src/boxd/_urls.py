"""Base-URL resolution and the derived API-key exchange URL.

There is no environment preset table: `base_url` selects the cluster and
everything else is derived from it. Keeping `api_url` and `exchange_url` in
lockstep by hand is what made presets necessary in the first place.
"""

from __future__ import annotations

import ipaddress
import os
import re
from typing import NamedTuple

# gRPC front door, over TLS. The proxy still accepts plain HTTP/2 on the same
# port for older clients, so an explicit http:// base_url keeps working against
# any cluster.
DEFAULT_BASE_URL = "https://boxd.sh:9443"

# The port every cluster serves its gRPC API on. A base_url without a port
# means it, as the `boxd` CLI does: the default port of https (443) is the
# cluster's website and console, which answer a gRPC call with a 404.
API_PORT = 9443

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

    Same mapping as the `boxd` CLI uses: the port is dropped. A base URL may
    name the gRPC port (`https://boxd.sh:9443`, the default) or leave it out
    (`https://boxd.sh`, which dials the same port: :func:`resolve_endpoint`);
    either way the console is not on it, and keeping it would aim the
    exchange at the gRPC listener. A deployed console is always TLS on 443
    at `app.<zone>`, hence the forced `https://`.

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

    A host without a port gets :data:`API_PORT` (``https://boxd.sh`` dials
    ``boxd.sh:9443``): gRPC's own default, 443, is the cluster's website.
    """
    if base_url.startswith("http://"):
        target, use_tls = base_url[len("http://") :], False
    elif base_url.startswith("https://"):
        target, use_tls = base_url[len("https://") :], True
    else:
        is_local = base_url.startswith("localhost") or base_url.startswith("127.")
        target, use_tls = base_url, not is_local
    return Endpoint(target=_with_port(target.rstrip("/")), use_tls=use_tls)


def _with_port(authority: str) -> str:
    """``host`` as ``host:9443``; ``host:port`` (and anything with a path) as
    it is. An IPv6 literal keeps its brackets: ``[::1]`` → ``[::1]:9443``."""
    if not authority or "/" in authority:
        return authority
    if authority.startswith("["):
        has_port = "]:" in authority
    else:
        has_port = ":" in authority
    return authority if has_port else f"{authority}:{API_PORT}"


def is_loopback_target(target: str) -> bool:
    """Whether a ``host:port`` (as :func:`resolve_endpoint` gives it) is a
    loopback address: ``localhost``, ``127.*`` or ``[::1]``."""
    target = target.strip()
    if target.startswith("["):
        host = target[1 : target.find("]")] if "]" in target else target[1:]
    else:
        host = target.split(":", 1)[0]
    host = host.lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def raw_key_allowed(base_url: str) -> bool:
    """Whether an API key may go as the bearer itself to `base_url`: over TLS,
    or in plaintext to a loopback address, which never leaves the machine."""
    endpoint = resolve_endpoint(base_url)
    return endpoint.use_tls or is_loopback_target(endpoint.target)


_DNS_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?")
_PORT = re.compile(r"[0-9]+")


def region_base_url(home_base_url: str, region: str) -> str | None:
    """A region's API endpoint by the platform's naming: ``<region>.<host>`` on
    the home base URL's scheme and port (home ``https://boxd.sh:9443`` → nyc
    ``https://nyc.boxd.sh:9443``).

    None when the home host is not a DNS name a region can be put in front of
    (an IP literal, ``localhost``, a name of one label), when the base URL has
    a path, or when `region` is not one label.
    """
    if not _DNS_LABEL.fullmatch(region):
        return None
    url = home_base_url.strip().rstrip("/")
    scheme = next((s for s in ("https://", "http://") if url.startswith(s)), "")
    authority = url[len(scheme) :]
    if "/" in authority or authority.startswith("["):
        return None
    host, sep, port = authority.partition(":")
    host = host.lower()
    labels = host.split(".")
    dns_name = (
        len(labels) > 1
        and all(_DNS_LABEL.fullmatch(label) for label in labels)
        and not labels[-1].isdigit()  # a dotted quad, valid or not
        and labels[-1] != "localhost"
    )
    if not dns_name or (sep and not _PORT.fullmatch(port)):
        return None
    return f"{scheme}{region}.{host}{sep}{port}"


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False
