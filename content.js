/* Partner Center Alternative Names
 * Adds an editable "Alternative Name" column to the Granular Administration grid.
 *
 * The grid lives inside the shadow root of <CUSTOMERSVCADMIN_HE-DATA-GRID>.
 * We fetch every customer's companyProfile.domain upfront from the Partner
 * Center Customer API (cached 30 days), fall back to the GDAP displayName for
 * non-transacted customers, and let the user type a custom name that overrides
 * both (persisted, no expiry). The column is kept alive across pagination/search
 * via a MutationObserver.
 */
(() => {
  'use strict';

  const DEBUG = true; // set to false for production
  function dbg(...args) {
    if (DEBUG) console.log('[AltName]', ...args);
  }

  // Grid rows briefly render with skeleton IDs (e.g. row-he-row-0, row-1)
  // before the real data swaps in ~700ms later. Only real tenant GUIDs should
  // get a cell or trigger a single-customer fetch — otherwise every skeleton
  // row fires a doomed 404 lookup.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const CACHE_KEY = 'domainCache';
  const DISPLAYNAME_KEY = 'displayNameCache';
  const OVERRIDE_KEY = 'nameOverrides'; // user-set custom names; never expires
  const EXPIRY_KEY = 'domainCacheExpiry';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const LIST_URL = 'https://api.partnercenter.microsoft.com/v1/customers?size=300';
  const CUSTOMER_URL = 'https://api.partnercenter.microsoft.com/v1/customers/';
  // GDAP customer list — used only for the displayName fallback. Some GDAP-only
  // (non-transacted) customers 404 on the Partner Center API above, so they have
  // no domain anywhere; for those we show this list's displayName instead.
  const GDAP_URL =
    'https://api.partnercustomersecurity.microsoft.com/CustomerServiceAdminApi/Web/v1/delegatedAdminGdapCustomers?$orderby=displayName&$count=true';

  // tenantId(lowercase) -> domain
  let domainMap = new Map();
  // tenantId(lowercase) -> GDAP displayName (fallback when no domain exists)
  let displayNameMap = new Map();
  // tenantId(lowercase) -> user-set custom name (takes priority over everything)
  let overrideMap = new Map();
  // 'pending' until a load attempt finishes; then 'ready' or 'failed'.
  let loadState = 'pending';

  /* ------------------------------------------------------------------ */
  /* Shadow DOM traversal                                               */
  /* ------------------------------------------------------------------ */

  // Recursively walk shadow roots to find the data grid host element.
  function findGrid(root, depth = 0) {
    if (!root || depth > 8) return null;
    let nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch (e) {
      return null;
    }
    for (const el of nodes) {
      if (el.tagName && el.tagName.includes('DATA-GRID')) return el;
      if (el.shadowRoot) {
        const found = findGrid(el.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Auth token                                                         */
  /* ------------------------------------------------------------------ */

  // Always read fresh — the token is short-lived and lives in sessionStorage.
  function getToken() {
    try {
      const raw = sessionStorage.getItem('AuthContextData');
      if (!raw) {
        dbg('Token extraction FAILED: AuthContextData missing from sessionStorage.');
        return null;
      }
      const authData = JSON.parse(raw);
      const token =
        authData &&
        authData.tokenMetadata &&
        authData.tokenMetadata.accountsFirstPartyApp &&
        authData.tokenMetadata.accountsFirstPartyApp.accessToken;
      if (!token) {
        dbg('Token extraction FAILED: accountsFirstPartyApp.accessToken not found.');
        return null;
      }
      dbg('Token extraction OK. Prefix:', String(token).slice(0, 20));
      return token;
    } catch (e) {
      dbg('Token extraction FAILED: error parsing AuthContextData', e);
      return null;
    }
  }

  function guid() {
    try {
      return crypto.randomUUID();
    } catch (e) {
      // Fallback RFC4122-ish v4
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Caching                                                            */
  /* ------------------------------------------------------------------ */

  // Resolves to { domains, displayNames } or null on miss/expiry.
  function readCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY], (result) => {
        const domains = result && result[CACHE_KEY];
        const displayNames = (result && result[DISPLAYNAME_KEY]) || {};
        const expiry = result && result[EXPIRY_KEY];
        if (!domains || !expiry || Date.now() >= expiry) {
          dbg('Cache MISS (missing or expired).');
          resolve(null);
          return;
        }
        dbg('Cache HIT.', Object.keys(domains).length, 'domains,',
          Object.keys(displayNames).length, 'names; expires', new Date(expiry).toISOString());
        resolve({ domains, displayNames });
      });
    });
  }

  function writeCache(domainObj, displayNameObj) {
    const payload = {};
    payload[CACHE_KEY] = domainObj || {};
    payload[DISPLAYNAME_KEY] = displayNameObj || {};
    payload[EXPIRY_KEY] = Date.now() + CACHE_TTL_MS;
    chrome.storage.local.set(payload, () => {
      dbg('Cached', Object.keys(payload[CACHE_KEY]).length, 'domains and',
        Object.keys(payload[DISPLAYNAME_KEY]).length, 'names; expires',
        new Date(payload[EXPIRY_KEY]).toISOString());
    });
  }

  /* ------------------------------------------------------------------ */
  /* User overrides (custom names) — separate store, no expiry          */
  /* ------------------------------------------------------------------ */

  function loadOverrides() {
    return new Promise((resolve) => {
      chrome.storage.local.get([OVERRIDE_KEY], (result) => {
        const data = (result && result[OVERRIDE_KEY]) || {};
        overrideMap = new Map(Object.entries(data));
        dbg('Loaded', overrideMap.size, 'name override(s).');
        resolve();
      });
    });
  }

  function persistOverrides() {
    const obj = {};
    for (const [k, v] of overrideMap) obj[k] = v;
    const payload = {};
    payload[OVERRIDE_KEY] = obj;
    chrome.storage.local.set(payload, () => dbg('Saved', overrideMap.size, 'name override(s).'));
  }

  function setOverride(tenantId, name) {
    overrideMap.set(String(tenantId).toLowerCase(), name);
    persistOverrides();
    publishAltIndex();
    dbg('Override set:', tenantId, '->', name);
  }

  function clearOverride(tenantId) {
    if (overrideMap.delete(String(tenantId).toLowerCase())) {
      persistOverrides();
      publishAltIndex();
      dbg('Override cleared:', tenantId);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Search bridge — publish the alt-name index to the MAIN-world script */
  /* ------------------------------------------------------------------ */
  //
  // The page's customer search is 100% server-side: React sends an OData
  // $filter that only knows displayName/tenantId, so a row whose *alternative*
  // name matches never comes back. search-inject.js (running in the page's MAIN
  // world) rewrites that outgoing $filter to also request the matching tenantIds
  // — but it can't read chrome.storage, so we hand it a lightweight index here.
  //
  // Index entry: [tenantId(lowercase), searchableValueLowercased]. Only
  // user-set custom names (overrides) are searchable — NOT the auto-populated
  // domains. Domains over-match badly (typing "a" hits ~36 onmicrosoft.com
  // domains) and blow past the API's 30-node OData filter limit, and they add
  // little value since the user rarely searches by domain. displayName-only
  // rows are omitted too because the server already matches those natively.

  const BRIDGE = '__altnameBridge';

  function buildAltIndex() {
    const idx = [];
    for (const [id, v] of overrideMap) {
      if (v) idx.push([id, String(v).toLowerCase()]);
    }
    return idx;
  }

  function publishAltIndex() {
    try {
      const payload = buildAltIndex();
      window.postMessage(
        { [BRIDGE]: true, kind: 'INDEX', payload },
        window.location.origin
      );
      dbg('Published alt-name index to search interceptor:', payload.length, 'entries.');
    } catch (e) {
      dbg('publishAltIndex failed:', e);
    }
  }

  // The MAIN-world script may load before or after us; when it asks, resend.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[BRIDGE] !== true) return;
    if (e.data.kind === 'REQUEST_INDEX') publishAltIndex();
  });

  /* ------------------------------------------------------------------ */
  /* API fetch                                                          */
  /* ------------------------------------------------------------------ */

  // Relay a cross-origin fetch through the background service worker.
  // MV3 content scripts can't fetch the Partner Center API directly (CORS),
  // but the service worker can via host_permissions. Returns the same shape
  // the worker sends: { ok, status, statusOk, body } or { ok:false, error }.
  function bgFetch(url, headers) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'PC_FETCH', url, headers }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'No response from background worker.' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function recordDomain(out, item) {
    if (!item) return;
    const cp = item.companyProfile || {};
    const id = cp.tenantId || item.id;
    const domain = cp.domain;
    if (id && typeof domain === 'string' && domain.length) {
      out[String(id).toLowerCase()] = domain.trim();
    }
  }

  // Fetch every customer across all continuation pages.
  // Returns a plain object { tenantId: domain } or null on failure.
  async function fetchAllDomains() {
    const token = getToken();
    if (!token) return null;

    const out = {};
    let continuationToken = null;
    let page = 0;
    let total = null;

    do {
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'MS-RequestId': guid(),
        'MS-CorrelationId': guid(),
      };
      if (continuationToken) headers['MS-ContinuationToken'] = continuationToken;

      const resp = await bgFetch(LIST_URL, headers);
      if (!resp.ok) {
        dbg('Network error fetching customers (via background):', resp.error);
        return null;
      }
      if (resp.status === 401) {
        dbg('API error 401 Unauthorized — token expired/invalid. Retry on next visit.');
        return null;
      }
      if (!resp.statusOk) {
        dbg('API error status', resp.status, 'body:', (resp.body || '').slice(0, 300));
        return null;
      }

      let data;
      try {
        data = JSON.parse(resp.body);
      } catch (e) {
        dbg('API error: failed to parse JSON', e);
        return null;
      }

      const items = Array.isArray(data && data.items) ? data.items : [];
      for (const item of items) recordDomain(out, item);
      total = typeof data.totalCount === 'number' ? data.totalCount : total;
      page++;
      dbg('Fetched page', page, '-', items.length, 'customers (running total', Object.keys(out).length + ')',
        total != null ? 'of ' + total : '');

      continuationToken = data && data.continuationToken ? data.continuationToken : null;
    } while (continuationToken);

    dbg('Fetch complete:', Object.keys(out).length, 'domains across', page, 'page(s).');
    return out;
  }

  // On-demand single-customer fallback for a tenant not in the map.
  async function fetchSingleDomain(tenantId) {
    const token = getToken();
    if (!token) return null;

    const resp = await bgFetch(CUSTOMER_URL + encodeURIComponent(tenantId), {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'MS-RequestId': guid(),
      'MS-CorrelationId': guid(),
    });
    if (!resp.ok) {
      dbg('Single-customer network error for', tenantId, resp.error);
      return null;
    }
    if (!resp.statusOk) {
      dbg('Single-customer fetch failed for', tenantId, 'status', resp.status);
      return null;
    }
    let data;
    try {
      data = JSON.parse(resp.body);
    } catch (e) {
      return null;
    }
    const out = {};
    recordDomain(out, data);
    const domain = out[String(tenantId).toLowerCase()];
    if (domain) {
      domainMap.set(String(tenantId).toLowerCase(), domain);
      publishAltIndex();
      dbg('Single-customer domain resolved:', tenantId, '->', domain);
    }
    return domain || null;
  }

  // The GDAP API uses a different short-lived token, also in sessionStorage.
  function getGdapToken() {
    try {
      const token = sessionStorage.getItem('CustomerSvcAdminKey');
      if (!token) {
        dbg('GDAP token FAILED: CustomerSvcAdminKey missing from sessionStorage.');
        return null;
      }
      dbg('GDAP token OK. Prefix:', String(token).slice(0, 20));
      return token;
    } catch (e) {
      dbg('GDAP token FAILED: error reading CustomerSvcAdminKey', e);
      return null;
    }
  }

  function recordDisplayName(out, c) {
    if (!c) return;
    const id = c.tenantId || c.customerTenantId || c.id;
    const name = c.displayName;
    if (id && typeof name === 'string' && name.trim().length) {
      out[String(id).toLowerCase()] = name.trim();
    }
  }

  // Fetch the GDAP customer list (display names). Follows OData @odata.nextLink.
  // Returns { tenantId: displayName } or null on failure.
  async function fetchDisplayNames() {
    const token = getGdapToken();
    if (!token) return null;

    const out = {};
    let url = GDAP_URL;
    let page = 0;

    while (url) {
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      const resp = await bgFetch(url, headers);
      if (!resp.ok) {
        dbg('GDAP network error (via background):', resp.error);
        break;
      }
      if (resp.status === 401) {
        dbg('GDAP 401 — CustomerSvcAdminKey expired/invalid.');
        break;
      }
      if (!resp.statusOk) {
        dbg('GDAP error status', resp.status, 'body:', (resp.body || '').slice(0, 300));
        break;
      }
      let data;
      try {
        data = JSON.parse(resp.body);
      } catch (e) {
        dbg('GDAP error: failed to parse JSON', e);
        break;
      }
      const items = Array.isArray(data && data.value) ? data.value : [];
      for (const c of items) recordDisplayName(out, c);
      page++;
      dbg('GDAP fetched page', page, '-', items.length, 'customers (running total', Object.keys(out).length + ')');
      url = data && data['@odata.nextLink'] ? data['@odata.nextLink'] : null;
    }

    dbg('GDAP fetch complete:', Object.keys(out).length, 'display names across', page, 'page(s).');
    return Object.keys(out).length ? out : null;
  }

  // Populate domainMap + displayNameMap from cache or API. Returns true if we
  // have any data to show. Domains and display names are tracked independently
  // so a prior failed GDAP fetch (empty names) self-heals on the next load
  // instead of staying blank until the 30-day cache expires.
  async function loadDomainData() {
    const cached = await readCache();
    let domains = cached && cached.domains ? cached.domains : null;
    let names =
      cached && cached.displayNames && Object.keys(cached.displayNames).length
        ? cached.displayNames
        : null;
    let changed = false;

    if (!domains) {
      const fresh = await fetchAllDomains();
      if (fresh && Object.keys(fresh).length) {
        domains = fresh;
        changed = true;
      }
    }
    // (Re)fetch display names whenever we don't have any cached.
    if (!names) {
      const fetched = await fetchDisplayNames();
      if (fetched && Object.keys(fetched).length) {
        names = fetched;
        changed = true;
      }
    }

    if (domains) domainMap = new Map(Object.entries(domains));
    if (names) displayNameMap = new Map(Object.entries(names));
    dbg('Loaded', domainMap.size, 'domains and', displayNameMap.size, 'display names.');

    // Only rewrite (and reset the expiry) when we fetched something new, so a
    // pure cache hit still lets the 30-day TTL drive a domain refresh.
    if (changed && (domainMap.size || displayNameMap.size)) {
      writeCache(domains || {}, names || {});
    }
    publishAltIndex();
    return domainMap.size > 0 || displayNameMap.size > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Column injection                                                   */
  /* ------------------------------------------------------------------ */

  const PLACEHOLDERS = ['Loading...', 'Unknown', '—'];

  // The auto-derived value (ignoring user overrides). Priority:
  // real domain > GDAP displayName > '—'/Unknown. All shown in normal style.
  function naturalInfoForTenant(tenantId) {
    if (loadState === 'pending') return { text: 'Loading...' };
    const key = String(tenantId).toLowerCase();
    const domain = domainMap.get(key);
    if (domain && domain.length) return { text: domain };
    const name = displayNameMap.get(key);
    if (name && name.length) return { text: name };
    if (loadState === 'failed') return { text: '—' }; // tokens/network failed, nothing cached
    return { text: 'Unknown' };
  }

  // What to actually show: a user override wins over the derived value.
  function effectiveInfoForTenant(tenantId) {
    const override = overrideMap.get(String(tenantId).toLowerCase());
    if (override && override.length) return { text: override, custom: true };
    return naturalInfoForTenant(tenantId);
  }

  // Button that doesn't steal focus from the input (preventDefault on mousedown)
  // and doesn't leak clicks to the grid's row handlers.
  function makeActionButton(cls, glyph, title, onActivate) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    });
    return b;
  }

  // Render a cell's content (value + edit controls), skipping no-op DOM churn.
  // Bails while the cell is being edited so it can't clobber the input.
  function renderCell(span, tenantId) {
    if (span.dataset.editing === '1') return;
    const info = effectiveInfoForTenant(tenantId);
    const sig = (info.custom ? 'c:' : 'p:') + info.text;
    if (span.dataset.rendered === sig) return;
    span.dataset.rendered = sig;
    span.textContent = '';

    const value = document.createElement('span');
    value.className = 'altname-value';
    value.textContent = info.text;
    if (info.custom) value.title = 'Custom name (set by you)';
    value.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      beginEdit(span, tenantId);
    });
    span.appendChild(value);

    // Controls appear once data has settled (not during the initial "Loading...").
    if (loadState !== 'pending') {
      span.appendChild(
        makeActionButton('altname-edit', '✎', 'Edit alternative name', () =>
          beginEdit(span, tenantId)
        )
      );
      if (info.custom) {
        span.appendChild(
          makeActionButton('altname-reset', '↺', 'Reset to original', () => {
            clearOverride(tenantId);
            renderCell(span, tenantId);
          })
        );
      }
    }
  }

  // Swap the cell into an inline text input with ✓ save / ✗ cancel buttons.
  // Enter or ✓ commits; Escape or ✗ cancels; clicking away commits.
  function beginEdit(span, tenantId) {
    if (span.dataset.editing === '1') return;
    span.dataset.editing = '1';
    span.dataset.rendered = '';
    span.textContent = '';

    const cur = effectiveInfoForTenant(tenantId);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'altname-input';
    input.value = PLACEHOLDERS.indexOf(cur.text) === -1 ? cur.text : '';
    input.placeholder = 'Custom name';
    // Stop grid handlers from hijacking focus/keys while editing.
    ['mousedown', 'click', 'keyup'].forEach((ev) =>
      input.addEventListener(ev, (e) => e.stopPropagation())
    );

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      span.dataset.editing = '';
      if (commit) applyEdit(tenantId, input.value);
      renderCell(span, tenantId);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    // Clicking away commits — but the ✓/✗ buttons preventDefault on mousedown
    // so they don't blur the input first, letting their click decide.
    input.addEventListener('blur', () => finish(true));

    span.appendChild(input);
    span.appendChild(makeActionButton('altname-save', '✓', 'Save (Enter)', () => finish(true)));
    span.appendChild(makeActionButton('altname-cancel', '✗', 'Cancel (Esc)', () => finish(false)));

    input.focus();
    input.select();
  }

  // Empty or equal-to-original clears the override; otherwise stores it.
  function applyEdit(tenantId, raw) {
    const value = (raw || '').trim();
    const natural = naturalInfoForTenant(tenantId).text;
    if (!value || value === natural) {
      clearOverride(tenantId);
    } else {
      setOverride(tenantId, value);
    }
  }

  function injectStyles(shadowRoot) {
    if (shadowRoot.querySelector('#altname-style')) return;
    const style = document.createElement('style');
    style.id = 'altname-style';
    style.textContent =
      '.altname-edit,.altname-reset,.altname-save,.altname-cancel{background:none;' +
      'border:none;cursor:pointer;font-size:12px;padding:0 2px;margin-left:4px;' +
      'line-height:1;vertical-align:baseline;}' +
      '.altname-edit,.altname-reset{opacity:.4;color:inherit;}' +
      '.altname-edit:hover,.altname-reset:hover{opacity:1;}' +
      '.altname-save{color:#107c10;}.altname-cancel{color:#a4262c;}' +
      '.altname-save:hover,.altname-cancel:hover{filter:brightness(1.2);}' +
      '.altname-input{font:inherit;width:60%;min-width:80px;box-sizing:border-box;' +
      'padding:1px 4px;margin:0;}';
    shadowRoot.appendChild(style);
  }

  function injectHeader(shadowRoot) {
    if (shadowRoot.querySelector('#tenant-domain-header')) return; // guard against duplicates

    const headerRow = shadowRoot.querySelector('#column-header');
    if (!headerRow) return;

    const tenantIdHeader = shadowRoot.querySelector('#cell-tenantId-column-header');

    const th = document.createElement('th');
    th.id = 'tenant-domain-header';
    th.setAttribute('role', 'columnheader');
    th.className = tenantIdHeader ? tenantIdHeader.className : 'data-grid__table-header';
    th.textContent = 'Alternative Name';

    if (tenantIdHeader && tenantIdHeader.parentNode === headerRow) {
      tenantIdHeader.insertAdjacentElement('afterend', th);
    } else {
      headerRow.appendChild(th);
    }
    dbg('Header injected.');
  }

  function injectRows(shadowRoot) {
    const rows = shadowRoot.querySelectorAll('tr[role="row"]:not(#column-header)');
    for (const row of rows) {
      if (!row.id || row.id.indexOf('row-') !== 0) continue;
      const tenantId = row.id.replace('row-', '');
      if (!UUID_RE.test(tenantId)) continue; // skip skeleton/placeholder rows

      const cellId = 'cell-tenantDomain-' + tenantId;
      if (row.querySelector('#' + CSS.escape(cellId))) continue; // already injected

      const tenantIdCell =
        row.querySelector('#' + CSS.escape('cell-tenantId-' + tenantId)) ||
        row.querySelector('[id^="cell-tenantId-"]');

      const td = document.createElement('td');
      td.id = cellId;
      td.className = tenantIdCell ? tenantIdCell.className : 'data-grid__cell';

      const span = document.createElement('span');
      span.className = 'data-grid__cell-content-wrapper';
      renderCell(span, tenantId);
      td.appendChild(span);

      if (tenantIdCell && tenantIdCell.parentNode === row) {
        tenantIdCell.insertAdjacentElement('afterend', td);
      } else {
        row.appendChild(td);
      }
      dbg('Row cell injected:', tenantId, '->', effectiveInfoForTenant(tenantId).text);

      // No real domain yet: try a single-customer lookup to upgrade the cell.
      // (Non-transacted GDAP customers will 404 and keep the displayName fallback.)
      if (loadState === 'ready' && !domainMap.has(String(tenantId).toLowerCase())) {
        fetchSingleDomain(tenantId).then((d) => {
          if (d) renderCell(span, tenantId); // override still wins if the user set one
        });
      }
    }
  }

  // Refresh text in already-injected cells (e.g. domains arrived after injection).
  function refreshRowText(shadowRoot) {
    const cells = shadowRoot.querySelectorAll('[id^="cell-tenantDomain-"]');
    for (const cell of cells) {
      const tenantId = cell.id.replace('cell-tenantDomain-', '');
      const span = cell.querySelector('span') || cell;
      renderCell(span, tenantId);
    }
  }

  function injectColumn(shadowRoot) {
    if (!shadowRoot) return;
    injectStyles(shadowRoot);
    injectHeader(shadowRoot);
    injectRows(shadowRoot);
    refreshRowText(shadowRoot);
  }

  /* ------------------------------------------------------------------ */
  /* Observer + bootstrap                                               */
  /* ------------------------------------------------------------------ */

  let debounceTimer = null;
  function debouncedInject(shadowRoot) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => injectColumn(shadowRoot), 100);
  }

  function startObserver(shadowRoot) {
    const observer = new MutationObserver((mutations) => {
      let added = 0;
      let removed = 0;
      for (const m of mutations) {
        added += m.addedNodes.length;
        removed += m.removedNodes.length;
      }
      if (DEBUG && (added || removed)) dbg('MutationObserver fired: +', added, '-', removed, 'nodes');
      debouncedInject(shadowRoot);
    });
    observer.observe(shadowRoot, { childList: true, subtree: true });
    dbg('MutationObserver attached to grid shadow root.');
  }

  // Wait for the grid's shadow root to exist (retry up to 10x @ 500ms).
  function waitForGrid(attempt = 0) {
    const grid = findGrid(document);
    const shadowRoot = grid && grid.shadowRoot;
    if (shadowRoot) {
      dbg('Grid shadow root found (attempt', attempt + 1, ').');
      injectColumn(shadowRoot);
      startObserver(shadowRoot);
      return;
    }
    if (attempt >= 9) {
      dbg('Gave up waiting for grid shadow root after 10 attempts.');
      return;
    }
    setTimeout(() => waitForGrid(attempt + 1), 500);
  }

  async function init() {
    dbg('Initializing.');

    // Expose debug helpers for DevTools inspection.
    window._tenantDomainDebug = {
      getCache: () => chrome.storage.local.get([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY]),
      clearCache: () => chrome.storage.local.remove([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY]),
      getMap: () => domainMap,
      getNameMap: () => displayNameMap,
      getOverrides: () => overrideMap,
      clearOverrides: () => {
        overrideMap = new Map();
        chrome.storage.local.remove([OVERRIDE_KEY]);
        publishAltIndex();
        const g = findGrid(document);
        if (g && g.shadowRoot) injectColumn(g.shadowRoot);
      },
      refetch: async () => {
        const [fresh, names] = await Promise.all([fetchAllDomains(), fetchDisplayNames()]);
        if (fresh) domainMap = new Map(Object.entries(fresh));
        if (names) displayNameMap = new Map(Object.entries(names));
        if (fresh || names) {
          writeCache(fresh || {}, names || {});
          loadState = 'ready';
          publishAltIndex();
          const g = findGrid(document);
          if (g && g.shadowRoot) injectColumn(g.shadowRoot);
        }
        return { domains: fresh, names };
      },
      getAltIndex: () => buildAltIndex(),
    };

    // Load user overrides first so the column reflects them on first paint.
    await loadOverrides();
    // Push whatever we already know (overrides) to the search interceptor now;
    // domains follow once loadDomainData() resolves below.
    publishAltIndex();

    // Show the column (with "Loading...") immediately; fill domains in after.
    waitForGrid();

    const ok = await loadDomainData();
    loadState = ok ? 'ready' : 'failed';
    dbg('Load state:', loadState);

    const grid = findGrid(document);
    if (grid && grid.shadowRoot) injectColumn(grid.shadowRoot);
  }

  init();
})();
