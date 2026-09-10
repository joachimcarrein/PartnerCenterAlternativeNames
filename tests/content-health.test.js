/* content.js — the health record: signature, write dedupe, row tallies.
 *
 * These are the first tests to reach content.js at all. .plan/2.1.1.tests.md
 * named the missing stub set as the reason it went uncovered; 2.2.0 needed
 * that set anyway, so it exists now (tests/helpers/stubs.js).
 *
 * What is worth protecting here:
 *   - the signature must NOT include `at`, or the dedupe never fires and every
 *     debounced mutation (scroll, page, search) becomes a storage write;
 *   - 'no-token' on the names half must record 'awaiting', not 'failed', or a
 *     healthy page gets badged one load in two;
 *   - the row tally must be skipped while the load is pending, or "0 of 10"
 *     gets recorded for the ~1s when every row legitimately reads "Loading…".
 *
 * All tenant IDs and names below are fictional, per the repository's
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
  fakeShadowRoot,
  fakeSessionStorage,
  fakeTimers,
} = require('./helpers/stubs');

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID_B = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
const ID_C = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

const EXPOSE =
  'globalThis.__t = { healthSignature, writeHealth, halfFacts, badgeLevel, brokenHalf, ' +
  '  emptyHealth, tokenStatus, namesLookupFailed, startNamesGrace, cancelNamesGrace, ' +
  '  injectRows, naturalInfoForTenant, effectiveInfoForTenant, renderCell, ' +
  '  HEALTH_KEY, NAMES_GRACE_MS, ' +
  '  getHealth: () => healthRecord, ' +
  '  resetHealth: () => { healthRecord = null; healthSig = null; }, ' +
  '  setHealth: (h) => { healthRecord = h; healthSig = healthSignature(h); }, ' +
  '  setLoadState: (s) => { loadState = s; }, ' +
  '  setDomains: (o) => { domainMap = new Map(Object.entries(o)); }, ' +
  '  setNames: (o) => { displayNameMap = new Map(Object.entries(o)); }, ' +
  '  setOverrides: (o) => { overrideMap = new Map(Object.entries(o)); } };';

/* Load content.js and let its init() settle.
 *
 * init() runs on load (it is a bare IIFE), so a test would otherwise race the
 * tail of loadDomainData(). One macrotask is enough because every stub answers
 * synchronously. Storage is then rolled back to what the test declared and the
 * recorded calls are cleared, so no assertion here can be satisfied by
 * something init() happened to leave behind. Timers are fake — see
 * fakeTimers() for why that is required and not a convenience. */
