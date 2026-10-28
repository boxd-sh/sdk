import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { NotFoundError } from "./errors.js";
import {
  toCreatedSnapshot,
  toSnapshot,
  type CreatedSnapshot,
  type Snapshot,
} from "./models.js";
import type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  DeleteSnapshotRequest,
  DeleteSnapshotResponse,
  GetSnapshotRequest,
  GetSnapshotResponse,
  ListSnapshotsRequest,
  ListSnapshotsResponse,
} from "./_generated/definitions.js";

/**
 * Point-in-time machine captures (memory + disk), replicated across a few
 * workers and versioned latest-only. Boot one with
 * `machines.create({ fromSnapshot })`.
 */
export class Snapshots {
  constructor(private readonly transport: Transport) {}

  /**
   * Capture `machine` (name or id; it must be running). Re-saving under an
   * existing name bumps the version. Returns before the artifact lands —
   * `status` is `"pending"` until it does. The machine's running automations
   * are captured too, and every machine created from the snapshot starts
   * them paused (`pausedAutomations` says how many).
   */
  async create(machine: string, name: string): Promise<CreatedSnapshot> {
    const req: CreateSnapshotRequest = { vm: machine, name };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createSnapshot,
      req,
    );
    const created = toCreatedSnapshot(resp);
    const n = created.pausedAutomations;
    if (n > 0) {
      console.warn(
        `boxd: ${n === 1 ? "1 automation" : `${n} automations`} captured: machines created from ` +
          `${created.name} start them paused so nothing runs twice. Inside one, ` +
          "`run restart <id>` starts it.",
      );
    }
    return created;
  }

  async get(name: string, params: { org?: string } = {}): Promise<Snapshot> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getSnapshot,
      { name, org: params.org ?? "" },
    );
    if (!resp.snapshot) throw new NotFoundError(`snapshot not found: ${name}`);
    return toSnapshot(resp.snapshot);
  }

  /** Snapshots never cross an org boundary; key-fenced callers are pinned. */
  async list(params: { org?: string } = {}): Promise<Snapshot[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listSnapshots,
      { org: params.org ?? "" },
    );
    return (resp.snapshots ?? []).map(toSnapshot);
  }

  async delete(name: string, params: { org?: string } = {}): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteSnapshot,
      { name, org: params.org ?? "" },
    );
  }
}
