#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/models"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

download_model_if_missing() {
  local output_path="$1"
  local url="$2"

  if [[ -s "$output_path" ]]; then
    echo "Model already present: $output_path"
    return 0
  fi

  echo "Downloading model: $output_path"
  curl -fsSL "$url" -o "$output_path"
}

require_cmd cargo
require_cmd wasm-pack
require_cmd npm
require_cmd curl

echo "Running Rust tests"
(
  cd "$ROOT_DIR/wasm-core"
  cargo test
)

echo "Building Wasm package"
(
  cd "$ROOT_DIR/wasm-core"
  wasm-pack build --target web --release --no-opt
)

echo "Preparing ONNX Runtime Web assets"
NPM_TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$NPM_TMP_DIR"
}
trap cleanup EXIT

npm install --no-save --prefix "$NPM_TMP_DIR" onnxruntime-web
ORT_DIST_DIR="$NPM_TMP_DIR/node_modules/onnxruntime-web/dist"
ORT_ESM_DIR="$ORT_DIST_DIR/esm"
if [[ -d "$ORT_ESM_DIR" ]]; then
  "$ROOT_DIR/scripts/setup-onnxruntime-web.sh" "$ORT_ESM_DIR"
else
  "$ROOT_DIR/scripts/setup-onnxruntime-web.sh" "$ORT_DIST_DIR"
fi

if [[ "${SKIP_MODEL_DOWNLOAD:-0}" == "1" ]]; then
  echo "Skipping model download (SKIP_MODEL_DOWNLOAD=1)"
else
  mkdir -p "$MODELS_DIR"
  download_model_if_missing \
    "$MODELS_DIR/ultraface_320.onnx" \
    "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx"
  download_model_if_missing \
    "$MODELS_DIR/mobilefacenet.onnx" \
    "https://huggingface.co/py-feat/mobilefacenet/resolve/main/mobilefacenet.onnx"
fi

echo "Build completed successfully"
