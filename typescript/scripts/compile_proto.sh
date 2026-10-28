#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# In the monorepo the proto lives at proto/api/v1/; in the public SDK repo it
# is mirrored to proto/api.proto, next to this SDK's folder.
if [ -f "${SDK_DIR}/../../proto/api/v1/api.proto" ]; then
    PROTO_DIR="$(cd "${SDK_DIR}/../../proto/api/v1" && pwd)"
else
    PROTO_DIR="$(cd "${SDK_DIR}/../proto" && pwd)"
fi
OUT_DIR="${SDK_DIR}/src/_generated"
# `forceLong=number` makes every 64-bit field a JS number, and the generated
# decoder throws on a value past 2^53. A field that can exceed that (a
# nanosecond timestamp) is marked `[jstype = JS_STRING]` in the proto, which
# `useJsTypeOverride` turns into a string here; every other field is
# unaffected.
TS_PROTO_OPTS="esModuleInterop=true,forceLong=number,useOptionals=messages,useExactTypes=false,useJsTypeOverride=true"

mkdir -p "${OUT_DIR}"

cd "${SDK_DIR}"

./node_modules/.bin/grpc_tools_node_protoc \
    --plugin=protoc-gen-ts_proto="./node_modules/.bin/protoc-gen-ts_proto" \
    --ts_proto_out="${OUT_DIR}" \
    --ts_proto_opt=outputServices=grpc-js,${TS_PROTO_OPTS} \
    --proto_path="${PROTO_DIR}" \
    api.proto

# Framework-agnostic message types + a `BoxdApiDefinition` method table
# (name/requestType/requestStream/responseType/responseStream per RPC) — used
# by the web transport (`src/_transportWeb.ts`). MUST NOT import
# `@grpc/grpc-js`, which cannot load in Cloudflare Workers (needs node
# http2/net) — `outputServices=generic-definitions` is ts-proto's own
# framework-agnostic mode (the same one `nice-grpc` builds clients from), so
# this file has no grpc-js import at all. protoc names the output after the
# .proto file regardless of the flags, so generate into a scratch dir and
# rename rather than fight it for a different output filename.
DEF_TMP="$(mktemp -d)"
trap 'rm -rf "${DEF_TMP}"' EXIT
./node_modules/.bin/grpc_tools_node_protoc \
    --plugin=protoc-gen-ts_proto="./node_modules/.bin/protoc-gen-ts_proto" \
    --ts_proto_out="${DEF_TMP}" \
    --ts_proto_opt=outputServices=generic-definitions,${TS_PROTO_OPTS} \
    --proto_path="${PROTO_DIR}" \
    api.proto
mv "${DEF_TMP}/api.ts" "${OUT_DIR}/definitions.ts"

echo "Proto compiled to ${OUT_DIR}"
