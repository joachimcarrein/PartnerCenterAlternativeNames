# CLAUDE.md

Guidance for AI agents and developers working in this repository.

## What this is

A Manifest V3 Chrome extension that adds an editable **"Alternative Name"** column to the Microsoft Partner Center **Customers | Granular Administration** (GDAP) page:

```
https://partner.microsoft.com/dashboard/v2/customers/granularadminaccess/*
```

For each customer it shows the primary domain (fetched from Microsoft's own APIs), lets the user assign a private custom label, and makes the page's built-in search box also match those labels. A toolbar popup (`popup.html`/`popup.js`) lets the user export/import those custom labels as a JSON file and rebuild the local domain cache on demand.

There is **no build step or bundler** — the source files are the shipped files. It is plain, dependency-free ES. `build.ps1` only zips the runtime files for distribution.

## Architecture

Four execution contexts cooperate:

| Context | File | Runs in | Can it use `chrome.*`? |
|---|---|---|---|
| Content script | `content.js` | Isolated world (`document_idle`) | Yes |
| Search interceptor | `search-inject.js` | **MAIN world** (`document_start`) | No |
| Service worker | `background.js` | Extension worker | Yes |
| Toolbar popup | `popup.html` / `popup.js` | Extension page (`action.default_popup`) | Yes |

Data/flow:

- `content.js` owns all state (domains, display names, user overrides), injects the column into the grid's Shadow DOM, handles editing, and caches to `chrome.storage.local`.
- `content.js` cannot fetch the Microsoft APIs directly (CORS blocks MV3 content-script cross-origin fetches), so it relays every API call to `background.js` via `chrome.runtime.sendMessage({ type: 'PC_FETCH', url, headers })`.
- `search-inject.js` runs in the page's MAIN world so it can patch `XMLHttpRequest`/`fetch`. It rewrites the search request's OData `$filter` to make custom names searchable. It cannot read `chrome.storage`, so `content.js` publishes a small alt-name index to it over `window.postMessage` (marker key `__altnameBridge`).
- `popup.js` reads/writes `chrome.storage.local` directly (it's an extension page, not a content script) for export/import of `nameOverrides`. For "Rebuild local cache" it can only clear the cache keys itself — the Microsoft tokens live in the GDAP page's `sessionStorage`, so it messages `content.js` (`chrome.tabs.sendMessage({ type: 'ALTNAME_REBUILD_CACHE' })`) to do the actual refetch. For "Clear local cache" (a separate, deliberately more destructive action that also deletes `nameOverrides`) it calls `chrome.storage.local.clear()` directly and messages `content.js` (`{ type: 'ALTNAME_CLEAR_ALL' }`) only to reset in-memory state for display — no refetch.

## Non-obvious constraints (read before changing anything)

These were each discovered the hard way; the fixes are load-bearing.

1. **The grid lives in a Shadow DOM.** The host element (`…DATA-GRID`) may be nested inside other shadow roots. Use the recursive `findGrid()` traversal, not `document.querySelector`. Re-injection is driven by a **debounced `MutationObserver`** on the shadow root, because pagination and search mutate rows in place with no page reload.

2. **MV3 content scripts can't call the Microsoft APIs directly** — CORS. Everything goes through `background.js` (`PC_FETCH`). Don't "simplify" this back to a direct `fetch()` in `content.js`.

3. **Reading React internals / patching the page's XHR requires the MAIN world.** Isolated-world content scripts can't see the page's JS objects or affect its `fetch`/`XHR`. That's why `search-inject.js` is a separate `"world": "MAIN"` content script. This requires **Chrome 111+**.

4. **Two different Microsoft tokens, both short-lived, both from `sessionStorage`** (placed there by the page). Read them **fresh at call time**, never cache them:
   - `AuthContextData` → `tokenMetadata.accountsFirstPartyApp.accessToken` — for `api.partnercenter.microsoft.com`.
   - `CustomerSvcAdminKey` — for `api.partnercustomersecurity.microsoft.com` (GDAP list, used only for the display-name fallback).

5. **Displayed value precedence:** user override → Partner Center domain → GDAP `displayName` fallback → `Unknown`/`—`. Some GDAP-only (non-transacted) customers 404 on the Partner Center API and legitimately have no domain; that's what the display-name fallback is for.

6. **The page's search is 100% server-side OData**, and the API only knows `displayName`/`tenantId`. To surface a row that only a custom name matched, `search-inject.js` appends `OR tenantId eq '<id>'` clauses to the outgoing `$filter`. Two hard limits:
   - The API rejects filters past an **OData node-count limit of 30**. Build a **flat** OR group (strip the base filter's outer parens) and **cap at 4** appended clauses; beyond that, skip expansion (the user still gets normal results, not an error banner).
   - **Only user overrides are searchable, not domains.** Domains over-match badly (e.g. typing "a" hits dozens of `onmicrosoft.com` domains) and blow the node limit.

7. **Grid rows briefly render with skeleton IDs** (e.g. `row-he-row-0`, `row-1`) before real data swaps in ~700ms later. Validate the row's tenant ID against `UUID_RE` before injecting a cell or firing a per-customer fetch, or you get a flood of 404s.

8. **Guard against double injection** by element ID before adding the header or any row cell; the observer fires often.

9. **The popup can't refetch the cache itself.** Rebuilding the domain/display-name cache always needs the page's `sessionStorage` tokens (constraint 4), which only `content.js` can read. So "Rebuild local cache" is always a two-step round trip: `popup.js` clears the three cache keys, then messages the GDAP tab to run `rebuildCache()` there. If no GDAP tab is open (or the content script is orphaned by an extension reload), the popup reports "cache cleared, open/refresh the tab" — clearing alone is a valid outcome because `content.js` re-fetches on its next load anyway. **`nameOverrides` must never be included in that cache-clear key list** — it's the one storage key that has no server-side source of truth to rebuild from.

   This is deliberately distinct from the popup's separate **"Clear local cache"** action, which *is* allowed to delete `nameOverrides`: it calls `chrome.storage.local.clear()` (no key list, wipes everything) after an explicit confirmation naming the override count, then messages the tab (`ALTNAME_CLEAR_ALL`) to reset in-memory state to a blank-install look. It does not trigger a refetch — that's what separates "wipe" from "wipe and rebuild".

10. **The "Keep default link behaviour" redirect is a scoped click interception, not a global `history.pushState` patch.** Clicking a customer's name in the grid (`<customersvcadmin_he-button appearance="link">` inside `cell-displayName-{id}`, several shadow roots deep) normally lands on `.../adminrelationships`; when the setting is off it should land on `.../servicemanagementpage` instead — but **only for that click**. A customer's own left-nav "Admin relationships" link must keep working once you're inside the detail view. That's why `content.js` uses a capture-phase `click` listener on `document` with `event.composedPath()` (click events are composed and cross shadow boundaries) instead of patching `window.history.pushState`/`replaceState` globally — a global patch would also hijack the left-nav link on every future visit to that route, not just the initial jump from the list. `stopImmediatePropagation()` on the capture-phase listener blocks the SPA's own (shadow-scoped) handler before it fires; navigation is then done ourselves via `history.pushState` + a manually dispatched `popstate` event — both work from the isolated world because session-history state and DOM event dispatch aren't tied to a JS world, unlike monkey-patching a function on a shared host object (see constraint 3). Not live-tested against the real Partner Center app; if the SPA's router doesn't pick up the manual `popstate`, fall back to a hard `location.assign(url)` in `redirectToServiceManagement()` (full reload, still correct).

## Storage keys (`chrome.storage.local`)

| Key | Contents | Expiry |
|---|---|---|
| `domainCache` | `{ tenantId: domain }` | 30 days (`domainCacheExpiry`) |
| `displayNameCache` | `{ tenantId: displayName }` (GDAP fallback) | tied to `domainCacheExpiry` |
| `domainCacheExpiry` | epoch ms | — |
| `nameOverrides` | `{ tenantId: customName }` (user labels) | never |
| `keepDefaultLinkBehaviour` | `boolean`, default `true` (missing = `true`) | never |

Tenant IDs are stored **lowercased**. Domains/display names are `.trim()`-ed. When only one part of the cache is missing, refetch just that part (independent tracking lets a failed GDAP fetch self-heal on the next load instead of waiting out the 30-day TTL).

### Export/import file contract (`popup.js`)

Only `nameOverrides` is ever exported — never the domain cache (it's derived, re-fetches in seconds, and would leak real customer domains into a portable file). The file is a JSON envelope:

```json
{
  "type": "partner-center-alternative-names",
  "formatVersion": 1,
  "extensionVersion": "2.0.2",
  "exportedAt": "2026-08-06T09:14:22.115Z",
  "count": 3,
  "nameOverrides": { "<tenantId>": "<customName>", "…": "…" }
}
```

`type` + `formatVersion` gate the import; anything else is refused with a specific message. Per-entry validation (UUID key, non-empty trimmed string value, length cap) skips bad rows without failing the whole import. Import supports **merge** (imported entries win per tenant, everything else untouched) and **replace all** (storage ends up exactly matching the file) — both write `nameOverrides` in a single `chrome.storage.local.set`, never `remove` + `set`, so there's no window where the data is briefly empty. A structurally valid file with zero usable entries is refused in replace mode rather than allowed to wipe everything.

## Debugging

`content.js` exposes `window._tenantDomainDebug` in the page for DevTools inspection: `getCache()`, `clearCache()`, `getMap()`, `getNameMap()`, `getOverrides()`, `clearOverrides()`, `rebuildCache()`, `getAltIndex()`, `exportOverrides()`, `importOverrides(data, mode)`. Both scripts log under `[AltName]` / `[AltName/net]` when their `DEBUG` flag is on.

## Building & loading

```powershell
./build.ps1   # -> dist/partner-center-alternative-names-<version>.zip
```

`build.ps1` packs from an **explicit allowlist** (`manifest.json`, `background.js`, `content.js`, `search-inject.js`, `popup.html`, `popup.js`, `icons/`). Nothing else ships — do not rely on directory sweeps. Bump `version` in `manifest.json` for each release.

To test: load unpacked at `chrome://extensions` (Developer mode). After editing any file, click the extension's **reload (↻)** icon, then refresh the Partner Center page — refreshing the page alone runs the old build.

## Repository conventions

- **Vanilla JS, no dependencies, no transpile.** Keep it that way; match the existing IIFE + `dbg()` style and comment density.
- **`.plan/`** holds the change history / prompts. It must contain **only fictional sample data** (Acme, Contoso, Northwind, `a1b2c3d4-…` tenant IDs, `*.onmicrosoft.com`). **Never commit real customer data** — tenant GUIDs, customer/company names, or customer domains — anywhere in this public repo, including code comments and screenshots. Screenshots must use the same fictional data.
- **Privacy policy** is `Docs/privacy.html`, published via GitHub Pages and linked from the store listing and `README.md`.

## File map

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest: `storage` permission, host permissions, two content scripts (isolated + MAIN), background worker, toolbar popup |
| `content.js` | Column injection, Shadow DOM traversal, data fetch/cache, inline editing, alt-name bridge publisher, cache rebuild, popup message handler, customer-name-click redirect |
| `search-inject.js` | MAIN-world `$filter` rewriter that makes custom names searchable |
| `background.js` | `PC_FETCH` relay for authenticated cross-origin API calls |
| `popup.html` / `popup.js` | Toolbar popup: "Keep default link behaviour" toggle, export/import `nameOverrides` as JSON, trigger a cache rebuild, or clear everything |
| `build.ps1` | Packs the runtime files into a versioned zip |
| `icons/`, `screenshots/`, `Docs/` | Store/listing assets and hosted privacy policy |
