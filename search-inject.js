/* Partner Center Alternative Names — search interceptor (MAIN world)
 *
 * The customer search on the Granular Administration page is entirely
 * server-side: React sends an OData $filter to the search API that only knows
 * `displayName` and `tenantId`, so a customer whose *alternative* name matches
 * the query never comes back (its displayName is something else). This script
 * makes alternative names searchable without touching React internals: it wraps
 * the page's XMLHttpRequest/fetch and, for each outgoing search request, appends
 * `OR tenantId eq '<id>'` clauses for every tenant whose alternative name
 * contains the query. The matching rows then return from the API normally, and
 * the isolated content script's MutationObserver renders their Alternative Name
 * cell as usual.
 *
 * Why MAIN world: patching the page's XHR/fetch and seeing the page's own
 * requests is only possible from the page's JS world. This script therefore
 * runs with "world": "MAIN" at document_start (before the page issues requests).
 * It can't use chrome.* APIs, so content.js (isolated world) hands it the
 * alt-name index over window.postMessage.
 */
(() => {
  'use strict';

  const DEBUG = true;
  function dbg(...args) {
    if (DEBUG) console.log('[AltName/net]', ...args);
  }

  const BRIDGE = '__altnameBridge';
  const TARGET_HOST = 'api.partnercustomersecurity.microsoft.com';

  // The search API rejects filters past an OData AST "node count limit of 30".
  // The base displayName/tenantId filter already spends ~12 nodes, and each
  // flat "tenantId eq '...'" clause costs a few more, so ~4 is the safe ceiling.
  // Beyond that we skip expansion entirely: the user still gets the normal
  // displayName results instead of a red "Something went wrong" banner.
  const MAX_CLAUSES = 4;

  // [tenantId(lowercase), searchableValueLowercased] — supplied by content.js.
  let altIndex = [];

  /* ------------------------------------------------------------------ */
  /* Bridge: receive the alt-name index from the isolated content script */
  /* ------------------------------------------------------------------ */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[BRIDGE] !== true) return;
    if (e.data.kind === 'INDEX' && Array.isArray(e.data.payload)) {
      altIndex = e.data.payload;
      dbg('Alt-name index updated:', altIndex.length, 'entries.');
    }
  });

  // content.js may have loaded first (document_idle vs our document_start) and
  // already published once. Ask it to (re)send so we don't start empty.
  try {
    window.postMessage({ [BRIDGE]: true, kind: 'REQUEST_INDEX' }, window.location.origin);
  } catch (e) {
    dbg('REQUEST_INDEX post failed:', e);
  }

  /* ------------------------------------------------------------------ */
  /* Filter rewriting                                                   */
  /* ------------------------------------------------------------------ */

  // Pull the search text out of the displayName clause of an OData $filter,
  // e.g. contains(tolower(displayName), tolower('acme')). OData escapes a
  // single quote by doubling it, so '' -> '.
  function extractQuery(filter) {
    const m = /tolower\('((?:[^']|'')*)'\)/.exec(filter);
    if (!m) return null;
    return m[1].replace(/''/g, "'");
  }

  function matchingTenantIds(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ids = [];
    for (const entry of altIndex) {
      if (entry && entry[1] && entry[1].indexOf(q) !== -1) ids.push(entry[0]);
    }
    return ids;
  }

  // Given a raw request URL, return a rewritten URL string with the alt-name
  // clauses folded into $filter, or null if there's nothing to change. Works on
  // the raw query string (not URLSearchParams) so we don't disturb the encoding
  // of parameters we aren't touching, and re-encode our new $filter with
  // encodeURIComponent (spaces as %20, safe for OData).
  function rewriteUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;

    let hostname;
    try {
      hostname = new URL(rawUrl, window.location.href).hostname;
    } catch (e) {
      return null;
    }
    if (hostname !== TARGET_HOST) return null;

    const qIdx = rawUrl.indexOf('?');
    if (qIdx === -1) return null;

    const params = rawUrl.slice(qIdx + 1).split('&');
    let fi = -1;
    for (let i = 0; i < params.length; i++) {
      if (params[i].indexOf('$filter=') === 0) {
        fi = i;
        break;
      }
    }
    if (fi === -1) return null;

    const encoded = params[fi].slice('$filter='.length);
    let decoded;
    try {
      decoded = decodeURIComponent(encoded.replace(/\+/g, ' '));
    } catch (e) {
      decoded = encoded;
    }
    // Only touch the customer search filter, never our own or unrelated calls.
    if (decoded.indexOf('displayName') === -1) return null;

    const query = extractQuery(decoded);
    if (!query) return null;

    const ids = matchingTenantIds(query);
    if (!ids.length) return null;
    if (ids.length > MAX_CLAUSES) {
      dbg('Skipping expansion for query', JSON.stringify(query), '-', ids.length,
        'matches exceed the', MAX_CLAUSES, 'clause cap (would exceed the API node limit).');
      return null;
    }

    // Build a single FLAT OR group. React's base filter is wrapped in its own
    // outer parens; strip them so we don't nest, which wastes OData AST nodes:
    //   (contains(...) OR contains(...) OR tenantId eq 'a' OR tenantId eq 'b')
    let inner = decoded;
    if (inner.charAt(0) === '(' && inner.charAt(inner.length - 1) === ')') {
      inner = inner.slice(1, -1);
    }
    const clauses = ids.map((id) => "tenantId eq '" + id + "'").join(' OR ');
    const expanded = '(' + inner + ' OR ' + clauses + ')';
    params[fi] = '$filter=' + encodeURIComponent(expanded);

    dbg('Expanded $filter for query', JSON.stringify(query), '+', ids.length, 'alt-name match(es).');
    return rawUrl.slice(0, qIdx + 1) + params.join('&');
  }

  /* ------------------------------------------------------------------ */
  /* Patch XMLHttpRequest.open and window.fetch                         */
  /* ------------------------------------------------------------------ */

  const RealOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const rewritten = rewriteUrl(url);
      if (rewritten) arguments[1] = rewritten;
    } catch (e) {
      dbg('XHR open rewrite error:', e);
    }
    return RealOpen.apply(this, arguments);
  };

  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          const r = rewriteUrl(input);
          if (r) input = r;
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          const r = rewriteUrl(input.url);
          if (r) input = new Request(r, input);
        }
      } catch (e) {
        dbg('fetch rewrite error:', e);
      }
      return realFetch.call(this, input, init);
    };
  }

  dbg('Search interceptor installed (MAIN world).');
})();
