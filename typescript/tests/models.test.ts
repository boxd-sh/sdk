import { describe, expect, it } from "bun:test";
import {
  isKnownMachineStatus,
  MACHINE_STATUSES,
  toApiKey,
  toBackup,
  toBackupSchedule,
  toBilling,
  toCheckpoint,
  toInvitedOrgMember,
  toOrgInvite,
  toDisk,
  toOrg,
  toEnvVar,
  toExposedPort,
  toMachine,
  toMachineFromCreate,
  toProxy,
  toSecret,
  toSnapshot,
  toAccount,
} from "../src/models.js";
import { toFsEntry } from "../src/models.js";
import type { GetVmResponse } from "../src/_generated/api.js";
import { FsEntryType } from "../src/_generated/definitions.js";

/** A fully-populated machine row; individual tests override one field. */
function machineRow(over: Partial<GetVmResponse> = {}): GetVmResponse {
  return {
    vmId: "vm_1",
    name: "brave-otter",
    imageRef: "ubuntu:24.04",
    publicIp: "51.1.2.3",
    status: "running",
    restartPolicy: "always",
    diskBytes: 100 * 1024 ** 3,
    autoSuspendTimeoutSecs: 30,
    sshPort: 12345,
    org: "acme",
    orgId: "org_acme",
    billingOrg: "acme",
    billingOrgId: "org_acme",
    accessDomain: "boxd.sh",
    autoHibernateTimeoutSecs: 0,
    autoDestroyTimeoutSecs: 0,
    source: "standalone",
    vcpu: 2,
    memoryBytes: 8 * 1024 ** 3,
    createdAt: 1_700_000_000,
    hibernatedAtMs: 0,
    bootTimeMs: 0,
    lastConnectedMs: 0,
    sourceInfo: undefined,
    networks: [],
    isolated: false,
    botProtection: true,
    botProtectionMode: "on",
    ...over,
  };
}

describe("toMachine — bot protection", () => {
  it("carries the flag through both ways", () => {
    expect(toMachine(machineRow({ botProtection: true })).botProtection).toBe(true);
    expect(toMachine(machineRow({ botProtection: false })).botProtection).toBe(false);
  });

  it("carries the mode through", () => {
    for (const mode of ["on", "sleep_only", "off"] as const) {
      const row = machineRow({ botProtection: mode !== "off", botProtectionMode: mode });
      expect(toMachine(row).botProtectionMode).toBe(mode);
    }
  });

  it("reads a server without the mode as sleep_only or off", () => {
    // Before the mode existed, "on" only ever covered a sleeping machine.
    expect(toMachine(machineRow({ botProtection: true, botProtectionMode: "" })).botProtectionMode).toBe("sleep_only");
    expect(toMachine(machineRow({ botProtection: false, botProtectionMode: "" })).botProtectionMode).toBe("off");
  });
});

describe("toMachine: idleIgnoreOutbound", () => {
  it("carries the flag through both ways", () => {
    expect(toMachine(machineRow({ idleIgnoreOutbound: true })).idleIgnoreOutbound).toBe(true);
    expect(toMachine(machineRow({ idleIgnoreOutbound: false })).idleIgnoreOutbound).toBe(false);
  });

  it("is off when the row does not carry it", () => {
    // `machineRow()` leaves it out, like a server older than the field.
    expect(toMachine(machineRow()).idleIgnoreOutbound).toBe(false);
  });

  it("the create-response fallback reports it off", () => {
    // Not known from that response; create()/fork() re-read the machine.
    const m = toMachineFromCreate({
      vmId: "vm_1",
      name: "brave-otter",
      publicIp: "",
      status: "pending",
      image: "ubuntu:24.04",
    });
    expect(m.idleIgnoreOutbound).toBe(false);
  });
});

describe("toMachine: ssh", () => {
  it("is off only when the server says disabled", () => {
    expect(toMachine(machineRow({ sshDisabled: true })).ssh).toBe(false);
    expect(toMachine(machineRow({ sshDisabled: false })).ssh).toBe(true);
  });

  it("is on when the row does not carry it", () => {
    // Inverted on the wire, so a server older than the field reads as on.
    expect(toMachine(machineRow()).ssh).toBe(true);
  });

  it("the create-response fallback reports it on", () => {
    // Not known from that response; create()/fork() re-read the machine.
    const m = toMachineFromCreate({
      vmId: "vm_1",
      name: "brave-otter",
      publicIp: "",
      status: "pending",
      image: "ubuntu:24.04",
    });
    expect(m.ssh).toBe(true);
  });
});

