#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-$ROOT_DIR/node_modules/onnxruntime-web/dist/esm}"
TARGET_DIR="$ROOT_DIR/vendor/onnxruntime-web"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Could not find ONNX Runtime Web assets at: $SOURCE_DIR" >&2
  echo "Install the dependency first with: npm install onnxruntime-web" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

cp "$SOURCE_DIR/ort.webgpu.min.mjs" "$TARGET_DIR/"
cp "$SOURCE_DIR/ort-wasm-simd-threaded.jsep.mjs" "$TARGET_DIR/"
cp "$SOURCE_DIR/"*.wasm "$TARGET_DIR/"

echo "Copied ONNX Runtime Web assets into $TARGET_DIR"