async function loadContent({
  store = {},
  session = { auth: false, gdap: false },
  onRuntimeMessage,
  grid,
} = {}) {
  const declared = JSON.parse(JSON.stringify(store));
  const chrome = fakeChrome(store, { onRuntimeMessage });
  const timers = fakeTimers();
  const doc = fakeDocument(grid);
  const win = fakeWindow();
  const sandbox = loadIife(
    'src/content.js',
    {
      chrome,
      document: doc,
      window: win,
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
  await new Promise((resolve) => setImmediate(resolve));
  // init() arms the grace window whenever it finds no GDAP token, which is
  // most of these fixtures. Cancel it through the module so both the timer and
  // the module's own handle are cleared — dropping the fake timer alone would
  // leave startNamesGrace() thinking one is still armed.
  sandbox.__t.cancelNamesGrace();
  for (const key of Object.keys(chrome.store)) delete chrome.store[key];
  Object.assign(chrome.store, JSON.parse(JSON.stringify(declared)));
  chrome.calls.set.length = 0;
  chrome.calls.runtimeMessages.length = 0;
  return { ...sandbox.__t, chrome, timers, doc, win, store: chrome.store };
}

const half = (source, count, reason) => ({ source, count, reason: reason || null });

function health(over = {}) {
  return {
    at: 1757505125990,
    domains: half('cache', 71),
    names: half('cache', 68),
    rows: { injected: 10, resolved: 10 },
    tokens: { partnerCenter: true, gdap: true },
    ...over,
  };
}

describe('healthSignature — what counts as a change', () => {
  test('the same state produces an identical signature', async () => {
    const t = await loadContent();
    assert.strictEqual(t.healthSignature(health()), t.healthSignature(health()));
  });

  test('`at` alone does NOT change the signature', async () => {
    // The whole point. Include `at` and every call differs from the last, the
    // dedupe never fires, and an injection pass on every debounced mutation
    // becomes a storage write on every debounced mutation.
    const t = await loadContent();
    const a = t.healthSignature(health({ at: 1 }));
    const b = t.healthSignature(health({ at: 999999999 }));
    assert.strictEqual(a, b);
  });

  test('tokens alone do NOT change the signature', async () => {
    // Diagnostic only, and they flip as the page loads; they must not drive
    // storage writes.
    const t = await loadContent();
    const a = t.healthSignature(health({ tokens: { partnerCenter: true, gdap: true } }));
    const b = t.healthSignature(health({ tokens: { partnerCenter: false, gdap: false } }));
    assert.strictEqual(a, b);
  });

  test('every fact that matters DOES change the signature', async () => {
    const t = await loadContent();
    const base = t.healthSignature(health());
    const variants = {
      'domains source': health({ domains: half('failed', 71) }),
      'domains count': health({ domains: half('cache', 70) }),
      'domains reason': health({ domains: half('cache', 71, 'network') }),
      'names source': health({ names: half('failed', 68) }),
      'names count': health({ names: half('cache', 67) }),
      'names reason': health({ names: half('cache', 68, 'auth') }),
      'rows injected': health({ rows: { injected: 9, resolved: 10 } }),
      'rows resolved': health({ rows: { injected: 10, resolved: 9 } }),
    };
    for (const [what, record] of Object.entries(variants)) {
      assert.notStrictEqual(t.healthSignature(record), base, what + ' must be visible');
    }
  });
});

describe('writeHealth — writes once per actual change', () => {
  test('the first write always lands', async () => {
    const t = await loadContent();
    t.resetHealth();
    assert.strictEqual(t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) }), true);
    assert.strictEqual(t.chrome.calls.set.length, 1);
    assert.ok(t.store[t.HEALTH_KEY], 'the record is persisted under loadHealth');
  });

  test('an unchanged state is not written again', async () => {
    const t = await loadContent();
    t.resetHealth();
    const patch = { domains: half('cache', 71), names: half('cache', 68) };
    t.writeHealth(patch);
    const after = t.chrome.calls.set.length;
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(t.writeHealth(patch), false, 'repeat call ' + i + ' must be a no-op');
    }
    assert.strictEqual(t.chrome.calls.set.length, after, 'no extra storage writes');
  });

  test('a changed row tally is written, and only once', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68), rows: { injected: 10, resolved: 10 } });
    const before = t.chrome.calls.set.length;
    assert.strictEqual(t.writeHealth({ rows: { injected: 10, resolved: 3 } }), true);
    assert.strictEqual(t.writeHealth({ rows: { injected: 10, resolved: 3 } }), false);
    assert.strictEqual(t.chrome.calls.set.length, before + 1);
  });

  test('a patch merges into the record rather than replacing it', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) });
    t.writeHealth({ rows: { injected: 4, resolved: 2 } });
    const stored = plain(t.store[t.HEALTH_KEY]);
    assert.strictEqual(stored.domains.count, 71, 'the untouched half survives the patch');
    assert.strictEqual(stored.rows.injected, 4);
  });

  test('`at` moves only when the state actually changed', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) });
    const first = plain(t.store[t.HEALTH_KEY]).at;
    assert.ok(first > 0, '`at` is stamped on write');
    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) });
    assert.strictEqual(plain(t.store[t.HEALTH_KEY]).at, first, '`at` dates the problem, not the poll');
  });

  test('the record carries no customer data of any kind', async () => {
    // The privacy claim in docs/privacy.html, asserted: counts, booleans, an
    // epoch timestamp and a reason enum, and nothing else.
    const t = await loadContent({ session: { auth: true, gdap: true } });
    t.resetHealth();
    t.setDomains({ [ID_A]: 'contoso.onmicrosoft.com' });
    t.setNames({ [ID_B]: 'Northwind Traders' });
    t.writeHealth({ domains: half('fetch', 1), names: half('fetch', 1) });
    const json = JSON.stringify(plain(t.store[t.HEALTH_KEY]));
    for (const secret of [ID_A, ID_B, 'contoso', 'Northwind', 'fake-pc-token', 'fake-gdap-token']) {
      assert.ok(!json.includes(secret), 'the health record must not contain ' + secret);
    }
    assert.deepStrictEqual(
      Object.keys(plain(t.store[t.HEALTH_KEY])).sort(),
      ['at', 'domains', 'names', 'rows', 'tokens']
    );
  });

  test('each write sends the badge level to the worker', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) });
    t.writeHealth({ names: half('failed', 0, 'no-token') });
    const badges = t.chrome.calls.runtimeMessages.filter((m) => m.type === 'ALTNAME_HEALTH');
    assert.deepStrictEqual(badges.map((m) => m.level), ['ok', 'warn']);
  });
});