describe("toMachine — networking", () => {
  it("no networks is the default network, not missing data", () => {
    // Every machine created before networks existed reports an empty list,
    // and it means "the org's default network" — never "unknown".
    expect(toMachine(machineRow()).networking).toEqual({ networks: [], isolated: false });
  });

  it("carries networks and isolated through", () => {
    const m = toMachine(machineRow({ networks: ["demo", "test"], isolated: true }));
    expect(m.networking).toEqual({ networks: ["demo", "test"], isolated: true });
  });

  it("egress allowlist: empty is no policy, entries carry through", () => {
    expect(toMachine(machineRow()).egressAllow).toEqual([]);
    expect(toMachine(machineRow({ egressAllow: ["api.example.com", "1.1.1.1"] })).egressAllow).toEqual([
      "api.example.com",
      "1.1.1.1",
    ]);
  });

  it("labels: empty by default, carried through as given", () => {
    expect(toMachine(machineRow()).labels).toEqual({});
    expect(toMachine(machineRow({ labels: { env: "prod", team: "" } })).labels).toEqual({
      env: "prod",
      team: "",
    });
  });

  it("tolerates a server that omits networks entirely", () => {
    // Defensive: an older server predating the field leaves it undefined on
    // the decoded message, and the mapper must not throw on `.map`/spread.
    const row = machineRow();
    delete (row as { networks?: string[] }).networks;
    expect(toMachine(row).networking.networks).toEqual([]);
  });

  it("the create-response fallback reports networking as unset", () => {
    // create()/fork() re-read the machine; this partial mapping only shows
    // when that read failed, so it must not claim isolation.
    const m = toMachineFromCreate({
      vmId: "vm_1",
      name: "brave-otter",
      publicIp: "",
      status: "pending",
      image: "ubuntu:24.04",
    });
    expect(m.networking).toEqual({ networks: [], isolated: false });
    expect(m.labels).toEqual({});
  });
});

