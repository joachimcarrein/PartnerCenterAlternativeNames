/* popup.js — assessHealth() and the rebuild report.
 *
 * Why this file exists: 2.1.1 degraded 7 of every 10 rows to "Unknown" while
 * reporting success, and the only thing that catches that class of failure is
 * a health signal (.plan/2.1.1.tests.md closed on exactly that point). This is
 * the judgement half of it — content.js records facts, popup.js decides what
 * they mean, and every wrong decision here is either a silent failure or a
 * badge that cries wolf.
 *
 * The two lines that matter most:
 *   - a fetch that completed with zero results is a SUCCESS (a partner with no
 *     delegated-admin customers legitimately has no display names);
 *   - a half still awaiting its token is PENDING, never a warning.
 * Get either wrong and the signal is worse than none.
 *
 * All tenant IDs and names below are fictional, per the repository's
 * no-real-customer-data rule.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadIife } = require('./helpers/load-iife');
const { fakeDocument, fakeChrome, fakeFileReader, fakeWindow } = require('./helpers/stubs');

/* Load popup.js and hand back the pure functions plus the banner elements. */
function load(store = {}) {
  const chrome = fakeChrome(store);
  const doc = fakeDocument();
  const sandbox = loadIife(
    'src/popup.js',
    {
      chrome,
      document: doc,
      window: fakeWindow(),
      FileReader: fakeFileReader(null),
      Blob: class {},
      confirm: () => true,
    },
    'globalThis.__t = { assessHealth, describeRebuild, healthTag, renderHealth, ' +
      'refreshStatus, CACHE_KEYS, OVERRIDE_KEY, HEALTH_KEY, CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY };'
  );
  return {
    ...sandbox.__t,
    chrome,
    store: chrome.store,
    el: (id) => doc.getElementById(id),
    /* Deliver a chrome.storage.onChanged event the way the real API would. */
    fireStorageChange: (changes, area) => {
      for (const fn of chrome.calls.onChanged) fn(changes, area || 'local');
    },
  };
}

/* A health record in the shape content.js writes. */
function record(over = {}) {
  return {
    at: 1757505125990,
    domains: { source: 'cache', count: 71, reason: null },
    names: { source: 'cache', count: 68, reason: null },
    rows: { injected: 10, resolved: 10 },
    tokens: { partnerCenter: true, gdap: true },
    ...over,
  };
}

const half = (source, count, reason) => ({ source, count, reason: reason || null });

describe('assessHealth — the fresh-install and healthy cases', () => {
  test('no record at all is unknown, not a failure', () => {
    const { assessHealth } = load();
    for (const missing of [undefined, null, {}]) {
      const v = assessHealth(missing, { domains: 0, names: 0 });
      assert.strictEqual(v.level, 'unknown', 'a missing record must never read as a failure');
      assert.match(v.headline, /no status yet/i);
    }
  });

  test('a record from an older version (halves missing) is unknown, not a crash', () => {
    const { assessHealth } = load();
    const v = assessHealth({ at: 1, rows: { injected: 3, resolved: 0 } }, { domains: 0, names: 0 });
    assert.strictEqual(v.level, 'unknown');
  });

  test('both halves served from cache is ok, and the banner is hidden', () => {
    const { assessHealth } = load();
    const v = assessHealth(record(), { domains: 71, names: 68 });
    assert.strictEqual(v.level, 'ok');
    assert.strictEqual(v.headline, '', 'an ok verdict has nothing to announce');
  });

  test('both halves freshly fetched is ok', () => {
    const { assessHealth } = load();
    const v = assessHealth(
      record({ domains: half('fetch', 71), names: half('fetch', 68) }),
      { domains: 71, names: 68 }
    );
    assert.strictEqual(v.level, 'ok');
  });

  test('a completed fetch that returned ZERO names is a success, not a failure', () => {
    // A partner with no delegated-admin customers legitimately has none. This
    // is the false alarm the whole design is built to avoid: before 2.2.0 both
    // fetchers returned null for an empty result, making it indistinguishable
    // from a hard failure.
    const { assessHealth } = load();
    const v = assessHealth(
      record({ domains: half('fetch', 71), names: half('fetch', 0), rows: { injected: 0, resolved: 0 } }),
      { domains: 71, names: 0 }
    );
    assert.strictEqual(v.level, 'ok', 'count 0 with source fetch must not warn');
  });

  test('the absence of a token is not a warning when nothing was asked of it', () => {
    // Pure cache hit: no fetch, no token needed. tokens.gdap false must not
    // colour the verdict.
    const { assessHealth } = load();
    const v = assessHealth(record({ tokens: { partnerCenter: false, gdap: false } }), {
      domains: 71,
      names: 68,
    });
    assert.strictEqual(v.level, 'ok');
  });
});

