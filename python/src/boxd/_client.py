"""The two clients: :class:`Boxd` and :class:`AsyncBoxd`.

The client is the only stateful thing in the SDK — it holds configuration and
credentials, and hands a transport to each resource namespace. Everything a
namespace returns is plain data.
"""

from __future__ import annotations

from ._credentials import AsyncCredentials, SyncCredentials
from ._regions import AsyncRouter, SyncRouter
from ._transport import AsyncTransport, SyncTransport
from ._urls import DEFAULT_BASE_URL, exchange_url_for, resolve_base_url
from .resources.account import Account, AsyncAccount
from .resources.credentials import ApiKeys, AsyncApiKeys
from .resources.disks import AsyncDisks, Disks
from .resources.domains import AsyncDomains, Domains
from .resources.machines import AsyncMachines, Machines
from .resources.orgs import AsyncOrgs, Orgs
from .resources.regions import AsyncRegions, Regions
from .resources.snapshots import AsyncSnapshots, Snapshots
from .resources.teams import AsyncTeams, Teams
from .resources.vars import AsyncEnv, AsyncSecrets, Env, Secrets

DEFAULT_TIMEOUT_SECS = 60.0
DEFAULT_MAX_RETRIES = 2


class Boxd:
    """The boxd client.

    ::

        boxd = Boxd()                                   # production
        boxd = Boxd(api_key="bxd_...")
        boxd = Boxd(region="nyc")                       # machines in New York
        boxd = Boxd(base_url="https://boxd.example.com:9443")  # any other cluster

    Args:
        api_key: A `bxd_` API key. Defaults to `BOXD_API_KEY`.
        token: A token, used as-is. Defaults to `BOXD_TOKEN`. Takes
            precedence over `api_key`.
        base_url: The cluster to talk to. Defaults to `BOXD_BASE_URL`, then
            production. There is no `environment` argument — one URL selects
            a cluster and everything else follows from it.
        region: The region machines, snapshots and disks are created in and
            looked up in (``"fra"``, ``"nyc"``, ...). Defaults to
            `BOXD_REGION`, then the region `base_url` serves. Account and org
            calls always go to `base_url`. Every such method also takes its
            own ``region=``.
        timeout: Per-request timeout in seconds.
        max_retries: Retries for connection failures, with exponential backoff.

    Inside a boxd machine, `Boxd()` authenticates automatically — no API key
    needed, and the machine's own cluster is used unless you pass `base_url`.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        base_url: str | None = None,
        region: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        resolved = resolve_base_url(base_url)
        credentials = SyncCredentials(
            api_key=api_key,
            token=token,
            exchange_url=exchange_url_for(resolved or DEFAULT_BASE_URL),
        )

        def connect(url: str | None, *, derived: bool = False) -> SyncTransport:
            # Every region's endpoint, and home's, share the one credential.
            return SyncTransport(
                base_url=url,
                credentials=credentials,
                timeout=timeout,
                max_retries=max_retries,
                derived=derived,
            )

        self._transport = SyncRouter(
            connect(resolved), region=region, connect=connect, credentials=credentials
        )

        self.machines = Machines(self._transport)
        self.snapshots = Snapshots(self._transport)
        self.disks = Disks(self._transport)
        self.env = Env(self._transport)
        self.secrets = Secrets(self._transport)
        self.domains = Domains(self._transport)
        self.orgs = Orgs(self._transport)
        self.teams = Teams(self._transport)
        self.api_keys = ApiKeys(self._transport)
        self.account = Account(self._transport)
        self.regions = Regions(self._transport)

    @property
    def base_url(self) -> str:
        """The cluster this client talks to: its home."""
        return self._transport.base_url

    @property
    def region(self) -> str | None:
        """The client's region (``region=`` or `BOXD_REGION`); None = the
        region `base_url` serves."""
        return self._transport.region

    def close(self) -> None:
        """Close the underlying connection. Safe to call more than once."""
        self._transport.close()

    def __enter__(self) -> Boxd:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()


class AsyncBoxd:
    """The async boxd client — same surface as :class:`Boxd`, awaited.

    ::

        boxd = AsyncBoxd(api_key="bxd_...")
        machines = await boxd.machines.list()
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        base_url: str | None = None,
        region: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        resolved = resolve_base_url(base_url)
        credentials = AsyncCredentials(
            api_key=api_key,
            token=token,
            exchange_url=exchange_url_for(resolved or DEFAULT_BASE_URL),
        )

        def connect(url: str | None, *, derived: bool = False) -> AsyncTransport:
            # Every region's endpoint, and home's, share the one credential.
            return AsyncTransport(
                base_url=url,
                credentials=credentials,
                timeout=timeout,
                max_retries=max_retries,
                derived=derived,
            )

        self._transport = AsyncRouter(
            connect(resolved), region=region, connect=connect, credentials=credentials
        )

        self.machines = AsyncMachines(self._transport)
        self.snapshots = AsyncSnapshots(self._transport)
        self.disks = AsyncDisks(self._transport)
        self.env = AsyncEnv(self._transport)
        self.secrets = AsyncSecrets(self._transport)
        self.domains = AsyncDomains(self._transport)
        self.orgs = AsyncOrgs(self._transport)
        self.teams = AsyncTeams(self._transport)
        self.api_keys = AsyncApiKeys(self._transport)
        self.account = AsyncAccount(self._transport)
        self.regions = AsyncRegions(self._transport)

    @property
    def base_url(self) -> str:
        """The cluster this client talks to: its home."""
        return self._transport.base_url

    @property
    def region(self) -> str | None:
        """The client's region (``region=`` or `BOXD_REGION`); None = the
        region `base_url` serves."""
        return self._transport.region

    async def close(self) -> None:
        """Close the underlying connection. Safe to call more than once."""
        await self._transport.close()

    async def __aenter__(self) -> AsyncBoxd:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()
