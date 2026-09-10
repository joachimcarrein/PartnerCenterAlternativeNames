/* Extracts one version's entry from docs/changelog.html and renders it as
 * Markdown, for use as a GitHub release body.
 *
 * This is CI tooling, not a shipped file. build.ps1 packs from an explicit
 * allowlist, so nothing under tools/ can reach the extension — which is why
 * this file may use a plain module.exports, unlike the runtime files
 * (CLAUDE.md, "How tests reach the code", forbids export footers there).
 *
 * The changelog is hand-written HTML in a fixed shape:
 *
 *   <h2 id="v2-1-1">Version 2.1.1 <span class="date">10 September 2026</span></h2>
 *   <ul>
 *     <li>…</li>
 *   </ul>
 *
 * One entry per version, newest first, never rewritten once released. A small
 * regex reader is therefore enough, and the repo has no dependencies to spend
 * on an HTML parser.
 *
 * Usage: node tools/changelog-notes.js 2.2.0 [path/to/changelog.html]
 */
'use strict';

const fs = require('node:fs');

const CHANGELOG_URL =
  'https://joachimcarrein.github.io/PartnerCenterAlternativeNames/changelog.html';

// Only the entities the changelog actually uses, plus the five that must
// always be handled. Anything unrecognised is left as-is rather than guessed.
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&middot;': '·',
};

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// '2.1.1' -> 'v2-1-1', the anchor docs/changelog.html uses for that version.
function versionToAnchor(version) {
  return 'v' + String(version).trim().replace(/\./g, '-');
}

// Each match is replaced exactly once, so '&amp;#39;' decodes to the literal
// '&#39;' rather than being decoded twice down to an apostrophe.
function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => {
      const key = m.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

// Inline HTML -> Markdown. Tags are converted BEFORE entities are decoded:
// decoding first would turn a literal '&lt;strong&gt;' in the prose into a
// real tag, which the tag-stripping pass would then eat.
function toMarkdown(fragment) {
  const converted = String(fragment)
    .replace(/<\s*(strong|b)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '**$2**')
    .replace(/<\s*(em|i)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '*$2*')
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, '`$1`')
    .replace(/<a[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, ''); // drop everything else, e.g. <span class="tag">
  return decodeEntities(converted).replace(/\s+/g, ' ').trim();
}

// -> { version, date, bullets: [markdown] }. Throws with a message aimed at
// whoever forgot the changelog entry, since CI surfaces it verbatim.
function extractEntry(html, version) {
  const anchor = versionToAnchor(version);
  const openTag = new RegExp('<h2[^>]*\\sid="' + escapeRegExp(anchor) + '"[^>]*>', 'i');
  const found = openTag.exec(String(html));
  if (!found) {
    throw new Error(
      'docs/changelog.html has no entry for version ' + version + ' (looked for ' +
        '<h2 id="' + anchor + '">). Every version bump needs a changelog entry ' +
        'in the same change — see CLAUDE.md, Repository conventions.'
    );
  }

  const rest = String(html).slice(found.index + found[0].length);
  const headingEnd = rest.search(/<\s*\/\s*h2\s*>/i);
  if (headingEnd === -1) {
    throw new Error('Malformed changelog: the <h2> for ' + version + ' is never closed.');
  }
  const heading = rest.slice(0, headingEnd);
  const afterHeading = rest.slice(headingEnd);

  // Stop at the next entry, or the rest of the file for the oldest one.
  // Without this boundary an entry would absorb every older entry's bullets.
  const nextEntry = afterHeading.search(/<h2[\s>]/i);
  const body = nextEntry === -1 ? afterHeading : afterHeading.slice(0, nextEntry);

  const dateMatch = /<span[^>]*class="date"[^>]*>([\s\S]*?)<\s*\/\s*span\s*>/i.exec(heading);
  const date = dateMatch ? toMarkdown(dateMatch[1]) : null;

  const bullets = [];
  const li = /<li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi;
  let item;
  while ((item = li.exec(body)) !== null) {
    const text = toMarkdown(item[1]);
    if (text) bullets.push(text);
  }
  if (!bullets.length) {
    throw new Error(
      'The changelog entry for ' + version + ' has no bullets. Refusing to ' +
        'publish a release with empty notes.'
    );
  }

  return { version: String(version).trim(), date, bullets };
}

function renderNotes(entry, options) {
  const opts = options || {};
  const out = [];
  if (entry.date) out.push('Released ' + entry.date + '.', '');
  for (const bullet of entry.bullets) out.push('- ' + bullet);
  out.push('');
  if (opts.zipName) {
    out.push(
      '**Install:** download `' + opts.zipName + '` below, unzip it, then load the ' +
        'unzipped folder at `chrome://extensions` with Developer mode turned on.'
    );
    out.push('');
  }
  out.push(
    '[Full changelog](' + (opts.changelogUrl || CHANGELOG_URL) + '#' +
      versionToAnchor(entry.version) + ')'
  );
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports = {
  CHANGELOG_URL,
  versionToAnchor,
  decodeEntities,
  toMarkdown,
  extractEntry,
  renderNotes,
};

if (require.main === module) {
  const version = process.argv[2];
  const file = process.argv[3] || 'docs/changelog.html';
  if (!version) {
    process.stderr.write('usage: node tools/changelog-notes.js <version> [changelog.html]\n');
    process.exit(2);
  }
  const html = fs.readFileSync(file, 'utf8');
  const entry = extractEntry(html, version);
  process.stdout.write(
    renderNotes(entry, {
      zipName: 'partner-center-alternative-names-' + entry.version + '.zip',
    })
  );
}