describe('assessHealth — the transient case must stay quiet', () => {
  test('names awaiting a token is pending, never warn', () => {
    const { assessHealth } = load();
    const v = assessHealth(
      record({ names: half('awaiting', 0, 'no-token'), rows: { injected: 10, resolved: 3 } }),
      { domains: 71, names: 0 }
    );
    assert.strictEqual(v.level, 'pending', 'a token that has not arrived yet is not a failure');
    assert.match(v.headline, /display names are still loading/i);
    assert.strictEqual(v.hint, '', 'nothing for the user to do while it is still coming');
  });

  test('the same record once escalated to failed does warn', () => {
    // The grace window in content.js is what moves it; the verdict must follow.
    const { assessHealth } = load();
    const v = assessHealth(
      record({ names: half('failed', 0, 'no-token'), rows: { injected: 10, resolved: 3 } }),
      { domains: 71, names: 0 }
    );
    assert.strictEqual(v.level, 'warn');
  });
});

describe('assessHealth — a failed half warns and says why', () => {
  const REASONS = {
    'no-token': /did not provide a sign-in token/i,
    auth: /token had expired/i,
    network: /could not be sent/i,
    http: /returned an error/i,
    parse: /something unexpected/i,
  };

  for (const [reason, phrase] of Object.entries(REASONS)) {
    test('names failed with reason ' + reason + ' warns in plain words', () => {
      const { assessHealth } = load();
      const v = assessHealth(record({ names: half('failed', 0, reason) }), {
        domains: 71,
        names: 0,
      });
      assert.strictEqual(v.level, 'warn');
      assert.match(v.headline, /display names could not be loaded/i);
      assert.match(v.detail, phrase, 'the reason must be readable, not the enum');
      assert.doesNotMatch(v.detail, new RegExp(reason, 'i'),
        'the raw reason enum must not leak into the UI');
      assert.ok(v.hint.length, 'a warning without a remedy is half a warning');
    });
  }

  test('an unknown reason still produces a usable message', () => {
    const { assessHealth } = load();
    const v = assessHealth(record({ names: half('failed', 0, 'something-new') }), {
      domains: 71,
      names: 0,
    });
    assert.strictEqual(v.level, 'warn');
    assert.match(v.detail, /did not complete/i);
    assert.ok(v.hint.length);
  });

  test('the domains half failing names the domains half', () => {
    const { assessHealth } = load();
    const v = assessHealth(record({ domains: half('failed', 0, 'auth') }), {
      domains: 0,
      names: 68,
    });
    assert.strictEqual(v.level, 'warn');
    assert.match(v.headline, /customer domains could not be loaded/i);
    assert.doesNotMatch(v.headline, /display names/i);
  });

  test('both halves failing says so once, not twice', () => {
    const { assessHealth } = load();
    const v = assessHealth(
      record({ domains: half('failed', 0, 'auth'), names: half('failed', 0, 'auth') }),
      { domains: 0, names: 0 }
    );
    assert.strictEqual(v.level, 'warn');
    assert.match(v.headline, /no customer data could be loaded/i);
    assert.match(v.detail, /customer domains/i);
    assert.match(v.detail, /display names/i);
  });

  test('a partial half warns and reports what did arrive', () => {
    const { assessHealth } = load();
    const v = assessHealth(record({ names: half('partial', 40, 'network') }), {
      domains: 71,
      names: 0,
    });
    assert.strictEqual(v.level, 'warn');
    assert.match(v.headline, /could not be fully loaded/i);
    assert.match(v.detail, /only 40 arrived/i, 'the partial count is the useful part');
  });

  test('the detail does not repeat the headline back at the reader', () => {
    // Spotted in the 2.2.0 live test: the banner read "Display names could not
    // be loaded." and then, as its own detail, "Display names could not be
    // loaded — the page did not provide a sign-in token." One failing half is
    // already named by the headline, so the detail leads with the reason.
    const { assessHealth } = load();
    const v = assessHealth(record({ names: half('failed', 0, 'no-token') }), {
      domains: 71,
      names: 0,
    });
    assert.strictEqual(v.headline, 'Display names could not be loaded.');
    assert.ok(
      !v.detail.includes(v.headline),
      'the detail must not restate the headline verbatim: ' + v.detail
    );
    assert.match(v.detail, /^The page did not provide a sign-in token\./);
  });

  test('with BOTH halves broken the detail still says which is which', () => {
    // Here the headline cannot name them, so the per-half sentences stay.
    const { assessHealth } = load();
    const v = assessHealth(
      record({ domains: half('failed', 0, 'network'), names: half('failed', 0, 'auth') }),
      { domains: 0, names: 0 }
    );
    assert.match(v.detail, /Customer domains could not be loaded/);
    assert.match(v.detail, /Display names could not be loaded/);
  });
});

