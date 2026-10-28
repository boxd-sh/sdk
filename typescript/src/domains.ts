import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toCustomDomain, type CustomDomain } from "./models.js";
import type {
  AddCustomDomainRequest,
  AddCustomDomainResponse,
  ListCustomDomainsRequest,
  ListCustomDomainsResponse,
  RemoveCustomDomainRequest,
  RemoveCustomDomainResponse,
} from "./_generated/definitions.js";

/**
 * Records to point at a machine before calling `create()`. Pure/local — no
 * network call. Mirrors what the CLI and console show inline.
 */
export function dnsInstructions(
  domain: string,
  params: { machineName: string; machineIp: string; zone: string },
): string {
  return `A     ${domain}        ${params.machineIp}\nCNAME *.${domain}      ${params.machineName}.${params.zone}`;
}

/**
 * Custom domains pointed at your machines.
 *
 * Unlike the old (removed) `BindDomain`/`UnbindDomain`/`ListDomains` RPCs,
 * `create` binds the domain and starts verification immediately — call it
 * only once DNS is actually set (an A record at the machine's public IP,
 * and a wildcard CNAME at `<machine>.<zone>`). Checking before the records
 * exist risks a public resolver caching the "no records" answer, delaying
 * propagation once you do set them. A control loop then verifies DNS and
 * issues certs automatically, then flips it `active`.
 */
export class Domains {
  constructor(private readonly transport: Transport) {}

  /** Point `domain` at a machine. DNS must already be set — see class docs. */
  async create(params: { domain: string; machine: string }): Promise<CustomDomain> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.addCustomDomain,
      { domain: params.domain, vmId: params.machine },
    );
    return toCustomDomain(resp.domain!);
  }

  /** List custom domains bound to machines you own. */
  async list(): Promise<CustomDomain[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listCustomDomains,
      {},
    );
    return (resp.domains ?? []).map(toCustomDomain);
  }

  /** Remove a domain binding. */
  async delete(domain: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.removeCustomDomain,
      { domain },
    );
  }
}
