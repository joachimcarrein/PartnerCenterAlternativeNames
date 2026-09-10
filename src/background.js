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

// Toolbar badge for the degraded-data signal.
// msg: { type: 'ALTNAME_HEALTH', level } — 'warn' shows '!', anything else
// clears it. content.js sends a level, not a message: the wording lives in the
// popup, and this only needs to know whether to raise the flag.
//
// A second listener is safe because the relay above returns false for anything
// that is not PC_FETCH. This one never replies, so it returns false too.
//
// Tab-scoped, never global: the Microsoft tokens live in one tab's
// sessionStorage, so the condition is per-tab, and a global badge would also
// outlive the tab that earned it. Chrome resets tab-specific action state when
// the tab navigates away, so there is nothing to clean up on exit.
// #a4262c is the error red popup.html and content.js already use.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'ALTNAME_HEALTH') return false;

  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return false; // not from a tab; nothing to badge

  try {
    chrome.action.setBadgeText({ text: msg.level === 'warn' ? '!' : '', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#a4262c', tabId });
  } catch (e) {
    // The tab can close between the send and here; that is not an error worth
    // surfacing anywhere the user would see it.
    console.log('[Partner Center Alternative Names] badge update skipped:', e);
  }
  return false;
});