describe('assessHealth — the row tally is a fact, not always an alarm', () => {
  test('unresolved rows while both halves succeeded is NOT a warning', () => {
    // Non-transacted customers legitimately have neither a domain nor a
    // display name (constraint 5). Badging that trains the user to ignore the
    // badge, which costs more than it buys.
    const { assessHealth } = load();
    const v = assessHealth(
      record({ domains: half('fetch', 71), names: half('fetch', 68), rows: { injected: 10, resolved: 7 } }),
      { domains: 71, names: 68 }
    );
    assert.strictEqual(v.level, 'ok');
    assert.match(v.detail, /7 of 10 rows/, 'still reported, just not alarming');
  });

  test('unresolved rows alongside a failed half sharpen the warning', () => {
    const { assessHealth } = load();
    const v = assessHealth(
      record({ names: half('failed', 0, 'no-token'), rows: { injected: 10, resolved: 3 } }),
      { domains: 71, names: 0 }
    );
    assert.strictEqual(v.level, 'warn');
    assert.match(v.detail, /3 of 10 rows/);
  });

  test('a fully resolved page adds no row line', () => {
    const { assessHealth } = load();
    const v = assessHealth(record({ rows: { injected: 10, resolved: 10 } }), {
      domains: 71,
      names: 68,
    });
    assert.doesNotMatch(v.detail, /rows on the last page/);
  });

  test('a page with no rows yet adds no row line', () => {
    const { assessHealth } = load();
    const v = assessHealth(record({ rows: { injected: 0, resolved: 0 } }), {
      domains: 71,
      names: 68,
    });
    assert.doesNotMatch(v.detail, /rows on the last page/);
  });
});

describe('assessHealth — the literal 2.1.1 failure', () => {
  test('71 domains cached, names failed with no token, 3 of 10 rows resolved', () => {
    // The exact state 2.1.1 shipped while reporting loadState 'ready' and a
    // green "Cache rebuilt — 71 domain(s), 0 name(s).".
    const { assessHealth } = load();
    const v = assessHealth(
      {
        at: 1757505125990,
        domains: { source: 'cache', count: 71, reason: null },
        names: { source: 'failed', count: 0, reason: 'no-token' },
        rows: { injected: 10, resolved: 3 },
        tokens: { partnerCenter: true, gdap: false },
      },
      { domains: 71, names: 0 }
    );
    assert.strictEqual(v.level, 'warn', 'this is the release that must never be reported as fine');
    assert.match(v.headline, /display names/i, 'the message must name the half that failed');
    assert.match(v.detail, /3 of 10 rows/);
    assert.match(v.hint, /rebuild local cache/i);
  });
});

describe('healthTag — the compact form on the cache line', () => {
  test('nothing to say when both halves are fine', () => {
    const { healthTag } = load();
    assert.strictEqual(healthTag(record()), '');
    assert.strictEqual(healthTag(undefined), '');
  });

  test('names the failing halves', () => {
    const { healthTag } = load();
    assert.match(healthTag(record({ names: half('failed', 0, 'auth') })), /display names failed/);
    assert.match(healthTag(record({ domains: half('partial', 3, 'http') })), /domains incomplete/);
    assert.match(healthTag(record({ names: half('awaiting', 0, 'no-token') })), /still loading/);
  });
});

