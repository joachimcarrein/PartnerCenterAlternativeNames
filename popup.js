/* Partner Center Alternative Names — popup
 * Export/import of custom name overrides, and an on-demand cache rebuild.
 * Runs as an extension page, so it can read/write chrome.storage.local
 * directly and does not need the domain/display-name tokens content.js uses.
 *
 * Storage keys below are duplicated from content.js (no module system, no
 * build step). Keep the names identical in both files.
 */
(() => {
  'use strict';

  const OVERRIDE_KEY = 'nameOverrides';
  const CACHE_KEY = 'domainCache';
  const DISPLAYNAME_KEY = 'displayNameCache';
  const EXPIRY_KEY = 'domainCacheExpiry';
  // Never add OVERRIDE_KEY to this list — rebuild must not touch custom names.
  const CACHE_KEYS = [CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY];

  const GDAP_URL_GLOB =
    'https://partner.microsoft.com/dashboard/v2/customers/granularadminaccess/*';

  const FORMAT_TYPE = 'partner-center-alternative-names';
  const FORMAT_VER = 1;
  const MAX_FILE_BYTES = 1_048_576; // 1 MB
  const MAX_ENTRIES = 5000;
  const MAX_NAME_LEN = 200;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const overrideStatusEl = document.getElementById('override-status');
  const cacheStatusEl = document.getElementById('cache-status');
  const statusEl = document.getElementById('status');
  const fileInput = document.getElementById('file-input');

  let pendingImportMode = null; // 'merge' | 'replace', set right before the picker opens

  /* ------------------------------------------------------------------ */
  /* Status line rendering                                              */
  /* ------------------------------------------------------------------ */

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  function refreshStatus() {
    chrome.storage.local.get([OVERRIDE_KEY, CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY], (result) => {
      const overrides = (result && result[OVERRIDE_KEY]) || {};
      const count = Object.keys(overrides).length;
      overrideStatusEl.textContent =
        count === 1 ? '1 alternative name stored' : count + ' alternative names stored';

      const domains = (result && result[CACHE_KEY]) || {};
      const names = (result && result[DISPLAYNAME_KEY]) || {};
      const expiry = result && result[EXPIRY_KEY];
      const domainCount = Object.keys(domains).length;
      const nameCount = Object.keys(names).length;

      if (!expiry || Date.now() >= expiry || (!domainCount && !nameCount)) {
        cacheStatusEl.textContent = 'No cached data';
      } else {
        cacheStatusEl.textContent =
          domainCount + ' domain(s) / ' + nameCount + ' display name(s) cached · expires ' +
          new Date(expiry).toLocaleDateString();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                             */
  /* ------------------------------------------------------------------ */

  function doExport() {
    chrome.storage.local.get([OVERRIDE_KEY], (result) => {
      const overrides = (result && result[OVERRIDE_KEY]) || {};
      const entries = Object.entries(overrides);
      if (!entries.length) {
        setStatus('Nothing to export.', 'err');
        return;
      }

      const envelope = {
        type: FORMAT_TYPE,
        formatVersion: FORMAT_VER,
        extensionVersion: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        count: entries.length,
        nameOverrides: overrides,
      };

      const json = JSON.stringify(envelope, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'partner-center-alt-names-' + dateStr + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus('Exported ' + entries.length + ' name(s).', 'ok');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Import                                                             */
  /* ------------------------------------------------------------------ */

  // Validates the parsed envelope and returns { clean, skipped } where
  // `clean` is a { tenantId(lowercase): name } object of valid entries only.
  // Throws with a user-facing message on any structural problem.
  function validateEnvelope(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Not a valid alternative-names file.');
    }
    if (parsed.type !== FORMAT_TYPE) {
      throw new Error('This file was not created by this extension.');
    }
    if (parsed.formatVersion !== FORMAT_VER) {
      throw new Error('Unsupported file format version (' + parsed.formatVersion + ').');
    }
    const raw = parsed.nameOverrides;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('File has no alternative names to import.');
    }
    const rawEntries = Object.entries(raw);
    if (rawEntries.length > MAX_ENTRIES) {
      throw new Error('File has too many entries (max ' + MAX_ENTRIES + ').');
    }

    const clean = {};
    let skipped = 0;
    for (const [key, value] of rawEntries) {
      const id = String(key).toLowerCase();
      if (!UUID_RE.test(id)) {
        skipped++;
        continue;
      }
      if (typeof value !== 'string') {
        skipped++;
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > MAX_NAME_LEN) {
        skipped++;
        continue;
      }
      clean[id] = trimmed;
    }
    return { clean, skipped };
  }

  function doImport(file, mode) {
    if (file.size > MAX_FILE_BYTES) {
      setStatus('File is too large.', 'err');
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => setStatus('Could not read the file.', 'err');
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        setStatus('File is not valid JSON.', 'err');
        return;
      }

      let clean, skipped;
      try {
        ({ clean, skipped } = validateEnvelope(parsed));
      } catch (e) {
        setStatus(e.message, 'err');
        return;
      }

      const cleanCount = Object.keys(clean).length;
      if (mode === 'replace' && cleanCount === 0) {
        setStatus('Refused: file has no usable entries — replace-all would wipe everything.', 'err');
        return;
      }
      if (cleanCount === 0) {
        setStatus('Nothing usable in that file (' + skipped + ' skipped).', 'err');
        return;
      }

      chrome.storage.local.get([OVERRIDE_KEY], (result) => {
        const existing = (result && result[OVERRIDE_KEY]) || {};

        if (mode === 'replace') {
          const removed = Object.keys(existing).filter((id) => !(id in clean)).length;
          chrome.storage.local.set({ [OVERRIDE_KEY]: clean }, () => {
            let msg = 'Replaced all names — ' + cleanCount + ' stored';
            if (skipped) msg += ', ' + skipped + ' skipped (invalid)';
            if (removed) msg += ' (' + removed + ' removed)';
            setStatus(msg + '.', 'ok');
            refreshStatus();
          });
        } else {
          let updated = 0;
          let added = 0;
          for (const id of Object.keys(clean)) {
            if (id in existing) updated++;
            else added++;
          }
          const merged = { ...existing, ...clean };
          chrome.storage.local.set({ [OVERRIDE_KEY]: merged }, () => {
            let msg = 'Imported ' + cleanCount + ' name(s) — ' + added + ' new, ' + updated + ' updated';
            if (skipped) msg += ', ' + skipped + ' skipped (invalid)';
            setStatus(msg + '.', 'ok');
            refreshStatus();
          });
        }
      });
    };
    reader.readAsText(file);
  }

  function startImport(mode) {
    if (mode === 'replace') {
      chrome.storage.local.get([OVERRIDE_KEY], (result) => {
        const existing = (result && result[OVERRIDE_KEY]) || {};
        const count = Object.keys(existing).length;
        if (count > 0) {
          const ok = window.confirm(
            'Replace all ' + count + ' stored name(s) with the contents of this file?'
          );
          if (!ok) return;
        }
        pendingImportMode = mode;
        fileInput.click();
      });
    } else {
      pendingImportMode = mode;
      fileInput.click();
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    const mode = pendingImportMode;
    fileInput.value = '';
    pendingImportMode = null;
    if (file && mode) doImport(file, mode);
  });

  /* ------------------------------------------------------------------ */
  /* Cache rebuild                                                      */
  /* ------------------------------------------------------------------ */

  function doRebuild() {
    setStatus('Rebuilding…', '');
    chrome.storage.local.remove(CACHE_KEYS, () => {
      chrome.tabs.query({ url: GDAP_URL_GLOB }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          setStatus('Cache cleared. Open the Partner Center tab to rebuild it.', 'ok');
          refreshStatus();
          return;
        }

        chrome.tabs.sendMessage(tab.id, { type: 'ALTNAME_REBUILD_CACHE' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            setStatus('Cache cleared. Refresh the Partner Center tab to rebuild it.', 'ok');
            refreshStatus();
            return;
          }
          if (!response.ok) {
            setStatus(
              'Cache cleared, but the refetch failed — sign in again on the Partner Center page and refresh.',
              'err'
            );
            refreshStatus();
            return;
          }
          const domainCount = response.domains ? Object.keys(response.domains).length : 0;
          const nameCount = response.names ? Object.keys(response.names).length : 0;
          setStatus('Cache rebuilt — ' + domainCount + ' domain(s), ' + nameCount + ' name(s).', 'ok');
          refreshStatus();
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Clear everything (cache AND custom names)                          */
  /* ------------------------------------------------------------------ */

  // Deliberately separate from doRebuild(): this is the one action in the
  // popup that is allowed to delete nameOverrides. It resets the extension
  // to a blank-install state, on purpose, on explicit user confirmation.
  function doClearAll() {
    chrome.storage.local.get([OVERRIDE_KEY], (result) => {
      const existing = (result && result[OVERRIDE_KEY]) || {};
      const count = Object.keys(existing).length;
      const warning =
        count > 0
          ? 'Clear ALL local data, including ' + count + ' custom name(s)? ' +
            'This cannot be undone unless you’ve exported them.'
          : 'Clear all local data (there are no custom names stored right now)?';
      if (!window.confirm(warning)) return;

      chrome.storage.local.clear(() => {
        chrome.tabs.query({ url: GDAP_URL_GLOB }, (tabs) => {
          const tab = tabs && tabs[0];
          if (tab) {
            // Best-effort live reset of an open tab; storage is already wiped
            // either way, so a missing/orphaned receiver isn't an error here.
            chrome.tabs.sendMessage(tab.id, { type: 'ALTNAME_CLEAR_ALL' }, () => {
              void chrome.runtime.lastError;
            });
          }
          setStatus('Cleared all local data. Refresh the Partner Center tab to start fresh.', 'ok');
          refreshStatus();
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */

  document.getElementById('btn-export').addEventListener('click', doExport);
  document.getElementById('btn-import-merge').addEventListener('click', () => startImport('merge'));
  document.getElementById('btn-import-replace').addEventListener('click', () => startImport('replace'));
  document.getElementById('btn-rebuild').addEventListener('click', doRebuild);
  document.getElementById('btn-clear-all').addEventListener('click', doClearAll);

  refreshStatus();
})();
