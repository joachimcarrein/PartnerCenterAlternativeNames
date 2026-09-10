/* popup.js — export/import of `nameOverrides`.
 *
 * Why this file exists: `nameOverrides` is the one storage key with no
 * server-side source of truth (CLAUDE.md, Storage keys). Everything else
 * re-fetches from Microsoft in seconds; custom names exist only in the user's
 * browser. A bug here loses data permanently, so the import path — and
 * specifically its refusal to let a junk file wipe everything — is the highest
 * consequence logic in the extension.
 *
 * All tenant IDs and names below are fictional, per the repository's
 * no-real-customer-data rule.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadIife } = require('./helpers/load-iife');
const { plain, fakeDocument, fakeChrome, fakeFileReader, fakeWindow } = require('./helpers/stubs');

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID_B = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
const ID_C = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

const FORMAT_TYPE = 'partner-center-alternative-names';

function envelope(nameOverrides, over = {}) {
  return {
    type: FORMAT_TYPE,
    formatVersion: 1,
    extensionVersion: '2.1.1',
    exportedAt: '2026-09-10T09:14:22.115Z',
    count: Object.keys(nameOverrides || {}).length,
    nameOverrides,
    ...over,
  };
}

/* Load popup.js fresh, optionally with a file staged for import. */
function load({ store = {}, fileText = null, fileSize = 10, readerFails = false } = {}) {
  const chrome = fakeChrome(store);
  const doc = fakeDocument();
  const sandbox = loadIife(
    'src/popup.js',
    {
      chrome,
      document: doc,
      window: fakeWindow(),
      FileReader: fakeFileReader(fileText, readerFails),
      Blob: class {},
      confirm: () => true,
    },
    'globalThis.__t = { validateEnvelope, doImport, MAX_ENTRIES, MAX_NAME_LEN, FORMAT_TYPE, FORMAT_VER };'
  );
  return {
    ...sandbox.__t,
    chrome,
    store: chrome.store,
    calls: chrome.calls,
    status: () => doc.getElementById('status').textContent,
    importFile: (mode) => sandbox.__t.doImport({ size: fileSize }, mode),
  };
}

describe('validateEnvelope — structural gating', () => {
  test('rejects non-objects', () => {
    const { validateEnvelope } = load();
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      assert.throws(() => validateEnvelope(bad), /not a valid alternative-names file/i);
    }
  });

  test('rejects a foreign file type', () => {
    const { validateEnvelope } = load();
    assert.throws(
      () => validateEnvelope(envelope({}, { type: 'something-else' })),
      /not created by this extension/i
    );
  });

  test('rejects an unsupported formatVersion', () => {
    const { validateEnvelope } = load();
    assert.throws(() => validateEnvelope(envelope({}, { formatVersion: 2 })), /unsupported file format/i);
    // A missing version must not pass as "0 == undefined" or similar.
    assert.throws(() => validateEnvelope(envelope({}, { formatVersion: undefined })), /unsupported/i);
  });

  test('rejects a missing or non-object nameOverrides', () => {
    const { validateEnvelope } = load();
    for (const bad of [undefined, null, [], 'x']) {
      assert.throws(() => validateEnvelope(envelope(bad)), /no alternative names to import/i);
    }
  });

  test('rejects a file over the entry cap', () => {
    const { validateEnvelope, MAX_ENTRIES } = load();
    const big = {};
    for (let i = 0; i <= MAX_ENTRIES; i++) big['id-' + i] = 'n';
    assert.throws(() => validateEnvelope(envelope(big)), /too many entries/i);
  });
});

describe('validateEnvelope — per-entry validation', () => {
  test('keeps valid entries, lowercases ids and trims names', () => {
    const { validateEnvelope } = load();
    const { clean, skipped } = validateEnvelope(
      envelope({ [ID_A.toUpperCase()]: '  Acme Corporation  ' })
    );
    assert.deepStrictEqual(plain(clean), { [ID_A]: 'Acme Corporation' });
    assert.strictEqual(skipped, 0);
  });

  test('skips bad rows without failing the whole import', () => {
    const { validateEnvelope, MAX_NAME_LEN } = load();
    const { clean, skipped } = validateEnvelope(
      envelope({
        [ID_A]: 'Acme',
        'not-a-uuid': 'Contoso',
        [ID_B]: 42,
        [ID_C]: '   ',
        'd4e5f6a7-b8c9-0123-def0-456789012345': 'x'.repeat(MAX_NAME_LEN + 1),
      })
    );
    assert.deepStrictEqual(plain(clean), { [ID_A]: 'Acme' }, 'only the one good row survives');
    assert.strictEqual(skipped, 4);
  });

  test('accepts a name exactly at the length cap', () => {
    const { validateEnvelope, MAX_NAME_LEN } = load();
    const name = 'x'.repeat(MAX_NAME_LEN);
    const { clean, skipped } = validateEnvelope(envelope({ [ID_A]: name }));
    assert.strictEqual(clean[ID_A], name);
    assert.strictEqual(skipped, 0);
  });

  test('a structurally valid file can legitimately yield zero usable entries', () => {
    const { validateEnvelope } = load();
    const { clean, skipped } = validateEnvelope(envelope({ 'not-a-uuid': 'Acme' }));
    assert.deepStrictEqual(plain(clean), {});
    assert.strictEqual(skipped, 1);
  });
});

