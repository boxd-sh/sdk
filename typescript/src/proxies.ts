import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toCreatedProxy, toProxy, type CreatedProxy, type Proxy } from "./models.js";
import type {
  CreateProxyRequest,
  CreateProxyResponse,
  DeleteProxyRequest,
  DeleteProxyResponse,
  ListProxiesRequest,
  ListProxiesResponse,
  SetProxyPortRequest,
  SetProxyPortResponse,
} from "./_generated/definitions.js";

/**
 * HTTPS routes into a machine: `<name>.<machine>.<zone>` (or
 * `<machine>.<zone>` for the default one).
 *
 * The `machine` argument takes an id or a name, like everything else on
 * `machines`. A listed route echoes its `machineId` back.
 */
export class MachineProxies {
  constructor(private readonly transport: Transport) {}

  /**
   * Add the route `<name>.<machine>.<zone>` and point it at `port` inside the
   * machine.
   *
   * `name` is a subdomain label: lowercase letters, digits and hyphens, not
   * starting or ending with one. It cannot be empty — every machine already
   * has its default route, and this call only ever adds a named one beside it.
   */
  async create(machine: string, name: string, port: number): Promise<CreatedProxy> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createProxy,
      { name, vm: machine, vmName: "", port },
    );
    return toCreatedProxy(resp);
  }

  async list(machine: string): Promise<Proxy[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listProxies,
      { vm: machine, vmName: "" },
    );
    return (resp.proxies ?? []).map(toProxy);
  }

  async delete(machine: string, name: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteProxy, {
      name,
      vm: machine,
      vmName: "",
    });
  }

  /**
   * Point a route at a different port, or pass `"auto"` to have the port
   * discovered inside the machine instead.
   *
   * `"auto"` re-detects for as long as the route stays in auto mode — not
   * just once at boot — by watching the guest's own `listen()` calls, so it
   * follows the app if its listener moves to a different port later (e.g. a
   * restart that binds a new port). Right after boot, a higher-priority
   * well-known port (say `:80` over `:3000`) wins outright so two services
   * racing to come up don't flap the route. After that, a candidate new
   * port has to hold steady — the most recently observed well-known port,
   * with no other well-known port contending — for a short quiet period
   * before the route switches to it, so multiple services racing or a
   * crash-looping app flapping between ports won't churn the route — but a
   * real listener move is still picked up within a few seconds. Passing a
   * concrete port switches the route out of auto mode and stops this
   * re-detection.
   *
   * Omit `name` to address the machine's default route. `"auto"` is only
   * available there — a named route must be pinned to a port.
   */
  async setPort(
    machine: string,
    port: number | "auto",
    params: { name?: string } = {},
  ): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setProxyPort,
      { name: params.name ?? "", vm: machine, vmName: "", port: String(port) },
    );
  }
}