describe("toMachine — the zero-to-null rule is per field", () => {
  it("sshPort 0 → null (not allocated), not port zero", () => {
    expect(toMachine(machineRow({ sshPort: 0 })).access.sshPort).toBeNull();
    expect(toMachine(machineRow({ sshPort: 22 })).access.sshPort).toBe(22);
  });

  it("idle.suspendAfter 0 stays 0 — it means disabled", () => {
    const m = toMachine(machineRow({ autoSuspendTimeoutSecs: 0 }));
    expect(m.idle.suspendAfter).toBe(0);
    expect(m.idle.suspendAfter).not.toBeNull();
  });

  it("every idle timer keeps its 0 — none of them is nulled", () => {
    const off = toMachine(
      machineRow({
        autoSuspendTimeoutSecs: 0,
        autoHibernateTimeoutSecs: 0,
        autoDestroyTimeoutSecs: 0,
      }),
    );
    expect(off.idle).toEqual({ suspendAfter: 0, hibernateAfter: 0, destroyAfter: 0 });

    const on = toMachine(
      machineRow({
        autoSuspendTimeoutSecs: 30,
        autoHibernateTimeoutSecs: 900,
        autoDestroyTimeoutSecs: 86_400,
      }),
    );
    expect(on.idle).toEqual({
      suspendAfter: 30,
      hibernateAfter: 900,
      destroyAfter: 86_400,
    });
  });

  it("timestamps of 0 are null — the thing never happened", () => {
    const never = toMachine(
      machineRow({ createdAt: 0, hibernatedAtMs: 0, lastConnectedMs: 0, bootTimeMs: 0 }),
    );
    expect(never.createdAt).toBeNull();
    expect(never.hibernatedAt).toBeNull();
    expect(never.deleteAt).toBeNull();
    expect(never.deleteAfterCron).toBeNull();
    expect(toMachine(machineRow({ deleteAtMs: 1, deleteAfterCron: "0 18 * * *" })).deleteAfterCron).toBe("0 18 * * *");
    expect(never.lastConnectedAt).toBeNull();
    expect(never.bootTimeMs).toBeNull();
  });

  it("createdAt is seconds; hibernatedAt and lastConnectedAt are milliseconds", () => {
    const m = toMachine(
      machineRow({
        createdAt: 1_700_000_000,
        hibernatedAtMs: 1_700_000_500_000,
        lastConnectedMs: 1_700_000_900_000,
        bootTimeMs: 1_250,
      }),
    );
    expect(m.createdAt?.getTime()).toBe(1_700_000_000_000);
    expect(m.hibernatedAt?.getTime()).toBe(1_700_000_500_000);
    expect(toMachine(machineRow({ deleteAtMs: 1_800_000_000_000 })).deleteAt?.getTime()).toBe(
      1_800_000_000_000,
    );
    expect(m.lastConnectedAt?.getTime()).toBe(1_700_000_900_000);
    // A boot duration, not a timestamp — it stays a number.
    expect(m.bootTimeMs).toBe(1_250);
  });

  it("resources are the server's effective values and are never nulled", () => {
    const m = toMachine(machineRow({ vcpu: 4, memoryBytes: 1024, diskBytes: 2048 }));
    expect(m.resources).toEqual({ vcpu: 4, memoryBytes: 1024, diskBytes: 2048 });
  });

  it("empty strings become null", () => {
    const m = toMachine(
      machineRow({ org: "", orgId: "", billingOrg: "", billingOrgId: "" }),
    );
    expect(m.org).toBeNull();
    expect(m.shared).toBe(false);
  });

  it("non-empty strings pass through, id beside name", () => {
    const m = toMachine(machineRow());
    expect(m.org).toEqual({ id: "org_acme", name: "acme" });
    expect(m.shared).toBe(true);
  });

  it("drops the redundant prefix: vmId → id", () => {
    const m = toMachine(machineRow());
    expect(m.id).toBe("vm_1");
    expect("vmId" in m).toBe(false);
  });

  it("access.domain is not null-mapped, and the url is built from it", () => {
    const m = toMachine(machineRow());
    expect(m.access.domain).toBe("boxd.sh");
    expect(m.access.url).toBe("https://brave-otter.boxd.sh");
  });

  it("drops the flattened fields the grouped ones replace", () => {
    const m = toMachine(machineRow()) as unknown as Record<string, unknown>;
    for (const gone of [
      "sshPort",
      "accessDomain",
      "billingOrg",
      "autoSuspendTimeout",
      "autoHibernateTimeout",
      "diskBytes",
    ]) {
      expect(gone in m).toBe(false);
    }
  });
});

describe("Machine.source", () => {
  it("is null for a standalone machine — the wire leaves the message unset", () => {
    expect(toMachine(machineRow({ sourceInfo: undefined })).source).toBeNull();
  });

  it("a fork has no version", () => {
    const m = toMachine(
      machineRow({
        sourceInfo: { kind: "fork", name: "parent", version: 0, id: "vm_parent" },
      }),
    );
    expect(m.source).toEqual({
      kind: "fork",
      name: "parent",
      version: null,
      id: "vm_parent",
    });
  });

  it("a snapshot keeps its version", () => {
    const m = toMachine(
      machineRow({
        sourceInfo: { kind: "snapshot", name: "golden", version: 3, id: "sn_1" },
      }),
    );
    expect(m.source?.kind).toBe("snapshot");
    expect(m.source?.version).toBe(3);
  });

  it("an unrecoverable source id is null, name and version survive", () => {
    const m = toMachine(
      machineRow({
        sourceInfo: { kind: "snapshot", name: "golden", version: 2, id: "" },
      }),
    );
    expect(m.source?.id).toBeNull();
    expect(m.source?.name).toBe("golden");
    expect(m.source?.version).toBe(2);
  });
});