describe('doImport — replace-all must not be able to wipe everything', () => {
  test('REFUSES replace when the file has no usable entries', () => {
    const t = load({
      store: { nameOverrides: { [ID_A]: 'Acme', [ID_B]: 'Contoso' } },
      fileText: JSON.stringify(envelope({ 'not-a-uuid': 'Northwind' })),
    });
    t.importFile('replace');
    assert.match(t.status(), /refused/i);
    assert.deepStrictEqual(
      plain(t.store.nameOverrides),
      { [ID_A]: 'Acme', [ID_B]: 'Contoso' },
      'existing names must survive untouched'
    );
    assert.strictEqual(t.calls.set.length, 0, 'nothing may be written at all');
  });

  test('refuses merge with nothing usable, also without writing', () => {
    const t = load({
      store: { nameOverrides: { [ID_A]: 'Acme' } },
      fileText: JSON.stringify(envelope({ 'not-a-uuid': 'Northwind' })),
    });
    t.importFile('merge');
    assert.match(t.status(), /nothing usable/i);
    assert.strictEqual(t.calls.set.length, 0);
  });
});

describe('doImport — write semantics', () => {
  test('replace makes storage match the file exactly', () => {
    const t = load({
      store: { nameOverrides: { [ID_A]: 'Old Acme', [ID_C]: 'Tailspin' } },
      fileText: JSON.stringify(envelope({ [ID_A]: 'New Acme', [ID_B]: 'Contoso' })),
    });
    t.importFile('replace');
    assert.deepStrictEqual(plain(t.store.nameOverrides), { [ID_A]: 'New Acme', [ID_B]: 'Contoso' });
    assert.match(t.status(), /replaced all names/i);
  });

  test('merge lets imported entries win per tenant and leaves the rest alone', () => {
    const t = load({
      store: { nameOverrides: { [ID_A]: 'Old Acme', [ID_C]: 'Tailspin' } },
      fileText: JSON.stringify(envelope({ [ID_A]: 'New Acme', [ID_B]: 'Contoso' })),
    });
    t.importFile('merge');
    assert.deepStrictEqual(plain(t.store.nameOverrides), {
      [ID_A]: 'New Acme',
      [ID_B]: 'Contoso',
      [ID_C]: 'Tailspin',
    });
    assert.match(t.status(), /1 new, 1 updated/i);
  });

  test('writes in a single set() — never remove()+set(), so the data is never briefly empty', () => {
    for (const mode of ['merge', 'replace']) {
      const t = load({
        store: { nameOverrides: { [ID_C]: 'Tailspin' } },
        fileText: JSON.stringify(envelope({ [ID_A]: 'Acme' })),
      });
      t.importFile(mode);
      assert.strictEqual(t.calls.set.length, 1, `${mode}: exactly one write`);
      assert.strictEqual(t.calls.remove.length, 0, `${mode}: no remove`);
      assert.strictEqual(t.calls.clear, 0, `${mode}: no clear`);
      assert.ok('nameOverrides' in t.calls.set[0], `${mode}: the write carries the overrides`);
    }
  });

  test('reports skipped rows alongside a successful import', () => {
    const t = load({
      store: {},
      fileText: JSON.stringify(envelope({ [ID_A]: 'Acme', 'not-a-uuid': 'x' })),
    });
    t.importFile('merge');
    assert.match(t.status(), /1 skipped/i);
    assert.deepStrictEqual(plain(t.store.nameOverrides), { [ID_A]: 'Acme' });
  });
});

describe('doImport — malformed input', () => {
  test('rejects a file over the byte cap before reading it', () => {
    const t = load({ store: {}, fileText: 'irrelevant', fileSize: 1_048_577 });
    t.importFile('merge');
    assert.match(t.status(), /too large/i);
    assert.strictEqual(t.calls.set.length, 0);
  });

  test('rejects invalid JSON', () => {
    const t = load({ store: {}, fileText: '{ not json' });
    t.importFile('merge');
    assert.match(t.status(), /not valid json/i);
    assert.strictEqual(t.calls.set.length, 0);
  });

  test('surfaces a read failure', () => {
    const t = load({ store: {}, fileText: null, readerFails: true });
    t.importFile('merge');
    assert.match(t.status(), /could not read/i);
    assert.strictEqual(t.calls.set.length, 0);
  });

  test('an envelope error message reaches the user verbatim', () => {
    const t = load({
      store: { nameOverrides: { [ID_A]: 'Acme' } },
      fileText: JSON.stringify(envelope({}, { type: 'nope' })),
    });
    t.importFile('replace');
    assert.match(t.status(), /not created by this extension/i);
    assert.deepStrictEqual(plain(t.store.nameOverrides), { [ID_A]: 'Acme' });
  });
});
