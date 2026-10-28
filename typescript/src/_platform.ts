/**
 * Host capabilities the SDK can't assume everywhere. Each entry
 * point passes what its runtime has: `index.ts` (Node/Bun/Deno) passes
 * `nodePlatform` from `_platformNode.ts`, `web.ts` passes an empty one. Code on
 * the shared graph asks for a capability here instead of importing `node:*`,
 * so the web entry's import graph never mentions a Node builtin at all, not
 * even lazily, and bundles for any target.
 */
export interface Platform {
  /** Read a local file. Absent on the web entry. */
  readFile?: ReadFile;
}

export type ReadFile = (path: string) => Promise<Uint8Array>;
