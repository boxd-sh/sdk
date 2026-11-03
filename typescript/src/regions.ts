import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toRegion, type Region } from "./models.js";

/** What every call on a machine, snapshot or disk takes besides its own options. */
export interface RegionOption {
  /**
   * The region the call goes to (`"fra"`, `"nyc"`, ...). Default: the
   * client's (`new Boxd({ region })`, `BOXD_REGION`), else the region
   * `baseURL` serves.
   */
  region?: string;
}

/**
 * The regions boxd runs in.
 *
 * Each region has its own API endpoint, and a machine, snapshot or disk
 * lives in one of them. Pass a region's `id` as `region` to the client or to
 * a call. An org can use its home region and the regions enabled for it;
 * `orgState` says which (`orgs.requestRegion` asks for another).
 */
export class Regions {
  constructor(private readonly transport: Transport) {}

  /** Every region, and where `org` stands with each (default: your default
   *  org, or an API key's org). */
  async list(params: { org?: string } = {}): Promise<Region[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listRegions, {
      orgId: params.org ?? "",
    });
    return (resp.regions ?? []).map(toRegion);
  }
}
