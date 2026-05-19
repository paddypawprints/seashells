/**
 * background.js — Service Worker / CORS Proxy
 *
 * Listens for "FETCH_IMAGE" messages from content scripts and fetches
 * the requested image URL server-side (no CORS restrictions in a SW),
 * returning the raw bytes as an ArrayBuffer so content.js can read the
 * canvas pixel data without triggering a tainted-canvas error.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "FETCH_IMAGE") return false;

  const normalizedUrl = normalizeImageUrl(message?.url);
  if (!normalizedUrl) {
    sendResponse({ error: "Invalid URL" });
    return true;
  }

  fetch(normalizedUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${normalizedUrl}`);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`Unexpected content type: ${contentType || "unknown"}`);
      }

      return response.arrayBuffer();
    })
    .then((buffer) => {
      // Transfer the ArrayBuffer back – Chrome will copy it through the
      // message channel automatically when it appears in the response.
      sendResponse({ buffer });
    })
    .catch((err) => {
      console.error("[Seashells background] fetch error:", err);
      sendResponse({ error: err.message });
    });

  // Return true to keep the message channel open for the async response.
  return true;
});

function normalizeImageUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}