describe('renderHealth — the banner is hidden when all is well', () => {
  test('hidden for ok, shown and classed for warn and pending', () => {
    const t = load();
    t.renderHealth(record(), { domains: 71, names: 68 });
    assert.strictEqual(t.el('health').hidden, true, 'a permanent all-good box is a box nobody reads');

    t.renderHealth(record({ names: half('failed', 0, 'auth') }), { domains: 71, names: 0 });
    assert.strictEqual(t.el('health').hidden, false);
    assert.match(t.el('health').className, /warn/);
    assert.match(t.el('health-headline').textContent, /display names/i);
    assert.ok(t.el('health-hint').textContent.length);

    t.renderHealth(record({ names: half('awaiting', 0, 'no-token') }), { domains: 71, names: 0 });
    assert.match(t.el('health').className, /pending/);
    assert.doesNotMatch(t.el('health').className, /warn/);
  });
});

describe('describeRebuild — the 2.1.1 mis-report', () => {
  const okHalf = (count) => ({ ok: true, count, partial: false, reason: null });
  const badHalf = (reason, count, partial) => ({
    ok: false,
    count: count || 0,
    partial: !!partial,
    reason,
  });

  test('both halves complete reports success with both counts', () => {
    const { describeRebuild } = load();
    const r = describeRebuild({ ok: true, domains: okHalf(71), names: okHalf(68) });
    assert.strictEqual(r.kind, 'ok');
    assert.match(r.message, /71 domain\(s\), 68 name\(s\)/);
  });

  test('a completed rebuild that found zero names is still a success', () => {
    const { describeRebuild } = load();
    const r = describeRebuild({ ok: true, domains: okHalf(71), names: okHalf(0) });
    assert.strictEqual(r.kind, 'ok');
  });

  test('THE bug: 71 domains and a failed names half is never reported as ok', () => {
    const { describeRebuild } = load();
    const r = describeRebuild({ ok: false, domains: okHalf(71), names: badHalf('auth') });
    assert.strictEqual(r.kind, 'err', 'this exact case used to show a green tick');
    assert.match(r.message, /71 domain\(s\)/, 'what did work is still worth saying');
    assert.match(r.message, /display names failed/i);
    assert.match(r.message, /token had expired/i);
  });

  test('both halves failing reports a failure, not a rebuild', () => {
    const { describeRebuild } = load();
    const r = describeRebuild({
      ok: false,
      domains: badHalf('no-token'),
      names: badHalf('no-token'),
    });
    assert.strictEqual(r.kind, 'err');
    assert.match(r.message, /rebuild failed/i);
    assert.doesNotMatch(r.message, /rebuilt —/i);
  });

  test('a partial half is named as partial, with its count', () => {
    const { describeRebuild } = load();
    const r = describeRebuild({
      ok: false,
      domains: badHalf('network', 40, true),
      names: okHalf(68),
    });
    assert.strictEqual(r.kind, 'err');
    assert.match(r.message, /only partly loaded \(40\)/);
  });

  test('a reply with no per-half facts claims nothing', () => {
    // A malformed reply, or a content script older than 2.2.0 (which answered
    // with the maps themselves). Nothing is known, so neither success nor a
    // specific failure may be asserted.
    const { describeRebuild } = load();
    const oldShape = {
      ok: true,
      domains: { 'a1b2c3d4-e5f6-7890-abcd-ef1234567890': 'contoso.onmicrosoft.com' },
      names: {},
    };
    for (const bad of [undefined, null, {}, { ok: true }, oldShape]) {
      const r = describeRebuild(bad);
      assert.strictEqual(r.kind, 'err');
      assert.match(r.message, /could not be read/i);
      assert.doesNotMatch(r.message, /rebuilt/i, 'and it must not read as a success');
    }
  });
});

