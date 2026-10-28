/**
 * Read-only tour. Creates nothing, changes nothing, costs nothing.
 * Good first run to confirm your key and cluster are right.
 */
import { client, show, target } from "./_common.js";

const boxd = client();
console.log(`cluster: ${target()}`);

show("account", await boxd.account.get());

const machines = await boxd.machines.list();
show(`machines (${machines.length})`, machines.map((m) => ({
  id: m.id,
  name: m.name,
  status: m.status,
  url: m.access.url,
  sshPort: m.access.sshPort,
  // vCPU/RAM are the effective values the host actually configured.
  size: `${m.resources.vcpu} vCPU / ${m.resources.memoryBytes / 1024 ** 3} GiB`,
  // 0 means the timer is disabled, not unset.
  idle: m.idle,
  // null = standalone; otherwise a fork or a snapshot restore.
  source: m.source,
  org: m.org?.name ?? "personal",
  shared: m.shared,
  createdAt: m.createdAt,
  lastConnectedAt: m.lastConnectedAt,
})));

show("snapshots", (await boxd.snapshots.list()));
show("disks", (await boxd.disks.list()));
show("orgs", (await boxd.orgs.list()));

// Secrets come back WITHOUT values — the type has no `value` field at all.
show("env vars", (await boxd.env.list()));
show("secrets (names only, by construction)", (await boxd.secrets.list()));

// Ports are account-wide unless you pass a machine.
show("exposed ports (all machines)", (await boxd.machines.ports.list()));

const first = machines[0];
if (first) {
  show(`proxies for ${first.name}`, (await boxd.machines.proxies.list(first.id)));
  show(`ports for ${first.name}`, (await boxd.machines.ports.list(first.id)));
}
