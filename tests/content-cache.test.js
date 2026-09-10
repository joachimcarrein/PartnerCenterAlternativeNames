/* content.js — cache semantics and the fetch result objects.
 *
 * Two jobs in one file, because they share the same stub set:
 *
 *  1. The 2.1.1 cache fixes, finally under test. That release shipped with no
 *     coverage at all (.plan/2.1.1.tests.md: the missing content.js stub set
 *     was the reason). Its bug was that a failed fetch could persist {} and
 *     have it read back as an authoritative "there are zero domains", which
 *     froze the whole column at Unknown for the full 30-day TTL and survived
 *     reloads, because {} is truthy.
 *  2. The 2.2.0 rule that extends it one step: a PARTIAL result renders but is
 *     never cached. A half-populated half frozen under the same 30-day TTL is
 *     the same failure mode, one page further on.
 *
 * All tenant IDs, domains and names below are fictional, per the repository's
 * no-real-customer-data rule.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadIife } = require('./helpers/load-iife');
const {
  plain,
  fakeChrome,
  fakeDocument,
  fakeWindow,
  fakeSessionStorage,
  fakeTimers,
} = require('./helpers/stubs');

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID_B = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
const ID_C = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

const CACHE_KEY = 'domainCache';
const DISPLAYNAME_KEY = 'displayNameCache';
const EXPIRY_KEY = 'domainCacheExpiry';
const HEALTH_KEY = 'loadHealth';

const EXPOSE =
  'globalThis.__t = { nonEmpty, readCache, writeCache, fetchResult, fetchAllDomains, ' +
  '  fetchDisplayNames, loadDomainData, rebuildCache, CACHE_TTL_MS, ' +
  '  getDomains: () => domainMap, getNames: () => displayNameMap, ' +
  '  getHealth: () => healthRecord, getLoadState: () => loadState, ' +
  '  resetHealth: () => { healthRecord = null; healthSig = null; }, ' +
  '  setLoadState: (s) => { loadState = s; } };';

/* Fake API replies for content.js's bgFetch(), which goes out as a PC_FETCH
 * runtime message. `plan` is consumed in order; the last entry repeats, so a
 * one-entry plan answers every page the same way. */
function pcFetch(plan) {
  const queue = [].concat(plan);
  let i = 0;
  let seen = [];
  const fn = (msg) => {
    if (!msg || msg.type !== 'PC_FETCH') return undefined; // badge messages etc.
    seen.push(msg.url);
    const reply = queue[Math.min(i, queue.length - 1)];
    i++;
    return typeof reply === 'function' ? reply(msg) : reply;
  };
  fn.seen = () => seen;
  fn.calls = () => i;
  fn.reset = () => {
    i = 0;
    seen = [];
  };
  return fn;
}

/* Reply builders, in the shape background.js sends back. */
const okPage = (body) => ({ ok: true, status: 200, statusOk: true, body: JSON.stringify(body) });
const netError = () => ({ ok: false, error: 'Failed to fetch' });
const unauthorized = () => ({ ok: true, status: 401, statusOk: false, body: '' });
const serverError = () => ({ ok: true, status: 500, statusOk: false, body: 'upstream boom' });
const badJson = () => ({ ok: true, status: 200, statusOk: true, body: 'not json at all' });

const customers = (entries, continuationToken) => ({
  items: entries.map(([id, domain]) => ({ companyProfile: { tenantId: id, domain } })),
  totalCount: entries.length,
  ...(continuationToken ? { continuationToken } : {}),
});

const gdapPage = (entries, nextLink) => ({
  value: entries.map(([id, displayName]) => ({ tenantId: id, displayName })),
  ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
});

async function loadContent({ store = {}, session = { auth: true, gdap: true }, fetchPlan } = {}) {
  const relay = pcFetch(fetchPlan === undefined ? netError() : fetchPlan);
  const declared = JSON.parse(JSON.stringify(store));
  const chrome = fakeChrome(store, { onRuntimeMessage: relay });
  const timers = fakeTimers();
  const sandbox = loadIife(
    'src/content.js',
    {
      chrome,
      document: fakeDocument(),
      window: fakeWindow(),
      sessionStorage: fakeSessionStorage(session),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      MutationObserver: class {
        observe() {}
      },
      CSS: { escape: (s) => String(s) },
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    },
    EXPOSE
  );
  // content.js is a bare IIFE, so init() — cache read, both fetches, the
  // health write — has already run by here. Roll storage back to the state the
  // test declared and rewind the response plan, so each test drives a clean
  // load instead of racing the tail of that one.
  await new Promise((resolve) => setImmediate(resolve));
  for (const key of Object.keys(chrome.store)) delete chrome.store[key];
  Object.assign(chrome.store, JSON.parse(JSON.stringify(declared)));
  relay.reset();
  chrome.calls.set.length = 0;
  chrome.calls.remove.length = 0;
  chrome.calls.runtimeMessages.length = 0;
  return { ...sandbox.__t, chrome, timers, relay, store: chrome.store };
}