describe('the cache-key list (constraint 9)', () => {
  test('nameOverrides is not in CACHE_KEYS, and loadHealth is', () => {
    // nameOverrides is the one storage key with no server-side source of
    // truth: a rebuild that cleared it would destroy data permanently.
    // loadHealth is the opposite — derived, so it must never be left
    // describing a cache that has been deleted.
    const { CACHE_KEYS, OVERRIDE_KEY, HEALTH_KEY, CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY } = load();
    assert.ok(!CACHE_KEYS.includes(OVERRIDE_KEY), 'rebuild must never touch custom names');
    assert.ok(CACHE_KEYS.includes(HEALTH_KEY), 'stale health must not outlive the cache');
    for (const key of [CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY]) {
      assert.ok(CACHE_KEYS.includes(key), key + ' must be cleared by a rebuild');
    }
    assert.strictEqual(CACHE_KEYS.length, 4, 'a new cache key needs a decision, not a default');
  });
});

describe('refreshStatus — what a healthy popup still shows', () => {
  test('the cache line carries the counts, the health tag and the expiry', () => {
    const t = load({
      domainCache: { 'a1b2c3d4-e5f6-7890-abcd-ef1234567890': 'contoso.onmicrosoft.com' },
      displayNameCache: {},
      domainCacheExpiry: Date.now() + 86400000,
      loadHealth: record({ names: half('failed', 0, 'no-token') }),
    });
    t.refreshStatus();
    const line = t.el('cache-status').textContent;
    assert.match(line, /1 domain\(s\) \/ 0 display name\(s\) cached/);
    assert.match(line, /display names failed/);
    assert.match(line, /expires/);
    assert.strictEqual(t.el('health').hidden, false, 'and the banner is up');
  });

  test('an open popup follows the grace-window escalation', () => {
    // Open the popup during the amber "still loading" phase and it would
    // otherwise sit there saying so ~15s after the load had actually failed.
    const t = load({
      domainCache: { 'a1b2c3d4-e5f6-7890-abcd-ef1234567890': 'contoso.onmicrosoft.com' },
      domainCacheExpiry: Date.now() + 86400000,
      loadHealth: record({ names: half('awaiting', 0, 'no-token') }),
    });
    t.refreshStatus();
    assert.match(t.el('health').className, /pending/);

    // content.js escalates and writes the record; the popup is already open.
    t.store.loadHealth = record({ names: half('failed', 0, 'no-token') });
    t.fireStorageChange({ loadHealth: { newValue: t.store.loadHealth } });

    assert.match(t.el('health').className, /warn/, 'the banner follows the record');
    assert.match(t.el('health-headline').textContent, /could not be loaded/i);
  });

  test('an unrelated storage change does not re-read storage', () => {
    // The listener is narrowed to HEALTH_KEY on purpose: popup.js writes
    // nameOverrides on every import and the nav setting on every click, and
    // re-reading all five keys for each of those is pure waste. Asserting the
    // rendered output would prove nothing here — a redraw with an unchanged
    // record looks identical — so this counts the reads.
    const t = load({ loadHealth: record() });
    t.refreshStatus();
    const reads = t.chrome.calls.get.length;

    t.fireStorageChange({ nameOverrides: { newValue: {} } });
    t.fireStorageChange({ keepDefaultLinkBehaviour: { newValue: true } });
    assert.strictEqual(t.chrome.calls.get.length, reads, 'no re-read for keys we do not render');

    t.fireStorageChange({ loadHealth: { newValue: record() } });
    assert.strictEqual(t.chrome.calls.get.length, reads + 1, 'but a health change does re-read');
  });

  test('a change in another storage area is ignored', () => {
    const t = load({ loadHealth: record() });
    t.refreshStatus();
    const reads = t.chrome.calls.get.length;
    t.fireStorageChange({ loadHealth: { newValue: record() } }, 'sync');
    assert.strictEqual(t.chrome.calls.get.length, reads);
  });

  test('an expired cache says so and reports unknown rather than a failure', () => {
    const t = load({
      domainCache: { 'a1b2c3d4-e5f6-7890-abcd-ef1234567890': 'contoso.onmicrosoft.com' },
      domainCacheExpiry: Date.now() - 1000,
    });
    t.refreshStatus();
    assert.strictEqual(t.el('cache-status').textContent, 'No cached data');
    assert.match(t.el('health-headline').textContent, /no status yet/i);
  });
});
