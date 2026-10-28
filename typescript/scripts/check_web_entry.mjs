#!/usr/bin/env node
// Guard: `@boxd-sh/sdk/web` must bundle for a runtime
// that isn't Node. That is the whole reason it exists as a separate entry
// from `@boxd-sh/sdk`: `@grpc/grpc-js` needs `node:http2`/`node:net` and can't
// load in a Cloudflare Worker, and Convex's default runtime refuses a bundle
// that so much as mentions a `node:*` builtin, even behind a lazy
// `await import(...)` no code path calls.
//
// It bundles instead of scanning imports because a scan only catches the
// import forms it knows about (a regex version of this check missed a lazy
// `node:fs/promises` import). esbuild fails on any Node builtin or grpc-js
// anywhere on the graph, static or dynamic.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  const result = await build({
    entryPoints: [path.join(root, "src", "web.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    absWorkingDir: root,
    logLevel: "silent",
  });
  const files = Object.keys(result.metafile.inputs).filter((f) => f.startsWith("src/")).length;
  console.log(`web entry check OK: web.ts bundles for the browser (${files} SDK source files)`);
} catch (err) {
  console.error("web entry check FAILED: @boxd-sh/sdk/web doesn't bundle for a non-Node runtime:");
  for (const e of err.errors ?? [err]) {
    const loc = e.location ? `${e.location.file}:${e.location.line}: ` : "";
    console.error(`  ${loc}${e.text ?? e.message}`);
  }
  console.error(
    "\nNothing reachable from web.ts may import @grpc/grpc-js or a Node builtin, " +
      "statically or dynamically. Route grpc-js usage through the Transport " +
      "interface (_rpc.ts). For a Node-only capability such as reading a local " +
      "file, add it to `Platform` in _platform.ts and implement it in " +
      "_platformNode.ts, which only index.ts imports.",
  );
  process.exit(1);
}
