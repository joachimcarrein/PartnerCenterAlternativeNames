# autoupload — submit a release to the Chrome Web Store from CI

**Status: NOT IMPLEMENTED. Research and design note only, written 10 September
2026.** Nothing in the repo has changed: no workflow, no code, no version bump,
no changelog entry. This exists so that if the idea is picked up later, the
Google-side research does not have to be redone — and so that the two findings
that would otherwise be discovered halfway through the work are recorded up
front. Every factual claim below was checked against Google's own docs on that
date; anything not verified is marked **unverified**.

## What it would do

Today `release.yml` ends at a published GitHub release with the zip attached
(CLAUDE.md, *Releasing*). The last mile is still manual: open the Chrome Web
Store Developer Dashboard, upload that zip, click submit. This would close that
gap — a released version reaches Google's review queue without a human opening
the dashboard.

The store item already exists (`mepicobhhcnbhcfppmihciachfgdefpa`), which
matters: **the API cannot create a new store item**, only publish new versions
of an existing one. That prerequisite is met, so this is purely additive.

## The two findings that shape the design

**1. `publish` *is* the review submission.** There is no separate "submit for
review" call. From the v2 reference for `publishers.items.publish`: *"The item
will be submitted for review unless `skipReview` is set to true, or the item is
staged from a previous submission with `publishType` set to
`STAGED_PUBLISH`."* So the automation is exactly two calls — upload, then
publish — and the second one is close to irreversible (see **Risks**).

**2. No off-the-shelf GitHub Action supports service accounts.** This is the
finding that actually decides the shape of the work. Every published action
surveyed (`wdzeng/chrome-extension`, `browser-actions/release-chrome-extension`,
`mnao305/chrome-extension-upload`, `puzzlers-labs/chrome-webstore-publish`)
takes `client-id` / `client-secret` / `refresh-token` and nothing else. Service
accounts arrived with API v2 in October 2025 and the action ecosystem has not
caught up.

The consequence is a genuine inversion of what you would expect:

| | Refresh token | Service account |
|---|---|---|
| Google Cloud project + enable API | yes | yes |
| OAuth consent screen, External, published to production | yes | **no** |
| OAuth Playground token dance | yes | **no** |
| Credential stored in GitHub | 3 secrets | 1 JSON key (or none, with WIF) |
| Credential decays | 7 days if the consent screen is left in *Testing*; ~6 months unused | **no** |
| Work inside this repo | ~10 lines, one `uses:` | **~40 lines of hand-rolled `curl`** |

**The service account is less Google setup and more repo code.** That trade is
the whole decision. It is taken here because the decay row is the one that
bites this project specifically: releases are irregular, and a credential that
dies quietly after six months without a release fails at exactly the moment it
is needed, long after anyone remembers configuring it.

## Google-side setup (one-time, manual, human-only)

None of this can be automated and none of it belongs in the repo.

1. **Google Cloud Console** — create or select a project, enable the **Chrome
   Web Store API**. No billing account is mentioned in the docs as required
   (*unverified*, but Cloud says so at the Enable click if that is wrong).
2. **Create a service account** in that project. *"You don't need to add any
   permissions to the service account at this stage."*
3. **Developer Dashboard → Account** — add the service account's email address.
   This is what binds it to the publisher; without it the credential is valid
   and useless.
4. **Publisher ID** — same Account / Publisher settings page. v2 requires it in
   every URL; v1 did not, which is why older tutorials omit it.
5. **A credential**, one of:
   - **JSON key** — create in Cloud Console, paste the whole file into a
     GitHub secret. Simple, and a long-lived secret.
   - **Workload Identity Federation** — no stored key at all, via
     `google-github-actions/auth` with `token_format: access_token` and
     `access_token_scopes: https://www.googleapis.com/auth/chromewebstore`.
     **Unverified against the Chrome Web Store API.** In principle it works —
     the API only cares that the bearer token identifies the registered service
     account — but Google's service-account page documents only the JSON key
     and `gcloud` impersonation, and never mentions WIF. **Test this first if
     attempted; do not design around it working.**

