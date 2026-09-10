/* search-inject.js — the MAIN-world OData $filter rewriter.
 *
 * Why this file exists: the page's customer search is 100% server-side and the
 * API only knows displayName/tenantId, so making alternative names searchable
 * means rewriting the outgoing $filter by hand (CLAUDE.md, constraint 6).
 * Every limit in here was found the hard way and is load-bearing:
 *
 *   - The API rejects filters past an OData AST node-count limit of 30, so the
 *     OR group must be FLAT (strip the base filter's outer parens) and capped
 *     at MAX_CLAUSES appended clauses.
 *   - Past the cap, expansion is skipped entirely: the user still gets normal
 *     displayName results rather than a red "Something went wrong" banner.
 *   - Only user overrides are searchable, never domains — domains over-match
 *     badly and blow the node limit.
 *
 * Failure here is silent (a customer quietly stops being findable) or a broken
 * search, so it is worth pinning down. All data below is fictional.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadIife } = require('./helpers/load-iife');
const { fakeWindow, fakeXhr } = require('./helpers/stubs');

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID_B = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
const ID_C = 'c3d4e5f6-a7b8-9012-cdef-345678901234';
const ID_D = 'd4e5f6a7-b8c9-0123-def0-456789012345';
const ID_E = 'e5f6a7b8-c9d0-1234-ef01-567890123456';

const HOST = 'https://api.partnercustomersecurity.microsoft.com';
const PATH = '/CustomerServiceAdminApi/Web/v1/delegatedAdminGdapCustomers';

/* The shape React actually sends: one parenthesised group of contains()
 * clauses over displayName. */
