/**
 * options.js — Training & Configuration Logic
 *
 * • Lets the user upload 1-5 face images and trains the recognition model
 *   by sending them to worker.js (MODE_TRAIN).
 * • Saves the resulting mean embedding vector to chrome.storage.local.
 * • Manages redactionMode and custom overlay image settings.
 */

const WORKER_URL = chrome.runtime.getURL("worker.js");
const WORKER_MSG_TIMEOUT = 60_000; // training can take a while

// ── Worker helper ─────────────────────────────────────────────────────────────
let worker = null;
let pendingCbs = new Map();
let msgId = 0;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type: "module" });
  worker.onmessage = (e) => {
    const { id, type, payload } = e.data;
    const cb = pendingCbs.get(id);
    if (!cb) return;
    clearTimeout(cb.timer);
    pendingCbs.delete(id);
    if (type === "ERROR") cb.reject(new Error(payload.message));
    else cb.resolve(payload);
  };
  return worker;
}

function postToWorker(type, payload, transferables = []) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pendingCbs.delete(id);
      reject(new Error("Worker timed out"));
    }, WORKER_MSG_TIMEOUT);
    pendingCbs.set(id, { resolve, reject, timer });
    getWorker().postMessage({ type, id, payload }, transferables);
  });
}

// ── DOM references ────────────────────────────────────────────────────────────
const trainFilesInput   = document.getElementById("train-files");
const uploadLabelText   = document.getElementById("upload-label-text");
const previewGrid       = document.getElementById("preview-grid");
const trainBtn          = document.getElementById("train-btn");
const trainBtnText      = document.getElementById("train-btn-text");
const trainSpinner      = document.getElementById("train-spinner");
const trainStatus       = document.getElementById("train-status");

const modePixelate      = document.getElementById("mode-pixelate");
const modeCustom        = document.getElementById("mode-custom");
const customUploadArea  = document.getElementById("custom-upload-area");
const customFileInput   = document.getElementById("custom-file");
const customLabelText   = document.getElementById("custom-label-text");
const customPreview     = document.getElementById("custom-preview");
const saveSettingsBtn   = document.getElementById("save-settings-btn");
const settingsStatus    = document.getElementById("settings-status");

// ── Storage helpers ───────────────────────────────────────────────────────────
const storage = {
  get: (keys) => new Promise((res) => chrome.storage.local.get(keys, res)),
  set: (items) => new Promise((res) => chrome.storage.local.set(items, res)),
};

// ── Initialise UI from saved settings ────────────────────────────────────────
async function initUI() {
  const saved = await storage.get([
    "redactionMode",
    "customImageData",
    "targetVector",
  ]);

  if (saved.redactionMode === "custom") {
    modeCustom.checked = true;
    customUploadArea.classList.remove("hidden");
  } else {
    modePixelate.checked = true;
  }

  if (saved.customImageData) {
    customPreview.src = saved.customImageData;
    customPreview.classList.remove("hidden");
    customLabelText.textContent = "Change replacement image…";
  }

  if (saved.targetVector) {
    showStatus(trainStatus, "✅ A face target is already trained.", "success");
  }
}

// ── Training image selection ──────────────────────────────────────────────────
let selectedFiles = [];

trainFilesInput.addEventListener("change", () => {
  const files = Array.from(trainFilesInput.files).slice(0, 5);
  selectedFiles = files;

  uploadLabelText.textContent =
    files.length === 0
      ? "Choose 1–5 photos…"
      : `${files.length} file${files.length > 1 ? "s" : ""} selected`;

  // Render previews
  previewGrid.innerHTML = "";
  files.forEach((file) => {
    const img = document.createElement("img");
    img.className = "preview-thumb";
    img.alt = "";  // leave blank; alt text comes from the label, not file.name
    // Use FileReader to decode the file into a data URL so that img.src receives
    // only a well-formed data: string, fully insulated from the raw File object.
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        img.src = dataUrl;
      }
    };
    reader.readAsDataURL(file);
    previewGrid.appendChild(img);
  });

  trainBtn.disabled = files.length === 0;
  clearStatus(trainStatus);
});

// ── Training ──────────────────────────────────────────────────────────────────
trainBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;

  setTrainBusy(true);
  clearStatus(trainStatus);

  try {
    // Decode files → RGBA pixel data
    const images = await Promise.all(selectedFiles.map(fileToImageData));

    // Prepare transferables (the ArrayBuffers)
    const transferables = images.map((img) => img.buffer);

    const result = await postToWorker(
      "MODE_TRAIN",
      { images },
      transferables
    );

    // result.meanVector is a Float32Array
    // Store as plain object (chrome.storage doesn't handle typed arrays directly)
    const vectorObj = Array.from(result.meanVector);
    await storage.set({ targetVector: vectorObj });

    showStatus(trainStatus, "✅ Training complete! The face target has been saved.", "success");
  } catch (err) {
    console.error("[Seashells options] Training error:", err);
    showStatus(trainStatus, `❌ Error: ${err.message}`, "error");
  } finally {
    setTrainBusy(false);
  }
});

function setTrainBusy(busy) {
  trainBtn.disabled = busy;
  trainSpinner.classList.toggle("hidden", !busy);
  trainBtnText.textContent = busy ? "Training…" : "Train Model";
}

// ── Convert File → { buffer, width, height } ─────────────────────────────────
async function fileToImageData(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx    = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);
  // Return the underlying ArrayBuffer so it can be transferred
  return { buffer: imageData.data.buffer, width, height };
}

// ── Redaction mode toggle ─────────────────────────────────────────────────────
modeCustom.addEventListener("change", () => {
  customUploadArea.classList.toggle("hidden", !modeCustom.checked);
});
modePixelate.addEventListener("change", () => {
  customUploadArea.classList.add("hidden");
});

// ── Custom overlay image selection ───────────────────────────────────────────
customFileInput.addEventListener("change", () => {
  const file = customFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    customPreview.src = e.target.result;
    customPreview.classList.remove("hidden");
    customLabelText.textContent = "Change replacement image…";
  };
  reader.readAsDataURL(file);
});

// ── Save settings ─────────────────────────────────────────────────────────────
saveSettingsBtn.addEventListener("click", async () => {
  clearStatus(settingsStatus);

  const mode = modeCustom.checked ? "custom" : "pixelate";
  const updates = { redactionMode: mode };

  if (mode === "custom" && customPreview.src) {
    updates.customImageData = customPreview.src;
  }

  await storage.set(updates);
  showStatus(settingsStatus, "✅ Settings saved.", "success");
});

// ── Status helpers ─────────────────────────────────────────────────────────────
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className   = `status-msg ${type}`;
}
function clearStatus(el) {
  el.textContent = "";
  el.className   = "status-msg";
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initUI();
