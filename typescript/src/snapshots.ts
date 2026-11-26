import { ALL_REGIONS, eachRegion, normalizeRegion, notFoundElsewhere } from "./_regions.js";
import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { APIStatusError, BoxdError, GrpcStatus, NotFoundError } from "./errors.js";
import {
  toCreatedSnapshot,
  toRegionalList,
  toSnapshot,
  toSnapshotCurrentVersion,
  toSnapshotVersion,
  type CreatedSnapshot,
  type RegionalList,
  type Snapshot,
  type SnapshotCurrentVersion,
  type SnapshotVersion,
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
 * `err`, or for a server too old to know the call a sentence saying so
 * (`what` it can't do yet).
 */
export function olderServer(err: unknown, what: string): unknown {
  if (err instanceof BoxdError && err.grpcCode === GrpcStatus.UNIMPLEMENTED) {
    return new APIStatusError(
      `this boxd doesn't ${what} yet (it runs an older version)`,
      err.grpcCode,
    );
  }
  return err;
}

/**
 * Point-in-time machine captures (memory + disk), replicated across a few
 * workers. Saving over a name makes a new version; boot one with
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
   *
   * `{ staged: true }` saves the version without making it the snapshot's
   * current one: machines created from the snapshot keep getting the current
   * version. Follow the save with `versions(name)` (the version is
   * `"saving"`, then `"ready"` with `staged` set), create a machine from it
   * with `machines.create({ fromSnapshot: name, snapshotVersion })`, and make
   * it current with `setCurrentVersion(name, version)`. The snapshot must
   * already have a version (`ConflictError` for the first save of a name). A
   * snapshot keeps as many staged versions as the org keeps versions
   * (`orgs.getSnapshotVersionsKeep`): one more replaces the oldest staged one.
   */
  async create(
    machine: string,
    name: string,
    opts: { staged?: boolean } & RegionOption = {},
  ): Promise<CreatedSnapshot> {
    const req: CreateSnapshotRequest = { vm: machine, name };
    const staged = opts.staged ?? false;
    // A staged save is a call of its own, so that a server from before staged
    // saves refuses it instead of saving a version that becomes current.
    const method = staged
      ? BoxdApiDefinition.methods.createStagedSnapshot
      : BoxdApiDefinition.methods.createSnapshot;
    let resp: CreateSnapshotResponse;
    try {
      resp = await this.transport.unary(method, req, { region: opts.region });
    } catch (err) {
      throw staged ? olderServer(err, "stage a save; nothing was saved") : err;
    }
    const created = toCreatedSnapshot(resp, staged);
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
   * The versions a snapshot keeps, newest first.
   *
   * Saving over a snapshot's name makes a new version, and the org keeps the
   * newest ones (`orgs.setSnapshotVersionsKeep`). Create a machine from one
   * that is `"ready"` and `"local"` with
   * `machines.create({ fromSnapshot: name, snapshotVersion: v.version })`. A
   * version you may not use (saved from someone else's private machine) is
   * not listed.
   */
  async versions(name: string, params: { org?: string } & RegionOption = {}): Promise<SnapshotVersion[]> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listSnapshotVersions,
      { name, org: params.org ?? "" },
      { region: params.region },
    );
    return resp.versions.map(toSnapshotVersion);
  }

  /**
   * Make `version` the snapshot's current version: the one a machine created
   * from the snapshot gets when no version is named, and the one the
   * snapshot's size, saver and visibility are read from.
   *
   * Forward to a staged version (`create(machine, name, { staged: true })`),
   * or back to an older one. After going back, the ready versions above the
   * new current one are staged (`versions(name)`), and can be made current
   * again the same way. Nothing is copied or deleted by the call.
   *
   * For anyone who may save over the snapshot and may use that version. The
   * version must be `"ready"` and `"local"`, and the snapshot itself
   * `"local"` (`ConflictError` otherwise); `NotFoundError` for a version the
   * snapshot does not keep. Naming the version that is current already
   * succeeds, with `changed` false.
   */
  async setCurrentVersion(
    name: string,
    version: number,
    params: { org?: string } & RegionOption = {},
  ): Promise<SnapshotCurrentVersion> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.setSnapshotCurrentVersion,
      { snapshot: name, org: params.org ?? "", version },
      { region: params.region },
    );
    return toSnapshotCurrentVersion(resp);
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