function baseFilter(query) {
  const q = String(query).replace(/'/g, "''");
  return `(contains(tolower(displayName), tolower('${q}')) or contains(tolower(tenantId), tolower('${q}')))`;
}

function searchUrl(query, extraParams = '$orderby=displayName&$count=true') {
  return `${HOST}${PATH}?$filter=${encodeURIComponent(baseFilter(query))}&${extraParams}`;
}

/* Load search-inject.js and hand it an alt-name index over the real bridge
 * listener, exactly as content.js would. */
function load(index = []) {
  const window = fakeWindow();
  const XHR = fakeXhr();
  const sandbox = loadIife(
    'search-inject.js',
    { window, XMLHttpRequest: XHR, Headers: undefined, Request: undefined },
    'globalThis.__t = { rewriteUrl, extractQuery, matchingTenantIds, isTargetUrl, readAuthHeader, MAX_CLAUSES, TARGET_HOST };'
  );
  if (index.length) {
    window.dispatch({ __altnameBridge: true, kind: 'INDEX', payload: index });
  }
  return { ...sandbox.__t, window, XHR, sandbox };
}

/* Read the decoded $filter back out of a rewritten URL. */
function filterOf(url) {
  const m = /[?&]\$filter=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
}

describe('the bridge feeds the index', () => {
  test('an INDEX message is what makes matching possible at all', () => {
    const t = load();
    assert.deepStrictEqual([...t.matchingTenantIds('acme')], [], 'no index yet -> no matches');
    t.window.dispatch({ __altnameBridge: true, kind: 'INDEX', payload: [[ID_A, 'acme corporation']] });
    assert.deepStrictEqual([...t.matchingTenantIds('acme')], [ID_A]);
  });

  test('a message from another source is ignored', () => {
    const t = load();
    t.window.dispatch({ __altnameBridge: true, kind: 'INDEX', payload: [[ID_A, 'acme']] }, {});
    assert.deepStrictEqual([...t.matchingTenantIds('acme')], [], 'foreign source must not be trusted');
  });

  test('it asks content.js for the index on load', () => {
    const t = load();
    assert.ok(
      t.window.posted.some((m) => m && m.kind === 'REQUEST_INDEX'),
      'content.js may have loaded first and already published'
    );
  });
});

describe('extractQuery', () => {
  test('pulls the search text out of the displayName clause', () => {
    const t = load();
    assert.strictEqual(t.extractQuery(baseFilter('acme')), 'acme');
  });

  test("un-doubles OData's escaped single quotes", () => {
    const t = load();
    // OData escapes ' as '' — o''brien on the wire means o'brien.
    assert.strictEqual(t.extractQuery(baseFilter("o'brien")), "o'brien");
  });

  test('returns null when there is no tolower() literal', () => {
    const t = load();
    assert.strictEqual(t.extractQuery('startswith(displayName, 1)'), null);
  });
});

describe('matchingTenantIds', () => {
  test('matches on substring, case-insensitively', () => {
    const t = load([[ID_A, 'acme corporation'], [ID_B, 'contoso ltd']]);
    assert.deepStrictEqual([...t.matchingTenantIds('CORP')], [ID_A]);
    assert.deepStrictEqual([...t.matchingTenantIds('  ContoSo ')], [ID_B]);
  });

  test('an empty or whitespace query matches nothing', () => {
    const t = load([[ID_A, 'acme']]);
    assert.deepStrictEqual([...t.matchingTenantIds('')], []);
    assert.deepStrictEqual([...t.matchingTenantIds('   ')], []);
  });
});

describe('rewriteUrl — when it must decline', () => {
  test('leaves other hosts alone', () => {
    const t = load([[ID_A, 'acme']]);
    assert.strictEqual(t.rewriteUrl(`https://api.partnercenter.microsoft.com/v1/customers?$filter=${encodeURIComponent(baseFilter('acme'))}`), null);
    assert.strictEqual(t.rewriteUrl('https://example.com/?$filter=' + encodeURIComponent(baseFilter('acme'))), null);
  });

  test('ignores non-string input and URLs with no query string', () => {
    const t = load([[ID_A, 'acme']]);
    for (const bad of [null, undefined, 42, {}]) assert.strictEqual(t.rewriteUrl(bad), null);
    assert.strictEqual(t.rewriteUrl(HOST + PATH), null);
  });

  test('ignores requests to the same host that carry no $filter', () => {
    const t = load([[ID_A, 'acme']]);
    assert.strictEqual(t.rewriteUrl(`${HOST}${PATH}?$count=true`), null);
  });

  test('never touches a filter that is not the customer search', () => {
    const t = load([[ID_A, 'acme']]);
    const other = `${HOST}${PATH}?$filter=${encodeURIComponent("contains(tolower(somethingElse), tolower('acme'))")}`;
    assert.strictEqual(t.rewriteUrl(other), null, 'no displayName in the filter -> not ours');
  });

  test('declines when nothing in the index matches', () => {
    const t = load([[ID_A, 'acme']]);
    assert.strictEqual(t.rewriteUrl(searchUrl('northwind')), null);
  });

  test('declines when there is no index at all', () => {
    const t = load();
    assert.strictEqual(t.rewriteUrl(searchUrl('acme')), null);
  });
});

describe('rewriteUrl — the OData node limit', () => {
  test('expands up to and including MAX_CLAUSES matches', () => {
    const t = load();
    const ids = [ID_A, ID_B, ID_C, ID_D, ID_E];
    const index = ids.slice(0, t.MAX_CLAUSES).map((id) => [id, 'shared label']);
    t.window.dispatch({ __altnameBridge: true, kind: 'INDEX', payload: index });

    const out = t.rewriteUrl(searchUrl('shared'));
    assert.ok(out, 'exactly MAX_CLAUSES matches must still expand');
    const filter = filterOf(out);
    for (const id of index.map((e) => e[0])) {
      assert.ok(filter.includes(`tenantId eq '${id}'`), `clause for ${id} present`);
    }
    assert.strictEqual(
      (filter.match(/tenantId eq '/g) || []).length,
      t.MAX_CLAUSES,
      'no more clauses than the cap'
    );
  });

  test('SKIPS expansion past the cap rather than sending a filter the API rejects', () => {
    const t = load();
    const index = [ID_A, ID_B, ID_C, ID_D, ID_E].map((id) => [id, 'shared label']);
    assert.ok(index.length > t.MAX_CLAUSES);
    t.window.dispatch({ __altnameBridge: true, kind: 'INDEX', payload: index });

    assert.strictEqual(
      t.rewriteUrl(searchUrl('shared')),
      null,
      'over the cap must degrade to normal results, never an error banner'
    );
  });
});

describe('rewriteUrl — the rewritten filter', () => {
  test('builds ONE flat OR group, not a nested one', () => {
    const t = load([[ID_A, 'acme corporation']]);
    const filter = filterOf(t.rewriteUrl(searchUrl('acme')));

    assert.ok(filter.startsWith('('), 'wrapped in a single group');
    assert.ok(filter.endsWith(')'));
    assert.ok(!filter.startsWith('(('), 'the base filter\'s own parens must be stripped, not nested');
    // A flat group has exactly one open and one close paren at the edges.
    assert.strictEqual(filter.indexOf('('), 0);
    assert.strictEqual(filter.lastIndexOf(')'), filter.length - 1);
    assert.ok(filter.includes(`OR tenantId eq '${ID_A}'`));
  });

  test('keeps the original displayName clauses intact', () => {
    const t = load([[ID_A, 'acme corporation']]);
    const filter = filterOf(t.rewriteUrl(searchUrl('acme')));
    assert.ok(filter.includes("contains(tolower(displayName), tolower('acme'))"));
  });

  test('leaves every other query parameter byte-identical', () => {
    const t = load([[ID_A, 'acme corporation']]);
    const url = searchUrl('acme', '$orderby=displayName&$count=true&$top=25');
    const out = t.rewriteUrl(url);

    const others = (u) => u.slice(u.indexOf('?') + 1).split('&').filter((p) => !p.startsWith('$filter='));
    assert.deepStrictEqual(others(out), others(url), 'untouched params must not be re-encoded');
  });

  test('re-encodes the new $filter (spaces as %20, safe for OData)', () => {
    const t = load([[ID_A, 'acme corporation']]);
    const out = t.rewriteUrl(searchUrl('acme'));
    const raw = /[?&]\$filter=([^&]*)/.exec(out)[1];
    assert.ok(!raw.includes(' '), 'no literal spaces');
    assert.ok(!raw.includes('+'), 'spaces encoded as %20, not +');
    assert.ok(raw.includes('%20'));
  });

  test('a query containing a single quote survives the round trip', () => {
    const t = load([[ID_A, "o'brien holdings"]]);
    const out = t.rewriteUrl(searchUrl("o'brien"));
    assert.ok(out, "an apostrophe in the query must still expand");
    assert.ok(filterOf(out).includes(`tenantId eq '${ID_A}'`));
  });
});

describe('rewriteUrl is wired into the page network calls', () => {
  test('XMLHttpRequest.open receives the rewritten URL', () => {
    const t = load([[ID_A, 'acme corporation']]);
    const xhr = new t.XHR();
    xhr.open('GET', searchUrl('acme'));

    const seen = t.XHR.seen.opened.at(-1).url;
    assert.ok(seen.includes(encodeURIComponent("tenantId eq '")) || filterOf(seen).includes(`tenantId eq '${ID_A}'`),
      'the URL the page actually opens must carry the expansion');
  });

  test('a non-search XHR passes through unchanged', () => {
    const t = load([[ID_A, 'acme']]);
    const url = 'https://example.com/whatever?a=1';
    const xhr = new t.XHR();
    xhr.open('GET', url);
    assert.strictEqual(t.XHR.seen.opened.at(-1).url, url);
  });
});
