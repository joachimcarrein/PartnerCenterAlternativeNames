// MV3 service worker.
//
// In Manifest V3 a content script's fetch() to a cross-origin URL is subject to
// the host page's CORS policy and is NOT granted the extension's host_permissions.
// The Partner Center API (api.partnercenter.microsoft.com) returns no CORS headers
// for such requests, so a direct content-script fetch fails with
// "TypeError: Failed to fetch". The service worker, however, DOES get cross-origin
// access via host_permissions. So the content script relays every API call here.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Partner Center Alternative Names] Extension installed.');
});

// Generic authenticated-fetch relay.
// msg: { type: 'PC_FETCH', url, headers }
// reply: { ok, status, statusOk, body } on completion, or { ok:false, error } on failure.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'PC_FETCH') return false;

  (async () => {
    try {
      const resp = await fetch(msg.url, {
        method: msg.method || 'GET',
        credentials: 'include',
        headers: msg.headers || {},
      });
      let body = '';
      try {
        body = await resp.text();
      } catch (e) {
        // Body read failed; leave it empty and let the caller decide.
      }
      sendResponse({ ok: true, status: resp.status, statusOk: resp.ok, body });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
