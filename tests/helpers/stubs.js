/* Minimal fakes for the browser/extension globals the runtime files touch at
 * load time. Deliberately thin: just enough that the module body runs, with
 * recorded calls where a test needs to assert on them. No jsdom — that would
 * be a dependency, and its Shadow DOM fidelity would not match Partner
 * Center's real markup anyway (see .plan/2.1.1.tests.md, "Not covered").
 */
'use strict';

/* A fake element that swallows anything popup.js does to it and records the
 * handlers it registers, so a test can fire them. */
function fakeElement(id) {
  return {
    id,
    textContent: '',
    className: '',
    checked: false,
    href: '',
    download: '',
    value: '',
    handlers: {},
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    click() {
      for (const fn of this.handlers.click || []) fn();
    },
    remove() {},
    appendChild() {},
  };
}

/* document.getElementById returns a stable fake per id, so a test can reach
 * the same element the module captured at load time. */
function fakeDocument() {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, fakeElement(id));
    return els.get(id);
  };
  return {
    elements: els,
    getElementById: get,
    createElement: (tag) => fakeElement('created:' + tag),
    body: fakeElement('body'),
  };
}

/* chrome.storage.local over a plain object, with the same callback style the
 * real API uses. `store` is live — a test can read/mutate it directly. */
function fakeChrome(store = {}, opts = {}) {
  const calls = { set: [], remove: [], clear: 0, sendMessage: [], query: [] };
  return {
    store,
    calls,
    runtime: {
      lastError: opts.lastError || null,
      getManifest: () => ({ version: opts.version || '2.1.1' }),
      sendMessage: (msg, cb) => cb && cb({ ok: true }),
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
    },
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
  fakeChrome,
  fakeFileReader,
  fakeWindow,
  fakeXhr,
};
