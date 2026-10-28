// The `@boxd-sh/sdk/web` entry point: every namespace `index.ts`
// exports, wired to `WebTransport` (grpc-web over `fetch`, every RPC
// including `Exec`/`UploadFileStream` run half-duplex) instead of grpc-js.
// This file — and everything it imports — MUST NOT import
// `@grpc/grpc-js` or `_transport.ts`: that import needs `node:http2`/
// `node:net` and cannot load in a Cloudflare Worker, which is the whole
// reason this entry exists. The same goes for any `node:*` builtin: Node-only
// capabilities come in through `_platform.ts`, which this entry leaves empty.
// `scripts/check_web_entry.mjs` bundles this entry for the browser so a
// future import can't reintroduce either silently.
import type { Platform } from "./_platform.js";
import { WebTransport } from "./_transportWeb.js";
import { BoxdCore, resolveOptions, type BoxdOptions } from "./client.js";

/** Nothing Node-only here: no local files, no automatic in-machine auth. */
const webPlatform: Platform = {};

/**
 * ```ts
 * import { Boxd } from "@boxd-sh/sdk/web";
 * const boxd = new Boxd({ apiKey: "bxd_..." });     // Cloudflare Workers, browsers, ...
 * ```
 *
 * Same namespaces, same options, same errors as the default `@boxd-sh/sdk`
 * entry. Every RPC goes over grpc-web (`fetch`), with `Exec` and
 * `UploadFileStream` run half-duplex, and nothing here uses a Node API. Three
 * things need the default entry and throw here instead: `streamExec()`
 * (grpc-web can't hold a full-duplex connection), `files.upload` with
 * `{ fromPath }` (no local files), and automatic authentication inside a boxd
 * machine. Use this entry instead of the default one anywhere `@grpc/grpc-js`
 * can't load, a Cloudflare Worker most of all.
 */
export class Boxd extends BoxdCore {
  constructor(opts: BoxdOptions = {}) {
    super(new WebTransport(resolveOptions(opts, webPlatform)), webPlatform);
  }
}
export type { BoxdOptions };

// Namespaces — reachable as `boxd.machines`, `boxd.env`, … Exported for typing
// helper functions that take one. Kept in lockstep with `index.ts` by hand;
// `tests/web.test.ts` diffs the two export lists so they can't drift.
export { Machines } from "./machines.js";
export type {
  ExecParams,
  MachineCreateFromImageParams,
  MachineCreateFromSnapshotParams,
  MachineCreateFromSpecParams,
  MachineCreateParams,
  MachineForkParams,
  MachineListParams,
  MachineResizeParams,
  MachineUpdateLabelsParams,
  MachineUpdateSpecOptions,
  StreamExecParams,
  WaitUntilReadyParams,
} from "./machines.js";
// Machine specs: `Machine.spec()`, its pieces and the merge rules. `Machine`
// is also the machine model's type, so it is exported from here only.
export {
  MACHINE_SPEC_VERSION,
  Machine,
  MachineSpecBuilder,
  asana,
  claude,
  codex,
  github,
  jira,
  mergeSpecs,
  secrets,
  slack,
  snapshot,
  specPatch,
  team,
} from "./spec.js";
export type {
  ConnectionPieceOptions,
  MachineSize,
  MachineSpec,
  MachineSpecAgent,
  MachineSpecBase,
  MachineSpecConnection,
  MachineSpecPatch,
  MachineSpecPiece,
} from "./spec.js";
export { MachineFiles } from "./files.js";
export type { UploadSource } from "./files.js";
export { MachineFs } from "./fs.js";
export type {
  FsMkdirOptions,
  FsPath,
  FsReadOptions,
  FsRemoveOptions,
  FsRenameOptions,
  FsWriteData,
  FsWriteOptions,
} from "./fs.js";
export { MachinePorts } from "./ports.js";
export { MachineProxies } from "./proxies.js";
export { MachineCheckpoints } from "./checkpoints.js";
export { MachineBackups } from "./backups.js";
export { Snapshots } from "./snapshots.js";
export { Disks } from "./disks.js";
export { EnvVars, Secrets } from "./vars.js";
export type { VarMoveParams, VarParams } from "./vars.js";
export { Domains } from "./domains.js";
export { Orgs } from "./orgs.js";
export type {
  OrgBillingActivityParams,
  OrgIdleIgnoreOutboundDefaultParams,
  OrgMachineDefaultsParams,
  OrgMachineLimitRequestParams,
  OrgUsageParams,
} from "./orgs.js";
export type { TimeBound } from "./utils.js";
export { Teams } from "./teams.js";
export { ApiKeys } from "./apiKeys.js";
export type { ApiKeyCreateParams } from "./apiKeys.js";
export { AccountNamespace } from "./account.js";
export type { LinkSshKeyParams } from "./account.js";

// Streaming
export { AsyncByteQueue, ExecStream } from "./exec.js";

// Models
export { MACHINE_STATUSES, isKnownMachineStatus } from "./models.js";
export type {
  Account,
  ApiKey,
  ArtifactStatus,
  Backup,
  BackupSchedule,
  BackupStatus,
  Billing,
  Checkpoint,
  ClusterConfig,
  CreatedApiKey,
  CreatedCheckpoint,
  CreatedDisk,
  CreatedOrg,
  CreatedProxy,
  CreatedSnapshot,
  CustomDomain,
  DirEntry,
  DirListing,
  Disk,
  DiskAttachment,
  DiskStatus,
  EnvVar,
  ExecBytesResult,
  ExecResult,
  ExposedPort,
  FsEntry,
  FsEntryType,
  BillingActivityEntry,
  BillingActivityPage,
  MachineAccess,
  MachineConfig,
  MachineIdle,
  MachinePackage,
  MachineSpecApply,
  MachineSpecChange,
  MachineSpecUpdate,
  MachineRequirement,
  MachineResources,
  MachineSource,
  MachineSourceKind,
  MachineStatus,
  MachineUsage,
  MachineUsageReport,
  MachineLimitRequest,
  Org,
  OrgBotProtectionDefault,
  OrgBotProtectionDefaultResult,
  OrgDomain,
  OrgIdleIgnoreOutboundDefault,
  OrgIdleIgnoreOutboundDefaultResult,
  OrgInvite,
  OrgMachineDefaults,
  OrgMachineLimit,
  OrgMember,
  OrgMembers,
  OrgRef,
  OrgRole,
  OrgUsage,
  PortProtocol,
  Proxy,
  ProxyPortMode,
  ResizeResult,
  SelfDeleteResult,
  Secret,
  Snapshot,
  StateSeconds,
  Team,
  TeamMember,
  UsagePeriod,
  UsageRates,
  VarScope,
} from "./models.js";

export {
  APIConnectionError,
  APIStatusError,
  AgentOutdatedError,
  AuthenticationError,
  BoxdError,
  ConflictError,
  FilesystemError,
  MachineFileExistsError,
  MachineFileNotFoundError,
  MachineIsADirectoryError,
  MachineNotADirectoryError,
  MachinePermissionError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "./errors.js";
export type {
  AuthenticationErrorReason,
  BoxdErrorOptions,
  FilesystemErrorReason,
} from "./errors.js";

export { VERSION } from "./_version.js";