The Cloud project does **not** have to live under the same Google account as
the store publisher. That matters here: managed Workspace orgs commonly enforce
`iam.disableServiceAccountKeyCreation`, which blocks step 5's key outright. If
that policy is in the way, put the project under a personal Google account —
only the service account's *email* has to be added by whoever owns the listing.

## The workflow

**Trigger on `release: published`, not by extending `release.yml`.** Two
reasons, both load-bearing:

- `release.yml` fires on *any* push to `main` where the manifest version is new
  (CLAUDE.md: the gate is "does the release exist"). Chaining store submission
  onto that sends every such merge straight into Google's review queue, with
  days of turnaround and `:cancelSubmission` as the only undo. A separate
  workflow keeps "cut a release" and "ship it to users" as two decisions.
- Triggering on the published release lets the job **download the zip already
  attached to it** instead of rebuilding. The store then receives the
  byte-identical artifact that was released, not a second build of the same
  commit. It also makes the workflow trivially re-runnable, and
  `workflow_dispatch` with a tag input gives a manual retry path for a
  submission that failed on Google's side.

```yaml
name: Submit to Chrome Web Store
on:
  release: { types: [published] }
  workflow_dispatch:
    inputs:
      tag: { description: 'Release tag, e.g. v2.2.0', required: true }
      dry-run: { description: 'Upload as draft, do not submit', type: boolean, default: true }

permissions: { contents: read, id-token: write }  # id-token only if WIF
concurrency: { group: cws-submit, cancel-in-progress: false }

jobs:
  submit:
    runs-on: ubuntu-latest
    environment: chrome-web-store   # see Risks — gate the secret behind approval
    steps:
      - name: Download the released zip
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          set -euo pipefail
          gh release download "${{ inputs.tag || github.event.release.tag_name }}" \
            --repo "${{ github.repository }}" --pattern '*.zip' --dir dist
          ls -l dist

      # JSON-key variant. The WIF variant replaces this whole step with
      # google-github-actions/auth and reads its access_token output.
      - name: Mint an access token
        run: |
          set -euo pipefail
          # sign a JWT with the service account key, exchange it at
          # https://oauth2.googleapis.com/token for an access token scoped to
          # https://www.googleapis.com/auth/chromewebstore
          # (access tokens last ~40 min, ample for one submission)

      - name: Upload the package
        run: |
          curl -sS --fail-with-body -X POST \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/zip" \
            --data-binary @dist/*.zip \
            "https://chromewebstore.googleapis.com/upload/v2/publishers/$PUB/items/$EXT:upload"

      - name: Submit for review
        if: ${{ !inputs.dry-run }}
        run: |
          curl -sS --fail-with-body -X POST \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            -d '{"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}' \
            "https://chromewebstore.googleapis.com/v2/publishers/$PUB/items/$EXT:publish"
```

Endpoints, verified against the v2 reference:

| Purpose | Call |
|---|---|
| Upload | `POST /upload/v2/publishers/{pub}/items/{ext}:upload` |
| Submit for review | `POST /v2/publishers/{pub}/items/{ext}:publish` |
| Check state | `GET /v2/publishers/{pub}/items/{ext}:fetchStatus` |
| Withdraw a pending submission | `POST /v2/publishers/{pub}/items/{ext}:cancelSubmission` |

Host is `chromewebstore.googleapis.com`; the scope is
`https://www.googleapis.com/auth/chromewebstore`. **Use v2, not v1** — v1 is
deprecated and Google's stated end of support is **15 October 2026**, roughly
five weeks after this note was written. Any tutorial pointing at
`www.googleapis.com/chromewebstore/v1.1/...` is already obsolete.

The exact upload media semantics (whether the raw body suffices, or an
`uploadType` parameter is needed) are **unverified** — confirm at implementation
time against the `media.upload` reference rather than trusting the sketch above.

### Deliberate choices

- **`skipReview: false`.** The field exists and bypasses review "if eligible".
  Not used: the point is to reach the queue reliably, not to discover at 2am
  which eligibility rule changed.
- **`blockOnWarnings: true`** (the API default is `false`). A submission Google
  warns about should fail the workflow loudly rather than land in the queue
  unnoticed. If it turns out to trip on benign warnings, flip it — but start
  strict.
