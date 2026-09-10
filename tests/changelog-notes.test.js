/* tools/changelog-notes.js — the release-notes extractor.
 *
 * Why this is worth testing: .github/workflows/release.yml feeds the output
 * straight into `gh release create --notes-file`, so a bug here publishes a
 * wrong or empty release note to a public page, and a release cannot be
 * un-published cleanly once people have the link. The two failure modes that
 * matter are silent ones — an entry that absorbs older versions' bullets, and
 * an entry that resolves to nothing at all.
 *
 * Unlike the runtime files this is not a shipped IIFE, so it is required
 * directly rather than through tests/helpers/load-iife.js.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const notes = require('../tools/changelog-notes');

const CHANGELOG = path.join(__dirname, '..', 'docs', 'changelog.html');

/* A miniature changelog in exactly the real file's shape, including the
 * page <h1> before the entries and the extra <span class="tag"> that the
 * first-public-release heading carries. All data fictional. */
const FIXTURE = [
  '<h1 class="page-title">Changelog</h1>',
  '',
  '  <h2 id="v2-2-0">Version 2.2.0 <span class="date">1 October 2026</span></h2>',
  '  <ul>',
  '    <li>Added a <strong>health signal</strong> to the popup.</li>',
  '    <li><em>Under the hood:</em> reads <code>loadHealth</code> from storage.</li>',
  '    <li>See the <a href="https://example.invalid/x">notes</a> for detail.</li>',
  '  </ul>',
  '',
  '  <h2 id="v2-1-1">Version 2.1.1 <span class="date">10 September 2026</span></h2>',
  '  <ul>',
  '    <li>Fixed customers showing &quot;Unknown&quot; &mdash; a token moved.</li>',
  '  </ul>',
  '',
  '  <h2 id="v2-0-1">Version 2.0.1 <span class="date">1 July 2026</span><span class="tag">First public release</span></h2>',
  '  <ul>',
  '    <li>First release.</li>',
  '  </ul>',
].join('\n');

describe('versionToAnchor', () => {
  test('maps a dotted version onto the changelog anchor', () => {
    assert.strictEqual(notes.versionToAnchor('2.2.0'), 'v2-2-0');
    assert.strictEqual(notes.versionToAnchor(' 2.1.1 '), 'v2-1-1');
  });
});

describe('extractEntry', () => {
  test('pulls the version, date and bullets', () => {
    const entry = notes.extractEntry(FIXTURE, '2.2.0');
    assert.strictEqual(entry.version, '2.2.0');
    assert.strictEqual(entry.date, '1 October 2026');
    assert.strictEqual(entry.bullets.length, 3);
  });

  test('STOPS at the next entry instead of absorbing older versions', () => {
    // The whole point of the boundary: 2.2.0 must not inherit 2.1.1's bullet.
    const entry = notes.extractEntry(FIXTURE, '2.2.0');
    assert.strictEqual(entry.bullets.length, 3, 'exactly its own bullets');
    assert.ok(
      !entry.bullets.some((b) => b.includes('Unknown')),
      "2.1.1's bullet must not leak into 2.2.0"
    );
  });

  test('the oldest entry, with no following <h2>, still resolves', () => {
    const entry = notes.extractEntry(FIXTURE, '2.0.1');
    assert.deepStrictEqual(entry.bullets, ['First release.']);
  });

  test('an extra <span class="tag"> does not pollute the date', () => {
    assert.strictEqual(notes.extractEntry(FIXTURE, '2.0.1').date, '1 July 2026');
  });

  test('a missing version throws, naming the version and the anchor', () => {
    assert.throws(() => notes.extractEntry(FIXTURE, '9.9.9'), (err) => {
      assert.ok(err.message.includes('9.9.9'), 'names the version');
      assert.ok(err.message.includes('v9-9-9'), 'names the anchor it looked for');
      return true;
    });
  });

  test('an entry with no bullets throws rather than publishing empty notes', () => {
    const empty = '<h2 id="v3-0-0">Version 3.0.0</h2>\n<p>Coming soon.</p>';
    assert.throws(() => notes.extractEntry(empty, '3.0.0'), /no bullets/i);
  });

  test('a near-miss anchor is not matched', () => {
    // v2-2-0 must not be found by a request for 2.2 (anchor v2-2).
    assert.throws(() => notes.extractEntry(FIXTURE, '2.2'), /no entry for version 2\.2/);
  });
});