/* --------------------------------------------------------------------- */
/* 1. The 2.1.1 cache fixes, retro-covered                              */
/* --------------------------------------------------------------------- */

describe('nonEmpty — an empty object is not data', () => {
  test('only a populated object survives', async () => {
    const t = await loadContent();
    assert.strictEqual(t.nonEmpty({}), null, '{} is truthy, which is exactly the trap');
    assert.strictEqual(t.nonEmpty(null), null);
    assert.strictEqual(t.nonEmpty(undefined), null);
    assert.strictEqual(t.nonEmpty('nope'), null);
    assert.strictEqual(t.nonEmpty(42), null);
    const populated = { [ID_A]: 'contoso.onmicrosoft.com' };
    assert.strictEqual(t.nonEmpty(populated), populated);
  });
});

describe('readCache — a poisoned half reads as a miss', () => {
  test('an empty stored half is a miss, so the next load refetches it', async () => {
    // The 2.1.1 bug: {} read back as authoritative froze the column at
    // Unknown for 30 days, reload after reload.
    const t = await loadContent({
      store: {
        [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' },
        [DISPLAYNAME_KEY]: {},
        [EXPIRY_KEY]: Date.now() + 86400000,
      },
    });
    const cache = await t.readCache();
    assert.deepStrictEqual(plain(cache.domains), { [ID_A]: 'contoso.onmicrosoft.com' });
    assert.strictEqual(cache.displayNames, null, 'an empty half must not read as data');
  });

  test('an expired cache yields nothing, whatever it holds', async () => {
    const t = await loadContent({
      store: {
        [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' },
        [DISPLAYNAME_KEY]: { [ID_B]: 'Northwind Traders' },
        [EXPIRY_KEY]: Date.now() - 1,
      },
    });
    const cache = await t.readCache();
    assert.strictEqual(cache.domains, null);
    assert.strictEqual(cache.displayNames, null);
  });

  test('no expiry at all is a miss', async () => {
    const t = await loadContent({ store: { [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' } } });
    const cache = await t.readCache();
    assert.strictEqual(cache.domains, null, 'data without an expiry cannot be trusted');
  });

  test('the halves are independent', async () => {
    const t = await loadContent({
      store: {
        [DISPLAYNAME_KEY]: { [ID_B]: 'Northwind Traders' },
        [EXPIRY_KEY]: Date.now() + 86400000,
      },
    });
    const cache = await t.readCache();
    assert.strictEqual(cache.domains, null);
    assert.deepStrictEqual(plain(cache.displayNames), { [ID_B]: 'Northwind Traders' });
  });
});

describe('writeCache — a failed half cannot clear a populated one', () => {
  test('both halves empty writes nothing at all', async () => {
    const t = await loadContent({
      store: {
        [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' },
        [EXPIRY_KEY]: 12345,
      },
    });
    t.writeCache(null, {});
    assert.strictEqual(t.chrome.calls.set.length, 0, 'nothing to say, so say nothing');
    assert.deepStrictEqual(plain(t.store[CACHE_KEY]), { [ID_A]: 'contoso.onmicrosoft.com' });
    assert.strictEqual(t.store[EXPIRY_KEY], 12345, 'and the expiry is not extended either');
  });

  test('a names-only write leaves the domain half untouched', async () => {
    const t = await loadContent({
      store: { [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' } },
    });
    t.writeCache(null, { [ID_B]: 'Northwind Traders' });
    const payload = plain(t.chrome.calls.set[0]);
    assert.ok(!(CACHE_KEY in payload), 'the domain half is not in the payload, so it survives');
    assert.deepStrictEqual(payload[DISPLAYNAME_KEY], { [ID_B]: 'Northwind Traders' });
    assert.ok(payload[EXPIRY_KEY] > Date.now(), 'the shared expiry is refreshed');
  });

  test('a domains-only write leaves the names half untouched', async () => {
    const t = await loadContent({
      store: { [DISPLAYNAME_KEY]: { [ID_B]: 'Northwind Traders' } },
    });
    t.writeCache({ [ID_A]: 'contoso.onmicrosoft.com' }, null);
    const payload = plain(t.chrome.calls.set[0]);
    assert.ok(!(DISPLAYNAME_KEY in payload));
    assert.deepStrictEqual(plain(t.store[DISPLAYNAME_KEY]), { [ID_B]: 'Northwind Traders' });
  });
});

/* --------------------------------------------------------------------- */
/* 2. The fetch result objects                                          */
/* --------------------------------------------------------------------- */

describe('fetchResult — the shape both fetchers answer with', () => {
  test('a completed fetch with zero results is ok, not a failure', async () => {
    const t = await loadContent();
    const r = t.fetchResult({}, 1);
    assert.strictEqual(r.ok, true, 'zero customers is a valid answer');
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.reason, null);
    assert.strictEqual(r.partial, false);
  });

  test('a reason makes it not-ok', async () => {
    const t = await loadContent();
    const r = t.fetchResult({ [ID_A]: 'contoso.onmicrosoft.com' }, 2, 'network', true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.count, 1, 'what arrived is kept');
    assert.strictEqual(r.pages, 2);
  });
});

describe('fetchAllDomains — every exit carries a reason', () => {
  test('no token', async () => {
    const t = await loadContent({ session: { auth: false, gdap: false } });
    const r = await t.fetchAllDomains();
    assert.strictEqual(r.reason, 'no-token');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(t.relay.calls(), 0, 'and no request is even attempted');
  });

  test('network failure', async () => {
    const t = await loadContent({ fetchPlan: netError() });
    assert.strictEqual((await t.fetchAllDomains()).reason, 'network');
  });

  test('401 is auth, not a generic http error', async () => {
    // The user-facing remedy differs: sign in again versus try again later.
    const t = await loadContent({ fetchPlan: unauthorized() });
    assert.strictEqual((await t.fetchAllDomains()).reason, 'auth');
  });

  test('any other non-OK status is http', async () => {
    const t = await loadContent({ fetchPlan: serverError() });
    assert.strictEqual((await t.fetchAllDomains()).reason, 'http');
  });

  test('unparseable body is parse', async () => {
    const t = await loadContent({ fetchPlan: badJson() });
    assert.strictEqual((await t.fetchAllDomains()).reason, 'parse');
  });

  test('a clean single page is ok with its data', async () => {
    const t = await loadContent({
      fetchPlan: okPage(customers([[ID_A, 'contoso.onmicrosoft.com'], [ID_B, 'northwind.onmicrosoft.com']])),
    });
    const r = await t.fetchAllDomains();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.pages, 1);
    assert.strictEqual(r.partial, false);
    assert.deepStrictEqual(plain(r.data), {
      [ID_A]: 'contoso.onmicrosoft.com',
      [ID_B]: 'northwind.onmicrosoft.com',
    });
  });

  test('an empty first page is ok with zero results', async () => {
    const t = await loadContent({ fetchPlan: okPage(customers([])) });
    const r = await t.fetchAllDomains();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 0);
  });

  test('a failure on page 2 is partial, and page 1 is kept', async () => {
    const t = await loadContent({
      fetchPlan: [okPage(customers([[ID_A, 'contoso.onmicrosoft.com']], 'more-please')), netError()],
    });
    const r = await t.fetchAllDomains();
    assert.strictEqual(r.partial, true, 'some pages arrived, then one failed');
    assert.strictEqual(r.ok, false, 'and the sequence did not complete');
    assert.strictEqual(r.reason, 'network');
    assert.strictEqual(r.count, 1, 'showing some domains beats showing none');
  });

  test('a failure on page 1 is NOT partial', async () => {
    const t = await loadContent({ fetchPlan: netError() });
    assert.strictEqual((await t.fetchAllDomains()).partial, false);
  });

  test('continuation pages are followed to the end', async () => {
    const t = await loadContent({
      fetchPlan: [
        okPage(customers([[ID_A, 'contoso.onmicrosoft.com']], 'page-2')),
        okPage(customers([[ID_B, 'northwind.onmicrosoft.com']], 'page-3')),
        okPage(customers([[ID_C, 'acme.onmicrosoft.com']])),
      ],
    });
    const r = await t.fetchAllDomains();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pages, 3);
    assert.strictEqual(r.count, 3);
  });
});

describe('fetchDisplayNames — every exit carries a reason', () => {
  test('no GDAP token', async () => {
    const t = await loadContent({ session: { auth: true, gdap: false } });
    const r = await t.fetchDisplayNames();
    assert.strictEqual(r.reason, 'no-token');
    assert.strictEqual(r.ok, false);
  });

  for (const [label, reply, reason] of [
    ['network failure', netError(), 'network'],
    ['401', unauthorized(), 'auth'],
    ['500', serverError(), 'http'],
    ['bad JSON', badJson(), 'parse'],
  ]) {
    test(label + ' is ' + reason, async () => {
      const t = await loadContent({ fetchPlan: reply });
      assert.strictEqual((await t.fetchDisplayNames()).reason, reason);
    });
  }

  test('ZERO display names is a success, not a failure', async () => {
    // This is the line that used to read `return keys.length ? out : null`,
    // making a partner with no delegated-admin customers indistinguishable
    // from a hard failure. Harmless until a badge hung off it.
    const t = await loadContent({ fetchPlan: okPage(gdapPage([])) });
    const r = await t.fetchDisplayNames();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.reason, null);
  });

  test('a failure after the first page is partial, and keeps what arrived', async () => {
    // Its loop used to break and return the partial data as if complete,
    // which then got cached for 30 days as authoritative.
    const t = await loadContent({
      fetchPlan: [
        okPage(gdapPage([[ID_B, 'Northwind Traders']], 'https://example.invalid/next')),
        serverError(),
      ],
    });
    const r = await t.fetchDisplayNames();
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.reason, 'http');
  });

  test('nextLink pages are followed', async () => {
    const t = await loadContent({
      fetchPlan: [
        okPage(gdapPage([[ID_B, 'Northwind Traders']], 'https://example.invalid/next')),
        okPage(gdapPage([[ID_C, 'Acme Corporation']])),
      ],
    });
    const r = await t.fetchDisplayNames();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
  });
});

/* --------------------------------------------------------------------- */
/* 3. The new rule: a partial result is shown but never cached          */
/* --------------------------------------------------------------------- */

describe('loadDomainData — only a complete half becomes the cache', () => {
  test('a partial domain fetch renders but is NOT persisted', async () => {
    const t = await loadContent({
      fetchPlan: [
        okPage(customers([[ID_A, 'contoso.onmicrosoft.com']], 'page-2')),
        serverError(), // page 2 dies
        // the names half then gets whatever comes next: also dead
        serverError(),
      ],
    });
    t.resetHealth();

    await t.loadDomainData();

    assert.strictEqual(t.getDomains().size, 1, 'the partial data is shown');
    assert.ok(!(CACHE_KEY in t.store), 'but a half-populated half must never freeze under the TTL');
    assert.strictEqual(t.getHealth().domains.source, 'partial');
  });

  test('a complete fetch IS persisted', async () => {
    const t = await loadContent({
      fetchPlan: [
        okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
        okPage(gdapPage([[ID_B, 'Northwind Traders']])),
      ],
    });
    t.resetHealth();

    await t.loadDomainData();

    assert.deepStrictEqual(plain(t.store[CACHE_KEY]), { [ID_A]: 'contoso.onmicrosoft.com' });
    assert.deepStrictEqual(plain(t.store[DISPLAYNAME_KEY]), { [ID_B]: 'Northwind Traders' });
    assert.strictEqual(t.getHealth().domains.source, 'fetch');
    assert.strictEqual(t.getHealth().names.source, 'fetch');
  });

  test('a cache hit is recorded as cache and rewrites nothing', async () => {
    const t = await loadContent({
      store: {
        [CACHE_KEY]: { [ID_A]: 'contoso.onmicrosoft.com' },
        [DISPLAYNAME_KEY]: { [ID_B]: 'Northwind Traders' },
        [EXPIRY_KEY]: Date.now() + 86400000,
      },
      fetchPlan: netError(),
    });
    t.resetHealth();

    await t.loadDomainData();

    assert.strictEqual(t.relay.calls(), 0, 'a pure cache hit asks Microsoft nothing');
    assert.strictEqual(t.getHealth().domains.source, 'cache');
    assert.strictEqual(t.getHealth().names.source, 'cache');
    assert.strictEqual(t.getHealth().domains.count, 1);
    // The 30-day TTL still drives the refresh, so the expiry is untouched.
    const written = t.chrome.calls.set.filter((p) => EXPIRY_KEY in p);
    assert.strictEqual(written.length, 0);
  });

  test('the 2.1.1 shape: domains fine, no GDAP token — pending, not failed', async () => {
    const t = await loadContent({
      session: { auth: true, gdap: false },
      fetchPlan: okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
    });
    t.resetHealth();

    await t.loadDomainData();

    const h = t.getHealth();
    assert.strictEqual(h.domains.source, 'fetch');
    assert.strictEqual(h.names.source, 'awaiting', 'the token may still be on its way');
    assert.ok(t.timers.pending().includes(15000), 'and the escalation is armed');
    assert.ok(!(DISPLAYNAME_KEY in t.store), 'nothing is cached for the half that got nothing');
  });

  test('a fetched-but-empty names half is cached as nothing, and reported as fine', async () => {
    const t = await loadContent({
      fetchPlan: [okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])), okPage(gdapPage([]))],
    });
    t.resetHealth();

    await t.loadDomainData();

    assert.strictEqual(t.getHealth().names.source, 'fetch');
    assert.strictEqual(t.getHealth().names.count, 0);
    assert.ok(!(DISPLAYNAME_KEY in t.store), 'writeCache still refuses to store {}');
    assert.ok(!t.timers.pending().includes(15000), 'and no escalation is armed for a success');
  });
});

