import { nodePlatform } from "./_platformNode.js";
import { Transport } from "./_transport.js";
import { BoxdCore, resolveOptions, type BoxdOptions } from "./client.js";

/**
 * ```ts
 * const boxd = new Boxd();                                   // production
 * const boxd = new Boxd({ baseURL: "https://boxd.example.com:9443" });
 * const boxd = new Boxd({ apiKey: "bxd_..." });
 * ```
 *
 * Node/Bun/Deno only — this entry statically imports `@grpc/grpc-js`, which
 * needs `node:http2`/`node:net` and cannot load in a Cloudflare Worker. From
 * a Worker (or anywhere else without those), `import { Boxd } from
 * "@boxd-sh/sdk/web"` instead — same namespaces, same options, grpc-web
 * over `fetch` instead of grpc-js.
 */
export class Boxd extends BoxdCore {
  constructor(opts: BoxdOptions = {}) {
    super(new Transport(resolveOptions(opts, nodePlatform)), nodePlatform);
  }
}
export type { BoxdOptions };

// Namespaces — reachable as `boxd.machines`, `boxd.env`, … Exported for typing
// helper functions that take one.
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
export type { SecretSetParams, VarMoveParams, VarParams } from "./vars.js";
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
  BotProtectionMode,
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

// `src/_version.ts` is generated from package.json's `version` at build time
// (`scripts/gen_version.mjs`, run by `bun run build`/`prepublishOnly`) so it
// always matches the published version without a runtime `package.json`
// read — the web entry (`web.ts`) needs that: `createRequire` +
// filesystem access don't exist in a Cloudflare Worker.
export { VERSION } from "./_version.js";
