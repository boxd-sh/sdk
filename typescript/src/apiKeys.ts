import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toApiKey, toCreatedApiKey, type ApiKey, type CreatedApiKey } from "./models.js";
import type {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  DeleteApiKeyRequest,
  DeleteApiKeyResponse,
  ListApiKeysRequest,
  ListApiKeysResponse,
} from "./_generated/definitions.js";

export interface ApiKeyCreateParams {
  name: string;
  /** Seconds. Omit or 0 for no expiry. */
  expiresIn?: number;
  /** Org (by name) the key is fenced to. `""` = your own org. */
  org?: string;
  /**
   * `"member"` (default) acts as you within the org. `"org"` is a userless
   * service credential limited to the org's shared fleet — requires org admin.
   */
  kind?: "member" | "org";
}

/**
 * `bxd_` keys. Every key is fenced to exactly one org — a key never grants
 * account-wide access — and the row is re-read on every request, so deleting
 * one takes effect immediately.
 */
export class ApiKeys {
  constructor(private readonly transport: Transport) {}

  /** The raw key is returned once and never stored. Save it now. */
  async create(params: ApiKeyCreateParams): Promise<CreatedApiKey> {
    const req: CreateApiKeyRequest = {
      name: params.name,
      expiresInSecs: params.expiresIn ?? 0,
      org: params.org ?? "",
      kind: params.kind ?? "",
    };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createApiKey,
      req,
    );
    return toCreatedApiKey(resp);
  }

  /**
   * The keys you made, and in each org you administer the org's `"org"` keys
   * other people made: those keep working after their maker leaves, so the
   * org's admins can see and delete them (`mine` tells them apart).
   */
  async list(): Promise<ApiKey[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listApiKeys,
      {},
    );
    return (resp.keys ?? []).map(toApiKey);
  }

  /** Revoke a key you made, or an `"org"` key of an org you administer. */
  async delete(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteApiKey,
      { id },
    );
  }
}
