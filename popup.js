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
  const HEALTH_KEY = 'loadHealth'; // last-load facts written by content.js
  const NAV_SETTING_KEY = 'keepDefaultLinkBehaviour'; // default true; see content.js
  // Never add OVERRIDE_KEY to this list — rebuild must not touch custom names.
  // HEALTH_KEY does belong here: it is derived data with a server-side source
  // of truth, so it must never be left describing a cache that was deleted.
  const CACHE_KEYS = [CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY, HEALTH_KEY];

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
  const keepDefaultLinkChk = document.getElementById('chk-keep-default-link');
  const healthEl = document.getElementById('health');
  const healthHeadlineEl = document.getElementById('health-headline');
  const healthDetailEl = document.getElementById('health-detail');
  const healthHintEl = document.getElementById('health-hint');

  let pendingImportMode = null; // 'merge' | 'replace', set right before the picker opens

  /* ------------------------------------------------------------------ */
  /* Status line rendering                                              */
  /* ------------------------------------------------------------------ */

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  /* ------------------------------------------------------------------ */
  /* Health — turning content.js's facts into something to read         */
  /* ------------------------------------------------------------------ */
  //
  // The judgement lives here and ONLY here. content.js records facts (counts,
  // sources, a reason enum) and never a verdict or a user-facing string,
  // because with no module system a verdict computed there and rendered here
  // would need its wording in both files and would drift. Facts do not drift,
  // and this way the testable part is the pure function.

  // Plain words, no enum leaking into the UI.
  const REASON_PHRASE = {
    'no-token': 'the page did not provide a sign-in token',
    auth: 'the sign-in token had expired',
    network: 'the request could not be sent',
    http: 'Microsoft’s API returned an error',
    parse: 'Microsoft’s API returned something unexpected',
  };
  const REASON_HINT = {
    'no-token': 'Refresh the Partner Center tab, then use Rebuild local cache.',
    auth: 'Refresh the Partner Center tab, then use Rebuild local cache.',
    network: 'Try Rebuild local cache.',
    http: 'Try Rebuild local cache; Microsoft’s API may be having trouble.',
    parse: 'Try Rebuild local cache; Microsoft’s API may be having trouble.',
  };

  function reasonPhrase(reason) {
    return REASON_PHRASE[reason] || 'the lookup did not complete';
  }

  function reasonHint(reason) {
    return REASON_HINT[reason] || 'Try Rebuild local cache.';
  }

  function brokenHalf(half) {
    return !!half && (half.source === 'failed' || half.source === 'partial');
  }

  // Used when BOTH halves are broken, where the detail has to say which is
  // which because the headline cannot.
  function halfSentence(label, half) {
    if (half.source === 'partial') {
      return label + ' loaded only partly (' + (half.count || 0) + ' so far) — ' +
        reasonPhrase(half.reason) + '.';
    }
    return label + ' could not be loaded — ' + reasonPhrase(half.reason) + '.';
  }

  // Used when only ONE half is broken: the headline already named it, so the
  // detail leads with the reason instead of repeating the headline verbatim.
  function reasonSentence(half) {
    const phrase = reasonPhrase(half.reason);
    const lead = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    if (half.source === 'partial') return lead + ' — only ' + (half.count || 0) + ' arrived.';
    return lead + '.';
  }

  // record: the stored loadHealth, or undefined on a fresh install.
  // counts:  { domains, names } actually in the cache right now.
  // -> { level, headline, detail, hint }, level 'ok' | 'pending' | 'warn' | 'unknown'.
  //
  // Two lines in here are deliberate and load-bearing:
  //   - source 'fetch' with count 0 is a SUCCESS. A partner with no
  //     delegated-admin customers legitimately has zero display names.
  //   - an unresolved row while both halves succeeded is NOT a warning.
  //     Non-transacted customers legitimately have neither a domain nor a
  //     display name (constraint 5), and badging that would teach the user to
  //     ignore the badge.
  function assessHealth(record, counts) {
    const stored = counts || {};
    const storedLine =
      'Currently stored: ' + (stored.domains || 0) + ' domain(s), ' +
      (stored.names || 0) + ' display name(s).';

    if (!record || !record.domains || !record.names) {
      return {
        level: 'unknown',
        headline: 'No status yet — open the Partner Center page.',
        detail: 'The result of the last data load is reported here.',
        hint: '',
      };
    }

    const rows = record.rows || {};
    const injected = Number(rows.injected) || 0;
    const resolved = Number(rows.resolved) || 0;
    const rowLine =
      injected && resolved < injected
        ? 'Only ' + resolved + ' of ' + injected + ' rows on the last page showed a name.'
        : '';

    const badDomains = brokenHalf(record.domains);
    const badNames = brokenHalf(record.names);

    if (badDomains || badNames) {
      const parts = [];
      let headline;
      if (badDomains && badNames) {
        headline = 'No customer data could be loaded.';
        parts.push(halfSentence('Customer domains', record.domains));
        parts.push(halfSentence('Display names', record.names));
      } else if (badNames) {
        headline =
          record.names.source === 'partial'
            ? 'Display names could not be fully loaded.'
            : 'Display names could not be loaded.';
        parts.push(reasonSentence(record.names));
      } else {
        headline =
          record.domains.source === 'partial'
            ? 'Customer domains could not be fully loaded.'
            : 'Customer domains could not be loaded.';
        parts.push(reasonSentence(record.domains));
      }
      if (rowLine) parts.push(rowLine);
      parts.push(storedLine);
      return {
        level: 'warn',
        headline,
        detail: parts.join(' '),
        hint: reasonHint(badNames ? record.names.reason : record.domains.reason),
      };
    }

    // 'awaiting' is the transient case: the GDAP token often arrives after
    // content.js has already looked for it. Never a warning — content.js
    // escalates to 'failed' itself if it never turns up.
    if (record.names.source === 'awaiting' || record.domains.source === 'awaiting') {
      const which = record.names.source === 'awaiting' ? 'Display names' : 'Customer domains';
      return {
        level: 'pending',
        headline: which + ' are still loading.',
        detail:
          'The Partner Center page has not handed over the sign-in detail this lookup ' +
          'needs yet. It normally arrives within seconds of opening the page.',
        hint: '',
      };
    }

    const okParts = [storedLine];
    if (rowLine) okParts.push(rowLine);
    return { level: 'ok', headline: '', detail: okParts.join(' '), hint: '' };
  }

  // The compact form for the cache line — the banner is hidden when all is
  // well, so this is what a healthy popup still shows.
  function healthTag(record) {
    if (!record || !record.domains || !record.names) return '';
    const tags = [];
    if (record.domains.source === 'failed') tags.push('domains failed');
    else if (record.domains.source === 'partial') tags.push('domains incomplete');
    if (record.names.source === 'failed') tags.push('display names failed');
    else if (record.names.source === 'partial') tags.push('display names incomplete');
    else if (record.names.source === 'awaiting') tags.push('display names still loading');
    return tags.join(', ');
  }

  function renderHealth(record, counts) {
    const verdict = assessHealth(record, counts);
    // Hidden entirely when everything is fine: a permanent "all good" box is a
    // box nobody reads, which would defeat the point of having one at all.
    if (verdict.level === 'ok') {
      healthEl.hidden = true;
      return verdict;
    }
    healthEl.hidden = false;
    healthEl.className = 'panel ' + verdict.level;
    healthHeadlineEl.textContent = verdict.headline;
    healthDetailEl.textContent = verdict.detail;
    healthHintEl.textContent = verdict.hint;
    return verdict;
  }

  function refreshStatus() {
    chrome.storage.local.get(
      [OVERRIDE_KEY, CACHE_KEY, DISPLAYNAME_KEY, EXPIRY_KEY, HEALTH_KEY],
      (result) => {
        const overrides = (result && result[OVERRIDE_KEY]) || {};
        const count = Object.keys(overrides).length;
        overrideStatusEl.textContent =
          count === 1 ? '1 alternative name stored' : count + ' alternative names stored';

        const domains = (result && result[CACHE_KEY]) || {};
        const names = (result && result[DISPLAYNAME_KEY]) || {};
        const expiry = result && result[EXPIRY_KEY];
        const domainCount = Object.keys(domains).length;
        const nameCount = Object.keys(names).length;
        const record = result && result[HEALTH_KEY];

        if (!expiry || Date.now() >= expiry || (!domainCount && !nameCount)) {
          cacheStatusEl.textContent = 'No cached data';
        } else {
          const tag = healthTag(record);
          cacheStatusEl.textContent =
            domainCount + ' domain(s) / ' + nameCount + ' display name(s) cached' +
            (tag ? ' · ' + tag : '') +
            ' · expires ' + new Date(expiry).toLocaleDateString();
        }

        renderHealth(record, { domains: domainCount, names: nameCount });
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Settings — "Keep default link behaviour"                          */
  /* ------------------------------------------------------------------ */

  function loadNavSetting() {
    chrome.storage.local.get([NAV_SETTING_KEY], (result) => {
      keepDefaultLinkChk.checked =
        result && typeof result[NAV_SETTING_KEY] === 'boolean' ? result[NAV_SETTING_KEY] : false;
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

  function rebuildHalf(label, half) {
    if (half.partial) {
      return label + ' only partly loaded (' + (half.count || 0) + ') — ' + reasonPhrase(half.reason);
    }
    return label + ' failed (' + reasonPhrase(half.reason) + ')';
  }

  // The 2.1.1 mis-report itself, fixed. A rebuild whose display-name half had
  // hard-failed used to report a green "Cache rebuilt — 71 domain(s),
  // 0 name(s)." — indistinguishable from a partner who genuinely has no
  // delegated-admin customers. Now a failed half is named, and never 'ok'.
  // -> { message, kind }
  function describeRebuild(result) {
    // No per-half facts: a malformed reply, or a content script older than
    // 2.2.0 (which answered with the maps themselves). Nothing is known about
    // what happened, so claim neither success nor a specific failure.
    if (
      !result ||
      !result.domains ||
      !result.names ||
      typeof result.domains.ok !== 'boolean' ||
      typeof result.names.ok !== 'boolean'
    ) {
      return {
        message: 'Cache cleared, but the rebuild result could not be read — refresh the Partner Center tab.',
        kind: 'err',
      };
    }
    const d = result.domains;
    const n = result.names;
    if (d.ok && n.ok) {
      return {
        message: 'Cache rebuilt — ' + d.count + ' domain(s), ' + n.count + ' name(s).',
        kind: 'ok',
      };
    }
    if (!d.ok && !n.ok) {
      return {
        message:
          'Rebuild failed — ' + rebuildHalf('customer domains', d) + '; ' +
          rebuildHalf('display names', n) + '.',
        kind: 'err',
      };
    }
    const parts = [
      d.ok ? d.count + ' domain(s)' : rebuildHalf('customer domains', d),
      n.ok ? n.count + ' name(s)' : rebuildHalf('display names', n),
    ];
    return { message: 'Cache rebuilt — ' + parts.join('; ') + '.', kind: 'err' };
  }

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
          const described = describeRebuild(response);
          setStatus(described.message, described.kind);
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
          loadNavSetting();
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */

  keepDefaultLinkChk.addEventListener('change', () => {
    chrome.storage.local.set({ [NAV_SETTING_KEY]: keepDefaultLinkChk.checked });
  });

  // The record can change while the popup is open, and the 15s grace window
  // escalating 'awaiting' to 'failed' is exactly that: open the popup during
  // the amber "still loading" phase and without this it would sit there
  // saying so long after the load had actually failed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HEALTH_KEY]) refreshStatus();
  });

  document.getElementById('btn-export').addEventListener('click', doExport);
  document.getElementById('btn-import-merge').addEventListener('click', () => startImport('merge'));
  document.getElementById('btn-import-replace').addEventListener('click', () => startImport('replace'));
  document.getElementById('btn-rebuild').addEventListener('click', doRebuild);
  document.getElementById('btn-clear-all').addEventListener('click', doClearAll);

  loadNavSetting();
  refreshStatus();
})();
