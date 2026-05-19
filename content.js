/**
 * content.js — DOM Manipulation & Redaction
 *
 * • Watches for <img> elements (existing + newly inserted via MutationObserver).
 * • For each image, draws it to an offscreen canvas to obtain raw RGBA pixels.
 *   If the canvas is tainted (CORS), asks background.js to fetch the bytes.
 * • Sends the RGBA buffer to worker.js (MODE_MATCH) via a transferable ArrayBuffer.
 * • If matches are found, applies the chosen redaction mode and replaces the
 *   image src with an object URL of the redacted canvas blob.
 */

(function seashellsContentScript() {
  "use strict";

  // ── Constants ───────────────────────────────────────────────────────────────
  const WORKER_URL  = chrome.runtime.getURL("worker.js");
  const STORAGE_KEYS = {
    enabled:         "enabled",
    targetVector:    "targetVector",
    redactionMode:   "redactionMode",   // "pixelate" | "custom"
    customImageData: "customImageData", // data URL
    threshold:       "threshold",
  };
  const PIXELATE_BLOCK = 12;   // pixel block size for pixelation
  const MIN_IMAGE_DIM  = 40;   // ignore tiny images (icons, spacers)
  const WORKER_MSG_TIMEOUT = 15_000; // ms

  // ── Worker singleton ─────────────────────────────────────────────────────────
  let worker = null;
  let pendingCallbacks = new Map(); // id → { resolve, reject, timer }
  let msgId = 0;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_URL, { type: "module" });
    worker.onmessage = (e) => {
      const { id, type, payload } = e.data;
      const pending = pendingCallbacks.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCallbacks.delete(id);
      if (type === "ERROR") {
        pending.reject(new Error(payload.message));
      } else {
        pending.resolve(payload);
      }
    };
    worker.onerror = (e) => {
      console.error("[Seashells] Worker error:", e);
    };
    return worker;
  }

  function postToWorker(type, payload, transferables = []) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => {
        pendingCallbacks.delete(id);
        reject(new Error("Worker timeout"));
      }, WORKER_MSG_TIMEOUT);
      pendingCallbacks.set(id, { resolve, reject, timer });
      getWorker().postMessage({ type, id, payload }, transferables);
    });
  }

  // ── Processed set (avoid reprocessing the same element) ─────────────────────
  const processed = new WeakSet();

  // ── Main image processing pipeline ──────────────────────────────────────────
  async function processImage(img) {
    if (processed.has(img)) return;

    // Ignore tiny or unloaded images
    const w = img.naturalWidth  || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || w < MIN_IMAGE_DIM || h < MIN_IMAGE_DIM) return;

    // Read settings
    const settings = await getStorage([
      STORAGE_KEYS.enabled,
      STORAGE_KEYS.targetVector,
      STORAGE_KEYS.threshold,
    ]);

    if (!settings.enabled) return;
    if (!settings.targetVector) return; // not trained yet

    processed.add(img);

    const threshold = settings.threshold ?? 1.2;
    const targetVector = new Float32Array(Object.values(settings.targetVector));

    // Get RGBA pixels
    let imageData;
    try {
      imageData = await getImageData(img, w, h);
    } catch (err) {
      return; // silently skip (e.g. repeated CORS failure)
    }

    // Transfer the buffer to the worker (zero-copy)
    const buffer = imageData.data.buffer;
    let result;
    try {
      result = await postToWorker(
        "MODE_MATCH",
        { buffer, width: w, height: h, targetVector, threshold },
        [buffer]
      );
    } catch (err) {
      console.warn("[Seashells] Worker match error:", err.message);
      return;
    }

    const { boxes } = result;
    if (!boxes || boxes.length === 0) return;

    // We need a fresh ImageData because the buffer was transferred above.
    let freshData;
    try {
      freshData = await getImageData(img, w, h);
    } catch {
      return;
    }

    await applyRedaction(img, freshData, w, h, boxes);
  }

  // ── Redaction ────────────────────────────────────────────────────────────────
  async function applyRedaction(img, imageData, w, h, boxes) {
    const settings = await getStorage([
      STORAGE_KEYS.redactionMode,
      STORAGE_KEYS.customImageData,
    ]);
    const mode = settings.redactionMode ?? "pixelate";

    const canvas = new OffscreenCanvas(w, h);
    const ctx    = canvas.getContext("2d");

    // Draw original image first
    ctx.putImageData(imageData, 0, 0);

    for (const box of boxes) {
      const x1 = Math.max(0, Math.floor(box.x1));
      const y1 = Math.max(0, Math.floor(box.y1));
      const x2 = Math.min(w, Math.ceil(box.x2));
      const y2 = Math.min(h, Math.ceil(box.y2));
      const bw = x2 - x1;
      const bh = y2 - y1;
      if (bw <= 0 || bh <= 0) continue;

      if (mode === "pixelate") {
        pixelate(ctx, x1, y1, bw, bh, PIXELATE_BLOCK);
      } else if (mode === "custom" && settings.customImageData) {
        await drawCustomOverlay(ctx, settings.customImageData, x1, y1, bw, bh);
      } else {
        // fallback: solid black rectangle
        ctx.fillStyle = "#000000";
        ctx.fillRect(x1, y1, bw, bh);
      }
    }

    const blob   = await canvas.convertToBlob({ type: "image/png" });
    const objUrl = URL.createObjectURL(blob);
    img.src = objUrl;
  }

  function pixelate(ctx, x, y, w, h, blockSize) {
    // Sample one colour per block and fill the block with that colour
    for (let bx = x; bx < x + w; bx += blockSize) {
      for (let by = y; by < y + h; by += blockSize) {
        const bw = Math.min(blockSize, x + w - bx);
        const bh = Math.min(blockSize, y + h - by);
        const midX = Math.floor(bx + bw / 2);
        const midY = Math.floor(by + bh / 2);
        const pixel = ctx.getImageData(midX, midY, 1, 1).data;
        ctx.fillStyle = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3] / 255})`;
        ctx.fillRect(bx, by, bw, bh);
      }
    }
  }

  async function drawCustomOverlay(ctx, dataUrl, x, y, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
      img.onerror = () => resolve(); // fallback: leave as-is
      img.src = dataUrl;
    });
  }

  // ── RGBA pixel extraction (handles CORS via background.js) ──────────────────
  async function getImageData(img, w, h) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx    = canvas.getContext("2d");

    try {
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    } catch (corsErr) {
      // Canvas is tainted – ask background.js to fetch the bytes for us
      const src = img.currentSrc || img.src;
      if (!src) throw corsErr;

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "FETCH_IMAGE", url: src },
          (reply) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (reply && reply.error) {
              reject(new Error(reply.error));
            } else {
              resolve(reply);
            }
          }
        );
      });

      // Decode ArrayBuffer → ImageBitmap → draw onto fresh canvas
      const blob   = new Blob([response.buffer]);
      const bitmap = await createImageBitmap(blob);
      const canvas2 = new OffscreenCanvas(w, h);
      const ctx2    = canvas2.getContext("2d");
      ctx2.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return ctx2.getImageData(0, 0, w, h);
    }
  }

  // ── Storage helper ────────────────────────────────────────────────────────────
  function getStorage(keys) {
    return new Promise((resolve) =>
      chrome.storage.local.get(keys, resolve)
    );
  }

  // ── Scan existing images ──────────────────────────────────────────────────────
  function scanImage(img) {
    if (img.complete && img.naturalWidth > 0) {
      processImage(img);
    } else {
      img.addEventListener("load", () => processImage(img), { once: true });
    }
  }

  document.querySelectorAll("img").forEach(scanImage);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const enabledBecameTrue =
      changes.enabled?.newValue === true && changes.enabled.oldValue !== true;
    const targetVectorAdded =
      changes.targetVector?.newValue && !changes.targetVector?.oldValue;

    if (enabledBecameTrue || targetVectorAdded) {
      document.querySelectorAll("img").forEach(scanImage);
    }
  });

  // ── MutationObserver for dynamically inserted images ──────────────────────────
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "IMG") {
          scanImage(node);
        } else {
          node.querySelectorAll?.("img").forEach(scanImage);
        }
      }
      // Also watch for src attribute changes on existing <img> elements
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "src" &&
        mutation.target.tagName === "IMG"
      ) {
        processed.delete(mutation.target); // reset so it's re-evaluated
        scanImage(mutation.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
})();
