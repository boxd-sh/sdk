/**
 * Your scratch pad. Edit freely — nothing here is committed to as an example.
 *
 *   bun run playground/scratch.ts
 */
import { client, show } from "./_common.js";

const boxd = client();

// ── try things here ────────────────────────────────────────────────────────

const me = await boxd.account.get();
show("whoami", me);

const machines = await boxd.machines.list();
show(`you have ${machines.length} machine(s)`, machines.map((m) => m.name));

// Everything below is a comment so a bare run is read-only and free.

// const m = await boxd.machines.create({ name: "pg-hello" });
// await boxd.machines.waitUntilReady(m.id);
// const out = await boxd.machines.exec(m.id, { command: "uname -a" });
// console.log(out.stdout);
// await boxd.machines.delete(m.id);

// await boxd.env.set("LOG_LEVEL", "debug", { scope: "private" });
// await boxd.secrets.set("MY_TOKEN", "…", { scope: "private" });
// show("env", (await boxd.env.list()));   // values present
// show("secrets", (await boxd.secrets.list()));  // NO value field — by design

// await boxd.machines.proxies.create(m.id, "web", 3000);
// await boxd.machines.ports.expose(m.id, 5432, { protocol: "tcp" });