describe('badgeLevel — the one judgement content.js makes', () => {
  test('a failed or partial half warns; anything else does not', async () => {
    const t = await loadContent();
    assert.strictEqual(t.badgeLevel(health()), 'ok');
    assert.strictEqual(t.badgeLevel(health({ names: half('fetch', 0) })), 'ok', 'zero fetched is fine');
    assert.strictEqual(t.badgeLevel(health({ names: half('awaiting', 0, 'no-token') })), 'ok',
      'still arriving must not badge');
    assert.strictEqual(t.badgeLevel(health({ rows: { injected: 10, resolved: 0 } })), 'ok',
      'unresolved rows alone are not a warning (constraint 5)');
    assert.strictEqual(t.badgeLevel(health({ names: half('failed', 0, 'auth') })), 'warn');
    assert.strictEqual(t.badgeLevel(health({ domains: half('partial', 3, 'http') })), 'warn');
  });
});

describe('halfFacts — reading a fetch result', () => {
  const result = (over = {}) => ({ ok: true, count: 5, partial: false, reason: null, ...over });

  test('a completed fetch is `fetch`, even with zero results', async () => {
    const t = await loadContent();
    assert.strictEqual(t.halfFacts(result(), false).source, 'fetch');
    assert.strictEqual(t.halfFacts(result({ count: 0 }), false).source, 'fetch');
  });

  test('no token on the NAMES half is awaiting, not failed', async () => {
    // content.js runs at document_idle but the GDAP token exists only once the
    // page itself has called that API. Calling that a failure would badge a
    // healthy page on most first loads.
    const t = await loadContent();
    const facts = t.halfFacts(result({ ok: false, count: 0, reason: 'no-token' }), true);
    assert.strictEqual(facts.source, 'awaiting');
    assert.strictEqual(facts.reason, 'no-token', 'the reason is kept so the escalation can check it');
  });

  test('no token on the DOMAINS half is a plain failure', async () => {
    // That token comes from sessionStorage the page writes before our script
    // runs; if it is missing, it is missing.
    const t = await loadContent();
    assert.strictEqual(
      t.halfFacts(result({ ok: false, count: 0, reason: 'no-token' }), false).source,
      'failed'
    );
  });

  test('every other reason is a failure on both halves', async () => {
    const t = await loadContent();
    for (const reason of ['auth', 'network', 'http', 'parse']) {
      assert.strictEqual(t.halfFacts(result({ ok: false, count: 0, reason }), true).source, 'failed', reason);
      assert.strictEqual(t.halfFacts(result({ ok: false, count: 0, reason }), false).source, 'failed', reason);
    }
  });

  test('partial wins over everything and keeps its count', async () => {
    const t = await loadContent();
    const facts = t.halfFacts(result({ ok: false, count: 40, partial: true, reason: 'network' }), true);
    assert.strictEqual(facts.source, 'partial');
    assert.strictEqual(facts.count, 40);
  });
});