describe("machine status", () => {
  it("every documented status is recognised", () => {
    for (const s of MACHINE_STATUSES) expect(isKnownMachineStatus(s)).toBe(true);
  });

  it("covers the full union", () => {
    expect([...MACHINE_STATUSES].sort()).toEqual(
      [
        "destroyed",
        "failed",
        "hibernated",
        "migrating",
        "pending",
        "running",
        "starting",
        "stopped",
        "suspended",
      ].sort(),
    );
  });

  it("an unknown status is surfaced, not thrown on", () => {
    const m = toMachine(machineRow({ status: "quantum" }));
    expect(m.status).toBe("quantum" as never);
    expect(isKnownMachineStatus(m.status)).toBe(false);
  });
});

describe("toMachineFromCreate", () => {
  it("reports unknown fields as unset rather than inventing them", () => {
    const m = toMachineFromCreate({
      vmId: "vm_2",
      name: "new-one",
      publicIp: "",
      status: "pending",
      image: "ubuntu:24.04",
    });
    expect(m.id).toBe("vm_2");
    expect(m.imageRef).toBe("ubuntu:24.04");
    expect(m.access.sshPort).toBeNull();
    expect(m.access.domain).toBe("");
    // No domain yet, so no URL to invent.
    expect(m.access.url).toBe("");
    expect(m.createdAt).toBeNull();
    expect(m.source).toBeNull();
    expect(m.org).toBeNull();
    expect(m.shared).toBe(false);
    // Which bot protection mode a new machine gets is the cluster's choice.
    expect(m.botProtectionMode).toBeNull();
  });
});

describe("timestamps", () => {
  it("a checkpoint's createdAt is epoch milliseconds", () => {
    const c = toCheckpoint({
      checkpointId: "ck_1",
      name: "before-upgrade",
      status: "ready",
      sizeBytes: 42,
      createdAt: 1_700_000_000_000,
      createdBy: "u_1",
      available: true,
    });
    expect(c.createdAt).toBeInstanceOf(Date);
    expect(c.createdAt.getTime()).toBe(1_700_000_000_000);
  });

  it("0 means never / no expiry, and maps to null", () => {
    const k = toApiKey({
      id: "k_1",
      name: "ci",
      keyPrefix: "bxd_abcd",
      createdAt: 1_700_000_000,
      lastUsedAt: 0,
      expiresAt: 0,
      org: "acme",
      kind: "member",
    });
    expect(k.createdAt).toBeInstanceOf(Date);
    expect(k.lastUsedAt).toBeNull();
    expect(k.expiresAt).toBeNull();
  });

  it("a real expiry is a Date", () => {
    const k = toApiKey({
      id: "k_2",
      name: "ci",
      keyPrefix: "bxd_abcd",
      createdAt: 1_700_000_000,
      lastUsedAt: 1_700_000_500,
      expiresAt: 1_800_000_000,
      org: "acme",
      kind: "org",
    });
    expect(k.lastUsedAt?.getTime()).toBe(1_700_000_500_000);
    expect(k.expiresAt?.getTime()).toBe(1_800_000_000_000);
    expect(k.kind).toBe("org");
  });
});

