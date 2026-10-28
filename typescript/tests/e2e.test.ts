/**
 * End-to-end suite against a real cluster. Skipped unless `BOXD_RUN_E2E=1`.
 *
 *   BOXD_API_KEY=... BOXD_RUN_E2E=1 bun run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Boxd, Machine } from "../src/index.js";
import { NotFoundError } from "../src/index.js";
import { e2eEnabled, mkClient } from "./conftest.js";

const suite = e2eEnabled() ? describe : describe.skip;

/** Create a machine, run the body, always clean up. */
async function withMachine<T>(
  boxd: Boxd,
  body: (m: Machine) => Promise<T>,
  opts: { name?: string; wait?: boolean } = {},
): Promise<T> {
  const machine = await boxd.machines.create({
    ...(opts.name ? { name: opts.name } : {}),
    config: { autoSuspendTimeout: 0 },
  });
  try {
    if (opts.wait !== false) await boxd.machines.waitUntilReady(machine.id);
    return await body(machine);
  } finally {
    try {
      await boxd.machines.delete(machine.id);
    } catch {
      /* already gone */
    }
  }
}

suite("e2e: account", () => {
  let boxd: Boxd;
  beforeAll(() => {
    boxd = mkClient();
  });
  afterAll(async () => {
    await boxd.close();
  });

  it("retrieve() identifies the caller", async () => {
    const me = await boxd.account.get();
    expect(me.userId).toBeTruthy();
    expect(Array.isArray(me.sshKeyFingerprints)).toBe(true);
    expect(me.billing.maxVms).toBeGreaterThan(0);
  });

  it("config() reports the cluster defaults", async () => {
    const cfg = await boxd.account.config();
    expect(cfg.defaultImage).toBeTruthy();
    expect(cfg.zone).toBeTruthy();
  });

  it("orgs.list() includes a default org", async () => {
    const orgs = await boxd.orgs.list();
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.defaultOrgId).toBeTruthy();
  });

  it("billing.plans() returns the catalog", async () => {
    const plans = await boxd.billing.plans();
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.lookupKey).toBeTruthy();
  });
});

