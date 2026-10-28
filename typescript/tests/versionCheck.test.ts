import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { compareSemver, maybeNotifyUpdate, isPrerelease } from "../src/_versionCheck.js";
import { VERSION } from "../src/index.js";

// Picked to be unambiguously newer/older than any real shipped SDK so tests
// don't silently flip meaning when the package version bumps.
const NEWER = "99.0.0";
const OLDER = "0.0.1";

describe("compareSemver", () => {
  it("patch greater", () => expect(compareSemver("0.1.1", "0.1.0")).toBeGreaterThan(0));
  it("patch lesser", () => expect(compareSemver("0.1.0", "0.1.1")).toBeLessThan(0));
  it("equal", () => expect(compareSemver("0.1.0", "0.1.0")).toBe(0));
  it("major dominates minor", () => expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0));
  it("minor dominates patch", () => expect(compareSemver("0.2.0", "0.1.99")).toBeGreaterThan(0));
  it("release > prerelease", () => {
    expect(compareSemver("0.1.1", "0.1.1-dev.4")).toBeGreaterThan(0);
    expect(compareSemver("0.1.1-dev.4", "0.1.1")).toBeLessThan(0);
  });
  it("prerelease lex order", () => {
    expect(compareSemver("0.1.1-dev.4", "0.1.1-dev.5")).toBeLessThan(0);
    expect(compareSemver("0.1.1-dev.5", "0.1.1-dev.4")).toBeGreaterThan(0);
  });
  it("unparseable → 0", () => {
    expect(compareSemver("garbage", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "garbage")).toBe(0);
    expect(compareSemver("v1.0.0", "0.1.0")).toBe(0);
    expect(compareSemver("", "0.1.0")).toBe(0);
  });
  it("whitespace tolerated", () => expect(compareSemver("  0.1.1  ", "0.1.0")).toBeGreaterThan(0));
});

describe("isPrerelease", () => {
  it.each([
    ["0.2.6-dev.356", true],
    ["0.2.6.dev356", true],
    ["1.0.0-rc.1", true],
    ["0.2.6", false],
    ["garbage", false],
  ])("%s -> %s", (v, expected) => {
    expect(isPrerelease(String(v))).toBe(expected);
  });
});

// `notified` is module-level state that latches false→true once and never
// resets in production. Tests below run in declaration order and walk that
// lifecycle: silent cases first, then a single combined "warns once → stays
// silent" assertion. Adding new tests: any "should warn" test must run last.
describe("maybeNotifyUpdate (lifecycle)", () => {
  let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
  // The nag is for a person at a terminal, and a test runner is not one.
  // Every case below assumes a TTY unless it is the one testing otherwise.
  const realIsTTY = process.stderr.isTTY;
  beforeEach(() => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
  });
  afterEach(() => {
    warn?.mockRestore();
    (process.stderr as { isTTY?: boolean }).isTTY = realIsTTY;
  });

  it.each([
    ["header missing", undefined],
    ["latest equals current", VERSION],
    ["latest is older", OLDER],
    ["latest is whitespace-only", "   "],
    ["latest is unparseable", "garbage"],
  ])("silent when %s", (_label, headerValue) => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    maybeNotifyUpdate(headerValue);
    expect(warn).not.toHaveBeenCalled();
  });

  // Noise in a log nobody reads for this: CI, or an automation job whose
  // stderr IS its log file, on every single run.
  it("silent when stderr is not a terminal", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = false;
    warn = spyOn(console, "warn").mockImplementation(() => {});
    maybeNotifyUpdate(NEWER);
    expect(warn).not.toHaveBeenCalled();
  });

  // A prerelease is opt-in (`@next`). Someone on a release build did not ask
  // for the dev channel, and `@latest` — the only command we could print —
  // cannot install it, so the nag would repeat forever. Staging advertises
  // its own prereleases, so this is its normal case.
  it("silent when the advertised version is a prerelease and we are on a release", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    maybeNotifyUpdate("99.0.0-dev.356");
    expect(warn).not.toHaveBeenCalled();
  });

  it("silent when BOXD_NO_UPDATE_NOTICE is set", () => {
    const real = process.env.BOXD_NO_UPDATE_NOTICE;
    process.env.BOXD_NO_UPDATE_NOTICE = "1";
    warn = spyOn(console, "warn").mockImplementation(() => {});
    maybeNotifyUpdate(NEWER);
    expect(warn).not.toHaveBeenCalled();
    if (real === undefined) delete process.env.BOXD_NO_UPDATE_NOTICE;
    else process.env.BOXD_NO_UPDATE_NOTICE = real;
  });

  it("warns once on newer, then stays silent on subsequent calls", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    maybeNotifyUpdate(NEWER);
    expect(warn).toHaveBeenCalled();
    const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain(NEWER);
    expect(text).toContain(VERSION);
    expect(text).toContain("npm install @boxd-sh/sdk@latest");

    warn.mockClear();
    maybeNotifyUpdate(NEWER);
    expect(warn).not.toHaveBeenCalled();
  });
});
