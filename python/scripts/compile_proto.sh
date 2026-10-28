#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# In the monorepo the proto lives at proto/api/v1/; in the public SDK repo it
# is mirrored to proto/api.proto.
if [ -f "${SDK_DIR}/../../proto/api/v1/api.proto" ]; then
    PROTO_DIR="$(cd "${SDK_DIR}/../../proto/api/v1" && pwd)"
else
    PROTO_DIR="${SDK_DIR}/proto"
fi
OUT_DIR="${SDK_DIR}/src/boxd/_generated"

mkdir -p "${OUT_DIR}"

# Prefer the SDK's venv (where grpc_tools lives), then python3, then python.
# Bare `python` does not exist on Debian/Ubuntu — the script silently failed
# there, leaving the stubs stale after a proto change.
if [ -x "${SDK_DIR}/.venv/bin/python" ]; then
    PY="${SDK_DIR}/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY=python3
else
    PY=python
fi

# Refuse to generate with a toolchain newer than the pyproject.toml pin
# (grpcio-tools<=1.80). Newer tools stamp gencode that hard-fails at import
# on the SDK's runtime floors (grpcio>=1.80 / protobuf>=6.31.1) — this has
# shipped broken stubs twice. Bump MAX_TOOLS only together with
# the pin and the dependency floors in pyproject.toml.
MAX_TOOLS="1.80.0"
TOOLS="$("${PY}" -c 'import importlib.metadata as m; print(m.version("grpcio-tools"))' 2>/dev/null)" || {
    echo "error: grpcio-tools not found — run: cd ${SDK_DIR} && uv sync --extra dev" >&2
    exit 1
}
if [ "$(printf '%s\n' "${TOOLS}" "${MAX_TOOLS}" | sort -V | tail -1)" != "${MAX_TOOLS}" ]; then
    echo "error: grpcio-tools ${TOOLS} is newer than the ${MAX_TOOLS} pin." >&2
    echo "Generating with it would raise the SDK's runtime floors (see pyproject.toml)." >&2
    echo "Use the SDK venv instead: cd ${SDK_DIR} && uv sync --extra dev, then re-run." >&2
    exit 1
fi

"${PY}" -m grpc_tools.protoc \
    --proto_path="${PROTO_DIR}" \
    --python_out="${OUT_DIR}" \
    --grpc_python_out="${OUT_DIR}" \
    --experimental_allow_proto3_optional \
    api.proto

# Fix imports in generated code (grpc_tools generates absolute imports).
# Not `sed -i`: BSD sed on macOS reads its next argument as a backup suffix.
GRPC_PY="${OUT_DIR}/api_pb2_grpc.py"
sed 's/^import api_pb2/from . import api_pb2/' "${GRPC_PY}" > "${GRPC_PY}.tmp"
mv "${GRPC_PY}.tmp" "${GRPC_PY}"

echo "Proto compiled to ${OUT_DIR}"
