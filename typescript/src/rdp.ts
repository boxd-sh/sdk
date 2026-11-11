import type { Transport } from "./_rpc.js";
import type { RegionOption } from "./regions.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toRdpPassword, type RdpPassword } from "./models.js";

/**
 * `resetPassword` may wake the machine (up to 30 s) and then waits up to 70 s
 * for its agent to set the password. A client deadline before that would lose
 * a password the machine already took, so the call gets this much on top of
 * the client's timeout.
 */
const RESET_PASSWORD_EXTRA_MS = 90_000;

/**
 * `boxd.machines.rdp`: a Windows machine's RDP sign-in. The connection details
 * are on the machine (`machine.rdp`, a `MachineRdp`), never with a
 * password. boxd does not store the password: `resetPassword` generates one
 * and this is the only time it is shown. (Named like `AccountNamespace`, since
 * `MachineRdp` is the connection details' type.)
 */
export class MachineRdpNamespace {
  constructor(private readonly transport: Transport) {}

  /**
   * Generate a new password for the Windows machine's Administrator, set it
   * in the machine and return it, once. Any password it had stops working.
   *
   * boxd keeps no copy: a lost password means another reset. The machine
   * must be running (one in standby or hibernated is woken; a stopped one is
   * refused). Can't be called from inside the machine itself.
   *
   * ```ts
   * const { user, password } = await boxd.machines.rdp.resetPassword("win-1");
   * ```
   */
  async resetPassword(id: string, opts: RegionOption = {}): Promise<RdpPassword> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.resetRdpPassword,
      { vmId: id },
      {
        region: opts.region,
        extraTimeoutMs: RESET_PASSWORD_EXTRA_MS,
        // Sent once: the server's own "try again in a minute" reaches the
        // caller rather than another wait of the same length.
        retry: false,
      },
    );
    return toRdpPassword(resp);
  }
}
