/**
 * Shared helpers for the playground scripts. Not part of the package.
 */
import { Boxd } from "../src/index.js";

/** A client configured from the environment. Production unless BOXD_BASE_URL says otherwise. */
export function client(): Boxd {
  if (!process.env.BOXD_API_KEY && !process.env.BOXD_TOKEN) {
    console.error("set BOXD_API_KEY (or BOXD_TOKEN) first — see playground/README.md");
    process.exit(1);
  }
  return new Boxd();
}

/** Which cluster are we about to touch? Printed before anything destructive. */
export function target(): string {
  return process.env.BOXD_BASE_URL ?? "production (https://boxd.sh:9443)";
}

/** `pg-` prefixed so playground leftovers are obvious in `boxd list`. */
export function scratchName(): string {
  return `pg-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Confirm before doing something that costs money or mutates a real cluster.
 * `--yes` skips it. Reads the TTY directly so it works under `bun run`.
 */
export async function confirm(what: string): Promise<void> {
  if (process.argv.includes("--yes")) return;
  console.log(`\n  ${what}`);
  console.log(`  cluster: ${target()}\n`);
  process.stdout.write("  continue? [y/N] ");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(d.toString());
    });
  });
  if (answer.trim().toLowerCase() !== "y") {
    console.log("  aborted.");
    process.exit(0);
  }
}

/** Pretty-print whatever a call returned. */
export function show(label: string, value: unknown): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  console.dir(value, { depth: 4, colors: true });
}