describe('rebuildCache — reports per half', () => {
  test('both halves complete: ok, and both are cached', async () => {
    const t = await loadContent({
      fetchPlan: (msg) =>
        msg.url.includes('partnercustomersecurity')
          ? okPage(gdapPage([[ID_B, 'Northwind Traders']]))
          : okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
    });
    t.resetHealth();

    const r = await t.rebuildCache();

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.domains.count, 1);
    assert.strictEqual(r.names.count, 1);
    assert.ok(CACHE_KEY in t.store);
    assert.ok(DISPLAYNAME_KEY in t.store);
  });

  test('THE 2.1.1 mis-report: domains fine, names dead — ok must be false', async () => {
    const t = await loadContent({
      fetchPlan: (msg) =>
        msg.url.includes('partnercustomersecurity')
          ? unauthorized()
          : okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
    });
    t.resetHealth();

    const r = await t.rebuildCache();

    assert.strictEqual(r.ok, false, 'this used to be true, and the popup showed a green tick');
    assert.strictEqual(r.domains.ok, true);
    assert.strictEqual(r.domains.count, 1);
    assert.strictEqual(r.names.ok, false);
    assert.strictEqual(r.names.reason, 'auth');
    assert.strictEqual(t.getHealth().names.source, 'failed');
  });

  test('a rebuild that finds zero names is a genuine success', async () => {
    const t = await loadContent({
      fetchPlan: (msg) =>
        msg.url.includes('partnercustomersecurity')
          ? okPage(gdapPage([]))
          : okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
    });
    t.resetHealth();

    const r = await t.rebuildCache();

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.names.count, 0);
    assert.strictEqual(t.getHealth().names.source, 'fetch');
  });

  test('the reply carries counts and reasons, never customer data', async () => {
    // It crosses a message boundary to the popup, which only ever counted the
    // maps anyway.
    const t = await loadContent({
      fetchPlan: (msg) =>
        msg.url.includes('partnercustomersecurity')
          ? okPage(gdapPage([[ID_B, 'Northwind Traders']]))
          : okPage(customers([[ID_A, 'contoso.onmicrosoft.com']])),
    });
    const r = plain(await t.rebuildCache());
    const json = JSON.stringify(r);
    for (const secret of [ID_A, ID_B, 'contoso', 'Northwind']) {
      assert.ok(!json.includes(secret), 'the rebuild reply must not contain ' + secret);
    }
    assert.deepStrictEqual(Object.keys(r.domains).sort(), ['count', 'ok', 'partial', 'reason']);
  });

  test('a partial rebuild is not cached, but is still shown', async () => {
    const t = await loadContent({
      fetchPlan: (msg) => {
        if (msg.url.includes('partnercustomersecurity')) return okPage(gdapPage([[ID_B, 'Northwind Traders']]));
        return msg.headers['MS-ContinuationToken']
          ? serverError()
          : okPage(customers([[ID_A, 'contoso.onmicrosoft.com']], 'page-2'));
      },
    });
    t.resetHealth();

    const r = await t.rebuildCache();

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.domains.partial, true);
    assert.strictEqual(t.getDomains().size, 1, 'shown');
    assert.ok(!(CACHE_KEY in t.store), 'not cached');
    assert.ok(DISPLAYNAME_KEY in t.store, 'the complete half is still cached');
  });
});