- **`deployPercentage` / staged rollout: out of scope.** Percentage rollout
  requires 10,000+ seven-day active users; this extension is nowhere near that.
- **Dry run by default on manual runs.** `upload` without `publish` leaves a
  draft in the dashboard — the safest possible first live test, exercising auth,
  the publisher/item IDs and the zip in one go without committing to a review.

## Risks

- **The org policy** (`iam.disableServiceAccountKeyCreation`) can block the key.
  Covered above; the escape is a personal Cloud project, or WIF.
- **One service account per publisher.** Google: *"At this time, you can only
  add one service account to your publisher."* If the publisher is ever shared,
  or gains a second automated extension, that slot is contended.
- **The visibility trap.** Google: *"Items are always published with the
  existing visibility settings. If you have manually changed the settings in the
  Developer Dashboard, you won't be able to publish using the API until you have
  manually published with the new visibility at least once."* Any visibility
  change in the dashboard silently arms a failure in the next CI submission.
- **A green workflow does not mean a shipped extension.** `publish` returns as
  soon as the item is queued; a rejection arrives by email days later. CI will
  report success for a submission Google later refuses. Polling `fetchStatus`
  would close that gap but needs a schedule and somewhere to report to —
  deliberately out of scope, and worth stating plainly if this ships, so nobody
  reads a green tick as "live".
- **Secret exposure.** Anyone who can push a workflow to this repo can
  exfiltrate a repo secret, and this one can publish to real users. Hence the
  `environment:` in the sketch — a GitHub environment with a required reviewer
  keeps the credential behind an approval, which doubles as a human checkpoint
  before anything reaches the store.

## Out of scope

- **Creating a new store item.** The API cannot; first publication is manual.
- **Store listing metadata** — description, screenshots, category. Not among the
  v2 endpoints verified here (*unverified* whether v2 covers it at all). Assume
  the dashboard remains the place to edit the listing.
- **Edge / Firefox.** Different stores, different APIs.
- **Any change to `release.yml`, `build.ps1` or the extension itself.** This is
  purely additive; the existing release path keeps working untouched if this is
  never built.

## Testing

**This change is not testable by the `node --test` suite, and its own `.plan/`
entry should say so rather than pass over the question** (CLAUDE.md: *Write
tests when the change is testable, and say so when it is not*). There is no pure
logic in it — a workflow YAML, an OAuth exchange, and two HTTP calls against an
external service. Nothing to assert without mocking the whole of Google.

Verification is therefore manual, in this order:

1. `workflow_dispatch` with `dry-run: true` against an already-released tag →
   confirm a draft appears in the dashboard. Proves auth, both IDs, and the zip.
2. Check the drafted version number matches the release.
3. Only then a real submission, on a release that was going to be submitted by
   hand anyway.

## If this ships

It is a CI/tooling change, not an extension change — **no `manifest.json` bump
and no changelog entry**, since nothing changes for the user and the changelog
is user-facing (CLAUDE.md). What it *would* need:

| File | Change |
|---|---|
| `.github/workflows/autoupload.yml` | new — the workflow above |
| `CLAUDE.md` | *File map* gains a third workflow; *Releasing* gains the store step and the required secrets |
| `README.md` | mention that releases auto-submit, if that becomes true |
| this file, or `.plan/<version>.md` | record the live-test result and which auth route was actually used |

## Sources

All checked 10 September 2026.

- [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
- [Use a service account with the Chrome Web Store API](https://developer.chrome.com/docs/webstore/service-accounts)
- [API reference (v2)](https://developer.chrome.com/docs/webstore/api)
- [Method: publishers.items.publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
- [Introducing a new Chrome Web Store API](https://developer.chrome.com/blog/cws-api-v2) — v2 launch, v1 supported until 15 October 2026
- [wdzeng/chrome-extension](https://github.com/wdzeng/chrome-extension) — v2-capable action, refresh token only
- [browser-actions/release-chrome-extension](https://github.com/browser-actions/release-chrome-extension) — refresh token only
