import { ALL_REGIONS, eachRegion, normalizeRegion } from "./_regions.js";
import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import {
  toCreatedDisk,
  toDisk,
  toRegionalList,
  type CreatedDisk,
  type Disk,
  type RegionalList,
} from "./models.js";
import type { RegionOption } from "./regions.js";
import { parseSize } from "./utils.js";
import type {
  AttachDiskRequest,
  AttachDiskResponse,
  CreateDiskRequest,
  CreateDiskResponse,
  DestroyDiskRequest,
  DestroyDiskResponse,
  DetachDiskRequest,
  DetachDiskResponse,
  ListDisksRequest,
  ListDisksResponse,
} from "./_generated/definitions.js";

/** Persistent disks, attachable to one machine at a time. */
export class Disks {
  constructor(private readonly transport: Transport) {}

  /**
   * Create a disk. `size` takes bytes or a human string (`"10G"`).
   *
   * Always created writable — read-only is an attachment-level choice.
   */
  async create(name: string, size: string | number, opts: RegionOption = {}): Promise<CreatedDisk> {
    const sizeBytes = typeof size === "number" ? size : parseSize(size);
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.createDisk,
      { name, sizeBytes },
      { region: opts.region },
    );
    return toCreatedDisk(resp);
  }

  /**
   * Every disk you own, with its attachments. The list is of one region
   * (`region`, default the client's); its `elsewhere` counts your disks in
   * each other region. `{ region: "all" }` lists every region your org has.
   */
  async list(opts: RegionOption = {}): Promise<RegionalList<Disk>> {
    const region = normalizeRegion(opts.region);
    if (region === ALL_REGIONS) {
      const { pages, unavailable } = await eachRegion(
        this.transport,
        BoxdApiDefinition.methods.listDisks,
        { withElsewhere: false },
      );
      const all = pages.flatMap((p) => (p.resp.disks ?? []).map((d) => toDisk(d, p.region)));
      return toRegionalList(all, [], unavailable);
    }
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listDisks,
      { withElsewhere: true },
      { region },
    );
    return toRegionalList(
      (resp.disks ?? []).map((d) => toDisk(d, region)),
      resp.elsewhere,
    );
  }

  /**
   * A disk lives on one host, so it can be attached to only one machine at a
   * time — attaching an already-attached disk is rejected, read-only or not.
   */
  async attach(
    id: string,
    machine: string,
    mountPath: string,
    params: { readOnly?: boolean } & RegionOption = {},
  ): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.attachDisk,
      { diskId: id, vmId: machine, mountPath, readOnly: params.readOnly ?? false },
      { region: params.region },
    );
  }

  async detach(id: string, machine: string, opts: RegionOption = {}): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.detachDisk,
      { diskId: id, vmId: machine },
      { region: opts.region },
    );
  }

  async delete(id: string, opts: RegionOption = {}): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.destroyDisk,
      { diskId: id },
      { region: opts.region },
    );
  }
}
