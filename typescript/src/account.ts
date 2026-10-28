import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toAccount, type Account, type ClusterConfig } from "./models.js";
import type {
  GetConfigRequest,
  GetConfigResponse,
  LinkSshKeyRequest,
  LinkSshKeyResponse,
  WhoamiRequest,
  WhoamiResponse,
} from "./_generated/definitions.js";

export interface LinkSshKeyParams {
  /** The verbatim contents of a `.pub` file. Any trailing comment is ignored. */
  pubkey: string;
  /**
   * Optional device this key belongs to. When set, one key is kept per device:
   * re-linking from the same device replaces its previous key instead of
   * accumulating stale ones.
   */
  deviceId?: string;
  /** Optional human label for the device, for display. */
  label?: string;
}

/** Who you are, and the cluster defaults you are talking to. */
export class AccountNamespace {
  constructor(private readonly transport: Transport) {}

  async get(): Promise<Account> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.whoami, {});
    return toAccount(resp);
  }

  /**
   * Attach an SSH public key so `ssh <machine>.<zone>` authenticates with it.
   * Idempotent for the caller.
   */
  async linkSshKey(params: LinkSshKeyParams): Promise<void> {
    const req: LinkSshKeyRequest = {
      pubkey: params.pubkey,
      deviceId: params.deviceId ?? "",
      label: params.label ?? "",
    };
    await this.transport.unary(BoxdApiDefinition.methods.linkSshKey, req);
  }

  /** Cluster defaults: the default image and the DNS zone machines live under. */
  async config(): Promise<ClusterConfig> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getConfig,
      {},
    );
    return { defaultImage: resp.defaultImage, zone: resp.zone };
  }
}
