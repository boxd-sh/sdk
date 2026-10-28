import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import {
  toCheckpoint,
  toCreatedCheckpoint,
  type Checkpoint,
  type CreatedCheckpoint,
} from "./models.js";
import type {
  CreateCheckpointRequest,
  CreateCheckpointResponse,
  DeleteCheckpointRequest,
  DeleteCheckpointResponse,
  ListCheckpointsRequest,
  ListCheckpointsResponse,
  RestoreCheckpointRequest,
  RestoreCheckpointResponse,
} from "./_generated/definitions.js";

/**
 * Full captures of a single machine (state + memory + disk) that restore in
 * place. Unlike a snapshot they are not replicated and never become an
 * account-level image — they live and die with the machine.
 */
export class MachineCheckpoints {
  constructor(private readonly transport: Transport) {}

  /** The machine must be running. `status` is `"pending"` until the artifact lands. */
  async create(id: string, name: string): Promise<CreatedCheckpoint> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createCheckpoint,
      { vm: id, name },
    );
    return toCreatedCheckpoint(resp);
  }

  async list(id: string): Promise<Checkpoint[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listCheckpoints,
      { vm: id },
    );
    return (resp.checkpoints ?? []).map(toCheckpoint);
  }

  async delete(id: string, name: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteCheckpoint,
      { vm: id, name },
    );
  }

  /**
   * Restore in place. The checkpoint must be `"ready"` (poll `status`, not
   * `available`, if you want the wait loop to be self-explanatory — they
   * agree, but `status` is the field this checks).
   */
  async restore(id: string, name: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.restoreCheckpoint,
      { vm: id, name },
    );
  }
}
