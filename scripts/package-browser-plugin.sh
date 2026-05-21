#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/seashells-extension"
ZIP_PATH="$DIST_DIR/seashells-extension.zip"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

copy_entry() {
  local rel_path="$1"
  local src="$ROOT_DIR/$rel_path"
  local dst="$PACKAGE_DIR/$rel_path"

  if [[ ! -e "$src" ]]; then
    echo "Missing required build output: $rel_path" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dst")"
  if [[ -d "$src" ]]; then
    cp -R "$src" "$dst"
  else
    cp "$src" "$dst"
  fi
}

require_cmd zip
mkdir -p "$DIST_DIR"
rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

copy_entry "manifest.json"
copy_entry "background.js"
copy_entry "content.js"
copy_entry "worker.js"
copy_entry "options.html"
copy_entry "options.js"
copy_entry "popup.html"
copy_entry "popup.js"
copy_entry "styles.css"
copy_entry "icons"
copy_entry "wasm-core/pkg"
copy_entry "vendor/onnxruntime-web"

if [[ -d "$ROOT_DIR/models" ]]; then
  copy_entry "models"
else
  echo "Warning: models/ not found; packaged extension will require models before runtime use."
fi

(
  cd "$DIST_DIR"
  zip -rq "$(basename "$ZIP_PATH")" "$(basename "$PACKAGE_DIR")"
)

echo "Packaged browser extension at $ZIP_PATH"
