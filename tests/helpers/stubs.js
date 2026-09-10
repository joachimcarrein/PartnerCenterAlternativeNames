/* Minimal fakes for the browser/extension globals the runtime files touch at
 * load time. Deliberately thin: just enough that the module body runs, with
 * recorded calls where a test needs to assert on them. No jsdom — that would
 * be a dependency, and its Shadow DOM fidelity would not match Partner
 * Center's real markup anyway (see .plan/2.1.1.tests.md, "Not covered").
 */
'use strict';

/* A fake element that swallows anything popup.js or content.js does to it and
 * records the handlers it registers, so a test can fire them. `dataset` and
 * the querySelector pair are what content.js's cell rendering touches. */
function fakeElement(id) {
  return {
    id,
    textContent: '',
    className: '',
    title: '',
    checked: false,
    hidden: false,
    href: '',
    download: '',
    value: '',
    dataset: {},
    children: [],
    handlers: {},
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    click() {
      for (const fn of this.handlers.click || []) fn();
    },
    remove() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertAdjacentElement(_where, child) {
      this.children.push(child);
      return child;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
  };
}

/* document.getElementById returns a stable fake per id, so a test can reach
 * the same element the module captured at load time. querySelectorAll returns
 * nothing, which is what makes content.js's findGrid() give up cleanly instead
 * of relying on its try/catch. */
function fakeDocument(gridShadowRoot) {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, fakeElement(id));
    return els.get(id);
  };
  // content.js's findGrid() walks querySelectorAll('*') looking for a tag name
  // containing DATA-GRID, then recurses into shadow roots. Pass a shadow root
  // to make the walk succeed; omit it and findGrid() gives up, which is what
  // most tests want.
  const gridHost = gridShadowRoot
    ? { tagName: 'CUSTOMERSVCADMIN_HE-DATA-GRID', shadowRoot: gridShadowRoot }
    : null;
  const doc = {
    elements: els,
    gridHost,
    getElementById: get,
    createElement: (tag) => fakeElement('created:' + tag),
    body: fakeElement('body'),
    handlers: {},
    addEventListener(type, fn) {
      (doc.handlers[type] = doc.handlers[type] || []).push(fn);
    },
    querySelector: () => null,
    querySelectorAll: () => (gridHost ? [gridHost] : []),
  };
  return doc;
}

/* A grid shadow root with `count` real rows, for content.js's injectRows().
 * Row ids are row-<uuid>; ids from `skeleton` are added verbatim so a test can
 * check they are skipped (the real grid renders row-he-row-0 and friends for
 * ~700ms before the data swaps in — constraint 7). */
function fakeShadowRoot(tenantIds = [], skeleton = []) {
  const rows = [...tenantIds.map((id) => 'row-' + id), ...skeleton].map((id) => {
    const el = fakeElement(id);
    el.id = id;
    return el;
  });
  return {
    rows,
    querySelector: () => null,
    /* Only the row selector matches; the [id^="cell-tenantDomain-"] lookup in
     * refreshRowText() gets nothing, so cells are never double-counted. */
    querySelectorAll: (sel) => (String(sel).indexOf('tr[role="row"]') === 0 ? rows : []),
    appendChild() {},
  };
}

/* sessionStorage with just getItem, holding the two Microsoft tokens in the
 * shapes content.js reads. `auth` fills AuthContextData's nested
 * tokenMetadata.accountsFirstPartyApp.accessToken; `gdap` is the flat
 * CustomerSvcAdminKey. Either can be false to simulate a missing token, which
 * is the whole point of the health signal. */
function fakeSessionStorage({ auth = true, gdap = true } = {}) {
  const store = {};
  if (auth) {
    store.AuthContextData = JSON.stringify({
      tokenMetadata: { accountsFirstPartyApp: { accessToken: 'fake-pc-token' } },
    });
  }
  if (gdap) store.CustomerSvcAdminKey = 'fake-gdap-token';
  return {
    store,
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
  };
}

/* setTimeout/clearTimeout that record instead of scheduling.
 *
 * Not a convenience: content.js schedules a 10-deep 500ms waitForGrid retry
 * chain and a 15s display-name grace timer the moment it loads, and real
 * timers would keep the test process alive for both. Recording them also makes
 * the grace escalation testable — fire(15000) instead of waiting 15 seconds. */
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /* Delays currently scheduled, for asserting a timer was (or was not) set. */
    pending() {
      return [...timers.values()].map((t) => t.delay);
    },
    /* Fire every timer registered with exactly this delay, oldest first. */
    fire(delay) {
      let fired = 0;
      for (const [id, t] of [...timers]) {
        if (t.delay !== delay) continue;
        timers.delete(id);
        t.fn();
        fired++;
      }
      return fired;
    },
  };
}

