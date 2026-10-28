// Node-only: imported by `index.ts` and never by anything reachable from
// `web.ts` (`scripts/check_web_entry.mjs` enforces that).
import { readFile } from "node:fs/promises";
import type { Platform } from "./_platform.js";

export const nodePlatform: Platform = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
};
