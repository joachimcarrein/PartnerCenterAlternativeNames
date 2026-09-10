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
  const HEALTH_KEY = 'loadHealth'; // last-load facts; see the health section below
  const NAV_SETTING_KEY = 'keepDefaultLinkBehaviour'; // default true; see popup.html
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
  // false = new default: name click -> Service management. true is an
  // explicit opt-in (checked in the popup) to keep the original behaviour
  // (name click -> Admin relationships).
  let keepDefaultLinkBehaviour = false;
  // GDAP bearer token captured from the page's own request by search-inject.js
  // and handed over the bridge. Fallback for the sessionStorage key below,
  // which the page no longer reliably writes. Never persisted — it is as
  // short-lived as the sessionStorage one.
  let bridgeGdapToken = null;

  // Facts about the most recent load — counts, sources and a reason enum, and
  // nothing else. content.js records facts; popup.js owns the single
  // assessHealth() that turns them into a level and a user-facing message.
  // With no module system, a verdict computed here and rendered there would
  // need its wording duplicated in both files and would drift; facts do not.
  // Deliberately holds no tenant IDs, domains, display names or tokens — only
  // counts, booleans, an epoch timestamp and the reason enum. Never exported.
  let healthRecord = null;
  // Signature of what was last written, so an injection pass on every
  // debounced mutation does not become a storage write on every mutation.
  let healthSig = null;

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

  // An empty object is NOT cached data. A failed fetch must never be able to
  // persist {} and have it read back as an authoritative "there are zero
  // domains" — that froze the whole column at Unknown for the full 30-day TTL
  // and survived page reloads, because {} is truthy. Both halves are gated on
  // content, not just presence.
  function nonEmpty(obj) {
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  }

  // Resolves to { domains, displayNames }; either half is null when it is
  // missing or empty, and both are null once the shared expiry has passed.
  // The halves are independent so a failure on one side refetches only that
  // side on the next load instead of waiting out the TTL.
  function readCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY], (result) => {
        const expiry = result && result[EXPIRY_KEY];
        if (!expiry || Date.now() >= expiry) {
          dbg('Cache MISS (no expiry, or expired).');
          resolve({ domains: null, displayNames: null });
          return;
        }
        const domains = nonEmpty(result && result[CACHE_KEY]);
        const displayNames = nonEmpty(result && result[DISPLAYNAME_KEY]);
        dbg('Cache read:', domains ? Object.keys(domains).length : 0, 'domains,',
          displayNames ? Object.keys(displayNames).length : 0, 'names; expires',
          new Date(expiry).toISOString());
        resolve({ domains, displayNames });
      });
    });
  }

  // Writes only the halves it was actually given. A caller whose fetch failed
  // passes null/{} for that half, which must leave the stored half alone
  // rather than overwrite it with {} — see nonEmpty() above.
  function writeCache(domainObj, displayNameObj) {
    const domains = nonEmpty(domainObj);
    const names = nonEmpty(displayNameObj);
    if (!domains && !names) {
      dbg('writeCache skipped — both halves empty, keeping what is stored.');
      return;
    }
    const payload = {};
    if (domains) payload[CACHE_KEY] = domains;
    if (names) payload[DISPLAYNAME_KEY] = names;
    payload[EXPIRY_KEY] = Date.now() + CACHE_TTL_MS;
    chrome.storage.local.set(payload, () => {
      dbg('Cached', domains ? Object.keys(domains).length : '(unchanged)', 'domains and',
        names ? Object.keys(names).length : '(unchanged)', 'names; expires',
        new Date(payload[EXPIRY_KEY]).toISOString());
    });
  }

  /* ------------------------------------------------------------------ */
  /* Health record — what the last load actually got                    */
  /* ------------------------------------------------------------------ */
  //
  // 2.1.1 degraded 7 of every 10 rows to "Unknown" while reporting success,
  // and nothing anywhere said so. These are the facts that let the popup and
  // the toolbar badge say it instead: what was attempted, what came back, and
  // how many rows resolved. No verdicts, no user-facing strings.

  // Booleans only, never the token values — same contract as the debug
  // helper's getTokenStatus().
  function tokenStatus() {
    let partnerCenter = false;
    let gdapKey = false;
    try {
      partnerCenter = !!sessionStorage.getItem('AuthContextData');
      gdapKey = !!sessionStorage.getItem('CustomerSvcAdminKey');
    } catch (e) {
      dbg('tokenStatus: sessionStorage unreadable', e);
    }
    return { partnerCenter, gdap: gdapKey || !!bridgeGdapToken };
  }

  function emptyHealth() {
    return {
      at: 0,
      domains: { source: 'awaiting', count: 0, reason: null },
      names: { source: 'awaiting', count: 0, reason: null },
      rows: { injected: 0, resolved: 0 },
      tokens: { partnerCenter: false, gdap: false },
    };
  }

  function brokenHalf(half) {
    return !!half && (half.source === 'failed' || half.source === 'partial');
  }

  // Facts for one half of the load, derived from a fetch result object.
  // awaitingOnNoToken is for the names half only: content.js runs at
  // document_idle, but the GDAP token exists only once the page itself has
  // called that API, so "no token" at first load usually means not-yet-arrived
  // rather than broken. Reporting that as 'failed' would badge a healthy page;
  // startNamesGrace() below is what eventually calls it a failure.
  function halfFacts(result, awaitingOnNoToken) {
    let source;
    if (result.partial) source = 'partial';
    else if (result.ok) source = 'fetch';
    else if (awaitingOnNoToken && result.reason === 'no-token') source = 'awaiting';
    else source = 'failed';
    return { source, count: result.count, reason: result.reason };
  }

  // `at` is deliberately NOT part of the signature. Include it and every call
  // differs from the last, the dedupe never fires, and an injection pass on
  // every debounced mutation (scroll, page, search) becomes a storage write.
  // The cost is that `at` means "when this state was first observed" rather
  // than "when it was last checked" — the more useful of the two, since it
  // dates the problem and not the poll.
  function healthSignature(h) {
    return [
      h.domains.source, h.domains.count, h.domains.reason || '-',
      h.names.source, h.names.count, h.names.reason || '-',
      h.rows.injected, h.rows.resolved,
    ].join('|');
  }

  // Only the badge's on/off — popup.js owns the wording and the finer levels
  // ('pending' for a half still arriving, 'unknown' for a fresh install). The
  // one judgement the two files share is this: a half that failed or came back
  // partial is a warning, and an unresolved row on its own is not (constraint
  // 5 — non-transacted customers legitimately have no domain and no display
  // name, so badging that would train the user to ignore the badge).
  function badgeLevel(h) {
    return brokenHalf(h.domains) || brokenHalf(h.names) ? 'warn' : 'ok';
  }

  // chrome.action isn't reachable from a content script, so the worker owns
  // the badge. It may be asleep and there is nothing useful to do about that,
  // so lastError is read and dropped.
  function sendBadge(level) {
    try {
      chrome.runtime.sendMessage({ type: 'ALTNAME_HEALTH', level }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      dbg('Badge message failed:', e);
    }
  }

  // Merges `patch` into the current record and persists it, but only when the
  // signature changed. Returns true when it wrote. The badge is driven from
  // here and nowhere else, so it can never disagree with what the popup reads
  // back out of storage.
  function writeHealth(patch) {
    const base = healthRecord || emptyHealth();
    const next = {
      at: base.at,
      domains: Object.assign({}, base.domains, patch && patch.domains),
      names: Object.assign({}, base.names, patch && patch.names),
      rows: Object.assign({}, base.rows, patch && patch.rows),
      tokens: tokenStatus(),
    };
    const sig = healthSignature(next);
    if (healthRecord && sig === healthSig) return false;
    next.at = Date.now();
    healthRecord = next;
    healthSig = sig;
    chrome.storage.local.set({ [HEALTH_KEY]: next }, () => dbg('Health recorded:', sig));
    sendBadge(badgeLevel(next));
    return true;
  }

  // True when the names half is known to have failed, so a placeholder in a
  // cell means "could not find out" rather than "there is nothing to show".
  // The cell text stays 'Unknown' on purpose: a fourth placeholder would
  // ripple into PLACEHOLDERS, beginEdit()'s is-this-a-real-value test and
  // applyEdit()'s equal-to-natural comparison, for a distinction a tooltip
  // carries at zero risk.
  function namesLookupFailed() {
    return !!healthRecord && brokenHalf(healthRecord.names);
  }

  // 'no-token' on the names half is reported as 'awaiting' (see halfFacts),
  // but if the page never calls the GDAP API again the token never arrives and
  // a genuinely broken state would sit quietly at 'pending' forever. So
  // escalate once, after a grace window, unless a recovery got there first.
  //
  // 15s is a guess, written down as one: the grid's own data comes from that
  // same API, so the token should be captured at page load, well before
  // document_idle. The live test must confirm this never fires on a healthy
  // page — if it does, the number moves, not the design.
  const NAMES_GRACE_MS = 15000;
  let namesGraceTimer = null;

  function startNamesGrace() {
    if (namesGraceTimer) return;
    namesGraceTimer = setTimeout(() => {
      namesGraceTimer = null;
      if (displayNameMap.size) return; // recovered while we waited
      if (!healthRecord || healthRecord.names.source !== 'awaiting') return;
      dbg('Grace window elapsed with no GDAP token — escalating to failed.');
      writeHealth({ names: { source: 'failed', count: 0, reason: 'no-token' } });
      // The cells were rendered while the half was still 'awaiting', so they
      // carry no degraded tooltip yet, and on an idle page no grid mutation
      // will ever come to re-render them. Every other path that writes health
      // (rebuildCache, maybeRecoverDisplayNames) re-renders after doing so;
      // this one used to be the exception, and the tooltip simply never
      // appeared. Found by live-testing 2.2.0, not by any unit test.
      const g = findGrid(document);
      if (g && g.shadowRoot) injectColumn(g.shadowRoot);
    }, NAMES_GRACE_MS);
  }

  function cancelNamesGrace() {
    if (namesGraceTimer) {
      clearTimeout(namesGraceTimer);
      namesGraceTimer = null;
    }
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

  /* ------------------------------------------------------------------ */
  /* Settings — "Keep default link behaviour"                          */
  /* ------------------------------------------------------------------ */

  function loadNavSetting() {
    return new Promise((resolve) => {
      chrome.storage.local.get([NAV_SETTING_KEY], (result) => {
        keepDefaultLinkBehaviour =
          result && typeof result[NAV_SETTING_KEY] === 'boolean' ? result[NAV_SETTING_KEY] : false;
        dbg('Keep default link behaviour:', keepDefaultLinkBehaviour);
        resolve();
      });
    });
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

  // Picks up overrides written from outside this tab (popup export/import).
  // The persistOverrides() write above also fires this — a harmless self-echo,
  // since the map is rebuilt to the value it already holds and renderCell's
  // data-rendered signature check makes the re-render a no-op.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[OVERRIDE_KEY]) {
      overrideMap = new Map(Object.entries(changes[OVERRIDE_KEY].newValue || {}));
      dbg('Overrides changed externally:', overrideMap.size, 'entry(ies).');
      publishAltIndex();
      const g = findGrid(document);
      if (g && g.shadowRoot) injectColumn(g.shadowRoot);
    }
    if (changes[NAV_SETTING_KEY]) {
      keepDefaultLinkBehaviour =
        typeof changes[NAV_SETTING_KEY].newValue === 'boolean' ? changes[NAV_SETTING_KEY].newValue : false;
      dbg('Keep default link behaviour changed externally:', keepDefaultLinkBehaviour);
    }
  });

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
    // search-inject.js sniffed the GDAP token off the page's own request.
    if (e.data.kind === 'GDAP_TOKEN' && typeof e.data.payload === 'string' && e.data.payload) {
      const isNew = e.data.payload !== bridgeGdapToken;
      bridgeGdapToken = e.data.payload;
      dbg('GDAP token received over the bridge. Prefix:', bridgeGdapToken.slice(0, 12));
      if (isNew) maybeRecoverDisplayNames();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Navigation redirect — customer name click                          */
  /* ------------------------------------------------------------------ */
  //
  // Clicking a customer's name button (<customersvcadmin_he-button appearance
  // ="link"> inside <th id="cell-displayName-{id}">, several shadow roots
  // deep) is handled entirely by the SPA's own internal click handler and
  // normally lands on .../adminrelationships. When "Keep default link
  // behaviour" is off, we want *that specific click* — and only that click —
  // to land on .../servicemanagementpage instead; the customer detail view's
  // own left-nav "Admin relationships" link must keep working normally once
  // the user is already inside a customer. That scoping is why this is a
  // capture-phase click interception on the button itself, not a global
  // history.pushState patch (which would also hijack the left-nav link on
  // every future visit to that route).
  //
  // Holding Shift while clicking inverts whichever target the setting
  // currently selects, for that one click only (the stored setting itself is
  // never touched):
  //   unchecked + plain click    -> Service management
  //   unchecked + Shift+click    -> Admin relationships
  //   checked   + plain click    -> Admin relationships
  //   checked   + Shift+click    -> Service management
  // i.e. goToServiceManagement = (keepDefaultLinkBehaviour === event.shiftKey).
  //
  // Click events are composed and cross shadow boundaries, so
  // event.composedPath() sees the actual button element even though it is
  // nested several shadow roots deep. A capture-phase listener on `document`
  // fires before the button's own (shadow-scoped) handler, so
  // stopImmediatePropagation() here reliably blocks the SPA's native
  // navigation before it starts. tenantId is resolved from the row's own
  // id="row-{id}" — the same authoritative source injectRows() already uses
  // — not re-derived from the button/cell markup.

  function findNameButtonClick(path) {
    let inNameCell = false;
    let isNameButton = false;
    let tenantId = null;
    for (const el of path) {
      if (!el || !el.tagName) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'customersvcadmin_he-button') {
        const appearance = (el.getAttribute && el.getAttribute('appearance')) || '';
        if (appearance.toLowerCase() === 'link') isNameButton = true;
      }
      if (
        (el.id && el.id.indexOf('cell-displayName-') === 0) ||
        (el.slot && String(el.slot).indexOf('displayName-') === 0)
      ) {
        inNameCell = true;
      }
      if (el.id && el.id.indexOf('row-') === 0) {
        tenantId = el.id.slice('row-'.length);
      }
    }
    if (isNameButton && inNameCell && tenantId && UUID_RE.test(tenantId)) return tenantId;
    return null;
  }

  // history.pushState from the isolated world does move the tab's real
  // location (session-history state isn't tied to a JS world), and a
  // manually dispatched popstate is observed by the page's own listeners the
  // same way. If live testing shows the SPA's router doesn't pick this up,
  // fall back to a hard `location.assign(url)` here instead (full reload,
  // but still correct).
  function redirectToServiceManagement(tenantId) {
    const url = '/dashboard/v2/customers/' + tenantId + '/servicemanagementpage';
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    dbg('Redirected customer-name click to Service management:', tenantId);
  }

  document.addEventListener(
    'click',
    (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const tenantId = findNameButtonClick(path);
      if (!tenantId) return;
      // Shift held inverts whichever target the setting currently selects,
      // for this one click only — see the comment block above.
      const goToServiceManagement = keepDefaultLinkBehaviour === e.shiftKey;
      if (!goToServiceManagement) return; // let native navigation proceed (-> Admin relationships)
      e.preventDefault();
      e.stopImmediatePropagation();
      redirectToServiceManagement(tenantId);
    },
    { capture: true }
  );

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

  // Both list fetchers answer with a result object instead of "data or null",
  // which collapsed five different outcomes into one:
  //
  //   { ok, data, count, partial, reason, pages }
  //     ok      - the request sequence completed. count may be 0, which is a
  //               legitimate answer for a partner with no customers of that
  //               kind, NOT a failure. Collapsing those two is what makes a
  //               badge cry wolf.
  //     partial - some pages arrived, then one failed; data holds what arrived
  //     reason  - null when ok && !partial, otherwise how it failed:
  //               'no-token' | 'auth' | 'network' | 'http' | 'parse'
  function fetchResult(data, pages, reason, partial) {
    const out = data || {};
    return {
      ok: !reason,
      data: out,
      count: Object.keys(out).length,
      partial: !!partial,
      reason: reason || null,
      pages: pages || 0,
    };
  }

  // Fetch every customer across all continuation pages.
  async function fetchAllDomains() {
    const token = getToken();
    if (!token) return fetchResult(null, 0, 'no-token');

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
      // A failure on page 2+ keeps what already arrived and flags it partial:
      // showing some domains beats showing none. It is still not `ok`, so
      // loadDomainData() renders it without letting it become the cache.
      if (!resp.ok) {
        dbg('Network error fetching customers (via background):', resp.error);
        return fetchResult(out, page, 'network', page > 0);
      }
      if (resp.status === 401) {
        dbg('API error 401 Unauthorized — token expired/invalid. Retry on next visit.');
        return fetchResult(out, page, 'auth', page > 0);
      }
      if (!resp.statusOk) {
        dbg('API error status', resp.status, 'body:', (resp.body || '').slice(0, 300));
        return fetchResult(out, page, 'http', page > 0);
      }

      let data;
      try {
        data = JSON.parse(resp.body);
      } catch (e) {
        dbg('API error: failed to parse JSON', e);
        return fetchResult(out, page, 'parse', page > 0);
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
    return fetchResult(out, page);
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

  // The GDAP API uses a different short-lived token. It used to always be in
  // sessionStorage under CustomerSvcAdminKey, but the page stopped writing it
  // there — which silently emptied displayNameCache and left every
  // non-transacted customer showing "Unknown" (see .plan/2.1.1.md). So try the
  // key first, then the token search-inject.js captured from the page's own
  // request to the same API. Both are read fresh at call time; neither is
  // cached to storage.
  function getGdapToken() {
    try {
      const token = sessionStorage.getItem('CustomerSvcAdminKey');
      if (token) {
        dbg('GDAP token OK (sessionStorage). Prefix:', String(token).slice(0, 20));
        return token;
      }
      dbg('CustomerSvcAdminKey missing from sessionStorage — trying the bridged token.');
    } catch (e) {
      dbg('GDAP token: error reading CustomerSvcAdminKey', e);
    }
    if (bridgeGdapToken) {
      dbg('GDAP token OK (captured from the page request). Prefix:', bridgeGdapToken.slice(0, 12));
      return bridgeGdapToken;
    }
    dbg('GDAP token FAILED: no sessionStorage key, and nothing captured yet.');
    return null;
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
  // Same result object as fetchAllDomains(). Its loop used to break on failure
  // and hand back the partial data as if it were complete — which then got
  // cached for 30 days as authoritative. Now it says which it is.
  async function fetchDisplayNames() {
    const token = getGdapToken();
    if (!token) return fetchResult(null, 0, 'no-token');

    const out = {};
    let url = GDAP_URL;
    let page = 0;

    while (url) {
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      const resp = await bgFetch(url, headers);
      if (!resp.ok) {
        dbg('GDAP network error (via background):', resp.error);
        return fetchResult(out, page, 'network', page > 0);
      }
      if (resp.status === 401) {
        dbg('GDAP 401 — the GDAP token expired/invalid.');
        return fetchResult(out, page, 'auth', page > 0);
      }
      if (!resp.statusOk) {
        dbg('GDAP error status', resp.status, 'body:', (resp.body || '').slice(0, 300));
        return fetchResult(out, page, 'http', page > 0);
      }
      let data;
      try {
        data = JSON.parse(resp.body);
      } catch (e) {
        dbg('GDAP error: failed to parse JSON', e);
        return fetchResult(out, page, 'parse', page > 0);
      }
      const items = Array.isArray(data && data.value) ? data.value : [];
      for (const c of items) recordDisplayName(out, c);
      page++;
      dbg('GDAP fetched page', page, '-', items.length, 'customers (running total', Object.keys(out).length + ')');
      url = data && data['@odata.nextLink'] ? data['@odata.nextLink'] : null;
    }

    // No `? out : null` any more: a partner with no delegated-admin customers
    // legitimately has zero display names, and reporting that as a failure is
    // exactly the false alarm a badge must not raise.
    dbg('GDAP fetch complete:', Object.keys(out).length, 'display names across', page, 'page(s).');
    return fetchResult(out, page);
  }

  // A usable GDAP token can arrive *after* loadDomainData() already gave up on
  // the display-name half: search-inject.js only sees the token when the page
  // itself calls the API, which may be after document_idle, or not until the
  // user searches or pages. Fill the missing half in then, rather than leaving
  // every non-transacted customer on "Unknown" until the next reload.
  // Skipped while loadState is still 'pending' — the in-flight
  // loadDomainData() will pick the token up on its own attempt.
  let recoveringDisplayNames = false;
  async function maybeRecoverDisplayNames() {
    if (recoveringDisplayNames || loadState === 'pending' || displayNameMap.size) return;
    recoveringDisplayNames = true;
    try {
      const r = await fetchDisplayNames();
      if (r.count) {
        displayNameMap = new Map(Object.entries(r.data));
        // Names-only write; writeCache leaves the domain half untouched. Only
        // a complete result is allowed to become the cache — a partial one
        // renders but is never persisted (see loadDomainData()).
        if (r.ok) writeCache(null, r.data);
        loadState = 'ready';
        dbg('Display names recovered via the bridged token:', displayNameMap.size);
      }
      if (r.ok || r.partial) cancelNamesGrace();
      writeHealth({ names: halfFacts(r, true) });
      if (r.count) {
        const g = findGrid(document);
        if (g && g.shadowRoot) injectColumn(g.shadowRoot);
      }
    } finally {
      recoveringDisplayNames = false;
    }
  }

  // Populate domainMap + displayNameMap from cache or API. Returns true if we
  // have any data to show. Domains and display names are tracked independently
  // so a prior failed GDAP fetch (empty names) self-heals on the next load
  // instead of staying blank until the 30-day cache expires.
  //
  // Records what each half actually came from before returning: 71 domains and
  // zero names is not a success, and 2.1.1 shipped exactly that while
  // reporting 'ready' — the return value below still says "there is something
  // to show", which is a different question from "did it all work".
  async function loadDomainData() {
    const cached = await readCache();
    let domains = cached.domains;
    let names = cached.displayNames;
    let domainFacts = { source: 'cache', count: domains ? Object.keys(domains).length : 0, reason: null };
    let nameFacts = { source: 'cache', count: names ? Object.keys(names).length : 0, reason: null };
    // Only a COMPLETE fetch may become the cached truth. A partial result is
    // still shown (some domains beat none) but never persisted: a
    // half-populated half frozen under the 30-day TTL is the same failure mode
    // as the {} poisoning fixed in 2.1.1, one step further on.
    let freshDomains = null;
    let freshNames = null;

    if (!domains) {
      const r = await fetchAllDomains();
      domainFacts = halfFacts(r, false);
      if (r.count) domains = r.data;
      if (r.ok && r.count) freshDomains = r.data;
    }
    // (Re)fetch display names whenever we don't have any cached.
    if (!names) {
      const r = await fetchDisplayNames();
      nameFacts = halfFacts(r, true);
      if (r.count) names = r.data;
      if (r.ok && r.count) freshNames = r.data;
    }

    if (domains) domainMap = new Map(Object.entries(domains));
    if (names) displayNameMap = new Map(Object.entries(names));
    dbg('Loaded', domainMap.size, 'domains and', displayNameMap.size, 'display names.');

    // Only rewrite (and reset the expiry) when we fetched something new, so a
    // pure cache hit still lets the 30-day TTL drive a domain refresh.
    if (freshDomains || freshNames) writeCache(freshDomains, freshNames);
    publishAltIndex();
    writeHealth({ domains: domainFacts, names: nameFacts });
    if (nameFacts.source === 'awaiting') startNamesGrace();
    return domainMap.size > 0 || displayNameMap.size > 0;
  }

  // Discards nothing itself — the caller (debug helper or the popup's rebuild
  // message handler) owns clearing the cache keys first. Refetches domains
  // and display names from Microsoft and writes them.
  //
  // `ok` is true only when BOTH halves completed. It used to be
  // `!!(fresh || names)`, which is exactly how a rebuild whose display-name
  // half hard-failed still reported a green "Cache rebuilt — 71 domain(s),
  // 0 name(s)." The per-half facts go back to the popup, which owns the
  // wording; counts rather than the maps themselves, since the popup only
  // ever counted them.
  async function rebuildCache() {
    const [domainsR, namesR] = await Promise.all([fetchAllDomains(), fetchDisplayNames()]);
    if (domainsR.count) domainMap = new Map(Object.entries(domainsR.data));
    if (namesR.count) displayNameMap = new Map(Object.entries(namesR.data));
    // Complete halves only — a partial result renders but is never cached.
    writeCache(domainsR.ok ? domainsR.data : null, namesR.ok ? namesR.data : null);

    const domainFacts = halfFacts(domainsR, false);
    const nameFacts = halfFacts(namesR, true);
    // Written before the re-render below, so the cells' degraded tooltips and
    // the row tally injectRows() records both see the new state.
    writeHealth({ domains: domainFacts, names: nameFacts });
    if (nameFacts.source === 'awaiting') startNamesGrace();
    else cancelNamesGrace();

    if (domainMap.size || displayNameMap.size) {
      loadState = 'ready';
      publishAltIndex();
      const g = findGrid(document);
      if (g && g.shadowRoot) injectColumn(g.shadowRoot);
    }
    return {
      ok: domainsR.ok && namesR.ok,
      domains: {
        ok: domainsR.ok, count: domainsR.count, partial: domainsR.partial, reason: domainsR.reason,
      },
      names: {
        ok: namesR.ok, count: namesR.count, partial: namesR.partial, reason: namesR.reason,
      },
    };
  }

  // Popup messages. ALTNAME_REBUILD_CACHE: popup already cleared the cache
  // keys (it can't refetch — the Microsoft tokens live in this page's
  // sessionStorage), so refetch and re-render here. ALTNAME_CLEAR_ALL: popup
  // already wiped ALL of chrome.storage.local (including nameOverrides, on
  // purpose, on the user's confirmation) — this just resets in-memory state
  // to match and shows the blank-install "Loading..." placeholders instead of
  // stale data until the page is refreshed or Rebuild is used.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return; // not ours
    if (msg.type === 'ALTNAME_REBUILD_CACHE') {
      rebuildCache()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // keep the message channel open for the async reply
    }
    if (msg.type === 'ALTNAME_CLEAR_ALL') {
      overrideMap = new Map();
      domainMap = new Map();
      displayNameMap = new Map();
      loadState = 'pending';
      // Storage (loadHealth included) is already wiped by the popup, so this
      // only resets the in-memory record and drops the badge — no leftover '!'
      // on a toolbar that now describes nothing.
      healthRecord = null;
      healthSig = null;
      cancelNamesGrace();
      sendBadge('ok');
      publishAltIndex();
      const g = findGrid(document);
      if (g && g.shadowRoot) injectColumn(g.shadowRoot);
      dbg('Cleared all local state (storage already wiped by popup).');
      sendResponse({ ok: true });
      return;
    }
    // not ours
  });

  /* ------------------------------------------------------------------ */
  /* Column injection                                                   */
  /* ------------------------------------------------------------------ */

  const PLACEHOLDERS = ['Loading...', 'Unknown', '—'];

  // The auto-derived value (ignoring user overrides). Priority:
  // real domain > GDAP displayName > '—'/Unknown. All shown in normal style.
  //
  // `degraded` marks a placeholder the extension could not resolve *because a
  // lookup failed*, as opposed to a customer that legitimately has neither a
  // domain nor a display name (constraint 5). Only the tooltip changes; the
  // text stays as it was — see namesLookupFailed().
  function naturalInfoForTenant(tenantId) {
    if (loadState === 'pending') return { text: 'Loading...' };
    const key = String(tenantId).toLowerCase();
    const domain = domainMap.get(key);
    if (domain && domain.length) return { text: domain };
    const name = displayNameMap.get(key);
    if (name && name.length) return { text: name };
    const degraded = namesLookupFailed();
    if (loadState === 'failed') return { text: '—', degraded }; // nothing cached either
    return { text: 'Unknown', degraded };
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
    // `degraded` belongs in the signature: the tooltip has to appear when the
    // health record changes even though the cell's text does not.
    const sig = (info.custom ? 'c:' : 'p:') + (info.degraded ? 'd:' : '') + info.text;
    if (span.dataset.rendered === sig) return;
    span.dataset.rendered = sig;
    span.textContent = '';

    const value = document.createElement('span');
    value.className = 'altname-value';
    value.textContent = info.text;
    if (info.custom) value.title = 'Custom name (set by you)';
    else if (info.degraded) value.title = 'Display-name lookup failed — open the extension popup.';
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
    // Row tally for the health record, counted before the already-injected
    // guard below so it covers every real row on this pass and not only the
    // new ones. This is the number that actually matters: "3 of 10 rows showed
    // a name" needs no knowledge of the extension's internals to be alarming,
    // and it is the only signal that does not depend on guessing an expected
    // total — the two APIs cover different, overlapping customer populations,
    // so measuring names against domains would be a misleading denominator.
    let seen = 0;
    let resolved = 0;
    for (const row of rows) {
      if (!row.id || row.id.indexOf('row-') !== 0) continue;
      const tenantId = row.id.replace('row-', '');
      if (!UUID_RE.test(tenantId)) continue; // skip skeleton/placeholder rows

      seen++;
      if (PLACEHOLDERS.indexOf(effectiveInfoForTenant(tenantId).text) === -1) resolved++;

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

    // Skipped while the load is still in flight: every row reads "Loading..."
    // then, so recording 0 of 10 would be a lie for the ~1s before data lands.
    // Skipped for an empty pass too (a search that matched nothing), which
    // would otherwise overwrite a real tally with 0 of 0. refreshRowText()
    // does not repeat this — the tally comes from state rather than the DOM,
    // so a second pass over the same rows computes identical numbers.
    if (loadState !== 'pending' && seen) writeHealth({ rows: { injected: seen, resolved } });
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
      getCache: () => chrome.storage.local.get([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY, HEALTH_KEY]),
      // Same key list the popup's rebuild clears: loadHealth is derived data
      // and must never be left describing a cache that has been deleted.
      // OVERRIDE_KEY stays out of it — it has no server-side source of truth.
      clearCache: () => chrome.storage.local.remove([CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY, HEALTH_KEY]),
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
      rebuildCache,
      getAltIndex: () => buildAltIndex(),
      // The facts the popup and the badge are both driven from. Counts,
      // sources, a reason enum and booleans — no customer data of any kind.
      getHealth: () => healthRecord,
      // Booleans only — never expose the token values themselves.
      getTokenStatus: () => ({
        authContext: !!sessionStorage.getItem('AuthContextData'),
        gdapSessionStorage: !!sessionStorage.getItem('CustomerSvcAdminKey'),
        gdapBridged: !!bridgeGdapToken,
        loadState,
        domains: domainMap.size,
        names: displayNameMap.size,
      }),
      exportOverrides: () => {
        const obj = {};
        for (const [k, v] of overrideMap) obj[k] = v;
        return {
          type: 'partner-center-alternative-names',
          formatVersion: 1,
          extensionVersion: chrome.runtime.getManifest().version,
          exportedAt: new Date().toISOString(),
          count: overrideMap.size,
          nameOverrides: obj,
        };
      },
      // Thinner than popup.js's validator (no file-size check — there's no
      // file here), but the same UUID/string/trim rules. mode is 'merge' or
      // 'replace'; defaults to 'merge'.
      importOverrides: (data, mode) => {
        const raw = data && data.nameOverrides;
        if (!raw || typeof raw !== 'object') throw new Error('No nameOverrides in data.');
        const clean = {};
        for (const [key, value] of Object.entries(raw)) {
          const id = String(key).toLowerCase();
          if (!UUID_RE.test(id) || typeof value !== 'string') continue;
          const trimmed = value.trim();
          if (!trimmed) continue;
          clean[id] = trimmed;
        }
        const merged =
          mode === 'replace' ? clean : Object.fromEntries([...overrideMap, ...Object.entries(clean)]);
        overrideMap = new Map(Object.entries(merged));
        persistOverrides();
        publishAltIndex();
        const g = findGrid(document);
        if (g && g.shadowRoot) injectColumn(g.shadowRoot);
        return { imported: Object.keys(clean).length, stored: overrideMap.size };
      },
    };

    // Load user overrides first so the column reflects them on first paint.
    await loadOverrides();
    await loadNavSetting();
    // Push whatever we already know (overrides) to the search interceptor now;
    // domains follow once loadDomainData() resolves below.
    publishAltIndex();
    // search-inject.js runs at document_start, so it may already have captured
    // the GDAP token before this script loaded. Ask it to hand it over.
    try {
      window.postMessage({ [BRIDGE]: true, kind: 'REQUEST_TOKEN' }, window.location.origin);
    } catch (e) {
      dbg('REQUEST_TOKEN post failed:', e);
    }

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