/* chrome.storage.local over a plain object, with the same callback style the
 * real API uses. `store` is live — a test can read/mutate it directly. */
function fakeChrome(store = {}, opts = {}) {
  const calls = {
    get: [],
    set: [],
    remove: [],
    clear: 0,
    sendMessage: [],
    query: [],
    // chrome.runtime.sendMessage — content.js uses it both for the PC_FETCH
    // relay and for the badge, so a test can assert on either.
    runtimeMessages: [],
    onMessage: [],
    onChanged: [],
  };
  return {
    store,
    calls,
    runtime: {
      lastError: opts.lastError || null,
      getManifest: () => ({ version: opts.version || '2.2.0' }),
      /* opts.onRuntimeMessage(msg) supplies the reply, which is how a test
       * feeds fake API responses to content.js's bgFetch(). Returning
       * undefined is the "no listener replied" case bgFetch also handles. */
      sendMessage: (msg, cb) => {
        calls.runtimeMessages.push(msg);
        const reply =
          typeof opts.onRuntimeMessage === 'function' ? opts.onRuntimeMessage(msg) : { ok: true };
        if (cb) cb(reply);
      },
      onMessage: {
        addListener: (fn) => calls.onMessage.push(fn),
      },
    },
    tabs: {
      query: (q, cb) => {
        calls.query.push(q);
        cb(opts.tabs || []);
      },
      sendMessage: (id, msg, cb) => {
        calls.sendMessage.push({ id, msg });
        cb && cb(opts.tabResponse === undefined ? { ok: true } : opts.tabResponse);
      },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          calls.get.push([].concat(keys));
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          cb(out);
        },
        set: (payload, cb) => {
          calls.set.push(payload);
          Object.assign(store, payload);
          cb && cb();
        },
        remove: (keys, cb) => {
          calls.remove.push([].concat(keys));
          for (const k of [].concat(keys)) delete store[k];
          cb && cb();
        },
        clear: (cb) => {
          calls.clear++;
          for (const k of Object.keys(store)) delete store[k];
          cb && cb();
        },
      },
      onChanged: {
        addListener: (fn) => calls.onChanged.push(fn),
      },
    },
    // content.js only ever sets a badge through the worker, so nothing here
    // needs chrome.action — that half is not testable and is on the live-test
    // checklist in .plan/2.2.0.md instead.
  };
}

/* FileReader that resolves immediately with fixed text. */
function fakeFileReader(text, shouldError = false) {
  return class {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.result = null;
    }
    readAsText() {
      if (shouldError) {
        this.onerror && this.onerror();
        return;
      }
      this.result = text;
      this.onload && this.onload();
    }
  };
}

/* A window whose listeners and postMessage calls are recorded, plus a
 * dispatch() helper so a test can drive the __altnameBridge by hand. */
function fakeWindow(href = 'https://partner.microsoft.com/dashboard/v2/customers/granularadminaccess/list') {
  const win = {
    listeners: {},
    posted: [],
    location: { href, origin: 'https://partner.microsoft.com' },
    addEventListener(type, fn) {
      (win.listeners[type] = win.listeners[type] || []).push(fn);
    },
    postMessage(data) {
      win.posted.push(data);
    },
    fetch() {
      return Promise.resolve({});
    },
    /* Deliver a bridge message as if it came from the page itself. `source`
     * defaults to win because the real listeners reject anything else. */
    dispatch(data, source) {
      for (const fn of win.listeners.message || []) {
        fn({ source: source === undefined ? win : source, data });
      }
    },
  };
  return win;
}

/* XMLHttpRequest with just the two methods search-inject.js wraps. Every
 * instance records what it was given so a test can inspect the outcome. */
function fakeXhr() {
  const seen = { opened: [], headers: [] };
  function XHR() {}
  XHR.prototype.open = function (method, url) {
    seen.opened.push({ method, url, xhr: this });
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    seen.headers.push({ name, value, xhr: this });
  };
  XHR.seen = seen;
  return XHR;
}

/* Objects built inside the vm carry that realm's Object.prototype, so
 * assert.deepStrictEqual reports "same structure but not reference-equal".
 * Round-trip through JSON to compare by value instead. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  plain,
  fakeElement,
  fakeDocument,
  fakeShadowRoot,
  fakeSessionStorage,
  fakeTimers,
  fakeChrome,
  fakeFileReader,
  fakeWindow,
  fakeXhr,
};