describe('the display-name grace window', () => {
  test('awaiting escalates to failed when the token never arrives', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('awaiting', 0, 'no-token') });
    t.startNamesGrace();
    assert.ok(t.timers.pending().includes(t.NAMES_GRACE_MS), 'a grace timer is armed');
    assert.strictEqual(t.getHealth().names.source, 'awaiting', 'still quiet while it is armed');

    assert.strictEqual(t.timers.fire(t.NAMES_GRACE_MS), 1);
    assert.strictEqual(plain(t.store[t.HEALTH_KEY]).names.source, 'failed');
    const badges = t.chrome.calls.runtimeMessages.filter((m) => m.type === 'ALTNAME_HEALTH');
    assert.strictEqual(badges[badges.length - 1].level, 'warn');
  });

  test('a recovery before the window closes cancels the escalation', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('awaiting', 0, 'no-token') });
    t.startNamesGrace();
    t.cancelNamesGrace();
    assert.strictEqual(t.timers.fire(t.NAMES_GRACE_MS), 0, 'the timer is gone');
    assert.strictEqual(t.getHealth().names.source, 'awaiting');
  });

  test('names that arrived while the window was open stop the escalation', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('awaiting', 0, 'no-token') });
    t.startNamesGrace();
    t.setNames({ [ID_A]: 'Contoso Ltd' }); // recovered via the bridged token
    t.timers.fire(t.NAMES_GRACE_MS);
    assert.strictEqual(t.getHealth().names.source, 'awaiting', 'must not overwrite a recovery');
  });

  test('the window arms only once', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ names: half('awaiting', 0, 'no-token') });
    t.startNamesGrace();
    t.startNamesGrace();
    t.startNamesGrace();
    assert.strictEqual(
      t.timers.pending().filter((d) => d === t.NAMES_GRACE_MS).length,
      1,
      'a second call must not stack another timer'
    );
  });

  test('the escalation re-renders the cells so the tooltip actually appears', async () => {
    // The bug the 2.2.0 live test found. The cells are rendered while the half
    // is still legitimately 'awaiting', so they carry no tooltip; the
    // escalation updated the record, the badge and the popup but nothing
    // re-rendered the column, and on an idle page no grid mutation ever comes.
    const root = fakeShadowRoot([ID_C]);
    const t = await loadContent({ grid: root });
    t.setLoadState('ready');
    t.resetHealth();
    t.writeHealth({ domains: half('fetch', 71), names: half('awaiting', 0, 'no-token') });

    t.injectRows(root); // as the first injection pass would, while awaiting
    const beforeCells = root.rows[0].children.length;
    assert.ok(beforeCells > 0, 'a cell was injected');

    t.startNamesGrace();
    t.timers.fire(t.NAMES_GRACE_MS);

    assert.ok(root.rows[0].children.length > beforeCells, 'the column was re-rendered');
    const cell = root.rows[0].children[root.rows[0].children.length - 1];
    const value = cell.children[0].children.find((c) => c.className === 'altname-value');
    assert.match(value.title, /lookup failed/i, 'and the new cell admits the failure');
  });

  test('a half that already failed is not re-escalated', async () => {
    const t = await loadContent();
    t.resetHealth();
    t.writeHealth({ names: half('failed', 0, 'auth') });
    t.startNamesGrace();
    const before = t.chrome.calls.set.length;
    t.timers.fire(t.NAMES_GRACE_MS);
    assert.strictEqual(t.chrome.calls.set.length, before, 'nothing changed, so nothing is written');
    assert.strictEqual(t.getHealth().names.reason, 'auth', 'the real reason is not overwritten');
  });
});

