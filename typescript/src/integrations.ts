/**
 * `boxd.integrations` — what your machines are signed in to.
 *
 * Today: the coding agents' sign-ins, `"claude"` (Claude Code;
 * `"claude-code"` works too) and `"codex"`. A sign-in is yours, kept in one
 * organization: every private machine of yours there uses it, and the
 * platform keeps it fresh. It is the same sign-in as Integrations in the
 * console and `boxd manage integrations connect` on the command line.
 *
 * ```ts
 * const start = await boxd.integrations.connect("codex");
 * console.log(`Open ${start.url} and enter ${start.userCode}`);
 * const login = await boxd.integrations.wait("codex", start);
 *
 * const claude = await boxd.integrations.connect("claude");
 * console.log(`Open ${claude.url}, approve, and paste the code it shows you`);
 * await boxd.integrations.complete("claude", { code });
 * ```
 *
 * `org` (a name or id) picks the organization. Without it: your default
 * organization, or the one your API key is for. A sign-in belongs to a
 * person, so an organization API key can't make or read one. A shared or
 * isolated machine never gets anyone's sign-in: give it an API key as a
 * secret instead.
 */

import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import {
  type AgentLogin,
  type AgentLoginResult,
  type AgentLoginStart,
  toAgentLogin,
  toAgentLoginResult,
  toAgentLoginStart,
  waitForDeviceLogin,
} from "./agents.js";

/** The organization a sign-in is kept in. */
export interface IntegrationOrgOption {
  /** A name or id. Default: your default organization, or the one your API
   *  key is for. */
  org?: string;
}

/** Your sign-ins to the coding agents: `"claude"` and `"codex"`. */
export class Integrations {
  constructor(private readonly transport: Transport) {}

  /**
   * Start signing `name` in (`"claude"` or `"codex"`): where to go. Claude
   * Code (`paste_code`): open `url`, approve, and pass the code the page then
   * shows you to `complete()`. Codex (`device_code`): open `url`, enter
   * `userCode`, and `wait()`.
   */
  async connect(name: string, opts: IntegrationOrgOption = {}): Promise<AgentLoginStart> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.startAgentLogin, {
      vmId: "",
      harness: name,
      org: opts.org ?? "",
    });
    return toAgentLoginStart(resp);
  }

  /**
   * Finish a sign-in `connect()` began, in one call. Claude Code: `code` is
   * the code the page showed you after you approved, and you're signed in.
   * Codex: `handle` is the start's, and the result is `pending` until you've
   * approved; `wait()` asks again for you.
   */
  async complete(
    name: string,
    params: {
      /** `paste_code`: the code the page showed you after you approved. */
      code?: string;
      /** `device_code`: the start's `handle`. */
      handle?: string;
    } & IntegrationOrgOption,
  ): Promise<AgentLoginResult> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.completeAgentLogin, {
      vmId: "",
      harness: name,
      org: params.org ?? "",
      code: params.code ?? "",
      handle: params.handle ?? "",
    });
    return toAgentLoginResult(resp);
  }

  /**
   * Wait until you've approved a Codex (`device_code`) sign-in: asks with the
   * start's `handle` every `intervalSecs` until it's no longer pending, and
   * resolves to the login. It gives up with an error once the code expires
   * (`expiresAt`), or after `timeout` milliseconds when that comes first. A
   * Claude Code (`paste_code`) sign-in can't be waited on: pass the code its
   * page shows you to `complete()`.
   */
  async wait(
    name: string,
    start: AgentLoginStart,
    opts: {
      /** Milliseconds. Default: until the code expires. */
      timeout?: number;
    } & IntegrationOrgOption = {},
  ): Promise<AgentLogin> {
    return waitForDeviceLogin(
      name,
      start,
      opts.timeout,
      (handle) => this.complete(name, { handle, org: opts.org }),
      { startCall: "connect()", completeCall: "complete()", waitCall: "wait()" },
    );
  }

  /** Whether you're signed in to `name`, and as whom. */
  async get(name: string, opts: IntegrationOrgOption = {}): Promise<AgentLogin> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getAgentLogin, {
      vmId: "",
      harness: name,
      org: opts.org ?? "",
    });
    return toAgentLogin(resp);
  }

  /** Forget your sign-in to `name`: your private machines in the
   *  organization stop getting it. It isn't revoked at Anthropic or OpenAI;
   *  do that from your account there. */
  async disconnect(name: string, opts: IntegrationOrgOption = {}): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteAgentLogin, {
      vmId: "",
      harness: name,
      org: opts.org ?? "",
    });
  }
}
