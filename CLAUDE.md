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

4. **Two different Microsoft tokens, both short-lived.** Read them **fresh at call time**, never cache them to storage:
   - `AuthContextData` → `tokenMetadata.accountsFirstPartyApp.accessToken` in `sessionStorage` — for `api.partnercenter.microsoft.com`.
   - For `api.partnercustomersecurity.microsoft.com` (GDAP list, used only for the display-name fallback): `sessionStorage.CustomerSvcAdminKey` **if present**, otherwise the token `search-inject.js` sniffs off the page's own request to that host and hands over the `__altnameBridge` (`kind: 'GDAP_TOKEN'`). **Do not treat the sessionStorage key as reliable** — as of 2.1.1 the page frequently never writes it, and depending on it alone silently emptied `displayNameCache` and showed `Unknown` for every non-transacted customer (see `.plan/2.1.1.md`). The bridge is the load-bearing path now; the key is just a fast path. A token can also arrive *after* `loadDomainData()` has already given up, so `maybeRecoverDisplayNames()` refetches the names half on first receipt.

5. **Displayed value precedence:** user override → Partner Center domain → GDAP `displayName` fallback → `Unknown`/`—`. Some GDAP-only (non-transacted) customers 404 on the Partner Center API and legitimately have no domain; that's what the display-name fallback is for.