describe("other mappers", () => {
  it("snapshot version 0 means nothing captured yet", () => {
    const base = {
      snapshotId: "sn_1",
      name: "golden",
      status: "pending",
      sizeBytes: 0,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      vcpu: 2,
      memoryBytes: 0,
      useCount: 0,
    };
    expect(toSnapshot({ ...base, version: 0 }).version).toBeNull();
    expect(toSnapshot({ ...base, version: 3 }).version).toBe(3);
  });

  it("snapshot: createdAt is the first capture, updatedAt the latest", () => {
    // The wire values are epoch milliseconds, not seconds.
    const s = toSnapshot({
      snapshotId: "sn_1",
      name: "golden",
      version: 3,
      status: "ready",
      sizeBytes: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_090_000_000,
      vcpu: 2,
      memoryBytes: 0,
      useCount: 0,
    });
    expect(s.createdAt?.getTime()).toBe(1_700_000_000_000);
    expect(s.updatedAt?.getTime()).toBe(1_700_090_000_000);
    // 0 = the platform never recorded one.
    expect(
      toSnapshot({
        snapshotId: "sn_2",
        name: "old",
        version: 1,
        status: "ready",
        sizeBytes: 0,
        createdAt: 0,
        updatedAt: 0,
        vcpu: 0,
        memoryBytes: 0,
        useCount: 0,
      }).createdAt,
    ).toBeNull();
  });

  it("snapshot: storage says where it is, and an older server means local", () => {
    const base = {
      snapshotId: "sn_1",
      name: "golden",
      version: 3,
      status: "ready",
      sizeBytes: 0,
      createdAt: 0,
      updatedAt: 0,
      vcpu: 2,
      memoryBytes: 0,
      useCount: 0,
      failedVersion: 0,
      failureReason: "",
    };
    const s = toSnapshot({ ...base, archived: true, storage: "archived" });
    expect(s.storage).toBe("archived");
    expect(s.archived).toBe(true);
    const old = toSnapshot({ ...base, archived: false, storage: "" });
    expect(old.storage).toBe("local");
    expect(old.archived).toBe(false);
  });

  it("proxy: the port is the effective one, and the mode is machine-readable", () => {
    const p = toProxy({
      name: "",
      vmId: "vm_1",
      vmName: "brave-otter",
      domain: "brave-otter.boxd.sh",
      // The *stored* port is 0; traffic still lands on the detected 8000.
      port: 0,
      isDefault: true,
      portDisplay: "auto (8000)",
      portMode: "auto",
      effectivePort: 8000,
    });
    expect(p.name).toBeNull();
    expect(p.machineId).toBe("vm_1");
    expect(p.port).toBe(8000);
    expect(p.portMode).toBe("auto");
    expect(p.isDefault).toBe(true);
    expect(p.machineName).toBe("brave-otter");
    // No English to parse.
    expect("portDisplay" in p).toBe(false);
  });

  it("proxy: a pinned port reports mode locked", () => {
    const p = toProxy({
      name: "api",
      vmId: "vm_1",
      vmName: "brave-otter",
      domain: "api.brave-otter.boxd.sh",
      port: 3000,
      isDefault: false,
      portDisplay: "3000",
      portMode: "locked",
      effectivePort: 3000,
    });
    expect(p.name).toBe("api");
    expect(p.port).toBe(3000);
    expect(p.portMode).toBe("locked");
  });

  it("exposed port keeps its numbers, renames vmPort, and carries the machine id", () => {
    const e = toExposedPort({
      vmId: "vm_1",
      vmName: "brave-otter",
      dns: "brave-otter.boxd.sh",
      publicPort: 30001,
      vmPort: 5432,
      protocol: "tcp",
    });
    expect(e.machineId).toBe("vm_1");
    expect(e.machinePort).toBe(5432);
    expect(e.publicPort).toBe(30001);
    expect(e.protocol).toBe("tcp");
  });

  it("disk: status is a union, createdAt is a Date, attachments are mapped", () => {
    // The wire value is epoch milliseconds, not seconds.
    const d = toDisk({
      diskId: "d_1",
      name: "data",
      sizeBytes: 1024,
      status: "ready",
      createdAt: 1_700_000_000_000,
      attachments: [
        { vmId: "vm_1", vmName: "brave-otter", mountPath: "/data", mountMode: "rw" },
      ],
    });
    expect(d.status).toBe("ready");
    expect(d.createdAt?.getTime()).toBe(1_700_000_000_000);
    expect(d.attachments[0]).toEqual({
      machineId: "vm_1",
      machineName: "brave-otter",
      mountPath: "/data",
      mountMode: "rw",
    });
  });

  it("disk: createdAt 0 is null, not 1970", () => {
    const d = toDisk({
      diskId: "d_2",
      name: "old",
      sizeBytes: 1,
      status: "creating",
      createdAt: 0,
      attachments: [],
    });
    expect(d.createdAt).toBeNull();
    expect(d.status).toBe("creating");
  });

  it("an env var keeps its value; a secret has no value field at all", () => {
    const item = { name: "API_URL", kind: "env", scope: "shared", value: "https://x" };
    expect(toEnvVar(item)).toEqual({ name: "API_URL", scope: "shared", value: "https://x" });
    const secret = toSecret({ name: "TOKEN", kind: "secret", scope: "private", value: "" });
    expect(secret).toEqual({ name: "TOKEN", scope: "private", domains: [], boundMachines: 0 });
    expect("value" in secret).toBe(false);
    const scoped = toSecret({
      name: "TOKEN",
      kind: "secret",
      scope: "all",
      value: "",
      domains: ["api.example.com", "*.example.org"],
    });
    expect(scoped.domains).toEqual(["api.example.com", "*.example.org"]);
    const bound = toSecret({
      name: "NPM_TOKEN",
      kind: "secret",
      scope: "unattached",
      value: "",
      domains: [],
      boundMachines: 2,
    });
    expect([bound.scope, bound.boundMachines]).toEqual(["unattached", 2]);
  });

  it("billing: empty stripe ids and pastDueSince 0 are null", () => {
    const b = toBilling({
      subscriptionStatus: "active",
      pastDueSince: 0,
      maxVms: 10,
      vcpu: 2,
      memoryBytes: 8 * 1024 ** 3,
    });
    expect(b.pastDueSince).toBeNull();
    expect(b.maxVms).toBe(10);
  });

  it("billing tolerates an absent block", () => {
    expect(toBilling(undefined).maxVms).toBe(0);
  });

  it("account: an empty display name falls back to null", () => {
    const a = toAccount({
      userId: "u_1",
      pubkeyFingerprints: ["SHA256:abc"],
      displayName: "",
      billing: undefined,
    });
    expect(a.displayName).toBeNull();
    expect(a.sshKeyFingerprints).toEqual(["SHA256:abc"]);
  });
});

