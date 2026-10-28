import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import {
  toEnvVar,
  toSecret,
  type EnvVar,
  type Secret,
  type VarScope,
} from "./models.js";
import type {
  ListVarsRequest,
  RemoveVarRequest,
  SetSecretScopeRequest,
  SetVarRequest,
  VarItem,
  VarListReply,
  VarReply,
} from "./_generated/definitions.js";

/**
 * Scope decides which machines a value reaches:
 *
 * | Scope | Applies to |
 * |---|---|
 * | `private` | only your own machines in that org |
 * | `shared`  | the org's shared machines |
 * | `all`     | every machine in the org |
 * | `unattached` | secrets only: just the machines whose spec lists it in `secrets` (the org's with `org`, else your own) |
 * | `private-unattached` | secrets only: your own unattached secret in the org named by `org` |
 */
export interface VarParams {
  /**
   * Default `"shared"`. Ignored for personal (non-org) scope, except
   * `"unattached"`: your own unattached secret.
   */
  scope?: VarScope;
  /**
   * Org name. Empty = personal: your own private vars. With an API key
   * minted in an organization those live in that organization (the key
   * never reaches another one), so a key-authenticated client needs `org`
   * only to address the organization's own `shared`/`all` vars.
   */
  org?: string;
}

/** {@link Secrets.set} options: {@link VarParams} plus host binding. */
export interface SecretSetParams extends VarParams {
  /**
   * Bind the secret to the hosts it may be sent to (`api.example.com` or
   * `*.example.com`). The machine then only ever holds an opaque `bxds_…`
   * placeholder; the real value is substituted into HTTPS requests to
   * exactly these hosts on the way out (the URL, headers and body; never over
   * plain HTTP), is scrubbed back to the placeholder in their responses, and
   * never lands inside the machine.
   * The placeholder is stable across value rotations. This is the full
   * desired set: omit it to make (or keep) the secret a plain one.
   */
  domains?: string[];
}

export interface VarMoveParams {
  /**
   * Required: the same name can exist in several scopes at once, so only
   * `from` says which one is moving.
   */
  from: VarScope;
  to: VarScope;
  org?: string;
}

/**
 * Shared implementation of the two namespaces. `EnvVars` and `Secrets` differ
 * only in what they store and what they hand back.
 */
abstract class VarNamespace<T> {
  protected abstract readonly kind: "env" | "secret";
  protected abstract readonly map: (v: VarItem) => T;

  constructor(protected readonly transport: Transport) {}

  /** Create or update. Returns the server's human-readable confirmation. */
  async set(name: string, value: string, params: VarParams = {}): Promise<string> {
    const req: SetVarRequest = {
      org: params.org ?? "",
      kind: this.kind,
      name,
      value,
      scope: params.scope ?? "",
      domains: this.kind === "secret" ? ((params as SecretSetParams).domains ?? []) : [],
    };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setVar, req);
    return resp.message;
  }

  async list(params: { org?: string } = {}): Promise<T[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listVars, {
      org: params.org ?? "",
      kind: this.kind,
    });
    return (resp.vars ?? []).map((v) => this.map(v));
  }

  async delete(name: string, params: VarParams = {}): Promise<string> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.removeVar, {
      org: params.org ?? "",
      kind: this.kind,
      name,
      scope: params.scope ?? "",
    });
    return resp.message;
  }

  /**
   * Move a value from one scope to another. It is a move between two
   * addresses, not a field update — so calling it twice fails the second time.
   *
   * Env vars and secrets share one name space per scope, so an existing env
   * var can block a secret moving into that scope, and vice versa.
   */
  async move(name: string, params: VarMoveParams): Promise<string> {
    const req: SetSecretScopeRequest = {
      org: params.org ?? "",
      name,
      from: params.from,
      to: params.to,
    };
    const resp = await this.transport.unary(BoxdApiDefinition.methods.setSecretScope,
      req,
    );
    return resp.message;
  }
}

/** Environment variables injected into your machines. Values are readable. */
export class EnvVars extends VarNamespace<EnvVar> {
  protected readonly kind = "env" as const;
  protected map = toEnvVar;
}

/**
 * Secrets. Write-only values: a {@link Secret} has a name and a scope, and no
 * `value` — secret values never leave the server once set.
 */
export class Secrets extends VarNamespace<Secret> {
  protected readonly kind = "secret" as const;
  protected map = toSecret;

  /**
   * Create or update a secret. Pass {@link SecretSetParams.domains} to bind
   * it to hosts. Returns the server's human-readable confirmation.
   */
  override async set(name: string, value: string, params: SecretSetParams = {}): Promise<string> {
    return super.set(name, value, params);
  }
}
