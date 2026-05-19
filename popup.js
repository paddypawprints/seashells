/**
 * popup.js — Enable/Disable Toggle & Distance Threshold
 */

const storage = {
  get: (keys) => new Promise((res) => chrome.storage.local.get(keys, res)),
  set: (items) => new Promise((res) => chrome.storage.local.set(items, res)),
};

const enableToggle     = document.getElementById("enable-toggle");
const thresholdSlider  = document.getElementById("threshold-slider");
const thresholdValue   = document.getElementById("threshold-value");
const openOptionsLink  = document.getElementById("open-options");

// ── Load saved state ──────────────────────────────────────────────────────────
async function init() {
  const saved = await storage.get(["enabled", "threshold"]);
  enableToggle.checked   = saved.enabled ?? false;
  const thr = saved.threshold ?? 1.2;
  thresholdSlider.value  = thr;
  thresholdValue.textContent = Number(thr).toFixed(2);
}

// ── Toggle ─────────────────────────────────────────────────────────────────────
enableToggle.addEventListener("change", async () => {
  await storage.set({ enabled: enableToggle.checked });
});

// ── Threshold slider ──────────────────────────────────────────────────────────
thresholdSlider.addEventListener("input", () => {
  thresholdValue.textContent = Number(thresholdSlider.value).toFixed(2);
});

thresholdSlider.addEventListener("change", async () => {
  await storage.set({ threshold: parseFloat(thresholdSlider.value) });
});

// ── Open Options page ─────────────────────────────────────────────────────────
openOptionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
