import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import type { CreateMachineTokenRequest } from "./_generated/definitions.js";
import { toMachineToken, type MachineToken } from "./models.js";

export interface MachineTokenCreateParams {
  /** The machines the token acts on, by name or id: at least one, at most 100, all in one org. */
  machines: string[];
  /** Seconds. Omit or 0 for 1 hour; at most 24 hours. */
  expiresIn?: number;
}

/**
 * Short-lived `bxdm_` tokens fenced to a few machines.
 *
 * Hand one to code you don't fully trust, such as an eval worker or an agent:
 * `new Boxd({ token })` can run commands, move files, drive the machines'
 * lifecycle and change their settings, and nothing else. It cannot delete
 * them, create or fork machines, change networks, egress or secrets, see other
 * machines, or manage the account.
 *
 * The API enforces this. A command the token runs inside a machine has what
 * any process in that machine has: on a machine that is not isolated, that
 * includes the machine's own boxd access, which reaches the rest of the org.
 * For code you don't trust, use isolated machines (`isolated: true` on
 * `machines.create`).
 */
export class MachineTokens {
  constructor(private readonly transport: Transport) {}

  /**
   * Mint a token. It is pinned to the machines' ids, so a rename keeps it.
   * Minted with an API key, it never outlives that key, and deleting the key
   * ends every token minted with it. A command or file transfer still running
   * when the token expires is ended. Mint it in the machines' region (the
   * client's `region`). The token is returned once and never stored.
   */
  async create(params: MachineTokenCreateParams): Promise<MachineToken> {
    const req: CreateMachineTokenRequest = {
      machines: params.machines,
      expiresInSecs: params.expiresIn ?? 0,
    };
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.createMachineToken,
      req,
    );
    return toMachineToken(resp);
  }
}
