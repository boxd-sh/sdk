import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toCreatedDisk, toDisk, type CreatedDisk, type Disk } from "./models.js";
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
  async create(name: string, size: string | number): Promise<CreatedDisk> {
    const sizeBytes = typeof size === "number" ? size : parseSize(size);
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createDisk,
      { name, sizeBytes },
    );
    return toCreatedDisk(resp);
  }

  async list(): Promise<Disk[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listDisks,
      {},
    );
    return (resp.disks ?? []).map(toDisk);
  }

  /**
   * A disk lives on one host, so it can be attached to only one machine at a
   * time — attaching an already-attached disk is rejected, read-only or not.
   */
  async attach(
    id: string,
    machine: string,
    mountPath: string,
    params: { readOnly?: boolean } = {},
  ): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.attachDisk, {
      diskId: id,
      vmId: machine,
      mountPath,
      readOnly: params.readOnly ?? false,
    });
  }

  async detach(id: string, machine: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.detachDisk, {
      diskId: id,
      vmId: machine,
    });
  }

  async delete(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.destroyDisk, {
      diskId: id,
    });
  }
}
