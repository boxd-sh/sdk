/**
 * Stub-freshness guard (offline — no server needed).
 *
 * CI never regenerates the checked-in stubs, so an api.proto change without
 * `scripts/compile_proto.sh` ships a wire layer that still carries removed
 * RPCs. These assertions fail loudly when that happens.
 */
import { describe, expect, it } from "bun:test";
import * as gen from "../src/_generated/api.js";
import * as defs from "../src/_generated/definitions.js";

const clientProto = (gen.BoxdApiClient as unknown as { prototype: Record<string, unknown> })
  .prototype;

describe("generated stubs are current", () => {
  it("carries no retired shape/template types", () => {
    for (const t of [
      "ChangeShapeRequest",
      "ChangeShapeResponse",
      "CreateTemplateRequest",
      "ListTemplatesRequest",
      "CreateVmFromTemplateRequest",
      "BindDomainRequest",
      "UnbindDomainRequest",
      "ListDomainsRequest",
      "DomainInfo",
    ]) {
      expect(t in gen).toBe(false);
    }
  });

  it("carries no retired client methods", () => {
    for (const m of [
      "changeShape",
      "createTemplate",
      "listTemplates",
      "deleteTemplate",
      "createVmFromTemplate",
      "bindDomain",
      "unbindDomain",
      "listDomains",
    ]) {
      expect(clientProto[m]).toBeUndefined();
    }
  });

  it("still carries every RPC the SDK calls", () => {
    for (const m of [
      "createVm",
      "createVmFromSnapshot",
      "getVm",
      "listVms",
      "destroyVm",
      "renameVm",
      "forkVm",
      "shareVm",
      "unshareVm",
      "suspendVm",
      "resumeVm",
      "hibernateVm",
      "wakeVm",
      "setAutoSuspendTimeout",
      "setAutoHibernateTimeout",
      "setIdleIgnoreOutbound",
      "setSsh",
      "setDeleteAfter",
      "suggestVmName",
      "exec",
      "streamLogs",
      "uploadFile",
      "uploadFileStream",
      "downloadFile",
      "exposePort",
      "unexposePort",
      "listExposedPorts",
      "createProxy",
      "listProxies",
      "deleteProxy",
      "setProxyPort",
      "createCheckpoint",
      "listCheckpoints",
      "deleteCheckpoint",
      "restoreCheckpoint",
      "createSnapshot",
      "getSnapshot",
      "listSnapshots",
      "deleteSnapshot",
      "createDisk",
      "listDisks",
      "attachDisk",
      "detachDisk",
      "destroyDisk",
      "setVar",
      "listVars",
      "removeVar",
      "setSecretScope",
      "setVmEgressAllow",
      "updateVmLabels",
      "addCustomDomain",
      "listCustomDomains",
      "removeCustomDomain",
      "setOrgDomain",
      "getOrgDomain",
      "clearOrgDomain",
      "setOrgIdleIgnoreOutboundDefault",
      "getOrgIdleIgnoreOutboundDefault",
      "createNetwork",
      "listNetworks",
      "listOrgs",
      "getOrgBilling",
      "createApiKey",
      "listApiKeys",
      "deleteApiKey",
      "createToken",
      "listTokens",
      "revokeToken",
      "listPlans",
      "getBilling",
      "createCheckoutSession",
      "createBillingPortalSession",
      "whoami",
      "linkSshKey",
      "getConfig",
    ]) {
      expect(typeof clientProto[m]).toBe("function");
    }
  });

  it("VmConfig.idleIgnoreOutbound is optional in both flavors", () => {
    // Older stubs dropped an explicit false and defaulted an
    // unset field to false; the server now tells the two apart.
    for (const VmConfig of [gen.VmConfig, defs.VmConfig]) {
      const roundTrip = (v: boolean | undefined) =>
        VmConfig.decode(VmConfig.encode(VmConfig.fromPartial({ idleIgnoreOutbound: v })).finish())
          .idleIgnoreOutbound;
      expect(VmConfig.fromPartial({}).idleIgnoreOutbound).toBeUndefined();
      expect(roundTrip(undefined)).toBeUndefined();
      expect(roundTrip(false)).toBe(false);
      expect(roundTrip(true)).toBe(true);
    }
  });

  it("NetworkConfig.ssh is optional in both flavors", () => {
    // Older stubs dropped an explicit false, so `ssh: false` never reached
    // the server; unset now means "not requested".
    for (const NetworkConfig of [gen.NetworkConfig, defs.NetworkConfig]) {
      const roundTrip = (v: boolean | undefined) =>
        NetworkConfig.decode(NetworkConfig.encode(NetworkConfig.fromPartial({ ssh: v })).finish())
          .ssh;
      expect(NetworkConfig.fromPartial({}).ssh).toBeUndefined();
      expect(roundTrip(undefined)).toBeUndefined();
      expect(roundTrip(false)).toBe(false);
      expect(roundTrip(true)).toBe(true);
    }
  });

  it("message defaults carry no removed fields", () => {
    for (const obj of [
      gen.BillingInfo.fromPartial({}),
      gen.PlanInfo.fromPartial({}),
      gen.OrgBilledVm.fromPartial({}),
      gen.CreateCheckoutSessionRequest.fromPartial({}),
    ]) {
      expect(Object.keys(obj)).not.toContain("shape");
      expect(Object.keys(obj)).not.toContain("tier");
    }
  });
});
