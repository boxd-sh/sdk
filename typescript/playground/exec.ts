/**
 * Exec, streaming exec, and file transfer.
 *
 * CREATES A REAL MACHINE and destroys it on the way out.
 *
 *   bun run playground/exec.ts [--yes]
 */
import { client, confirm, scratchName, show } from "./_common.js";

const boxd = client();
const name = scratchName();

await confirm(`create machine "${name}", run commands in it, then destroy it`);

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
  await boxd.machines.waitUntilReady(id);
  console.log(`${name} is up\n`);

  // ── one-shot ─────────────────────────────────────────────────────────────
  show("uname", await boxd.machines.exec(id, { command: "uname -a" }));

  // stderr comes back separately from stdout for non-PTY execs.
  show("stderr split", await boxd.machines.exec(id, {
    command: "echo out; echo err 1>&2; exit 3",
  }));

  // ── streaming ────────────────────────────────────────────────────────────
  console.log("\n── streaming ───────────────────────────────────────────────");
  const stream = boxd.machines.streamExec(id, {
    command: "for i in 1 2 3; do echo tick $i; sleep 1; done",
  });
  for await (const chunk of stream) {
    process.stdout.write(new TextDecoder().decode(chunk));
  }
  console.log(`exit: ${stream.exitCode}`);

  // ── files ────────────────────────────────────────────────────────────────
  await boxd.machines.files.upload(id, "/tmp/hello.txt", "hello from the playground\n");
  const back = await boxd.machines.files.download(id, "/tmp/hello.txt");
  show("round-tripped", new TextDecoder().decode(back));

  // ── publishing ports ─────────────────────────────────────────────────────
  const proxy = await boxd.machines.proxies.create(id, "web", 8000);
  show("https proxy", proxy);
  show("proxies for this machine", (await boxd.machines.proxies.list(id)));

  const fwd = await boxd.machines.ports.expose(id, 5432, { protocol: "tcp" });
  show("raw tcp forward", fwd);
  // Now scoped server-side to this machine, rather than the whole account.
  show("ports for this machine", (await boxd.machines.ports.list(id)));
} finally {
  await cleanup();
}
