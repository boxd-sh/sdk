import { ALL_REGIONS, eachRegion, normalizeRegion, notFoundElsewhere } from "./_regions.js";
import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { NotFoundError } from "./errors.js";
import {
  toCreatedSnapshot,
  toRegionalList,
  toSnapshot,
  type CreatedSnapshot,
  type RegionalList,
  type Snapshot,
} from "./models.js";
import type { RegionOption } from "./regions.js";
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
  async create(machine: string, name: string, opts: RegionOption = {}): Promise<CreatedSnapshot> {
    const req: CreateSnapshotRequest = { vm: machine, name };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createSnapshot, req, {
      region: opts.region,
    });
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

  async get(name: string, params: { org?: string } & RegionOption = {}): Promise<Snapshot> {
    const req = { name, org: params.org ?? "" };
    const region = { region: params.region };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getSnapshot, req, region);
    if (!resp.snapshot) {
      throw await notFoundElsewhere(
        this.transport,
        new NotFoundError(`snapshot not found: ${name}`),
        BoxdApiDefinition.methods.getSnapshot,
        req,
        region,
      );
    }
    return toSnapshot(resp.snapshot);
  }

  /**
   * Snapshots never cross an org boundary; key-fenced callers are pinned.
   *
   * The list is of one region (`region`, default the client's); its
   * `elsewhere` counts the org's snapshots in each other region.
   * `{ region: "all" }` lists every region the org has.
   */
  async list(params: { org?: string } & RegionOption = {}): Promise<RegionalList<Snapshot>> {
    const region = normalizeRegion(params.region);
    const req = { org: params.org ?? "", withElsewhere: false };
    if (region === ALL_REGIONS) {
      const { pages, unavailable } = await eachRegion(
        this.transport,
        BoxdApiDefinition.methods.listSnapshots,
        req,
        params.org,
      );
      const all = pages.flatMap((p) =>
        (p.resp.snapshots ?? []).map((s) => toSnapshot(s, p.region)),
      );
      return toRegionalList(all, [], unavailable);
    }
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listSnapshots,
      { ...req, withElsewhere: true },
      { region },
    );
    return toRegionalList(
      (resp.snapshots ?? []).map((s) => toSnapshot(s, region)),
      resp.elsewhere,
    );
  }

  async delete(name: string, params: { org?: string } & RegionOption = {}): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.deleteSnapshot,
      { name, org: params.org ?? "" },
      { region: params.region },
    );
  }

  /**
   * Start restoring an archived snapshot (`storage: "archived"`) from object
   * storage to local disk, so machines can be created from it again. Anyone
   * who can create a machine from the snapshot can.
   *
   * Returns at once with the snapshot as the call left it: `storage` is
   * `"unarchiving"` while the restore runs, then `"local"`. Follow it with
   * `get()`. If `storage` goes back to `"archived"` the restore failed, and
   * calling this again retries it.
   *
   * A snapshot that is already being restored is left as it is. One that is
   * being archived stays local: the upload is cancelled. A local one is
   * returned unchanged. An org can have a few restores running at once; past
   * that this throws a `ConflictError` until one is done.
   *
   * Creating a machine from an archived snapshot starts the same restore and
   * throws a `ConflictError`; create again once `storage` is `"local"`.
   */
  async unarchive(name: string, params: { org?: string } & RegionOption = {}): Promise<Snapshot> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.unarchiveSnapshot,
      { name, org: params.org ?? "" },
      { region: params.region },
    );
    if (!resp.snapshot) throw new NotFoundError(`snapshot not found: ${name}`);
    return toSnapshot(resp.snapshot, normalizeRegion(params.region));
  }
}