describe("orgs", () => {
  it("marks the default org rather than smuggling an id beside the array", () => {
    const orgs = [
      toOrg({ id: "org-a", name: "A", slug: "a", isAdmin: true } as never, "org-b"),
      toOrg({ id: "org-b", name: "B", slug: "b", isAdmin: false } as never, "org-b"),
    ];
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs.map((o) => o.isDefault)).toEqual([false, true]);
  });
});

describe("Machine.org and Machine.shared are two different questions", () => {
  it("a private org-billed machine still names its org", () => {
    // The confusing case: the wire blanks `org`/`org_id` when a machine is not
    // shared, but the machine still belongs to — and is billed to — that org.
    // Reading the shared-gated copy as "the org" would report `null` here.
    const priv = toMachine(
      machineRow({
        org: "",
        orgId: "",
        billingOrg: "laurci",
        billingOrgId: "org-73839683",
      }),
    );
    expect(priv.org).toEqual({ id: "org-73839683", name: "laurci" });
    expect(priv.shared).toBe(false);
  });

  it("a shared machine reports the same org, with shared true", () => {
    const shared = toMachine(
      machineRow({
        org: "laurci",
        orgId: "org-73839683",
        billingOrg: "laurci",
        billingOrgId: "org-73839683",
      }),
    );
    expect(shared.org).toEqual({ id: "org-73839683", name: "laurci" });
    expect(shared.shared).toBe(true);
  });

  it("a personal machine has no org at all", () => {
    const personal = toMachine(
      machineRow({ org: "", orgId: "", billingOrg: "", billingOrgId: "" }),
    );
    expect(personal.org).toBeNull();
    expect(personal.shared).toBe(false);
  });
});

describe("backups", () => {
  it("a disabled schedule maps to null", () => {
    expect(toBackupSchedule({ enabled: false } as never)).toBeNull();
  });

  it("an enabled schedule maps fields, and an unset last_backup_at maps to null", () => {
    const sched = toBackupSchedule({
      enabled: true,
      scheduleKind: "interval",
      scheduleValue: "3600",
      retentionSecs: 604_800,
      nextBackupAt: 1_700_000_000_000,
      lastBackupAt: 0,
    });
    expect(sched).not.toBeNull();
    expect(sched?.scheduleKind).toBe("interval");
    expect(sched?.nextBackupAt).toBeInstanceOf(Date);
    expect(sched?.nextBackupAt.getTime()).toBe(1_700_000_000_000);
    expect(sched?.lastBackupAt).toBeNull();
  });

  it("a dedup row has no checksum of its own but names what it points at", () => {
    const b = toBackup({
      backupId: "bkp_2",
      status: "dedup",
      sizeBytes: 0,
      checksum: "",
      pointsToBackupId: "bkp_1",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_600_000_000,
    });
    expect(b.status).toBe("dedup");
    expect(b.checksum).toBeNull();
    expect(b.pointsToBackupId).toBe("bkp_1");
  });
});

