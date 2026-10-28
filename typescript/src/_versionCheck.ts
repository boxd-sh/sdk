import { VERSION } from "./_version.js";

/**
 * Request/response header names, deliberately transport-agnostic: gRPC
 * metadata and an HTTP header are the same bytes on the wire either way (gRPC
 * metadata IS HTTP/2 headers), so both the Node transport (grpc-js
 * `Metadata`) and the web transport (`fetch`'s `Headers`) read and
 * write these under the same two names.
 */
export const VERSION_REQUEST_HEADER = "x-boxd-ts-sdk-version";
export const VERSION_RESPONSE_HEADER = "x-boxd-ts-sdk-latest";
const UPGRADE_CMD = "npm install @boxd-sh/sdk@latest";
const PRERELEASE_UPGRADE_CMD = "npm install @boxd-sh/sdk@next";

let notified = false;

/**
 * `maybeNotifyUpdate` takes the response header's value directly (not a
 * metadata/headers container) so it works the same way for both transports —
 * the Node transport reads `md.get(VERSION_RESPONSE_HEADER)[0]`, the web
 * transport reads `resp.headers.get(VERSION_RESPONSE_HEADER)`.
 */
export function maybeNotifyUpdate(latestHeaderValue: string | string[] | undefined): void {
  if (notified) return;
  // A nag is a message to a person at a terminal. Anywhere else — a CI step,
  // an automation job whose stderr is its log file — it is noise in a log
  // someone reads later to find out what went wrong, printed on every single
  // run. Nothing is lost by staying quiet: the version is not a problem to be
  // acted on by a program.
  // An explicit opt-out beats every heuristic below: set BOXD_NO_UPDATE_NOTICE
  // to any non-empty value and this is never printed.
  if (typeof process !== "undefined" && process.env?.BOXD_NO_UPDATE_NOTICE) return;
  if (typeof process === "undefined" || !process.stderr?.isTTY) return;
  const first = Array.isArray(latestHeaderValue) ? latestHeaderValue[0] : latestHeaderValue;
  if (!first) return;
  const latest = String(first).trim();
  if (!latest) return;

  if (compareSemver(latest, VERSION) <= 0) return;
  // A prerelease is opt-in: `@next`, never `@latest`. Telling someone on a
  // release build to "update" to one is wrong twice over — they did not ask
  // for the dev channel, and the command we would print cannot install it, so
  // the nag would repeat forever. Staging advertises its own prereleases, so
  // this is the normal case there, not an edge.
  const latestIsPre = isPrerelease(latest);
  if (latestIsPre && !isPrerelease(VERSION)) return;

  notified = true;
  console.warn("");
  console.warn(`  A new version of @boxd-sh/sdk is available (v${latest}, you have v${VERSION}). Update with:`);
  console.warn(`    ${latestIsPre ? PRERELEASE_UPGRADE_CMD : UPGRADE_CMD}`);
}

/** Does this version carry a prerelease suffix ("0.2.6-dev.356", "0.2.6.dev356")? */
export function isPrerelease(v: string): boolean {
  return parseSemver(v)?.suffix !== "" && parseSemver(v) !== null;
}

// Returns >0 if a > b, <0 if a < b, 0 if equal. Handles SemVer "-dev.6"
// and PEP 440 ".dev6" prerelease suffixes by component-wise compare,
// numeric where both components are all-digits (so dev.10 > dev.9, not
// the lex order which says otherwise). Unparseable input returns 0 —
// treat as equal so we never nag on garbage.
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Numeric parts equal: a release (no suffix) ranks above any prerelease.
  if (pa.suffix === "" && pb.suffix !== "") return 1;
  if (pa.suffix !== "" && pb.suffix === "") return -1;
  return compareSuffix(pa.suffix, pb.suffix);
}

function compareSuffix(a: string, b: string): number {
  if (a === b) return 0;
  const partsA = parseSuffixComponents(a);
  const partsB = parseSuffixComponents(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1; // shorter prerelease ranks lower
    if (pb === undefined) return 1;
    const na = /^\d+$/.test(pa) ? Number(pa) : null;
    const nb = /^\d+$/.test(pb) ? Number(pb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null) {
      return -1; // numeric < alphanumeric (SemVer §11.4.3)
    } else if (nb !== null) {
      return 1;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

// Split a prerelease suffix into components. Handles both "-dev.6"
// (SemVer) and ".dev6" (PEP 440 packed) by stripping the leading
// separator, splitting on "." and "-", and further breaking each piece
// at letter↔digit boundaries so "dev6" → ["dev", "6"].
function parseSuffixComponents(s: string): string[] {
  if (!s) return [];
  const stripped = s.replace(/^[-.]/, "");
  if (!stripped) return [];
  return stripped
    .split(/[.-]/)
    .flatMap((p) => p.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/))
    .filter(Boolean);
}

function parseSemver(v: string): { major: number; minor: number; patch: number; suffix: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    suffix: m[4] ?? "",
  };
}
