import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toExposedPort, type ExposedPort, type PortProtocol } from "./models.js";
import type {
  ExposePortRequest,
  ExposePortResponse,
  ListExposedPortsRequest,
  ListExposedPortsResponse,
  UnexposePortRequest,
  UnexposePortResponse,
} from "./_generated/definitions.js";

/**
 * Raw TCP/UDP port forwards on the proxy's public IP. Max 3 per machine.
 * (HTTP(S) routing is `machines.proxies` — different mechanism, different
 * namespace.)
 */
export class MachinePorts {
  constructor(private readonly transport: Transport) {}

  /**
   * Allocate a public port for `port` inside the machine. Re-exposing the same
   * machine port keeps its public port and just updates the protocol set;
   * `"both"` shares one allocated port across TCP and UDP.
   */
  async expose(
    id: string,
    port: number,
    params: { protocol?: PortProtocol } = {},
  ): Promise<ExposedPort> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.exposePort,
      { vm: id, vmId: "", vmPort: port, protocol: params.protocol ?? "tcp" },
    );
    return toExposedPort(resp);
  }

  /** Remove the forward and free its public port. Echoes back what was removed. */
  async unexpose(id: string, port: number): Promise<ExposedPort> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.unexposePort,
      { vm: id, vmId: "", vmPort: port },
    );
    return toExposedPort(resp.forward!);
  }

  /**
   * Forwards for one machine, or — with no argument — every forward you own
   * across the account.
   */
  async list(id?: string): Promise<ExposedPort[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listExposedPorts,
      { vm: id ?? "" },
    );
    return (resp.forwards ?? []).map(toExposedPort);
  }
}
