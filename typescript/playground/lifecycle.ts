/**
 * Full machine lifecycle against a real cluster.
 *
 * CREATES A REAL MACHINE and bills a real org. Always destroys it, including
 * on Ctrl-C or a thrown error.
 *
 *   bun run playground/lifecycle.ts [--yes]
 */
import { client, confirm, scratchName, show } from "./_common.js";

const boxd = client();
const name = scratchName();

await confirm(`create machine "${name}", exercise its lifecycle, then destroy it`);

let id: string | undefined;
const cleanup = async () => {
  if (!id) return;
  process.stdout.write(`\ndestroying ${name} … `);
  await boxd.machines.delete(id).catch((e) => console.error(e));
  console.log("done");
  id = undefined;
};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  const created = await boxd.machines.create({ name });
  id = created.id;
  show("created", created);

  await boxd.machines.waitUntilReady(id);
  show("ready", await boxd.machines.get(id));

  // Timeouts are explicit setters — there is no generic config namespace.
  await boxd.machines.setAutoSuspendTimeout(id, 900);
  await boxd.machines.setAutoHibernateTimeout(id, 0); // 0 = disabled
  show("after setting timeouts", await boxd.machines.get(id));

  // Warm standby → resume.
  await boxd.machines.pause(id);
  show("paused", (await boxd.machines.get(id)).status);
  await boxd.machines.resume(id);
  show("resumed", (await boxd.machines.get(id)).status);

  // Cold hibernate → wake.
  await boxd.machines.hibernate(id);
  show("hibernated", (await boxd.machines.get(id)).status);
  await boxd.machines.wake(id);
  show("woken", (await boxd.machines.get(id)).status);

  // A fork lands on the same worker as its source — they share the overlay.
  const fork = await boxd.machines.fork(id, { name: `${name}-fork` });
  // `source` records where it came from; a standalone machine has none.
  show("forked", { machine: fork, source: fork.source });
  await boxd.machines.delete(fork.id);

  // Snapshots are account-level; checkpoints are per-machine and restore in place.
  const snap = await boxd.snapshots.create(id, `${name}-snap`);
  show("snapshot", snap);
  await boxd.snapshots.delete(snap.id);
} finally {
  await cleanup();
}
