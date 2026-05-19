# Suggested Testing Strategy

## Goals

- Catch regressions in the Rust Wasm core before rebuilding the extension.
- Verify the browser-extension workflow end to end with the required local assets.
- Exercise the privacy and input-validation boundaries added to the extension.

## Recommended Layers

### 1. Fast checks on every change

- Run `cargo test` in `/home/runner/work/seashells/seashells/wasm-core`.
- Rebuild the Wasm package with `wasm-pack build --target web --release` after
  Rust changes.
- When runtime asset wiring changes, run `./scripts/setup-onnxruntime-web.sh`
  after `npm install onnxruntime-web` and confirm the expected files appear in
  `vendor/onnxruntime-web/`.

### 2. Manual extension smoke test

After preparing `models/`, `vendor/onnxruntime-web/`, and the Wasm package:

- Load the unpacked extension in Chrome or Edge.
- Open the popup and confirm the enable toggle and threshold slider persist.
- Open the options page and verify:
  - valid PNG/JPEG/WebP/GIF uploads preview correctly,
  - oversized or unsupported uploads are rejected with a visible error,
  - training succeeds with 1–5 valid images,
  - custom overlay selection saves and restores correctly.
- Visit pages with same-origin and cross-origin images and confirm matching
  faces are redacted while non-matching faces are left alone.

### 3. Security-focused regression checks

- Confirm `background.js` rejects non-HTTP(S) image URLs.
- Confirm the background fetch path rejects non-image responses.
- Confirm large training or overlay files are rejected before decoding.
- Confirm enabling the extension or training a target after page load causes
  existing page images to be scanned.

### 4. Release verification

Before cutting a release candidate:

- Run the Rust tests.
- Rebuild the Wasm package from a clean checkout.
- Re-copy ONNX Runtime assets with the setup script.
- Load the unpacked extension in a clean browser profile and repeat the manual
  smoke test with representative pages and training images.