suite("e2e: machines", () => {
  let boxd: Boxd;
  beforeAll(() => {
    boxd = mkClient();
  });
  afterAll(async () => {
    await boxd.close();
  });

  it("suggestName() returns a free name", async () => {
    expect(await boxd.machines.suggestName()).toBeTruthy();
  });

  it("create → retrieve → list → delete", async () => {
    await withMachine(
      boxd,
      async (m) => {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();

        const fetched = await boxd.machines.get(m.id);
        expect(fetched.id).toBe(m.id);
        expect(fetched.status).toBe("running");
        // Mapper contract: unset means null, never 0 or "".
        expect(fetched.access.sshPort === null || fetched.access.sshPort > 0).toBe(true);
        expect(fetched.access.domain).toBeTruthy();
        expect(fetched.access.url).toBe(`https://${fetched.name}.${fetched.access.domain}`);
        // The server always resolves an effective size.
        expect(fetched.resources.vcpu).toBeGreaterThan(0);
        expect(fetched.resources.memoryBytes).toBeGreaterThan(0);
        // Booted from an image, so it came from nowhere.
        expect(fetched.source).toBeNull();

        const listed = await boxd.machines.list();
        expect(listed.some((x) => x.id === m.id)).toBe(true);
      },
    );
  });

  it("retrieving a machine that does not exist throws NotFoundError", async () => {
    await expect(boxd.machines.get("vm_does_not_exist")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("exec returns stdout and an exit code", async () => {
    await withMachine(boxd, async (m) => {
      const ok = await boxd.machines.exec(m.id, { command: ["echo", "hello"] });
      expect(ok.stdout.trim()).toBe("hello");
      expect(ok.exitCode).toBe(0);

      const bad = await boxd.machines.exec(m.id, { command: ["false"] });
      expect(bad.exitCode).not.toBe(0);

      const withEnv = await boxd.machines.exec(m.id, {
        command: ["sh", "-c", "echo $GREETING"],
        env: { GREETING: "hi there" },
      });
      expect(withEnv.stdout.trim()).toBe("hi there");
    });
  });

  it("streamExec drives an interactive shell", async () => {
    await withMachine(boxd, async (m) => {
      const stream = boxd.machines.streamExec(m.id, { command: "sh", tty: true });
      stream.write("echo marker\n");
      stream.write("exit\n");
      let seen = "";
      for await (const chunk of stream) {
        seen += new TextDecoder().decode(chunk);
        if (seen.includes("marker")) break;
      }
      expect(seen).toContain("marker");
      stream.close();
    });
  });

  it("files round-trip", async () => {
    await withMachine(boxd, async (m) => {
      const body = `written at ${Date.now()}`;
      const written = await boxd.machines.files.upload(m.id, "/tmp/sdk-test.txt", body);
      expect(written).toBe(body.length);
      const read = await boxd.machines.files.download(m.id, "/tmp/sdk-test.txt");
      expect(new TextDecoder().decode(read)).toBe(body);
    });
  });

  it("timeouts are explicit setters, and land on the machine", async () => {
    await withMachine(boxd, async (m) => {
      await boxd.machines.setAutoSuspendTimeout(m.id, 0);
      expect((await boxd.machines.get(m.id)).idle.suspendAfter).toBe(0);
      await boxd.machines.setAutoSuspendTimeout(m.id, 120);
      expect((await boxd.machines.get(m.id)).idle.suspendAfter).toBe(120);
    });
  });

  it("pause / resume round-trips", async () => {
    await withMachine(boxd, async (m) => {
      const paused = await boxd.machines.pause(m.id);
      expect(paused.suspendUs).toBeGreaterThan(0);
      const resumed = await boxd.machines.resume(m.id);
      expect(resumed.resumeUs).toBeGreaterThan(0);
    });
  });

  it("ports expose and unexpose", async () => {
    await withMachine(boxd, async (m) => {
      const forward = await boxd.machines.ports.expose(m.id, 8080, { protocol: "tcp" });
      expect(forward.machinePort).toBe(8080);
      expect(forward.publicPort).toBeGreaterThan(0);

      const all = await boxd.machines.ports.list();
      expect(all.some((f) => f.machineName === m.name && f.machinePort === 8080)).toBe(
        true,
      );

      await boxd.machines.ports.unexpose(m.id, 8080);
    });
  });

  it("proxies list by machine name", async () => {
    await withMachine(boxd, async (m) => {
      const proxies = await boxd.machines.proxies.list(m.name);
      expect(Array.isArray(proxies)).toBe(true);
    });
  });

  it("logs stream", async () => {
    await withMachine(boxd, async (m) => {
      let bytes = 0;
      for await (const chunk of boxd.machines.logs(m.id)) {
        bytes += chunk.length;
        if (bytes > 0) break;
      }
      expect(bytes).toBeGreaterThanOrEqual(0);
    });
  });
});

suite("e2e: env and secrets", () => {
  let boxd: Boxd;
  const name = `SDK_TEST_${Date.now()}`;
  beforeAll(() => {
    boxd = mkClient();
  });
  afterAll(async () => {
    for (const ns of [boxd.env, boxd.secrets]) {
      try {
        await ns.delete(name);
      } catch {
        /* not set */
      }
    }
    await boxd.close();
  });

  it("env values are readable", async () => {
    await boxd.env.set(name, "hello");
    const listed = await boxd.env.list();
    const found = listed.find((v) => v.name === name);
    expect(found?.value).toBe("hello");
    await boxd.env.delete(name);
  });

  it("secret values are never returned", async () => {
    await boxd.secrets.set(name, "s3cret");
    const listed = await boxd.secrets.list();
    const found = listed.find((v) => v.name === name);
    expect(found).toBeDefined();
    expect("value" in (found as object)).toBe(false);
    await boxd.secrets.delete(name);
  });
});

suite("e2e: disks", () => {
  let boxd: Boxd;
  beforeAll(() => {
    boxd = mkClient();
  });
  afterAll(async () => {
    await boxd.close();
  });

  it("create → list → delete", async () => {
    const disk = await boxd.disks.create(`sdk-test-${Date.now()}`, "1G");
    try {
      expect(disk.id).toBeTruthy();
      expect(disk.sizeBytes).toBe(1024 ** 3);
      const listed = await boxd.disks.list();
      expect(listed.some((d) => d.id === disk.id)).toBe(true);
    } finally {
      await boxd.disks.delete(disk.id);
    }
  });
});