6. **The page's search is 100% server-side OData**, and the API only knows `displayName`/`tenantId`. To surface a row that only a custom name matched, `search-inject.js` appends `OR tenantId eq '<id>'` clauses to the outgoing `$filter`. Two hard limits:
   - The API rejects filters past an **OData node-count limit of 30**. Build a **flat** OR group (strip the base filter's outer parens) and **cap at 4** appended clauses; beyond that, skip expansion (the user still gets normal results, not an error banner).
   - **Only user overrides are searchable, not domains.** Domains over-match badly (e.g. typing "a" hits dozens of `onmicrosoft.com` domains) and blow the node limit.

7. **Grid rows briefly render with skeleton IDs** (e.g. `row-he-row-0`, `row-1`) before real data swaps in ~700ms later. Validate the row's tenant ID against `UUID_RE` before injecting a cell or firing a per-customer fetch, or you get a flood of 404s.

8. **Guard against double injection** by element ID before adding the header or any row cell; the observer fires often.

9. **The popup can't refetch the cache itself.** Rebuilding the domain/display-name cache always needs the page's `sessionStorage` tokens (constraint 4), which only `content.js` can read. So "Rebuild local cache" is always a two-step round trip: `popup.js` clears the three cache keys, then messages the GDAP tab to run `rebuildCache()` there. If no GDAP tab is open (or the content script is orphaned by an extension reload), the popup reports "cache cleared, open/refresh the tab" — clearing alone is a valid outcome because `content.js` re-fetches on its next load anyway. **`nameOverrides` must never be included in that cache-clear key list** — it's the one storage key that has no server-side source of truth to rebuild from.

   This is deliberately distinct from the popup's separate **"Clear local cache"** action, which *is* allowed to delete `nameOverrides`: it calls `chrome.storage.local.clear()` (no key list, wipes everything) after an explicit confirmation naming the override count, then messages the tab (`ALTNAME_CLEAR_ALL`) to reset in-memory state to a blank-install look. It does not trigger a refetch — that's what separates "wipe" from "wipe and rebuild".

10. **The "Keep default link behaviour" redirect is a scoped click interception, not a global `history.pushState` patch — and it defaults to OFF (opt-in), inverting the setting's own name.** Clicking a customer's name in the grid (`<customersvcadmin_he-button appearance="link">` inside `cell-displayName-{id}`, several shadow roots deep) normally lands on `.../adminrelationships`; on a fresh install (setting missing/`false`) it lands on `.../servicemanagementpage` instead — that redirect is the new default, not the original Microsoft behaviour. Only a user who explicitly checks "Keep default link behaviour" (setting `true`) gets `.../adminrelationships` back. This was a deliberate correction to the original 2.0.3 plan, which had specified the opposite default; don't "fix" it back without re-checking with the user. The redirect applies **only to that specific click**, not globally — a customer's own left-nav "Admin relationships" link must keep working once you're inside the detail view. That's why `content.js` uses a capture-phase `click` listener on `document` with `event.composedPath()` (click events are composed and cross shadow boundaries) instead of patching `window.history.pushState`/`replaceState` globally — a global patch would also hijack the left-nav link on every future visit to that route, not just the initial jump from the list. `stopImmediatePropagation()` on the capture-phase listener blocks the SPA's own (shadow-scoped) handler before it fires; navigation is then done ourselves via `history.pushState` + a manually dispatched `popstate` event — both work from the isolated world because session-history state and DOM event dispatch aren't tied to a JS world, unlike monkey-patching a function on a shared host object (see constraint 3). Live-tested against the real Partner Center app: the `history.pushState` + manually dispatched `popstate` navigation is picked up correctly by the SPA's router, so the `location.assign(url)` fallback in `redirectToServiceManagement()` has never been needed. **Holding Shift while clicking inverts whichever target the setting currently selects, for that one click only** (the stored setting itself is never touched): the redirect condition is `goToServiceManagement = (keepDefaultLinkBehaviour === event.shiftKey)`, checked inside the same capture-phase listener. This means the listener can no longer early-return before resolving `tenantId` when the setting is checked (it used to) — `findNameButtonClick(path)` now always runs first, since Shift can flip the outcome in either setting state. Also live-tested and confirmed working.

## Storage keys (`chrome.storage.local`)

| Key | Contents | Expiry |
|---|---|---|
| `domainCache` | `{ tenantId: domain }` | 30 days (`domainCacheExpiry`) |
| `displayNameCache` | `{ tenantId: displayName }` (GDAP fallback) | tied to `domainCacheExpiry` |
| `domainCacheExpiry` | epoch ms | — |
| `nameOverrides` | `{ tenantId: customName }` (user labels) | never |
| `keepDefaultLinkBehaviour` | `boolean`, default `false` (missing = `false`) — opt-in only | never |

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

## Testing

```powershell
node --test "tests/**/*.test.js"   # 42 assertions, ~0.15s
```

**Quote the glob and never pass the bare directory** — `node --test tests` fails with `MODULE_NOT_FOUND`, because the runner resolves the directory as an entry point instead of discovering test files inside it. Node expands the quoted glob itself, so the identical command works in PowerShell and bash. The `*.test.js` suffix is also what keeps `tests/helpers/` out of the run: Node otherwise treats *every* file under a directory named `tests` as a test file.

Zero dependencies — `node:test` and `node:assert` are built into Node, so there is still no `package.json` and no `node_modules`. Nothing under `tests/` ships either: `build.ps1` packs from an explicit allowlist, so a new directory is excluded by default rather than needing a blacklist entry.

**How tests reach the code.** Every runtime file is a bare `(() => { ... })()` exporting nothing, and it must stay that way — do **not** add `module.exports` footers to shipped files. (`search-inject.js` runs in the page's MAIN world, where a stray global `module` left by Partner Center's own bundler could make such a footer do something unintended.) Instead `tests/helpers/load-iife.js` strips the IIFE wrapper and runs the body in a `node:vm` context, with stub globals from `tests/helpers/stubs.js`. Two rules when extending it:

- Top-level `function` declarations become properties of the context's global object even under `'use strict'`, so they come out for free. Top-level `const`/`let` do **not** — they stay lexical, so ask for them via the `expose` snippet argument, which is appended to the same source string and therefore shares that scope.
- Inject **host** globals only. A fresh vm context already owns its own ECMAScript intrinsics; layering the outer realm's `Object`/`Array` on top mixes realms and makes `instanceof` unreliable inside the module. For the same reason, compare vm-created objects using `plain()` from `stubs.js` — `deepStrictEqual` otherwise rejects them as "same structure but not reference-equal".

**What is covered** (details in `.plan/2.1.1.tests.md`): `popup.js` export/import — `nameOverrides` is the only storage key with no server-side source of truth, so a bug there loses data permanently — and `search-inject.js`'s `$filter` rewriter, where every limit in constraint 6 is load-bearing and fails silently.

**What is deliberately not covered:** Shadow DOM traversal, column injection and the MutationObserver. That needs jsdom (a dependency), and its shadow-root/slot fidelity would not match Partner Center's real markup, so such tests would exercise the fixture rather than reality. Anything hitting the Microsoft APIs is out too. Know the limit of unit tests here: the 2.1.1 GDAP-token bug was an external contract change, and **no test could have caught it** — only a live check against the real page does.

## Building & loading

```powershell
./build.ps1   # -> dist/partner-center-alternative-names-<version>.zip
```

`build.ps1` packs from an **explicit allowlist** (`manifest.json`, `background.js`, `content.js`, `search-inject.js`, `popup.html`, `popup.js`, `docs/icons/`). Nothing else ships — do not rely on directory sweeps. **Icons deliberately live inside `docs/`** so the GitHub Pages site can reference the same files without a copy; the manifest points at `docs/icons/…` and the build preserves that relative path inside the zip (Chrome is fine with subfolder icon paths). The rest of `docs/` (HTML pages, screenshots) must never ship. Bump `version` in `manifest.json` for each release, **and add a matching entry to `docs/changelog.html` in the same change** (see Repository conventions).

To test: load unpacked at `chrome://extensions` (Developer mode). After editing any file, click the extension's **reload (↻)** icon, then refresh the Partner Center page — refreshing the page alone runs the old build.

## Repository conventions

- **Vanilla JS, no dependencies, no transpile.** Keep it that way; match the existing IIFE + `dbg()` style and comment density.
- **`.plan/`** holds the change history / prompts. It must contain **only fictional sample data** (Acme, Contoso, Northwind, `a1b2c3d4-…` tenant IDs, `*.onmicrosoft.com`). **Never commit real customer data** — tenant GUIDs, customer/company names, or customer domains — anywhere in this public repo, including code comments and screenshots. Screenshots must use the same fictional data.
- **`docs/` is the public GitHub Pages site** (served at `https://joachimcarrein.github.io/PartnerCenterAlternativeNames/`): `index.html` (overview), `changelog.html`, `privacy.html`, plus `docs/screenshots/` and `docs/icons/` (Pages only serves the `docs/` folder, which is why screenshots and icons live there — the icons are shared with the extension manifest, see Building). All three pages share the same inline CSS + theme-toggle boilerplate; keep them visually in sync when styling changes.
- **Changelog is mandatory per release:** every `manifest.json` version bump gets a new entry at the **top** of `docs/changelog.html` (`Version X.Y.Z <span class="date">D Month YYYY</span>` + a short `<ul>`). Keep bullets user-facing and brief — what changed for the user, not implementation detail. Never rewrite history for already-released versions; add, don't edit.
- **Privacy policy** is `docs/privacy.html`, linked from the store listing and `README.md`.
- **A bug fix is a release.** Every confirmed bug gets all four of: the code change, a `version` bump in `manifest.json`, a changelog entry, and a `.plan/<version>.md` write-up (Status / Symptom / Evidence / Root cause / the fix / what was deliberately *not* fixed / Verification / files-touched table). State plainly in the Status line whether the fix was live-tested against the real Partner Center app or only inspected.
- **Write tests when the change is testable, and say so when it is not.** Any change to pure logic — cache semantics, validation, parsing, filter/URL rewriting, precedence rules — gets assertions under `tests/` in the *same* change. When a fix is genuinely untestable (DOM injection, an external API contract, token plumbing), say so explicitly in the `.plan/` entry instead of passing over the question in silence.
- **New tests must be mutation-tested.** A suite that passes on its first run proves nothing. Break the code each test is meant to protect (invert the guard, raise the cap, delete the unescaping), confirm the test fails, then restore the file and verify it byte-identical with `cmp` plus `node --check`. Record the mutations and their results in the `.plan/` entry.
- **Always run the full suite before reporting a change as done** — `node --test "tests/**/*.test.js"`, not merely the file you touched — and quote the real pass/fail counts. Never report work complete on the strength of inspection alone when a suite exists. If a test fails, say so with the output rather than describing the change as finished.

## File map

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest: `storage` permission, host permissions, two content scripts (isolated + MAIN), background worker, toolbar popup |
| `content.js` | Column injection, Shadow DOM traversal, data fetch/cache, inline editing, alt-name bridge publisher, cache rebuild, popup message handler, customer-name-click redirect |
| `search-inject.js` | MAIN-world `$filter` rewriter that makes custom names searchable |
| `background.js` | `PC_FETCH` relay for authenticated cross-origin API calls |
| `popup.html` / `popup.js` | Toolbar popup: "Keep default link behaviour" toggle, export/import `nameOverrides` as JSON, trigger a cache rebuild, or clear everything |
| `build.ps1` | Packs the runtime files into a versioned zip |
| `tests/` | `node --test` suites (zero dependencies, never shipped): `popup-import.test.js`, `search-inject-filter.test.js`, plus `helpers/load-iife.js` (vm loader for the IIFE files) and `helpers/stubs.js` (DOM / `chrome.*` / bridge fakes) |
| `docs/` | Public GitHub Pages site: `index.html` (overview), `changelog.html` (update on every release), `privacy.html`, `screenshots/` (fictional data only), `icons/` (shared with the manifest — the only part of `docs/` that ships in the zip) |