describe('injectRows — the row tally', () => {
  test('counts every real row, and the ones showing a name', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.setDomains({ [ID_A]: 'contoso.onmicrosoft.com' });
    t.setNames({ [ID_B]: 'Northwind Traders' });
    t.resetHealth();

    t.injectRows(fakeShadowRoot([ID_A, ID_B, ID_C]));

    const stored = plain(t.store[t.HEALTH_KEY]);
    assert.strictEqual(stored.rows.injected, 3);
    assert.strictEqual(stored.rows.resolved, 2, 'a domain and a display name resolve; Unknown does not');
  });

  test('a user override counts as resolved', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.setOverrides({ [ID_C]: 'Acme (renewal Q3)' });
    t.resetHealth();

    t.injectRows(fakeShadowRoot([ID_A, ID_C]));

    const stored = plain(t.store[t.HEALTH_KEY]);
    assert.strictEqual(stored.rows.resolved, 1);
  });

  test('skeleton rows are not counted', async () => {
    // The grid renders row-he-row-0 / row-1 for ~700ms before the real data
    // swaps in (constraint 7). Counting those would make every first pass look
    // broken.
    const t = await loadContent();
    t.setLoadState('ready');
    t.setDomains({ [ID_A]: 'contoso.onmicrosoft.com' });
    t.resetHealth();

    t.injectRows(fakeShadowRoot([ID_A], ['row-he-row-0', 'row-1', 'not-a-row']));

    assert.strictEqual(plain(t.store[t.HEALTH_KEY]).rows.injected, 1);
  });

  test('nothing is recorded while the load is still pending', async () => {
    // Every row reads "Loading…" then, so 0 of 10 would be a lie for the ~1s
    // before data lands.
    const t = await loadContent();
    t.setLoadState('pending');
    t.resetHealth();

    t.injectRows(fakeShadowRoot([ID_A, ID_B]));

    assert.strictEqual(t.getHealth(), null, 'no tally, and no write');
    assert.strictEqual(t.chrome.calls.set.length, 0);
  });

  test('an empty pass does not overwrite a real tally', async () => {
    // A search that matched nothing must not turn "3 of 10" into "0 of 0".
    const t = await loadContent();
    t.setLoadState('ready');
    t.resetHealth();
    t.writeHealth({ rows: { injected: 10, resolved: 3 } });

    t.injectRows(fakeShadowRoot([]));

    const stored = plain(t.store[t.HEALTH_KEY]);
    assert.strictEqual(stored.rows.injected, 10);
    assert.strictEqual(stored.rows.resolved, 3);
  });

  test('a repeated identical pass writes once, not once per mutation', async () => {
    // The MutationObserver fires on scroll, pagination and search; the debounce
    // only bounds how often injectColumn() runs, not how often it agrees with
    // the last result.
    const t = await loadContent();
    t.setLoadState('ready');
    t.setDomains({ [ID_A]: 'contoso.onmicrosoft.com' });
    t.resetHealth();

    const root = fakeShadowRoot([ID_A, ID_B]);
    t.injectRows(root);
    const after = t.chrome.calls.set.length;
    for (let i = 0; i < 4; i++) t.injectRows(fakeShadowRoot([ID_A, ID_B]));
    assert.strictEqual(t.chrome.calls.set.length, after, 'no storage write per mutation');
  });
});

describe('the cell admits uncertainty without changing its text', () => {
  test('Unknown gains a degraded flag only when the names half failed', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.resetHealth();

    t.writeHealth({ domains: half('cache', 71), names: half('cache', 68) });
    let info = t.naturalInfoForTenant(ID_C);
    assert.strictEqual(info.text, 'Unknown');
    assert.ok(!info.degraded, 'a customer with genuinely no name is not a failure (constraint 5)');

    t.writeHealth({ names: half('failed', 0, 'no-token') });
    info = t.naturalInfoForTenant(ID_C);
    assert.strictEqual(info.text, 'Unknown', 'the text must not change — no fourth placeholder');
    assert.strictEqual(info.degraded, true);
  });

  test('a resolved cell is never marked degraded', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.setDomains({ [ID_A]: 'contoso.onmicrosoft.com' });
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('failed', 0, 'auth') });

    const info = t.naturalInfoForTenant(ID_A);
    assert.strictEqual(info.text, 'contoso.onmicrosoft.com');
    assert.ok(!info.degraded);
  });

  test('an awaiting half does not mark cells degraded', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.resetHealth();
    t.writeHealth({ names: half('awaiting', 0, 'no-token') });
    assert.ok(!t.naturalInfoForTenant(ID_C).degraded, 'still arriving is not a failure');
  });

  test('the degraded flag survives into the rendered tooltip', async () => {
    const t = await loadContent();
    t.setLoadState('ready');
    t.resetHealth();
    t.writeHealth({ domains: half('cache', 71), names: half('failed', 0, 'no-token') });

    const span = t.doc.createElement('span');
    t.renderCell(span, ID_C);
    const value = span.children.find((c) => c.className === 'altname-value');
    assert.ok(value, 'the value span is rendered');
    assert.match(value.title, /lookup failed/i);
    assert.strictEqual(span.dataset.rendered, 'p:d:Unknown', 'the signature carries the degraded ' +
      'flag, so the tooltip appears even though the text did not change');
  });
});

describe('tokenStatus — booleans only', () => {
  test('reports presence, never the values', async () => {
    const withBoth = await loadContent({ session: { auth: true, gdap: true } });
    assert.deepStrictEqual(plain(withBoth.tokenStatus()), { partnerCenter: true, gdap: true });

    const withNone = await loadContent({ session: { auth: false, gdap: false } });
    assert.deepStrictEqual(plain(withNone.tokenStatus()), { partnerCenter: false, gdap: false });
  });
});