describe('toMarkdown', () => {
  test('converts the inline tags the changelog actually uses', () => {
    assert.strictEqual(notes.toMarkdown('a <strong>b</strong> c'), 'a **b** c');
    assert.strictEqual(notes.toMarkdown('<em>x</em>'), '*x*');
    assert.strictEqual(notes.toMarkdown('<code>y</code>'), '`y`');
    assert.strictEqual(
      notes.toMarkdown('<a href="https://example.invalid/p">here</a>'),
      '[here](https://example.invalid/p)'
    );
  });

  test('drops unknown tags but keeps their text', () => {
    assert.strictEqual(notes.toMarkdown('<span class="tag">kept</span>'), 'kept');
  });

  test('decodes entities and collapses whitespace', () => {
    assert.strictEqual(
      notes.toMarkdown('&quot;Unknown&quot;\n   &mdash;   moved'),
      '"Unknown" — moved'
    );
    assert.strictEqual(notes.toMarkdown('it&#39;s &amp; that'), "it's & that");
  });

  test('converts tags BEFORE decoding entities', () => {
    // Decoding first would make this a real tag and then strip it away.
    assert.strictEqual(notes.toMarkdown('use &lt;strong&gt; for bold'), 'use <strong> for bold');
  });

  test('an unrecognised entity is left alone rather than guessed', () => {
    assert.strictEqual(notes.toMarkdown('&notarealentity;'), '&notarealentity;');
  });
});

describe('renderNotes', () => {
  const entry = notes.extractEntry(FIXTURE, '2.2.0');

  test('renders a date line, one bullet per entry, and the changelog anchor', () => {
    const md = notes.renderNotes(entry);
    assert.ok(md.startsWith('Released 1 October 2026.'));
    assert.strictEqual(md.split('\n').filter((l) => l.startsWith('- ')).length, 3);
    assert.ok(md.includes('changelog.html#v2-2-0'), 'links back to the version anchor');
    assert.ok(md.endsWith('\n'), 'trailing newline for --notes-file');
  });

  test('names the zip only when one is supplied', () => {
    assert.ok(!notes.renderNotes(entry).includes('**Install:**'));
    const md = notes.renderNotes(entry, { zipName: 'pcan-2.2.0.zip' });
    assert.ok(md.includes('`pcan-2.2.0.zip`'));
    assert.ok(md.includes('chrome://extensions'));
  });
});

describe('the real docs/changelog.html', () => {
  const html = fs.readFileSync(CHANGELOG, 'utf8');
  const anchors = [...html.matchAll(/<h2[^>]*\sid="(v[\d-]+)"/gi)].map((m) => m[1]);

  test('has at least one version entry to read', () => {
    assert.ok(anchors.length > 0, 'no version anchors found — has the markup changed?');
  });

  test('every released version parses into non-empty notes', () => {
    for (const anchor of anchors) {
      const version = anchor.slice(1).replace(/-/g, '.');
      const entry = notes.extractEntry(html, version);
      assert.ok(entry.bullets.length > 0, version + ' has no bullets');
      assert.ok(entry.date, version + ' has no date');
      for (const bullet of entry.bullets) {
        assert.ok(!/[<>]/.test(bullet.replace(/&[a-z]+;/gi, '')), version + ': stray markup in "' + bullet + '"');
      }
    }
  });

  test('the current manifest version has an entry (the release gate)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
    );
    const entry = notes.extractEntry(html, manifest.version);
    assert.ok(entry.bullets.length > 0, 'manifest version ' + manifest.version + ' has empty notes');
  });
});