describe("desktop url", () => {
  it("is the console origin plus /desktop/<name>, and empty without one", () => {
    const v = { vmId: "vm-1", name: "box", accessDomain: "boxd.sh" } as never;
    expect(toMachine(v, "https://app.boxd.sh").access.desktopUrl).toBe(
      "https://app.boxd.sh/desktop/box",
    );
    // No endpoint to derive it from: empty, never a half-built URL.
    expect(toMachine(v).access.desktopUrl).toBe("");
  });
});

describe("toFsEntry", () => {
  const base = {
    name: new TextEncoder().encode("f"),
    path: new TextEncoder().encode("/d/f"),
    type: FsEntryType.FS_ENTRY_TYPE_FILE,
    targetType: FsEntryType.FS_ENTRY_TYPE_FILE,
    size: 3,
    mode: 0o640,
    mtimeNs: 0,
    uid: 1,
    gid: 2,
    symlinkTarget: new Uint8Array(),
  };

  it("a FIFO or device is \"other\", and so is a kind added later", () => {
    expect(toFsEntry({ ...base, type: FsEntryType.FS_ENTRY_TYPE_OTHER, targetType: FsEntryType.FS_ENTRY_TYPE_OTHER }).type).toBe("other");
    const future = toFsEntry({ ...base, type: 99 as FsEntryType, targetType: 99 as FsEntryType });
    expect(future.type).toBe("other");
    expect(future.targetType).toBe("other");
    expect(future.isFile).toBe(false);
  });

  it("a name starting with U+FEFF keeps it", () => {
    const name = new TextEncoder().encode("\uFEFFbom");
    expect(toFsEntry({ ...base, name }).name).toBe("\uFEFFbom");
  });

  it("mtime: nanoseconds as a number or as an exact decimal string", () => {
    expect(toFsEntry({ ...base, mtimeNs: 1_500_000 }).mtime.getTime()).toBe(1);
    const exact = toFsEntry({ ...base, mtimeNs: "1761580800123456789" as unknown as number });
    expect(exact.mtime.toISOString()).toBe("2025-10-27T16:00:00.123Z");
  });

  it("symlinkTarget only for a symlink; bytes are copies", () => {
    expect(toFsEntry(base).symlinkTarget).toBeNull();
    expect(toFsEntry(base).symlinkTargetBytes).toBeNull();
    const e = toFsEntry(base);
    e.nameBytes[0] = 0;
    expect(base.name[0]).toBe(0x66);
  });

  it("a symlink target that isn't UTF-8 is exact in symlinkTargetBytes", () => {
    const target = new Uint8Array([0x2e, 0x2e, 0x2f, 0x66, 0xff]); // "../f\xff"
    const e = toFsEntry({
      ...base,
      type: FsEntryType.FS_ENTRY_TYPE_SYMLINK,
      targetType: FsEntryType.FS_ENTRY_TYPE_UNSPECIFIED,
      symlinkTarget: target,
    });
    expect(e.symlinkTarget).toBe("../f\uFFFD");
    expect(e.symlinkTargetBytes).toEqual(target);
    e.symlinkTargetBytes![0] = 0;
    expect(target[0]).toBe(0x2e);
  });
});

describe("invites", () => {
  it("carry what became of the email, and nothing from an older server", () => {
    const invited = toInvitedOrgMember(
      { token: "tok", acceptUrl: "https://app.example.com/accept?token=tok", createdAt: 1_700_000_000, expiresAt: 1_700_172_800, emailStatus: "failed" },
      "new@example.com",
      "member",
    );
    expect(invited.emailStatus).toBe("failed");
    expect(invited.acceptUrl).toEndWith("token=tok");

    const base = { token: "a", email: "a@example.com", acceptUrl: "", createdAt: 1, expiresAt: 2, role: "member" };
    expect(toOrgInvite({ ...base, emailStatus: "bounced" }).emailStatus).toBe("bounced");
    expect(toOrgInvite({ ...base, emailStatus: "" }).emailStatus).toBe("");
  });
});
