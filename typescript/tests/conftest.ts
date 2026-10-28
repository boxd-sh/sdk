import { Boxd } from "../src/index.js";

/** A client built from the ambient env — the e2e suite's only entry point. */
export function mkClient(): Boxd {
  return new Boxd({
    apiKey: process.env.BOXD_API_KEY,
    token: process.env.BOXD_TOKEN,
    baseURL: process.env.BOXD_BASE_URL ?? process.env.BOXD_API_URL,
  });
}

export function e2eEnabled(): boolean {
  return process.env.BOXD_RUN_E2E === "1";
}
