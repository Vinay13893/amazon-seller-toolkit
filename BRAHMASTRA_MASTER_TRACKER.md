# BRAHMASTRA MASTER TRACKER

**Project:** Amazon Seller Intelligence Tool / Brahmastra  
**Owner:** Vinay Aggarwal  
**Purpose:** Permanent source of truth for decisions, pending work, blockers, deployment state, data trust, and product requirements.

---

## 1. Standing Project Rules

1. Brahmastra is a **daily decision engine**, not another dashboard.
2. Dashboard answers **“What happened?”**; Brahmastra answers **“What should I do today?”**
3. Internal truth first; external intelligence second.
4. No Rainforest, Keepa, or additional paid data subscriptions for the MVP.
5. Do not add a new job if an existing automated pipeline already provides the signal.
6. If Brahmastra cannot explain how it knows something, it does not get to say it.
7. If a recommendation cannot be proved trustworthy, suppress it.
8. One AI writes; another AI reviews.
9. Claude Code is the main developer; Codex is the reviewer; GitHub is the checkpoint system.
10. Do not use `git add .`.
11. No Amazon Ads write/update endpoints.
12. Never expose or modify credentials, OAuth tokens, profile selection, payments, replenishment calculations, or production settings without explicit approval.
13. Before starting any new task, check this tracker for unfinished blockers.
14. Every new requirement, correction, decision, blocker, PR, deployment, and next step must be added to this tracker.

---

## 2. Repository and Production

- **Active repository branch:** `master`
- **Do not use:** old/abandoned `main` branch
- **Production URL:** `https://esolz-app.vercel.app`
- **Supabase workspace:** `55a321c9-7729-4662-a494-9f1f1aa86846`
- **Amazon Ads profile:** `1119208106810251 — EMOUNT RETAIL — IN`
- **SP-API marketplace:** `A21TJRUUN4KGV`

### Operational risk

GitHub currently treats `main` as the default in parts of the UI, but the active production application is on `master`. This remains a repository-safety item to resolve later.

---

## 3. Current Production State

### Live and verified

- Amazon Ads OAuth fixed and verified.
- Correct Ads profile selected.
- Ads sync working without recent 401/429 failures.
- Sync Health V1 live.
- Render/Vercel orchestrator cleanup complete.
- Vercel Cron exists for ASIN product snapshots.
- PR #13 live:
  - Added Sync Health checks for Buy Box, Keyword Rank, and Pincode.
- PR #14 live:
  - Buy Box Sync Health now uses `asin_snapshots`.
  - Separates pipeline freshness from confirmed Buy Box coverage.
  - Prevents false “Healthy” status based on one fresh row.
- Production commit before PR #15 promotion: `f9949bb`.
- PR #16 live: added this tracker file to repo root (docs only, no runtime impact).
- PR #15 promoted to production `2026-07-11T06:28:00Z`.

### Live, verification in progress

#### PR #15 — Cron base URL loud-failure fix

- **Merge commit:** `1e829b6`
- **Production deployment:** `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b` (promoted from `dpl_9HvE25HKZr4fSRnZ44py6VRGxUgL`)
- **Build state:** READY, `target: production`, aliased to `esolz-app.vercel.app` — confirmed via Vercel `get_project`.
- **Environment variable:** `APP_BASE_URL=https://esolz-app.vercel.app` confirmed set in Vercel Production before promotion.
- **Verification status:** Promotion confirmed live. The cron run at 06:00 UTC (before promotion finished) was still on old code. The first real post-fix run is 08:00 UTC — a one-time scheduled check (`verify-cron-fix-8am-run`) runs at 08:10 UTC to confirm it reaches `/enqueue` and `/process-next`, and to check `asin_snapshots`/`background_jobs` counts.

### What PR #15 fixes

The Vercel Cron fired every two hours but its internal calls used the protected per-deployment `VERCEL_URL`. Those calls were redirected to Vercel SSO and silently treated as successful. The cron returned HTTP 200 while `/enqueue` and `/process-next` never ran.

PR #15:

- Removes silent fallback to protected `VERCEL_URL`
- Requires explicit `APP_BASE_URL`
- Rejects redirects, HTML/non-JSON responses, and null bodies
- Returns 502/503 with a clear reason instead of fake success

---

## 4. Immediate Blocking Task

### P0 — Promote and verify PR #15

**Status:** Promotion done, verification in progress  
**Why it blocks later work:** Price, BSR, and Buy Box freshness depend on the ASIN snapshot pipeline. The current queue has been stuck because the cron's internal calls did not reach the handlers.

### Required actions

1. ✅ Promote deployment `dpl_9HvE25HKZr4fSRnZ44py6VRGxUgL` — done, now live as `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b`.
2. ✅ Verify production points to commit `1e829b6` — confirmed via Vercel `get_project`.
3. ⏳ Wait for the next scheduled cron run (08:00 UTC, 2026-07-11) — scheduled check `verify-cron-fix-8am-run` fires at 08:10 UTC.
4. ⏳ Confirm logs show calls to:
   - `/api/asins/jobs/enqueue`
   - `/api/asins/jobs/process-next`
5. ⏳ Confirm new `asin_snapshots` rows appear.
6. ⏳ Confirm the queued `background_jobs` count starts falling.
7. ⏳ Confirm the cron no longer returns `{ ok: true, enqueue: null, process: null }`.

### Do not do yet

- Do not change batch size.
- Do not increase cron frequency.
- Do not add another cron.
- Do not manually run a heavy production queue.
- Do not redesign the ASIN page until the pipeline's real behavior is observed.

---

## 5. ASIN Snapshot Pipeline Findings

### Existing pipeline

- Vercel Cron: every 2 hours
- Route: `/api/cron/asins/process-product-snapshots`
- Internal calls:
  - `/api/asins/jobs/enqueue`
  - `/api/asins/jobs/process-next`
- Data written to: `asin_snapshots`
- Uses Amazon SP-API Catalog and Pricing
- Does not depend on Render checker-worker

### Current observed problem before PR #15

- 470 jobs queued
- Oldest queued job roughly 47 hours old
- Completion throughput dropped to zero after Render orchestrator was disabled
- Last successful ASIN snapshot was roughly 28–29 hours old
- Cron itself kept returning 200 every two hours

### Throughput risk after routing is fixed

Current theoretical capacity:

- Batch size: 5
- Cadence: once per 2 hours
- Maximum: about 60 jobs/day
- Catalog size: roughly 470–500 ASINs
- Full refresh cycle: roughly 8 days

### Pending follow-up

After PR #15 is live and queue draining is verified:

1. Measure actual throughput for at least one or two cron runs.
2. Decide whether to:
   - increase batch size,
   - increase cadence,
   - prioritize hero/high-value ASINs,
   - or use a combination.
3. Keep Amazon throttling and cost within safe limits.

---

## 6. Trust Readiness

### Ready / strongest

- Replenishment: approximately 70/100 trust readiness, but needs visible data age.
- Brand Analytics: ready as a data browser, not yet as an action engine.

### Near ready

- Sync Health
- Replenishment
- BSR Monitoring
- Listing Down data layer

### Blocked or shadow mode

- Ads Bleed
- Capped Winner
- Margin Anomaly
- Settlement-to-ASIN P&L
- Inventory Risk
- Keyword Drop
- Pricing Opportunity
- Review Monitoring
- Competitor Intelligence

### Buy Box trust rules

- Canonical automated source: `asin_snapshots`
- Manual detail source: `buybox_snapshots`
- Never infer Buy Box loss from `unknown`
- Future Buy Box Loss cards require fresh confirmed `won` or `lost` data
- Pipeline freshness and confirmed-coverage percentage are separate gates

---

## 7. Data Source Strategy

### Use existing internal sources

- Amazon Ads API
- Amazon SP-API
- Business Reports
- Brand Analytics
- Settlement CSV
- Replenishment engine
- ASIN snapshots
- Buy Box snapshots
- Keyword rank snapshots
- Pincode checks
- Render checker-worker
- Vercel Cron
- Sync Health

### Deferred

- Rainforest API
- Keepa API
- New paid data providers
- New subscriptions

### Standing decision

No new paid external API until Brahmastra has paying customers or a proven ROI reason.

---

## 8. ASIN Page — New Product Requirements

### Overall objective

The ASIN page must become simple, consistent, seller-friendly, actionable, and trustworthy.

### Structure

Both **My Products** and **Competitor Products** should use the same overall design:

1. Page header
2. Summary cards
3. Search and filters
4. Add / Sync / Refresh actions
5. Product table
6. Row-level actions
7. Data freshness details

### My Products requirements

- Add a visible action section, similar to Competitor Products.
- Actions should include:
  - Sync from Amazon
  - Add ASIN manually
  - Refresh all
  - View sync status
- Missing or unmapped products should be addable without making the section feel like a different product.

### Competitor Products requirements

- Keep consistent placement and design.
- Actions:
  - Add competitor ASIN
  - Import list
  - Refresh all
  - View monitoring status

### Customer-facing wording

Replace or explain technical terms:

- `Discoverable` → `Listing Live` or a clearly defined state
- `Seller unknown` → `Buy Box seller not confirmed`
- `Pricing rate-limited` → `Price refresh delayed`
- `Latest attempt rate-limited` → `Showing last confirmed result`
- `BSR unavailable from Catalog source` → `BSR not currently available`
- Technical API names should move to an expandable diagnostics drawer.

### Summary cards

Do not display metrics unless their formula and scope are defensible.

Possible cards:

- My Products
- Listings Live
- Buy Box Won
- Price Available
- BSR Available
- Needs Attention

#### Average BSR

Must be audited before keeping. Do not blindly average BSR across unlike categories.

Preferred alternatives:

- Median BSR within selected category
- Improved / declined product count
- Products in Top 100 / Top 1,000 / Top 10,000

#### Average rating

Missing ratings must not display as zero.

### Table columns

- Product
- Status
- Price
- BSR
- Buy Box
- Availability
- Rating
- Deal
- Data freshness
- Actions

### Buy Box display

Show seller name where possible, not only seller ID.

Examples:

- Won by Emount Retail
- Lost to another seller
- Not confirmed

### Availability display

Do not show an unexplained percentage.

Examples:

- Available in 4 of 8 checked pincodes
- Available
- Partially available
- Unavailable
- Not checked

### Freshness

Use one clear field:

- Updated 3 hours ago
- Some signals delayed

Expandable detail:

- Price checked
- BSR checked
- Buy Box checked
- Pincode availability checked

### Refresh controls

Page level:

- Refresh all, but prioritize stale/high-value ASINs rather than blindly refreshing everything.

Row level:

- Refresh
- View details
- Track / Untrack
- More

Show progress and partial outcomes.

### Track ASIN behavior

Fix contradictory flows such as:

- Already tracked
- Followed by “Failed to track ASIN”

Required outcomes:

- Already tracked → link to existing product
- Added successfully → show next refresh step
- Invalid ASIN → explain marketplace/input issue
- Amazon unavailable → seller-friendly retry message plus internal error code

---

## 9. ASIN Page — Data Audit Required Before UI Build

The following must be inspected and defined before implementation:

1. Meaning of `12 of 999`
2. How Average BSR is currently calculated
3. Why missing ratings display as zero
4. Exact meaning of `Discoverable`
5. Exact meaning of availability percentage
6. Why price exists for some products and not others
7. Whether Buy Box seller IDs can map to seller names
8. Why Track ASIN reports “already tracked” and then fails
9. Canonical table/source for every displayed field
10. What `Check now` refreshes
11. Difference between My Products, tracked ASINs, and imported Amazon listings
12. Which values are current, stale, unavailable, or inferred

### Implementation gate

Do not implement the ASIN redesign until:

- PR #15 is live and verified
- the ASIN snapshot queue is draining
- real pipeline throughput is measured
- this metric/data-definition audit is complete

Design discussion may continue while those tasks are being completed.

---

## 10. Keyword and Pincode Pipelines

### Keyword rank

- Stored in `keyword_rank_snapshots`
- Generated by Playwright via checker-worker `/keyword-rank`
- Manual/on-demand only
- No scheduler
- Lower trust tier than official Amazon API data

### Pincode availability

- Stored in `pincode_checks`
- Generated by Playwright via `/pincode-availability`
- Manual/on-demand only
- No scheduler

### Pending build order

After ASIN snapshot reliability is restored:

1. Pincode capped scheduler
2. Keyword rank capped scheduler
3. Observe freshness and blocking behavior after each

Do not add both at once.

---

## 11. Brahmastra Homepage

### Status

Paused until the underlying data is trusted.

### Homepage principles

- Show only real signals
- No placeholder cards
- No fake confidence scores
- No precise money impact unless defensible
- Explain evidence
- Deep-link to existing detail pages
- Include:
  - Today’s Priorities
  - Keep Doing This
  - Safe To Ignore Today
- Queue must eventually support:
  - Done
  - Dismiss
  - Not Relevant

### Biggest product gap

A queue that never shrinks will destroy daily usage. Persistent feedback/action tracking must be implemented before broad external launch.

---

## 12. Completed Major Work

- P0 security and RLS fixes
- Amazon Ads OAuth reauthorization
- Correct Ads profile selection
- Ads sync reliability improvements
- Sync Health MVP and polish
- Render/Vercel orchestrator cleanup
- Vercel Pro upgrade and deployment recovery
- PR #13: added Buy Box/Keyword/Pincode Sync Health
- PR #14: coverage-aware Buy Box Sync Health
- PR #15: cron base URL loud-failure fix — merged and promoted to production (`1e829b6`, `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b`); cron-run verification in progress
- PR #16: added this tracker file to repo root
- Product strategy and trust-readiness architecture completed

---

## 13. Exact Next Action

### Next task now

**Wait for the 08:00 UTC (2026-07-11) cron run and confirm it reaches `/enqueue` and `/process-next`.**

PR #15 is already promoted to production:

- Production deployment: `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b`
- Production commit: `1e829b6`
- A one-time scheduled check (`verify-cron-fix-8am-run`) fires at 08:10 UTC to pull Vercel runtime logs and Supabase aggregate counts and report back automatically.

### After verification

If queue begins draining:

1. Measure one or two cron cycles.
2. Inspect real processing rate.
3. Decide the smallest safe throughput adjustment.
4. Run the ASIN-page metric/data-definition audit.
5. Finalize ASIN-page UX specification.
6. Implement the ASIN-page redesign.

If queue does not drain:

- inspect the new explicit 502/503 reason;
- fix only the reported root cause;
- do not increase batch size yet.

---

## 14. Tracker Update Protocol

Every future Claude/Codex prompt must end with:

> Update `BRAHMASTRA_MASTER_TRACKER.md` with:
> - task status,
> - files changed,
> - PR and deployment state,
> - what was verified,
> - unresolved blockers,
> - decisions made,
> - next approved step.

Every session must begin by checking:

1. Is anything merged but not deployed?
2. Is anything deployed but not verified?
3. Is any P0/P1 blocker unfinished?
4. Does the new task depend on stale or untrusted data?
5. Has a previous product requirement already covered this work?

---

## 15. Track ASIN Archive/Reinsert Fix

**Status:** ✅ Merged to `master` and **promoted to production**. Founder-approved production verification
complete via read-only evidence; live mutation testing (add/restore/already-active flows) not performed — no
credentials/authenticated session available and no approved test ASIN/fixture was provided (see below).
**Branch:** `fix/track-asin-restore` (separate clean worktree from `origin/master`, not the dirty
`intern/asins-page-work` checkout).
**PR:** [#18](https://github.com/Vinay13893/amazon-seller-toolkit/pull/18) — `Fix Track ASIN restore after archive`. **Merged** into `master` at `2026-07-11T08:01:14Z`.
**Merge commit:** `3fa72fa222a61e16b778905980f6ef7f814f787f` ("Merge pull request #18 from
Vinay13893/fix/track-asin-restore"). Diff against pre-merge master (`b363746`) confirmed exactly 3 files
changed: `esolz-app/src/lib/supabase/asins.ts`, `esolz-app/scripts/test-track-asin.ts`,
`BRAHMASTRA_MASTER_TRACKER.md`.

### Deployment status

- **Vercel build:** `dpl_8TC7jbay4jue1XUX8X1WifRw19GW` for commit `3fa72fa` — `readyState: READY` (build
  succeeded).
- **Production promotion:** ✅ Done via `vercel promote dpl_8TC7jbay4jue1XUX8X1WifRw19GW` (existing local
  Vercel CLI session already authenticated as the founder; no tokens created/exposed). Vercel recorded this as
  a promote action (`action: promote`, `originalDeploymentId: dpl_8TC7jbay4jue1XUX8X1WifRw19GW`) that produced
  production deployment **`dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA`**, commit `3fa72fa222a61e16b778905980f6ef7f814f787f`,
  `readyState: READY`, `target: production`. Confirmed via `get_project`: production alias
  `esolz-app.vercel.app` now resolves to this deployment (previously `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b`, PR #15).
  **Production URL:** https://esolz-app.vercel.app

### Production verification

- **Read-only evidence:** deployed commit (`3fa72fa`) is byte-identical to the commit that passed all 5
  targeted tests and a clean `tsc`/`eslint` pass pre-merge — no drift between tested and deployed code. Vercel
  build completed with no compile errors. `get_runtime_errors` (last 30 min, routes
  `/api/asins/listings`, `/api/asins/jobs/enqueue`, `/api/asins/jobs/process-next`) shows only 2 pre-existing
  error groups (`amazon-pricing` 400, `amazon-catalog` 404 — both intentional classified-failure logging from
  `pricing.ts`/`catalog.ts`, first seen 2026-06-21, attributed to the *previous* deployment
  `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b`), and nothing new or Track-ASIN-related.
- **Live mutation testing not performed.** No authenticated session/credentials to the production app were
  available in this session, and touching auth/tokens is out of scope. No "approved safe test ASIN" or test
  workspace was supplied. Per the fallback instruction given for this task, these three flows were **not**
  exercised live and remain unverified end-to-end in production:
  - adding a genuinely new ASIN
  - re-adding a previously archived ASIN (confirming same row id / `asin_snapshots` history preserved, no
    duplicate row)
  - adding an already-active ASIN (confirming no duplicate row)
  An `internal-test-entitlement.ts` designated test account (`test2026@sociomonkey.com`) exists in the
  codebase for exactly this kind of QA, but no credentials for it were available this session.

### Root cause

`tracked_asins` has `UNIQUE (workspace_id, asin, marketplace)`. Removing an ASIN only sets `status='archived'`
— the row persists and still occupies the unique key. `getTrackedAsins()` filters archived rows out of every
re-check, so re-adding a previously removed ASIN hit the constraint on INSERT and returned a bare "Failed to
track ASIN" with no indication it was previously removed.

### Fix

`esolz-app/src/lib/supabase/asins.ts` — new `addOrRestoreTrackedAsin(workspaceId, input, supabaseClient?)`:
looks up the existing row by `(workspace_id, asin, marketplace)` first. Active → `already_active` (no write).
Archived → **reactivates the same row in place** (`status='active'`, refreshed title/brand/category/image),
preserving `id` so `asin_snapshots` history (FK'd to `tracked_asin_id`) stays linked — no duplicate row. Not
found → inserts, `added`. Lost race on insert (`23505`) → re-resolves from current state instead of erroring or
duplicating. ASIN format validated (`/^[A-Z0-9]{10}$/`) before any DB call. `addTrackedAsin` (the existing
export used by `page.tsx`) is now a thin wrapper with the same signature — **no UI file was touched**.

### Tests

`esolz-app/scripts/test-track-asin.ts`, run via `npx tsx scripts/test-track-asin.ts` (no test framework in this
repo; plain script per existing `scripts/*.ts` convention, no `package.json` change). All 5 required scenarios
passed in the clean worktree: new ASIN, already-active ASIN, archived ASIN restored (same row id preserved),
concurrent duplicate attempt (no duplicate row created), invalid ASIN (rejected before any DB call).
`npx tsc --noEmit` and `npx eslint` on both changed files: clean, no errors.

### Follow-ups (not done here — out of scope for this fix)

- **UI toast wiring deferred.** `TrackAsinResult` (outcome: `already_active` / `restored` / `added` /
  `invalid_asin` / `unavailable`, plus a seller-friendly `message`) is exported but not yet surfaced in
  `page.tsx` toasts — that file is off-limits while `intern/asins-page-work` is uncommitted. Once that branch
  lands, wire `addOrRestoreTrackedAsin`'s outcome/message into `handleAddAsin` and `handleTrackFromListing` for
  precise toasts instead of the current generic success/failure messages.
- **Unresolved: `amazon_listing_items` has the identical unique-constraint shape** —
  `UNIQUE INDEX ... WHERE asin IS NOT NULL` on `(workspace_id, asin, marketplace_id)`
  (`esolz-app/supabase/migrations/007_amazon_account_data_foundation.sql:93-95`) — but no archive/soft-delete
  path was found in the code reviewed for that table, so this specific failure mode is `tracked_asins`-specific
  today. Flagged for awareness only; not in scope for this fix and no evidence it's currently reachable.
- **ASIN snapshot cron verification/throughput measurement (§4/§13) remains pending**, independent of this fix.
  This PR did not touch the cron, `/enqueue`, or `/process-next` routes and does not change that work's status.

---

## 16. ASIN Snapshot Cron Verification & Throughput Measurement (post-PR #15)

**Status:** Read-only production verification complete. Pipeline reaches handlers and processes correctly.
**Decision: B — pipeline reaches handlers, but capacity is too low for a 24h freshness SLA**, plus a
**separate, independently-confirmed issue (D-type): a second, uncoordinated worker (the Render cron) is still
actively processing the same queue**, contrary to this tracker's prior belief that it was decommissioned. No
code changed. No manual heavy production run triggered. No batch size/cadence change made.

### 1–2. Did cron reach `/enqueue` and `/process-next`? What did each return?

**Yes.** Vercel production runtime logs, `dpl_AuPQX5fNL9uuZCmCBWwW66FR2m7b` (commit `1e829b6`, the PR #15 code):

- `08:00:11 GET /api/cron/asins/process-product-snapshots` → `200`
- `08:00:11 POST /api/asins/jobs/enqueue` → `200` (body not console-logged by that route; reconciled via DB below)
- `08:00:16 POST /api/asins/jobs/process-next` → `200`, body:
  `{"jobType":"product_page_snapshot","mode":"system","processed":5,"completed":3,"partialCatalogOnly":0,"pricingSkippedCooldown":0,"pricingRateLimited":0,"pricingUnavailable":2,"catalogNotFound":0,"retried":0,"failed":0,"skippedNoConnection":0}`

This is the **only** real post-fix Vercel cron cycle observed so far (schedule `0 */2 * * *`; next due ~10:00 UTC).
Six `401`s were also seen at `06:29` on the same deployment — these are **not** the scheduled cron (Vercel Cron
always sends a valid `Authorization: Bearer <CRON_SECRET>`); they're unauthenticated probe requests to the same
URL, correctly rejected. Not a pipeline problem.

### 3. `background_jobs` counts by status (`job_type='product_page_snapshot'`)

| status | count | split |
|---|---|---|
| completed | 13,468 | 12,784 my_product / 684 competitor_asin |
| queued | 467 | 454 my_product / 13 competitor_asin |
| running | 10 | **10 my_product, 0 competitor** — see §16.D below |
| failed | 71 | 64 my_product / 7 competitor_asin |

### 4. Oldest queued job age

Created `2026-07-08 18:20:57 UTC` → **~62 hours old** as of `2026-07-11 08:19:49 UTC`. 466 of 467 queued jobs
have `run_after <= now()` (immediately eligible) — this is a throughput backlog, not a cooldown-gating problem.

### 5. Queue-count movement across recent runs

Only one real post-fix Vercel cron cycle exists — too early for a multi-run Vercel-only trend. Combined with the
independently-running Render cron (see §16.D), completed-job counts by hour (last 48h): `07-10 12:00→1`,
`16:00→0` (2 jobs left stuck), `20:00→0` (2 jobs left stuck), `07-11 00:00→2`, `04:00→3`, `08:00→15` (13
completed + 2 failed). Net queued count: ~470 (pre-fix baseline) → 467 now — negligible net movement so far,
expected this early given enqueue also adds new due jobs each cycle.

### 6. New `asin_snapshots` rows by hour, last 48h

`07-10 12:00→1` (bsr:1, price:0), `07-11 00:00→2` (bsr:2, price:1), `04:00→3` (bsr:3, price:2), `08:00→13`
(bsr:13, price:11). **19 total new snapshots in 48h** — reflects the multi-day near-total outage before the fix.

### 7. Actual jobs processed per invocation

- **Vercel system cron:** exactly 5 (matches `SYSTEM_BATCH_SIZE`), 3 fully completed + 2 failed (both catalog
  404 and pricing 400) in the one observed run.
- **Render cron** (separate — see §16.D): up to 10 (`--limit=10`), but inconsistent — two recent runs
  (`07-10 16:00`, `20:00`) completed **zero** jobs and left 2 stuck each; the `08:00` run today completed all 10.

### 8. Are catalog and pricing both being written?

**Yes**, for the majority. Of the 13 snapshots written in the `08:00` hour: all 13 have BSR (Catalog), 11 have
price (Pricing) — 2 are catalog-only (pricing returned "unavailable," not a hard failure).

### 9. Pricing 429/cooldown frequency

Low in the observed window: **0 rate-limited completions since the fix.** Last `amazon_pricing_rate_limited`
event was `2026-07-11 04:01 UTC` (3 jobs, pre-fix/Render-attributed). The one fixed Vercel run had 2
`amazon_pricing_unavailable` (HTTP 400, a different — non-throttling — failure class). Sample size is too small
(1 run) to rule out future 429s at higher throughput.

### 10. Effective full-catalog refresh duration

Catalog size confirmed: **482 My Products + 14 tracked competitors = 496 total addressable targets** (matches
the earlier ~470–500 estimate). Vercel-cron-only theoretical capacity: 5/2h × 12 = 60/day → **~8.3 days per full
cycle** — unchanged from the pre-fix estimate; PR #15 restored correctness, not capacity. The Render cron could
nominally add up to another ~60/day (10/4h × 6) when it doesn't crash, but two of its last six runs completed
zero jobs, so this upside cannot be relied on.

### 11. Is the 24-hour freshness SLA realistic?

**No.** Keeping 496 targets under a 24h staleness ceiling requires ≥496/24 ≈ 20.7 jobs/hour sustained.
Vercel-cron-only capacity is 2.5 jobs/hour — **~8x under** what's needed. Even generously crediting the Render
cron's nominal average, combined capacity (~5 jobs/hour) is still **~4x under** the 24h SLA requirement.

### D. Separate confirmed issue: an uncoordinated second worker is still active

Direct evidence (not inferred): all 10 stuck `running` rows have `locked_by = 'render-cron'` — the exact
worker-identity literal in `esolz-app/scripts/process-asin-checker-jobs.ts:368`, the Render-hosted script this
tracker's Completed Major Work section believed was replaced by the Vercel Cron (PR #12,
"Replace checker-worker orchestrator loop with Vercel Cron"). Reconciling job counts for the `08:00` hour: the
logged Vercel process-next call accounts for exactly 5 of the 15 jobs that finished that hour (3 completed + 2
failed); **the other 10 completions match the Render script's own `--limit=10` default** and its
`0 */4 * * *`-equivalent schedule (documented in `CLAUDE.md` as `easyhome-asin-live-checker`, which coincides
with the Vercel cron every 4 hours, including `08:00` today). `locked_at` timestamps on the 10 stuck rows align
almost exactly with that same 4-hourly cadence going back to `2026-07-09 16:01`.

The script has its own stale-lock reclaim (`cleanupStuckJobs()`, 10-minute timeout) that should have already
reset these 10 rows to `failed` (their `attempt_count` already equals `max_attempts`, so reclaim would not
re-queue them, just unstick them) — but they remain `running` after 12–40 hours despite clear evidence the
script ran successfully since. Either the reclaim logic has a latent bug, or **Render's actually-deployed script
differs from what's on `origin/master`** (Render deploys are independent of the Vercel/GitHub pipeline) — not
confirmed here; would need direct access to the Render dashboard/logs to verify.

**Practical implications:** (a) real combined throughput today was better than Vercel-alone capacity suggests,
but unreliable and uncoordinated; (b) the two workers use different retry-delay constants
(`PRICING_COOLDOWN_RETRY_MINUTES=240min` in the Vercel path vs. `RETRY_DELAY_MINUTES=30min` in the Render
script), so a job's retry cadence depends on which worker last touched it; (c) CLAUDE.md's "Render account has
an unpaid invoice... crons at risk until paid" note is evidently not (yet) blocking this cron — it ran
successfully as recently as today.

### D.1 Follow-up investigation (2026-07-11, later same day) — root cause classification

**Inspection only. No jobs reset, no Render/Vercel config touched, no code changed.**

**Render dashboard/API access: not available in this environment** (no Render CLI installed, no `RENDER_*`
credentials present, no Render MCP tool). Everything below is evidence assembled from git history and Supabase —
**Render's exact deployed commit SHA and deployment timestamp could not be directly confirmed** and remain
open questions requiring dashboard access.

**1. Is the "old Render orchestrator" still running? No — conclusively ruled out.** There are two
*different* Render mechanisms in this repo and they must not be conflated:
- `checker-worker/src/automation/productPageOrchestrator.ts` — a boot-time loop inside the separate
  `checker-worker` **web service** that used to ping `/api/asins/jobs/enqueue` and `/process-next` every 3
  minutes. Commit `b5e13dc` ("chore: disable checker-worker productPageOrchestrator boot loop", merged via PR
  #12 / `e3ebbb2`) removed its `startProductPageSnapshotOrchestrator()` call from `checker-worker/src/server.ts`
  — confirmed via direct diff read. **This is genuinely disabled.**
- `esolz-app/scripts/process-asin-checker-jobs.ts` — a **completely separate, standalone Render Cron Job**
  (`easyhome-asin-live-checker` per `CLAUDE.md`, schedule `0 */4 * * *`, `--limit=10 --max-runtime-ms=240000`)
  that writes directly to Supabase via its own SP-API calls — it never touches the Vercel HTTP routes at all.
  **PR #12 never touched this file.** It is not "the old orchestrator being reactivated" — it was simply never
  in scope for that PR and has apparently been running independently the whole time. (`render.yaml` at the repo
  root describes an unrelated, seemingly stale FastAPI/Celery stack under `saas-backend/` — not this Node
  checker-worker/cron setup — so it isn't authoritative for what's actually deployed on Render either.)

**2. Stuck-job evidence (all 10, re-verified, unchanged since the earlier check this session):** all
`target_type='my_product'`, all `workspace_id=55a321c9-7729-4662-a494-9f1f1aa86846`, `locked_by='render-cron'`,
`attempt_count=3` (equals `max_attempts=3` for every row). `created_at` ages 63–92 hours. `locked_at` (last
claim time) ages 812–2493 **minutes** (13.5–41.5 hours) — static, unchanged from the check performed earlier
this session, confirming no reclaim has happened in the interim despite the Render cron completing 10 other
jobs successfully at `08:00` UTC today. `last_error_safe` is populated (`catalog_not_found` /
`amazon_pricing_rate_limited` / `amazon_pricing_unavailable`) on every row, but this is **stale, from an
earlier (2nd) attempt** — the claim update and the terminal update are separate writes in
`process-asin-checker-jobs.ts`, so a row can show a leftover reason from its previous attempt while its *current*
(3rd, final) attempt is the one that never reached its terminal update and left it stuck `running`. (No
secrets/credentials in any of the above — job IDs and workspace ID only, no tokens.)

**3. Queue-claim logic:** **Claims are atomic on both workers** — confirmed by direct code read. Vercel
(`process-next/route.ts`) and Render (`process-asin-checker-jobs.ts:368`) both use the identical pattern:
`UPDATE background_jobs SET status='running', locked_at=now(), locked_by=<worker>, attempt_count=attempt_count+1
WHERE id=<job> AND status='queued'`, then check the affected-row count to detect a lost race. **A genuine
double-claim of the same row is not possible.** There is **no heartbeat** — `locked_at` is set once at claim
time and never renewed during processing, so a live-but-slow job is indistinguishable from an abandoned one
except by elapsed time. The Render script **does** define a stale-lock reclaim (`cleanupStuckJobs()`,
`STUCK_JOB_TIMEOUT_MINUTES=10`) that should reset any `running` row older than 10 minutes — for these 10 rows
(13.5–41.5 hours stuck) that reclaim has evidently not fired across many observed successful Render invocations
since `2026-07-09`. **Vercel and Render can and do claim from the same queue** — confirmed independently (both
completed jobs in the same `08:00` UTC hour today) — but because claims are atomic, this causes coordination
confusion and unlogged/hard-to-observe combined throughput, **not** duplicate processing of the same row.

**4/5. Pipeline movement / logs since the earlier check this session:** unchanged — `queued=467`,
`running=10`, `completed=13468`, `failed=71`; no new `asin_snapshots` rows since the `08:00` hour (next Vercel
cron is `10:00` UTC, next Render cron is `12:00` UTC — neither had fired as of this check, `~09:35` UTC). Vercel
runtime logs for the last 24h show **zero `502`/`503` responses** anywhere (the PR #15 loud-failure path has not
been triggered since promotion) and no cron activity outside the already-documented `08:00` cycle.

### Root cause classification — FINAL (resolved in D.4, after D.2's timestamp cross-check)

~~**Primary: B — Render is (at least partially) updated, but stale `running` jobs have no working reclaim.**~~
This was written without Render dashboard access. **A is ruled out** (checker-worker's `productPageOrchestrator`
boot loop conclusively disabled, direct commit evidence, `b5e13dc`/PR #12). **C is confirmed true** (Vercel and
Render both actively draining the same queue on overlapping schedules — real, ongoing, but not itself harmful
since claims are atomic). **B, refined and now resolved (D.4):** Render's `cleanupStuckJobs()` reclaim
mechanism **does run every cron cycle and correctly identifies the same 10 real stuck rows each time** — but its
per-row `UPDATE` has no error/result check, so it logs `Stuck reset: 10` believing it succeeded while the write
never actually persists. Confirmed by cross-referencing two independent `Stuck reset: 10` log events
(2026-07-11, `04:01` and `08:00` UTC) against exact-timestamp Supabase queries: in both windows, the only rows
actually touched were unrelated fresh (`attempt_count=1`) jobs completing normally — not the 10 stuck rows,
which remain untouched through both events. **D is ruled out.** **E not needed.**

### D.2 Founder-supplied Render dashboard evidence (2026-07-11, later same day) — correction and reconciliation

**Inspection only. No jobs reset, no SQL run, no Render/Vercel config touched, no code changed, no cadence/batch
size changed**, per explicit instruction this round.

**New confirmed facts (founder-supplied, from Render dashboard screenshots — resolves the "cannot verify without
dashboard access" gap in D.1):**
- Render Cron Job: **`easyhome-asin-live-checker`**, service ID `crn-d93v9stckfvc739b1d9g`.
- Repo/branch: `Vinay13893/amazon-seller-toolkit` / `master`. Latest visible build: **`3fa72fa`** — the PR #18
  merge commit — confirming Render **is** tracking `master` and picked up recent commits (this postdates the
  reclaim logic, which has been on `master` well before `3fa72fa`).
- Command matches `CLAUDE.md` exactly: `npx tsx scripts/process-asin-checker-jobs.ts
  --workspace-id=55a321c9-7729-4662-a494-9f1f1aa86846 --limit=10 --max-runtime-ms=240000`, schedule every 4
  hours.
- Render logs show real run outputs, e.g. `processed 10, completed 10` in one run and `processed 3, completed 2,
  partialCatalog 1, pricingRateLimited 1` in another — both consistent with the script's own summary format and
  with what was independently inferred from Supabase in D.1 (Render successfully completing batches). Logs also
  show an explicit `Amazon Pricing 429` occurrence and a **`Stuck reset: 10`** line.

**Reconciliation against Supabase (re-verified this round, read-only):** the same 10 `background_jobs` rows
(`6282a60e…`, `9eab8a78…`, `d74c7817…`, `adff57d2…`, `00fd6134…`, `3bdc12b8…`, `277c7d02…`, `495fd4bf…`,
`2615ca6a…`, `d0d2fc2b…` — internal IDs only) remain `status='running'` with **byte-identical `locked_at`
timestamps** to the earlier check this session — no movement at all. A direct query for
`last_error_safe = 'stale processing reset'` (the exact string `cleanupStuckJobs()` writes when it resets a
row) returns **zero rows in the entire table, ever**. So: Render's logs and the founder's read of them say a
reset of 10 happened; Supabase shows no reset of *these* 10, and no reset with that marker has ever landed.
**This is not yet fully resolved** — two explanations are both plausible and not yet distinguished:
(a) the `Stuck reset: 10` line reported a *different* batch of 10 stuck rows (from an earlier incident, now
gone) and a *new* set of 10 got stuck again afterward through the same underlying crash pattern — the current
10 would then be a fresh recurrence, not evidence the mechanism doesn't work; or (b) `cleanupStuckJobs()`'s
per-row `.update(...)` call (`esolz-app/scripts/process-asin-checker-jobs.ts` — the update inside its reset loop
has no error check) is silently failing while the function still increments and reports its local `reset`
counter regardless, so it *logs* success without the write taking effect. **Not adjudicated here** — would need
the exact timestamp of the `Stuck reset: 10` log line to cross-reference against these rows' `locked_at`/
`updated_at`, which requires further Render log access beyond this round's screenshots.

**Revised classification (superseded by D.4 below — resolved, not just "downgraded"):** see D.4.

### D.4 Timestamp cross-check (2026-07-11, later same day) — discrepancy resolved

**Founder supplied the exact Render log timestamps (IST) for two `Stuck reset: 10` events. Converted to UTC
(IST = UTC+5:30) and cross-checked against Supabase, read-only, no SQL mutations, no rows changed:**

| Render event (IST) | UTC | Render's own JSON summary |
|---|---|---|
| 1 — `09:31:13 AM` reset line, `09:31:19 AM` summary | **≈04:01:13–04:01:19** | `stuckReset:10, processed:3, completed:2, partialCatalog:1, pricingRateLimited:1, failed:0` |
| 2 — `01:30:54 PM` reset line, `01:31:08 PM` summary | **≈08:00:54–08:01:08** | `stuckReset:10, processed:10, completed:10, failed:0` |

**Supabase, `updated_at` in each exact window:**
- Window 1 (04:00:30–04:02:00 UTC): **exactly 3 rows touched**, all `created_at=2026-07-09 20:01:05` (one
  original batch), all `attempt_count=1` (first attempt — never previously stuck), 2 completed clean + 1
  completed with `amazon_pricing_rate_limited` — an exact match to Render's own `processed:3/completed:2/
  pricingRateLimited:1`.
- Window 2 (08:00:30–08:02:00 UTC): **exactly 10 rows touched**, same `created_at=2026-07-09 20:01:05` cohort,
  all `attempt_count=1`, all completed clean, `last_error_safe=null` — an exact match to Render's own
  `processed:10/completed:10`. (These are the same 10 rows already reconciled against the Vercel side in D.1's
  original `08:00` hour analysis.)

**None of the known 10 stuck job IDs appear in either window** — their `updated_at`/`locked_at` remain at their
original claim times (`2026-07-09 16:01` through `2026-07-10 20:01`), unchanged through both reset events and
through now. **Zero rows anywhere carry `last_error_safe='stale processing reset'`, at either timestamp or
ever.**

**Answers:**
1. **Did the same 10 stuck job IDs change at either timestamp? No.**
2. **Were 10 different jobs reset at either timestamp? No** — the rows written in both windows were fresh,
   `attempt_count=1` jobs undergoing ordinary claim→complete processing, not resets of anything.
3. **Any rows marked `stale processing reset` around those times? No — none, ever, anywhere in the table.**
4. **Did status/locked_by/locked_at/attempt_count change for the stuck rows at those times? No.**
5. **Is `stuckReset:10` possibly logged before confirming DB persistence? Yes — this is now the best-supported
   explanation.** `cleanupStuckJobs()`'s per-row `.update(...)` call has no error/result check
   (`esolz-app/scripts/process-asin-checker-jobs.ts`), so its counter increments once per stuck row *found*,
   regardless of whether that row's UPDATE actually persists. Both events report exactly **10** — matching the
   exact, unchanging count of real stuck rows in the table at both points in time, days apart. The function is
   correctly *finding* the same 10 stuck rows every cron cycle and *believes* it fixed them, but the write is
   not landing.
6. **Is Render definitely connected to the same Supabase DB as Vercel? Yes** — Render's self-reported
   `processed`/`completed`/`pricingRateLimited` counts for both events match Supabase row-for-row, down to the
   same `created_at` batch and sub-second completion timestamps. This could not coincidentally match a
   different database.
7. **Were rows reset and then immediately reclaimed again? No evidence of this** — the rows touched in both
   windows were fresh first-attempt jobs, not previously-stuck rows cycling through reset→reclaim.
8. **Did new jobs enter `running`/`locked_by='render-cron'` at those times? Transiently, yes** (implied by the
   atomic claim pattern for the 3 and 10 jobs actually processed) but not persistently — all are `completed`
   with `locked_by=NULL` now, which is expected/correct, not the stuck-job phenomenon.

**Resolution:** hypothesis (b) from D.2 is now well-supported and hypothesis (a) is not — **this is not a fresh
recurrence of a different batch; it is the same 10 rows being rediscovered and "reset" (log-wise) every cron
cycle without the fix ever taking effect in the database**, most likely because the reclaim loop's per-row
update has no verification step. **The discrepancy is resolved: Render's cleanup-log line is not reliable
evidence that the DB was actually fixed.** This is a real, still-open code-level bug in
`cleanupStuckJobs()` (not touched — no code changed this round, per instruction).

### D.3 Combined throughput measurement, last ~22–48h (read-only)

Real activity in the `background_jobs`/`asin_snapshots` tables only starts at `2026-07-10 12:00 UTC` — everything
before that in the 48h window is zero, consistent with the pre-PR#15 near-outage already documented in §16.

| Hour (UTC) | Completed | Failed | New `asin_snapshots` | With price | Note |
|---|---|---|---|---|---|
| 07-10 12:00 | 1 | 0 | 1 | 0 | |
| 07-11 00:00 | 2 | 0 | 2 | 1 | |
| 07-11 04:00 | 3 | 0 | 3 | 2 | |
| 07-11 08:00 | 13 | 2 | 13 | 11 | Vercel (5) + Render (10) both fired — best hour observed |
| 07-11 10:00 | 4 | 1 | 4 | **0** | **Vercel-only hour** (Render's schedule doesn't fire at :10) — `pricingRateLimited=1` this hour, 0/4 got a price |

**Totals, last 48h:** 23 completed + 3 failed = 26 finished. Over the ~22-hour active window
(07-10 12:00 → 07-11 10:00): **≈1.2 jobs/hour ≈ 28/day combined observed rate.**

**Jobs completed per source:** not cleanly distinguishable after the fact — both workers clear `locked_by` to
`NULL` on their terminal update, so completed rows carry no worker identity. Best-effort proxy: Render's
schedule (`0,4,8,12,16,20` UTC) only overlaps 6 of the 24 hours/day; the other 18 (`2,6,10,14,18,22` UTC) are
Vercel-only by construction. The one clean Vercel-only sample this window (`10:00`) produced 5 processed
(matches `SYSTEM_BATCH_SIZE`), matching Vercel's own logged summary format from earlier in §16.

**`pricingRateLimited` counts, last 48h:** 4 total (`12:00` day-1: 1, `00:00`: 1, `04:00`: 1, `10:00`: 1) —
roughly 1 per active hour so far, spread across both Vercel-only and combined hours, confirming Amazon Pricing
429/cooldown is an **account-wide constraint that affects both workers identically**, not a Render-specific or
Vercel-specific problem.

**Estimated full-catalog refresh duration, current combined setup:** 496 addressable targets (482 My Products +
14 tracked competitors, per §16 original) ÷ ≈28/day observed ≈ **~18 days**. This is *worse* than the
Vercel-alone theoretical estimate (~8.3 days at 60/day) computed earlier in §16 — the gap is Amazon Pricing 429
throttling plus Render's own intermittent zero-completion runs (both already documented), not a new problem.

**What Vercel-only settings would be needed before disabling Render:** Vercel's own theoretical solo capacity
(60/day at batch=5, cadence=2h) **already exceeds** the current messy combined-observed rate (~28/day) — a
finding worth sitting with before assuming Render is net-additive today. Before disabling Render:
1. Confirm Vercel alone can sustain its 60/day theoretical rate in practice (not yet measured Vercel-only over a
   full day — today's data has only one clean Vercel-only hour).
2. Confirm the account-wide Pricing 429 gate behaves the same or better under Vercel-only load (no reason to
   expect Amazon's limit changes, but not yet directly observed).
3. Resolve the D.2 stuck-reset discrepancy first — disabling Render while its reclaim behavior is still
   ambiguous would remove the only mechanism (however uncertain) currently touching those rows at all.
No batch size or cadence change was made this round, per instruction.

### Cheapest safe fix

1. **Surgical, immediate SQL reclaim of the 10 known stuck rows: still recommended, still deferred, still not
   run.** Code fix in D.5 below does not retroactively touch these existing 10 rows — it only makes *future*
   reclaim attempts trustworthy. The 10 rows first identified in D.1 remain stuck as of this writing and will
   need either this one-time SQL (still not executed, per instruction) or a subsequent successful automated
   reclaim once PR #24 (below) is merged and deployed.
2. **Code-level fix — ✅ implemented, PR open, not merged.** See D.5.
3. **Longer-term:** unchanged — decide whether to keep both workers or consolidate; informed by D.3's finding
   that Vercel-alone theoretical capacity already exceeds today's real combined throughput.

### D.5 Code fix for the reclaim-verification bug (2026-07-11, later same day)

**Root cause (confirmed in D.4):** `cleanupStuckJobs()` in `esolz-app/scripts/process-asin-checker-jobs.ts`
counted a stuck job as reclaimed the moment it issued the `UPDATE`, without checking the Supabase response's
`error` or matched-row count. Both live `Stuck reset: 10` events found the same 10 real stuck rows every run and
logged success, but the write never persisted.

**Fix (PR [#24](https://github.com/Vinay13893/amazon-seller-toolkit/pull/24), not merged):**
- Extracted `reclaimStuckJob()` as a standalone, exported function. Each reclaim now uses a **guarded update**
  (`.eq('status','running').eq('locked_at', <snapshot taken at SELECT time>)`) plus `.select('id')`, and checks
  the returned `error`/row-count before counting the row as reclaimed — the same verify-after-write pattern this
  file's atomic job-claim query already used. The `locked_at` guard also closes a race window: a row reclaimed
  by another worker between the SELECT and this UPDATE is correctly reported as "not reclaimed" instead of
  silently overwritten.
- `cleanupStuckJobs()` now returns `{found, reclaimed, failed, failures}` instead of a bare count.
  `main()`'s console log and JSON summary now report `stuckFound` / `stuckReclaimed` / `stuckFailed` (plus a
  reason per failure) instead of the single misleading `stuckReset` field — **future Render log lines will be
  trustworthy** and the exact D.4-style discrepancy cannot recur silently.
- **Semantics preserved exactly:** `attempt_count >= max_attempts` → `failed` (not re-queued — avoids retrying a
  poisoned job forever); otherwise → `queued` with the existing `RETRY_DELAY_MINUTES` delay.
  `last_error_safe='stale processing reset'` marker unchanged (kept for continuity with D.1–D.4's documented
  evidence trail).
- **Idempotent** — a repeat run only re-finds rows still matching `status='running'`, and the `locked_at` guard
  prevents double-acting on a row already reclaimed by a prior/concurrent run.
- Also made the Supabase admin client lazy (created inside `main()`, not at module load) and guarded the
  bottom-level `main()` invocation behind an entrypoint check, so the file is importable for testing without
  live credentials — required to add `esolz-app/scripts/test-stuck-job-reclaim.ts` (5 scenarios: retries-
  remaining reclaim, max-attempts reclaim, Supabase error not counted as success, zero-row-match not counted as
  success, idempotent double-reclaim — all passing). No behavior change to the real cron invocation path beyond
  the write verification itself.

**Checks:** `npx tsx scripts/test-stuck-job-reclaim.ts` — 5/5 pass. `npx tsx scripts/test-track-asin.ts` — 5/5
still pass (no regression). `npx tsc --noEmit` — clean. `npx eslint` — no new issues (one pre-existing unused-
var warning, confirmed present on `master` already).

**Not done:** no SQL run, no DB rows changed, no Render/Vercel config/cadence/batch-size changed, no migration
(none needed — all columns already existed), not merged, not deployed.

### D.6 PR #24 merged and first post-merge verification (2026-07-11, later same day)

**PR #24 merged.** Merge commit `26c819dd3ee9ab5fe816d2efd632d4e44a260c77`, merged `2026-07-11T11:45:49Z`.
Files changed (confirmed via `git diff --name-only` against the pre-merge tip): exactly
`esolz-app/scripts/process-asin-checker-jobs.ts` and `esolz-app/scripts/test-stuck-job-reclaim.ts`. Vercel
auto-built the merge commit (`dpl_Bij7FnSWHjhhoV7x3wMjAdJ8gUBq`, preview build, `target: null`) — **not
promoted**, per instruction (this fix only affects the Render-hosted script; Vercel doesn't run it).

**Render's own build/deploy state could not be directly confirmed** — no Render dashboard/API access in this
environment, same limitation as D.1–D.4.

**First post-merge Render cron cycle (12:00 UTC, ~14 minutes after the merge) — inconclusive, most likely still
old code:**
- All 10 originally-tracked stuck job IDs remain **completely unchanged** — identical `status='running'`,
  identical `locked_at` timestamps, identical `last_error_safe` values, down to the same values recorded in
  D.1–D.4.
- A single **new**, previously-untracked row also entered `status='running'` and is now stuck too (overall
  `running` count went 10 → 11 between checks), alongside normal queue movement elsewhere (`completed`
  13468→13478, `failed` 71→72, `queued` 467→456) confirming the cron did fire and do real work.
- **Most likely explanation: deploy lag, not a fix failure.** Only ~14 minutes elapsed between the GitHub merge
  and this cron's scheduled fire — not necessarily enough time for Render to build and roll out the new
  container before that specific invocation started. A fresh job getting stuck in exactly the old, pre-fix
  pattern is consistent with the *old* code still being live for this one cycle, not with the new
  verify-before-counting logic running and revealing some deeper problem.
- **Not adjudicated with certainty** — the fastest way to resolve this is checking the Render dashboard log
  format for the 12:00 UTC run directly: the **old** code logs a single line
  `[asin-checker] Stuck reset: N`; the **new** (fixed) code logs
  `[asin-checker] Stuck cleanup: found=X reclaimed=Y failed=Z` (a different shape). Whichever format appears
  for the 12:00 run settles whether Render had already redeployed by then.
- **No SQL reclaim run.** Per instruction: "if they do not clear, report exact reason before any manual SQL" —
  the reason above (probable deploy lag) is reported; recommend waiting for the **next** cron cycle (16:00 UTC)
  for an unambiguous read, by which time Render should certainly have redeployed, rather than concluding
  anything definitive from this one early, timing-ambiguous cycle.

### D.7 PR #24's fix confirmed live — explicit root cause found (2026-07-11, later same day)

**PR #24 is live on Render.** Founder-supplied log evidence from `easyhome-asin-live-checker` around `09:31 PM
IST` confirms the new logging format is in production:

```
Stuck reclaim failed for job ...: null value in column "run_after" of relation "background_jobs" violates not-null constraint
{"stuckFound":11,"stuckReclaimed":0,"stuckFailed":11,"enqueued":4,"processed":2,"completed":1,"partialCatalog":1,"pricingRateLimited":1,...}
```

**This is exactly what the D.6 recommendation anticipated:** the old silent-logging bug (PR #24) is confirmed
fixed — the reclaim mechanism now reports failures explicitly instead of claiming false success. What it
revealed is a second, previously-invisible bug: **`background_jobs.run_after` is `timestamptz NOT NULL DEFAULT
now()` (migration 034), but `reclaimStuckJob()`'s max-attempts branch wrote `run_after: null`, so every reclaim
attempt for a job at max attempts was rejected outright by Postgres.** This fully explains why the original 10
(now 11) stuck rows never cleared across every prior cycle in D.1–D.6 — not deploy lag as hypothesized, but a
second real bug that PR #24 had to exist first in order to expose.

**Fix (PR [#26](https://github.com/Vinay13893/amazon-seller-toolkit/pull/26), not merged):** the terminal-`failed`
branch now writes `run_after: undefined` instead of `null`. Supabase-js drops `undefined`-valued keys during
JSON serialization, so the column is left at its existing (non-null) value instead of being written at all —
the same pattern already used correctly for this exact case in
`esolz-app/src/app/api/asins/jobs/process-next/route.ts` (Vercel side). Retry-path (`queued`) semantics
unchanged. 6/6 targeted tests pass (2 new, covering both paths' non-null `run_after` plus a dedicated regression
guard simulating the exact Supabase rejection seen live); `test-track-asin.ts` 5/5 still pass; `tsc`/`eslint`
clean.

**Related, flagged, not fixed:** the identical `run_after: null` pattern also pre-exists in **three other,
unrelated spots in this same file** — the main claim-processing loop's own failed-path branches (approximately
the lines handling `skippedNoConnection`, pricing/catalog terminal failure, and snapshot-insert failure). These
are separate, pre-existing latent bugs that would cause the same NOT NULL rejection for *any* job reaching
max-attempts through the normal processing path (not just the stuck-reclaim path) — out of scope for PR #26 per
explicit "small targeted fix only" instruction. **Recommended as the next code-fix task** once #26 is reviewed.

### D.8 PR #26 merged, deployed, and verified — thread closed (2026-07-11/12)

**PR #26 merged.** Merge commit `fc88d014559ec17c2dcf9199dddc1e501f64140e`, merged `2026-07-11T17:15:29Z`. Files
changed (confirmed via `git diff --name-only` against the pre-merge tip): exactly
`esolz-app/scripts/process-asin-checker-jobs.ts` and `esolz-app/scripts/test-stuck-job-reclaim.ts`. Vercel
auto-built the merge commit (`dpl_3JU89QhYVwd89vBFWopvWKhzBd1u`, `READY`) — informational only, not promoted (no
production relevance; this fix only runs on Render).

**Render's build/deploy state still could not be directly confirmed** (no dashboard/API access this session) —
verified indirectly via the next cron cycle's actual effect on Supabase instead, same approach as D.6/D.7. This
time there was ~2h45m between merge and the next scheduled cron (`20:00 UTC`, vs. only ~14 min last time), ruling
out the deploy-lag ambiguity from D.6.

**Result: ✅ full success — all 11 stuck rows cleared naturally, no SQL needed.**
- Cross-checked all 10 originally-tracked stuck job IDs (internal IDs only): every one now shows
  `status='failed'`, `completed_at='2026-07-11 20:01:02.224+00'` (exactly the `20:00 UTC` cron cycle),
  `locked_at=NULL`, `locked_by=NULL`, `last_error_safe='stale processing reset'`.
- **`run_after` is non-null on every row and preserved at each row's original pre-stuck value** (e.g. job
  `6282a60e…` shows `run_after='2026-07-09 14:15:06.767+00'`, matching exactly what was recorded for it in
  D.1–D.4) — confirms the PR #26 fix (`undefined` instead of `null`) worked precisely as designed: the column
  was left untouched rather than nulled or overwritten.
- The previously-new 11th stuck row is also gone: aggregate `failed` count moved 72 → 83 (+11), and a direct
  query for any `status='running'` row in the whole `product_page_snapshot` job type now returns **zero rows**.
- Aggregate counts: `completed=13500` (+22), `failed=83` (+11), `queued=442`, `running=0`.

**SQL reclaim: not needed, not run.** The automated fix cleared every stuck row on its own on the very next
cycle.

**Thread closed.** Both bugs found during this investigation (D.1–D.8) are now fixed and verified live:
1. The silent-success logging bug (PR #24) — reclaim now reports found/reclaimed/failed accurately.
2. The `run_after: null` NOT NULL violation (PR #26) — reclaim writes now actually persist.

**Review automation is held until this thread's closure is acknowledged** — noted per instruction, not started
this session.

**Follow-up not started, still open:** the identical `run_after: null` pattern remains unfixed in **three other,
unrelated spots** in `esolz-app/scripts/process-asin-checker-jobs.ts` (the main claim-processing loop's own
failed-path branches, approximately lines 385/447/515 as of PR #26) — these affect the *normal* (non-stuck)
terminal-failure path, not just reclaim, and would cause the same NOT NULL rejection for any job that
legitimately exhausts its retries during ordinary processing. Recommended as the next code-fix task.

### D.9 Follow-up fix: the 3 remaining `run_after: null` sites (2026-07-12)

**PR #25 merged** (merge commit `fd96278518a07643df367ff5b98a3f532abb10c4`, `2026-07-12T01:49:09Z`, docs only —
closed out D.1–D.8 on `master`).

**Inspected all three flagged sites plus two adjacent ones for completeness:**

| Site | Branch | Status before this fix |
|---|---|---|
| No active Amazon connection for the workspace | `canRetry ? <30min retry> : null` | Bug (fixed) |
| Catalog **and** Pricing both failed | `canRetry ? <variable retryDelay> : null` | Bug (fixed) |
| `asin_snapshots` insert failed | `canRetry ? <30min retry> : null` | Bug (fixed) |
| Missing ASIN in job payload | `run_after` omitted from update entirely | Already correct, untouched |
| Job completed successfully | `run_after` omitted from update entirely | Already correct, untouched |

**Fix (PR [#28](https://github.com/Vinay13893/amazon-seller-toolkit/pull/28), not merged):** extracted
`buildRetryOrFailUpdate(canRetry, reason, retryAfterIso, nowIso)` — a small, pure, exported helper building the
shared `{status, last_error_safe, run_after, locked_at, locked_by, completed_at}` payload. All three sites now
call this helper instead of writing an inline literal; each site's own `canRetry` computation and
reason/retry-delay logic is untouched — only the payload construction changed. `run_after: undefined` (not
`null`) on the `canRetry=false` branch, identical pattern to the reclaim fix in PR #26. No throughput,
scheduling, cadence, batch-size, or worker-architecture change; no auth/tokens/Ads/payments/replenishment/
migration touched.

**Tests:** new `esolz-app/scripts/test-retry-or-fail-update.ts`, 6/6 pass (2 per site: retries-remaining path has
a valid non-null `run_after`; max-attempts path never has `run_after: null`). `test-stuck-job-reclaim.ts` 6/6 and
`test-track-asin.ts` 5/5 still pass (no regression). `tsc --noEmit` clean. `eslint` clean on both changed files
(one pre-existing, unrelated warning).

**Not yet done:** PR #28 not merged, not deployed. Per the same post-merge verification pattern used for PR #26
(D.8), once merged the next step is: wait for a real scheduled Render cron cycle, then confirm via Supabase that
any job legitimately hitting these three paths at max attempts ends up `status='failed'` with a non-null
`run_after` — these three paths are rarer in normal operation than the stuck-reclaim path was, so a specific
live trigger may take longer to observe than one cron cycle; absence of a NOT NULL error in that window is
itself partial evidence, not full confirmation.

### Options to consider (not implemented — awaiting approval)

1. **Increase Vercel batch size only** (5 → 15–20 per 2h run): ~180–240/day → full refresh ~2.1–2.8 days.
   Risk: **medium** — burstier Pricing calls raise 429 risk; needs headroom check against the 120s
   `process-next` `maxDuration`.
2. **Increase Vercel cadence only** (every 2h → every 30–60min, batch stays 5): ~120–240/day depending on
   interval → full refresh ~2.1–4.1 days. Risk: **low–medium** — same total daily API volume as option 1 for
   equivalent throughput, spread more evenly (gentler on rate limits); more serverless invocations.
3. **Prioritize My Products / hero ASINs**: reorder candidate selection to drain My Products (482/496, i.e.
   nearly the whole catalog) first. Risk: **low** — no capacity gain by itself since My Products already
   dominates by volume; would need a "hero ASIN" concept that doesn't exist in the schema yet to be meaningful.
4. **Safe combination (smallest single change, tentatively recommended)**: batch 5→10 **and** cadence 2h→1h:
   ~240/day → full refresh ~2.1 days, split across two smaller, independently-revertible levers instead of one
   large one. Risk: **low–medium**.

**Separately, and independent of any throughput decision:** the 10 stuck `render-cron`-locked rows should be
reclaimed (one-time `UPDATE ... SET status='failed', locked_at=null, locked_by=null WHERE status='running' AND
locked_by='render-cron' AND locked_at < now() - interval '1 hour'`), and the Render cron's actual deployed state
should be checked directly (dashboard/logs) before tuning Vercel's batch size or cadence — running two
uncoordinated workers against the same queue while also increasing one of them's throughput compounds the
diagnostic difficulty if something goes wrong.

### Recommended next approved task

1. Investigate the Render cron directly (dashboard/deployed script version/recent run logs) and decide: keep,
   coordinate with the Vercel cron, or finally decommission it — before any Vercel throughput change.
2. Reclaim the 10 stuck rows (read-only-verified fix, not yet applied).
3. Only then pick one of the throughput options above, smallest change first, and re-measure over multiple
   cycles before going further.

### D.5 Founder-resupplied Render dashboard evidence — cross-checked against deploy state (2026-07-11, ~17:57 UTC)

**Inspection only. No code changed, no Render/Vercel settings changed, no SQL run (read-only or otherwise), no
manual SQL reclaim performed, per explicit instruction this round.**

**Founder-supplied Render evidence this round (verbatim):** Render Cron Job `easyhome-asin-live-checker`
(service ID `crn-d93v9stckfvc739b1d9g`), repo/branch `Vinay13893/amazon-seller-toolkit` / `master`, command
`npx tsx scripts/process-asin-checker-jobs.ts --workspace-id=55a321c9-7729-4662-a494-9f1f1aa86846 --limit=10
--max-runtime-ms=240000`, schedule every 4 hours, **latest visible build `3fa72fa`** (the PR #18 merge commit).
Logs show: `Stuck reset: 10`; `Enqueued 0`; one run `processed 10, completed 10`; another run `processed 3,
completed 2, partialCatalog 1, pricingRateLimited 1`; an Amazon Pricing 429 occurrence.

**Cross-check against git history (read-only, `git log`/`git show`, no SQL):** `3fa72fa` merged
**2026-07-11 08:01:13 UTC**. Every subsequent investigation and fix in this section postdates it:

| Commit | What | Merged (UTC) |
|---|---|---|
| `3fa72fa` | PR #18 (Track ASIN restore) — what Render's dashboard still shows as latest deployed | 08:01:13 |
| `6f65df2` | PR #23 — D.1–D.4 Render investigation (docs only) | 11:27:59 |
| `26c819d` | PR #24 — fix `cleanupStuckJobs()` to verify writes before reporting reclaim success | 11:45:49 |
| `fc88d01` | PR #26 — fix `reclaimStuckJob()` writing `run_after: null` (the actual root cause PR #24 exposed: a NOT NULL constraint rejected every reclaim write) | 17:15:28 |

**Render's own dashboard still reports `3fa72fa` as its latest deployed build** — over 9 hours and three merged
fixes behind current `master`. As of this evidence, **Render has not redeployed since PR #18** and is still
running the pre-PR-#23 script.

**Correcting the proposed interpretation:** the `Stuck reset: 10` / `processed 10, completed 10` log lines in
this evidence are from that same pre-fix script — structurally identical to the evidence already recorded in
§16 D.2, which D.4's exact-timestamp cross-check against Supabase already showed does **not** correspond to the
10 known stuck rows actually being reclaimed. D.4 concluded the pre-fix `cleanupStuckJobs()` logs `stuckReset:
N` based on rows *found*, not rows *successfully written* — exactly the bug PR #24 fixed, and exactly the
failure mode PR #26 then found and fixed underneath it (the reclaim write was rejected by a NOT NULL
constraint).

**So: "B — stale reclaim missing is no longer correct; reclaim is running" is not supported by this evidence.**
The safer reading is close to the opposite: this evidence is fully consistent with the reclaim still being
broken on Render, because Render hasn't picked up either fix yet. Whether the fix actually works cannot be
confirmed until (a) Render redeploys to at least `fc88d01`, and (b) a fresh, timestamped `Stuck reset` log line
from *that* build is cross-checked against Supabase the same way D.4 did — which requires a read-only SQL
check, not run this round per instruction.

**What is confirmed / re-confirmed by this round's evidence, independent of the B question:**

- **A — old orchestrator active: still false.** Unchanged; proven independently via commit diff
  (`b5e13dc`/PR #12), not dependent on Render's current build.
- **C — dual workers active: still true.** Render (`easyhome-asin-live-checker`, confirmed live and current per
  this evidence, on schedule) and Vercel Cron (`0 */2 * * *`) are both still processing the same
  `background_jobs` queue.
- **Queue is moving.** Consistent with §16 D.1/D.3's existing throughput numbers — not re-measured this round
  (no SQL run).
- **Amazon Pricing throttling is real and ongoing** — another 429 in this round's evidence, consistent with the
  4-in-48h rate already documented in D.3.
- **Throughput/canonical-worker architecture decision remains open** — unchanged from §16's existing "Options
  to consider," now additionally gated on confirming whether Render needs a manual redeploy trigger before any
  of PR #24/#26's fixes take effect.

**Manual SQL reclaim: still not performed, per explicit instruction this round** (was already not performed in
D.1/D.2/D.4; remains the case).

**Recommended next step (not performed — awaiting approval):** confirm whether Render auto-deploys from
`master` on push or requires a manual "Deploy latest commit" trigger from the Render dashboard. If manual,
that is a Render-settings-adjacent action needing explicit approval before touching it. Only after Render is
confirmed running `fc88d01` (or later) should the next Render log evidence be treated as a real test of the
PR #24/#26 fix.

---

## 17. Standing Rule: Reuse Before Request (Report Reuse Gate)

**New permanent architecture decision.** For every existing or future API report fetch, Brahmastra must use a
centralized "reuse before request" gate. Before creating a new Amazon SP-API or Amazon Ads report, the system
must check, in order: (1) whether trusted normalized data already covers the requested scope; (2) whether a
matching completed report exists in our database; (3) whether a matching report is already queued or
processing; (4) whether Amazon already has a usable completed report; (5) only then may it create a new report.
This applies to Business Reports, Amazon Ads reports, Brand Analytics, settlement/payment reports (once
auto-fetch is ever built), inventory/FBA reports, and any future report-fetching workflow.

**Status:** ✅ Architecture **approved and merged to `master`**. Inspection and architecture complete.
**Implementation not started. No migration created or applied. No report job modified.** Full spec:
`REPORT_REUSE_GATE_SPEC.md` (repo root).

**Merge record:**
- PR [#20](https://github.com/Vinay13893/amazon-seller-toolkit/pull/20) (ASIN snapshot cron verification, §16)
  — merged `2026-07-11T09:20:46Z`, merge commit `c27dccb72c944171fbfb3ab0bdd86d37e313a2e2`. Files changed:
  `BRAHMASTRA_MASTER_TRACKER.md` only (docs only, content unaltered).
- PR [#21](https://github.com/Vinay13893/amazon-seller-toolkit/pull/21) (this section + the spec) — rebased
  cleanly onto post-#20 `master` (`git rebase --onto origin/master`) before merge; final diff verified to
  contain exactly `REPORT_REUSE_GATE_SPEC.md` (new) and `BRAHMASTRA_MASTER_TRACKER.md` (+76/-0, §17 only) — no
  PR #20 content reappeared as new changes. Merged `2026-07-11T09:23:00Z`, merge commit
  `cf377201d16f23c076032bfa867f4b0cd022b9aa`.
- Both merges were documentation-only; no Vercel build promotion was needed or performed for either.

### Audit status

All current report-fetching workflows audited: Business Reports (`GET_SALES_AND_TRAFFIC_REPORT`), Amazon Ads
(6 report types), Brand Analytics (3 report types), Inventory/FBA (`GET_LEDGER_DETAIL_VIEW_DATA`). Confirmed
settlement/payment has no auto-fetch today (manual CSV import only — zero `createReport`-family calls anywhere
in that code path). Replenishment inputs consume already-stored tables and don't call Amazon report endpoints
directly, so they inherit whatever reuse behavior their upstream workflow has.

### Current duplicate-request risks (highest first)

1. **Brand Analytics and Inventory/FBA have zero reuse logic today.** Every request to
   `POST /api/amazon/brand-analytics/reports/request` or the FBA `fulfillment-report` route's `action:'start'`
   unconditionally calls `createAmazonReport` — no check against prior requests, no local-data check, no
   concurrency lock. A double-click, a UI retry, or two admins requesting the same scope each create a separate
   Amazon report with no warning. This is the clearest, most reachable risk found.
2. **Ads sync and Business Report sync already have partial reuse** (6h success-skip, 30-day Amazon-retention
   reuse for Ads, per-workspace+source concurrency lock, stale-run cleanup) via `internal_data_refresh_runs` —
   but the concurrency lock is a SELECT-then-decide check, not atomic: the same TOCTOU race class already found
   and fixed in `tracked_asins` this session (§15/PR #18) exists here too, just not yet triggered in production.
3. **Three separate, structurally-incompatible registry tables exist**: `internal_data_refresh_runs` (Ads +
   Business Reports, has reuse columns), `amazon_report_jobs` (Brand Analytics, no reuse columns),
   `internal_fba_report_jobs` (FBA, no reuse columns) — same underlying problem solved three different ways
   (two of them not solved at all).
4. **No workflow anywhere checks trusted local data coverage before requesting** (`LOCAL_DATA_REUSE` doesn't
   exist today), and **no workflow queries Amazon's own report list** (`PROVIDER_REPORT_REUSE` as an active
   Amazon `getReports` lookup doesn't exist — the closest analog still depends on our own prior memory of a
   report ID, not asking Amazon directly).

### Existing registry available?

Partially. `internal_data_refresh_runs` (migrations 046/049/050/053) is the strongest existing candidate — it
already has `workspace_id`, `source`, `status`, `report_request_key`, `amazon_report_id`, `marketplace_id`,
`report_type`, `report_options`. **Not sufficient as-is**: needs a `provider` column, a proper hashed
fingerprint instead of an ad-hoc per-script string, and a DB-level atomic concurrency guarantee (a partial
unique index) instead of today's application-level check-then-insert.

### Implementation prerequisites (none started)

1. Shared fingerprint-builder function (no migration, no DB change — pure refactor extracting what
   `sync-ads-reports.ts`/`sync-business-reports.ts` already do independently).
2. New gate module (`src/lib/reports/report-reuse-gate.ts`, illustrative name) implementing the state machine:
   `LOCAL_DATA_REUSE → LOCAL_REPORT_REUSE → WAIT_FOR_EXISTING → PROVIDER_REPORT_REUSE → CREATE_NEW →
   REJECT_STALE_OR_PARTIAL / FAILED`.
3. Additive migration (proposed in the spec, **not created**): `provider` + `fingerprint_hash` columns and a
   partial unique index `WHERE status IN ('running','queued')` on `internal_data_refresh_runs`.
4. Adapter so Brand Analytics and FBA write into the same registry the gate reads.

### Recommended implementation sequence

1. Extract the shared fingerprint builder (zero risk, no migration).
2. Build the gate module against `internal_data_refresh_runs` as-is.
3. Migrate Ads sync + Business Report sync onto the gate first (refactor only — they already have equivalent
   behavior; lowest risk, easiest to verify against production logs the same way PR #15/§16 was verified).
4. Apply the proposed migration once the gate is proven.
5. Migrate Brand Analytics + FBA onto the gate — this is where real new protection is added (today: none) and
   is the highest-value, highest-risk step since it changes live user-facing behavior.
6. Route settlement/payment auto-fetch through the gate from day one, if/when that work is ever approved.

**Nothing in this section has been implemented.** No report workflow was modified. No migration was created or
applied. Design only, per instructions.

### Current next blocker (unrelated to this section)

The Report Reuse Gate is a design decision, not an active blocker. The actual next-in-line blocker remains
**§16 — ASIN snapshot cron/queue throughput verification**: the 10 rows stuck in `running` (locked by the still-
active Render cron) are unreclaimed, the Render cron's actual deployed state hasn't been checked directly, and
no Vercel throughput change (batch size/cadence) has been made or approved. Nothing in this session changes
that status.

**Superseded (2026-07-12):** the stuck-row reclaim blocker above is resolved — see §16.D.6–D.9. All 11 stuck
rows cleared naturally via the automated fix (PR #26), and a related follow-up (PR #28) closes the same bug
class in three more sites. The ASIN cron **throughput/canonical-worker** question (increase batch size, cadence,
or consolidate Render+Vercel into one worker) remains genuinely open and is explicitly deferred — see §18.

### §16.D.10 — PR #28 three-cycle post-deploy verification (complete, 2026-07-12)

PR #28 merged to master at `dpl_5Yy9bcwTD45jw2AmEEnLiCbHcwEu` (commit `3de0ca6`). Three Vercel-cron cycles
observed after deploy, each checked against Supabase directly (not against self-reported log text alone):

| Cycle | UTC time | enqueue | process-next | JSON result | running (stuck) | run_after NULL rows | new asin_snapshots |
|---|---|---|---|---|---|---|---|
| 1 | 04:00 | 200 | 200 | processed>0, no NOT NULL errors | 0 | 0 | matched processed count |
| 2 | 08:00 | 200 | 200 | processed>0, no NOT NULL errors | 0 | 0 | matched processed count |
| 3 | 12:00:42 | 200 | 200 | `{"processed":5,"completed":1,"partialCatalogOnly":4,"pricingSkippedCooldown":3,"pricingRateLimited":1,"pricingUnavailable":0,"catalogNotFound":0,"retried":0,"failed":0,"skippedNoConnection":0}` | 0 | 0 | 5 (`asin_snapshots.checked_at >= 12:00Z` = 5, matches `processed`) |

Cycle 3 detail (Supabase, queried live): `background_jobs` status counts `completed=13546, failed=83,
queued=446`; `status='running'` count = **0**; `run_after IS NULL` count = **0** project-wide. Rows updated in
the cycle-3 window show retries correctly preserving a non-null `run_after` across a pricing-cooldown retry
chain (e.g. `run_after=2026-07-09 20:01:05` carried forward unchanged on `amazon_pricing_cooldown_active` /
`amazon_pricing_rate_limited` completions) — the exact behavior PR #26/#28 fixed, now confirmed live across all
three corrected call sites collectively (no site individually hit its rare max-attempts branch in these three
cycles, but none regressed the common paths either).

**Final status (per the taxonomy the founder specified):**
- Unit and integration verification: **complete** (`test-stuck-job-reclaim.ts` 6/6, `test-retry-or-fail-update.ts`
  6/6, `test-track-asin.ts` 5/5 unaffected).
- Deployment verification: **complete** — 3 clean cron cycles recorded above, zero NOT NULL errors, zero stuck
  rows.
- Regression verification: **complete** — no new stuck-job or NOT NULL issue appeared in any of the 3 cycles;
  `background_jobs` failed count did not increase abnormally; queued count moving normally (446, expected given
  ~500 targets under pricing cooldown, consistent with prior observation).
- Direct live execution of each rare max-attempts branch (the 3 paths PR #28 fixed): **pending natural
  observation** — not observed directly in these 3 cycles, accepted as non-blocking per standing instruction.

**Scheduler inventory (evidence for the later canonical-worker decision, §18 — not acted on):** confirmed via
`git show origin/master:esolz-app/vercel.json` (single cron entry, `schedule: "0 */2 * * *"` →
`/api/cron/asins/process-product-snapshots`), `git ls-tree` (no `.github/workflows` directory exists in this
repo), and `git grep` (no other file references `/api/asins/jobs/enqueue` or `/api/asins/jobs/process-next`).
Exactly two schedulers exist and are already fully documented: **Vercel Cron**, every 2h, hits the HTTP routes
(confirmed firing at 02:00:42, 04:00:42, 06:00:42, 08:01:41, 12:00:42 UTC on `dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA`);
**Render Cron** (`easyhome-asin-live-checker`), every 4h, runs `process-asin-checker-jobs.ts` directly against
Supabase. No third/unknown scheduler exists. Both independently observed to be healthy and non-colliding
(atomic claim guard prevents double-processing) in this verification window.

**Pricing 429 observation:** `[amazon-pricing] getItemOffersForAsin error: 429` recurs across all 3 cycles
(8 occurrences logged 2026-06-21 through 2026-07-12 in Vercel's runtime-error aggregation, route
`/api/asins/jobs/process-next`). Each occurrence is caught and classified into `pricingRateLimited` /
`pricingSkippedCooldown` in the JSON result and retried with the existing cooldown backoff — not raw error
propagation. Treated as separate from the `run_after` correctness fix, per standing instruction; not itself a
defect.

**GET 500 `/` investigation (separate issue, inspection only — complete, non-blocking):** Vercel's runtime-error
aggregation shows `Error running the exported Web Handler: Error: Your project's URL and Key are required to
create a Supabase client!` at `routes=/middleware`, count=7, users=2, first=2026-05-30, last=2026-07-12T12:02:30Z,
attributed to `lastDeployment=dpl_4QsnTynAkk5d4LvcRtiAW3ogTXpx`. That deployment ID resolves (via
`get_deployment`) to a **preview** build — branch `fix/render-cron-stuck-reclaim-verify` (PR #24's preview,
URL `esolz-jl38uwve9-vinay13893s-projects.vercel.app`), **not** the production alias (`esolz-app.vercel.app`,
`esolz-app-vinay13893s-projects.vercel.app`, `esolz-app-git-master-vinay13893s-projects.vercel.app` — confirmed
via `get_project`). A direct query of production-environment runtime logs for `statusCode=500` over the trailing
24h returned **zero results**. Root cause: this specific preview deployment's environment is missing/misconfigured
Supabase env vars (a Vercel preview-environment config gap, not an app code defect), and the first occurrence
(2026-05-30) predates every PR in this session by weeks — it is pre-existing and unrelated to the `run_after`
work. **Classification: non-blocking, production unaffected.** No code, config, or env change made (inspection
only, per instruction). Flagging as a possible future cleanup item (either set preview-env Supabase vars or
accept stale preview builds returning 500 on `/`), not an active incident.

---

## 18. Standing Decisions (2026-07-12)

Founder-approved sequencing and scope decisions, recorded here so a fresh session has the full context without
re-deriving it.

### Sequencing

1. **`run_after` follow-up (§16.D.9, PR #28) is the active thread.** Review automation and the Report Reuse Gate
   both wait on this closing (merged + verified), per explicit instruction.
2. **Review automation** moves out of "held" status once the `run_after` follow-up is merged and verified — but
   **only inspection and implementation planning**, and **only in a separate, fresh session**. Do not create a
   branch, migration, or production code for review automation until that happens.
3. **ASIN cron canonical-worker/throughput redesign (Vercel batch size, cadence, or consolidating Render +
   Vercel into a single worker) is explicitly on hold** — do not begin until reassessed with production evidence
   gathered *after* the `run_after` follow-up lands. The options already drafted in §16 ("Options to consider")
   remain valid candidates for that future reassessment, not yet chosen.
4. **Report Reuse Gate implementation stays queued after review automation planning**, unless live production
   evidence emerges that it is actively blocking a real flow (none identified as of this writing — see
   `REPORT_REUSE_GATE_SPEC.md` and tracker §17 for the approved-but-unimplemented design).

### Review automation — locked specification (do not deviate without a new founder decision)

Recorded here in full so it survives to whatever fresh session picks it up:

- **Scope:** Amazon India / EasyHOME only.
- **Backfill:** one-time last-30-days Orders API catch-up only. **No 120-day backfill.**
- **Ongoing:** daily forward processing after the one-time catch-up.
- **API:** Amazon's official Solicitations API only — no scraping, no unofficial endpoints.
- **Eligibility:** `GET` eligibility is the source of truth for whether a solicitation can be sent.
- **Sending:** `POST` only when `productReviewAndSellerFeedback` is present/available in the eligibility
  response.
- **Idempotency:** never send more than once per `amazon_order_id` — requires a durable, unique per-order
  tracking record (schema/migration work, not yet designed).
- **Safety default:** dry-run by default. Live sending only when `REVIEW_REQUESTS_ENABLED=true` is explicitly
  set.
- **Required data model (not yet designed):** unique order tracking (one row per `amazon_order_id`, enforced at
  the DB level) plus eligibility/error audit fields (what `GET` returned, when, why a `POST` was or wasn't sent,
  any error).
- **Explicitly not started this session:** no branch, no migration, no production code. Planning-only, and only
  in a fresh session, per sequencing item 2 above.

### §18 update (2026-07-12) — full implementation-ready spec written

Founder moved review automation out of "held" and requested a full inspection + planning pass in this
session (not a separate fresh session as originally sequenced — superseding sequencing item 2 above by
explicit instruction). **Still inspection/planning only — no branch, migration, env var, or code
created; no Amazon API called.**

Full spec: **`REVIEW_REQUEST_AUTOMATION_SPEC.md`** (new file, repo root). Key inspection findings:

- **Orders API:** not implemented anywhere in this repo. No Orders API function in
  `src/lib/amazon/spapi-client.ts`; no live-fetched shipped-order data exists. The only `order_id`
  data in the DB is manually-imported settlement CSV rows in `internal_payment_transactions`
  (migration 033) — unrelated to Orders API and insufficient for solicitation eligibility.
- **Solicitations API:** not implemented at all — zero references to `Solicitation` anywhere in `src/`.
- **Reusable auth:** `lwa.ts` (`refreshAccessToken`), `crypto.ts` (`encryptToken`/`decryptToken`), and
  the `amazon_connections` + `loadWorkspaceConnection()` pattern already duplicated twice
  (`process-next/route.ts`, `process-asin-checker-jobs.ts`) — spec proposes extracting this into
  `src/lib/amazon/connection.ts` as PR #1, so review automation isn't a third copy.
- **SP-API scope sufficiency: unknown, cannot be determined from code.** Spec proposes a read-only
  permission probe (mirroring the existing `probeInboundShipmentsAccess` pattern) as PR #3, to be run
  and confirmed *before* any real catch-up/daily-job code is written — per instruction to stop and
  report only if scope changes are needed.
- **Migration numbering correction:** CLAUDE.md's "last used: 055" note is stale — `origin/master`
  actually has migrations through **058** (`058_restrict_connection_token_columns.sql`) as of this
  check. Next free number is **059**. Spec's proposed migration is numbered accordingly.
- Data model (`review_solicitation_orders`), state machine (terminal/retryable/dry-run statuses),
  idempotency/locking design, one-time catch-up design, daily-job design, pre-POST safety gates, env
  var design, cron architecture/scheduling recommendation, required tests, and an 8-PR implementation
  sequence are all fully written out in the spec — see that file for detail, not duplicated here.
- **Nothing implemented.** No branch, migration, env var, or code exists yet. Awaiting founder review
  of the spec and explicit go-ahead per PR in the proposed sequence.

### §18 update (2026-07-12) — Implementation PR #1: permission probe (opened, not merged)

Branch `feat/review-automation-permission-probe` off latest `master` (post-PR #30). Scope matches the
spec's PR #3 (permission probe) plus the minimal slice of PR #1 (connection helper) and PR #4 (client
functions) needed to make the probe runnable — narrowed and re-sequenced per explicit founder
instruction for this PR specifically. **No migration, no `review_solicitation_orders` table, no cron,
no Solicitations POST function, no env var, no scope/credential change.** ASIN checker, Ads, payments,
replenishment, Report Reuse Gate, and ASIN UI files are untouched (confirmed via `git status`).

**Files changed (4):**
- `src/lib/amazon/connection.ts` (new) — `loadWorkspaceConnection()`, a third, canonical copy of the
  existing (already twice-duplicated) `amazon_connections` lookup + LWA refresh logic from
  `process-next/route.ts` / `process-asin-checker-jobs.ts`. Those two files are **not** modified —
  refactoring them onto this helper is out of scope for this PR (would touch ASIN checker code).
- `src/lib/amazon/spapi-client.ts` (additive only) — added `listOrders()` (Orders API v0,
  `GET /orders/v0/orders`) and `getSolicitationActionsForOrder()` (Solicitations API v1,
  `GET /solicitations/v1/orders/{id}`). **No POST/create/send function added** — verified by a
  dedicated test asserting `createProductReviewAndSellerFeedbackSolicitation` is not exported and no
  export name matches a "create...Solicitation" shape. All 3 pre-existing functions in this file are
  unchanged.
- `scripts/probe-review-automation-permissions.ts` (new) — read-only orchestration script, lazy admin
  client + entrypoint guard (same import-safe pattern as `process-asin-checker-jobs.ts`). Fetches a
  small recent Orders page (3-day window, max 5 results, India marketplace only), and — only if at
  least one order is returned — GETs Solicitations eligibility for the first order. Performs **zero
  database writes**. Never logs a full order id (`maskOrderId()` keeps only the last 4 characters).
  Fails closed: `scopesSufficient` is only ever `'yes'` when both calls unambiguously succeed;
  ambiguous/transient errors (5xx, network) report `'uncertain'`, never `'yes'`.
- `scripts/test-review-automation-permission-probe.ts` (new) — 9/9 passing. Covers: Orders
  success/denied, Solicitations GET success/denied, no-order-available (Solicitations correctly
  skipped, not attempted), the POST-function-does-not-exist assertion, a sensitive-data assertion
  (full order id never appears in the serialized report; no buyer-PII-shaped keys), `maskOrderId` edge
  cases, and transient-error-is-uncertain-not-no.

**Checks run:** `npx tsc --noEmit` — pass. `npx eslint` on all 4 changed files — pass, zero warnings.
Regression: `test-track-asin.ts` 5/5, `test-stuck-job-reclaim.ts` 6/6, `test-retry-or-fail-update.ts`
6/6 — all still passing, confirming no unrelated breakage.

**Live probe run (2026-07-12, founder-approved) — result: scopes sufficient.**

Ran once against the real EasyHOME Amazon connection (workspace `55a321c9-…`), GET-only, 3-day Orders
window, max 5 orders, at most one Solicitations eligibility check. Sanitized output (exactly what was
printed — no raw API response was captured or committed):

```json
{
  "ordersApiAccess": "pass",
  "ordersReturned": 5,
  "solicitationsGetAccess": "pass",
  "productReviewAndSellerFeedbackObserved": false,
  "sanitizedError": null,
  "scopesSufficient": "yes",
  "postAttempted": false,
  "sampleOrderIdMasked": "***1161"
}
```

- **Orders API: pass**, 5 orders returned (the requested max) in the 3-day window. Nothing persisted —
  the script performs zero database writes.
- **Solicitations GET: pass.** The one sample order checked currently has no `productReviewAndSellerFeedback`
  action available — per the state-machine correction from the founder's last instruction, **absence of
  the action is not a failure or a scope problem**; it just means that specific order isn't currently
  eligible (could be too recent, or already past Amazon's window). Not evidence of a scope gap, since the
  GET call itself succeeded cleanly.
- **Scopes sufficient: yes** — both Orders and Solicitations GET access are confirmed working end-to-end
  on the live EasyHOME connection.
- **Safety confirmed live:** no POST attempted (no such function exists in the codebase), no DB writes, no
  customer communication, no tokens/secrets in any output, order id masked to last 4 characters
  (`***1161`) in the only place one appeared.
- **Not yet answered by this single run:** whether *any* order in a larger window actually has
  `productReviewAndSellerFeedback` available (this run's one sample order didn't) — that's a volume
  question for the dry-run catch-up (spec PR #5), not a permission question, and is out of scope here.

**PR #31: MERGED** (merge commit `952a38f`, 2026-07-12). Confirmed via `git diff --name-only` against
the pre-merge tip: exactly the 6 expected files changed, nothing else. No deployment/promotion was
needed or performed — no route or cron calls any of this code yet, so merging alone activates nothing
in production. Review automation is **not enabled and not running** anywhere.

### §18 update (2026-07-12) — Implementation PR #2: migration only (opened, not applied)

Branch `feat/review-solicitation-orders-migration` off latest `master` (post-PR #31). **Schema only —
no jobs, no cron, no RPC, no Amazon calls, no live sending.** ASIN checker, Ads, payments,
replenishment, and Report Reuse Gate untouched.

**File:** `esolz-app/supabase/migrations/059_review_solicitation_orders.sql` (1 file). Confirmed via
`git ls-tree origin/master` that 058 is still the latest applied migration, so 059 is the correct next
number (the CLAUDE.md "055" note remains stale, as already flagged in the prior §18 update).

**Table:** `review_solicitation_orders` — all 19 columns from the founder's exact spec, plus 3
justified claim/idempotency columns (`claimed_at`, `claimed_by`, `claim_expires_at`) so a future guarded
pre-POST claim can be a single conditional UPDATE, mirroring `reclaimStuckJob()`'s pattern from the ASIN
checker — no RPC/function created to use them yet, columns only.

**Identity constraint:** `UNIQUE (workspace_id, marketplace_id, amazon_order_id)` — multi-workspace,
multi-marketplace safe, per instruction (not a global `amazon_order_id`-only constraint). This same
index also serves order lookups, so no separate lookup index was added (would be an exact duplicate).

**Status model:** enforced by a `CHECK` constraint listing exactly the 12 statuses given (7 non-terminal:
`pending`, `too_early`, `not_eligible_retryable`, `eligible_dry_run`, `failed_retryable`, `checking`,
`send_claimed`; 5 terminal: `sent`, `already_solicited`, `expired`, `ineligible_terminal`,
`failed_terminal`). `eligible_dry_run` is explicitly documented as non-terminal in the migration's
comment block, with the constraint that any future POST still requires a fresh GET — matches the
founder's correction from the prior turn. `ineligible_terminal` is documented as requiring Amazon to
clearly establish permanence — a merely-absent `productReviewAndSellerFeedback` action must map to
`not_eligible_retryable` or `too_early`, never straight to terminal.

**Safety constraints added:** `solicitation_sent` and `solicitation_status='sent'` are constrained to
always agree (`(solicitation_status = 'sent') = solicitation_sent`); `solicitation_sent_at` must be
non-null whenever `solicitation_sent` is true; `send_claimed` status requires both `claimed_at` and
`claim_expires_at` to be set; `check_attempts >= 0`. "Sent rows cannot be selected for new sends" is
enforced practically by the due-work partial index excluding all terminal statuses (including `sent`)
outright, not by a table constraint (a `CHECK` can't express "excluded from a future SELECT").

**Indexes (4 requested, 3 created + 1 already covered):**
1. Due-work: `(workspace_id, marketplace_id, next_check_at)`, partial — `WHERE solicitation_status NOT
   IN (<5 terminal statuses>)`.
2. Status/reporting: `(workspace_id, solicitation_status)`.
3. Sent audit: `(workspace_id, solicitation_sent_at)`, partial — `WHERE solicitation_sent_at IS NOT
   NULL`.
4. Order lookup: already served by the unique constraint's own index (constraint #1 above) — a separate
   index on the identical column set would be a redundant duplicate, so none was added.

**RLS/security:** `SELECT`-only policy for `authenticated`, scoped to `workspace_id in (select
public.user_workspace_ids())` — the corrected pattern from migration 056 (no hardcoded test-email/plan
gate). **No `INSERT`/`UPDATE`/`DELETE` policy for `authenticated`** — intentionally more restrictive
than `background_jobs` (which allows a member-triggered manual insert for "Check Now"): nothing in this
workstream is user-triggered, so all writes come from server-side automation via the service-role key,
which bypasses RLS entirely regardless. No `SECURITY DEFINER` function created. No RPC created — schema
only, per instruction.

**PII:** no buyer name/address/phone/email column exists. `last_eligibility_response jsonb` is
documented as sanitized-only (action-name list, not raw payloads), plus a best-effort defensive `CHECK`
constraint rejecting a handful of obviously PII-shaped top-level JSON keys (`buyerName`, `buyerEmail`,
`buyerPhone`, `shippingAddress`, `BuyerInfo`, and PascalCase variants) as defense in depth — documented
as non-exhaustive; the application writing only sanitized data is the real enforcement point.

**Validation performed:** manual syntax review (balanced constraints/parens, valid Postgres `CHECK`/JSONB
`?` operator usage), and line-by-line cross-reference against 4 existing applied migrations'
create-table/RLS/trigger patterns (034 `background_jobs`, 051 `internal_payment_transaction_upload_batches`,
054 `internal_brahmastra_thresholds`, 056's corrected RLS pattern). **No automated SQL linter or local
Postgres instance exists in this repo** (no `supabase/config.toml`, no lint script) — this is the same
validation depth as every other migration in this session's history. `npx tsc --noEmit` run repo-wide —
pass (a schema-only change has no TS surface of its own; this confirms nothing else was inadvertently
touched). Confirmed additive-only: every statement is `CREATE ... IF NOT EXISTS` or `DROP POLICY/TRIGGER
IF EXISTS` immediately followed by re-create (the same idempotent pattern every other migration in this
repo uses) — no existing table is altered, no existing data touched. Rollback: a single `DROP TABLE
public.review_solicitation_orders CASCADE` cleanly removes the table, its indexes, constraints, policy,
and trigger — nothing else in the schema references this new table yet.

**Founder final-review pass (2026-07-12) — 2 corrections applied, migration not yet applied:**

1. **`updated_at`:** uses the existing, already-audited `public.fn_set_updated_at()` trigger function
   (the same one every other table in this repo uses) — no new function, no `SECURITY DEFINER`. Confirmed.
2. **Sent-state consistency:** confirmed the `(solicitation_status = 'sent') = solicitation_sent`
   constraint is a true biconditional — Postgres evaluates it as boolean-equals-boolean, so all 4 required
   directions hold: `sent=true` forces `status='sent'`, `status='sent'` forces `sent=true`, `sent=true`
   forces `solicitation_sent_at IS NOT NULL` (separate constraint), and an unsent row cannot have
   `status='sent'` (contrapositive of the same biconditional). Confirmed, no change needed.
3. **Due-work index — corrected.** Originally filtered only on non-terminal status; added explicit
   `solicitation_sent = false` (redundant given #2's constraint, but now correct even read in isolation)
   and `next_check_at IS NOT NULL` (excludes never-scheduled rows, which "due at time X" has no meaning
   for). Smallest possible correction — same file, not yet merged, so edited in place rather than adding
   a second migration.
4. **Claim fields:** confirmed `send_claimed` rows can freely set `claimed_at`/`claimed_by`/
   `claim_expires_at`, and the one constraint referencing them (`send_claimed` requires both timestamps
   set) does not block a future stale-claim recovery UPDATE (transitioning status away from
   `send_claimed` is unconstrained). No RPC added. Confirmed, no change needed.
5. **PII documentation — strengthened.** The JSONB check comment now explicitly enumerates the only 4
   things future application code may write to `last_eligibility_response` (eligible action names,
   sanitized status/reason, checked-at timestamp, non-sensitive Amazon error metadata) and explicitly
   states raw Orders/Solicitations API response bodies must never be stored there. The `CHECK` constraint
   itself is unchanged and remains explicitly documented as defensive-only, not an allowlist.

Re-ran `npx tsc --noEmit` after both corrections — pass (unchanged from before; this is a schema-only
file with no TS surface).

**Production migration: APPLIED (2026-07-12, founder-approved).**

- **Supabase project:** `okxfwcfxxrtmijmvztdq` (confirmed — same project CLAUDE.md and every prior
  session query has used). This project is confirmed **shared** with an unrelated hobby app
  ("Travel-tracker" — `tt_profiles`/`trips` tables visible in `list_tables`) — pre-existing, not a
  mixup, does not affect any esolz-app table.
- **Pre-apply checks:**
  - Migration 059 had **not** been applied yet — `review_solicitation_orders` was absent from
    `list_tables` before this run.
  - SQL applied is byte-identical to `master` commit `af37c47` (`git diff` against both the merge
    commit and the local working copy — zero diff).
  - **Migrations 001–058: schema confirmed correct, ledger has pre-existing gaps.** Every expected
    table exists live (spot-checked `workspaces`, `tracked_asins`, `internal_payment_transactions`,
    and `internal_brahmastra_thresholds` from migration 054 specifically). However, Supabase's
    `list_migrations` ledger only shows 26 tracked entries and is **missing entries for 001–033 and
    054** even though their tables demonstrably exist — a pre-existing bookkeeping gap (those were
    evidently applied via a path that didn't record migration history), **not** something this
    session introduced, and not a blocker since the live schema — not the ledger — is what matters
    for correctness. Flagging transparently per instruction rather than silently treating "confirmed."
  - Confirmed `public.user_workspace_ids()` and `public.fn_set_updated_at()` (the two functions 059
    depends on) both exist and match the expected definitions before applying.
- **Applied via Supabase MCP `apply_migration`, name `059_review_solicitation_orders`** — result: success.

**Post-apply read-only verification (all passed):**
- **Table exists:** `public.review_solicitation_orders`, confirmed via `information_schema.columns`.
- **All 22 columns present** with correct types/nullability/defaults, including every column the
  founder listed by name (`workspace_id`, `marketplace_id`, `amazon_order_id`, `solicitation_status`,
  `solicitation_sent`, `solicitation_sent_at`, `next_check_at`, `claimed_at`, `claimed_by`,
  `claim_expires_at`, `last_eligibility_response`, `created_at`, `updated_at`).
- **All 8 constraints present**, confirmed via `pg_constraint`: primary key, FK to `workspaces`, the
  `(workspace_id, marketplace_id, amazon_order_id)` unique constraint, the 12-status CHECK, the
  sent/status-agreement CHECK, the sent-timestamp CHECK, the `send_claimed` CHECK, `check_attempts >= 0`,
  and the defensive PII-key CHECK — all match the migration file exactly.
- **All 5 indexes present**, confirmed via `pg_indexes`: pkey, the unique identity index, the due-work
  partial index (confirmed its `WHERE` clause includes all 3 required predicates —
  `solicitation_sent = false`, `next_check_at IS NOT NULL`, and the non-terminal-status filter — exactly
  as corrected in the founder's review pass), the status/reporting index, and the sent-audit partial
  index.
- **Security:** `relrowsecurity = true` (RLS enabled). Exactly **one** policy exists —
  `review_solicitation_orders: internal select`, `FOR SELECT TO authenticated`, `USING (workspace_id IN
  (SELECT user_workspace_ids()))`. **No policy of any kind exists for `anon`** (anonymous access is
  denied by RLS default — no matching policy means no rows), and **no INSERT/UPDATE/DELETE policy exists
  for `authenticated`** (write-denied by the same default).
- **Trigger:** `trg_review_solicitation_orders_updated_at`, `BEFORE UPDATE`, calling the existing
  `fn_set_updated_at()` — confirmed via `pg_trigger`.

**Synthetic verification (service-role connection, non-PII, non-Amazon-format order id
`TEST-SYNTHETIC-VERIFY-0001`, workspace `55a321c9-…`):**
1. Inserted one row — succeeded.
2. Re-inserted the identical `(workspace_id, marketplace_id, amazon_order_id)` — **correctly rejected**:
   `23505 duplicate key value violates unique constraint "review_solicitation_orders_identity_uidx"`.
3. Simulated an authenticated user outside any workspace (`set_config('request.jwt.claims', ...)` with a
   random, non-existent `sub` UUID + `SET LOCAL ROLE authenticated`) and queried for the synthetic row —
   **0 rows visible**, confirming workspace isolation is real and enforced by RLS, not just declared.
4. Ran an `UPDATE` (touched `last_checked_at`) and confirmed `updated_at` advanced
   (`13:45:12.343995+00` → `13:45:25.285106+00`) — trigger confirmed live, not just present.
5. Deleted the synthetic row.
6. Confirmed `select count(*) from review_solicitation_orders` = **0** after cleanup.

**No Amazon API call was made at any point in this step. No customer communication occurred. Review
automation remains completely disabled — no route, cron, or job reads or writes this table yet.**

### §18 update (2026-07-12) — Dry-run catch-up foundation built (opened, not merged, not run live)

Branch `feat/review-request-dry-run-catchup` off latest `master` (post-PR #33). Builds the repository
layer, one-time catch-up script, and dry-run reporting from `REVIEW_REQUEST_AUTOMATION_SPEC.md` §4–§7.
**No POST/send capability, no daily cron, no protected sending route, no live mode, no migration
change.** ASIN checker, Ads, payments, replenishment, and Report Reuse Gate untouched. The live 30-day
catch-up was **not run** against production Amazon in this step — code only, tested against fakes.

**Files changed (5):**
- `src/lib/review-requests/policy.ts` (new) — pure, DB-free decision logic. Status model constants
  (`TERMINAL_STATUSES`, `PROTECTED_STATUSES` = `sent`/`send_claimed`, `DUE_CANDIDATE_STATUSES`),
  `classifyEligibilityOutcome()` (action present → `eligible_dry_run`; absent → `not_eligible_retryable`
  — **never** `too_early`/`already_solicited`/`expired`/`ineligible_terminal` from a GET-only signal,
  documented as a deliberate "do not invent Amazon eligibility reasons" choice), `classifySolicitationsError()`
  (always `failed_retryable` — a failed GET call is evidence about the call, not the order),
  `computeNextCheckAt()` (centralized retry-scheduling policy: terminal statuses and `eligible_dry_run`
  → `null`; `failed_retryable` → +24h; `too_early`/`not_eligible_retryable` → +3 days — conservative,
  no immediate/tight retry loop possible), `buildSanitizedEligibilityEvidence()` (strict allowlist
  return shape: `actionNames`, `checkedAt`, `sanitizedReason`, `amazonStatusCode`, `amazonErrorCode` —
  structurally cannot smuggle a raw payload or buyer field through, since there is no parameter for one).
- `src/lib/review-requests/repository.ts` (new) — DB operations only, all writes guarded (matching
  `reclaimStuckJob()`'s verify-after-write pattern from the ASIN checker):
  - `upsertDiscoveredOrder()` — only ever writes Amazon-sourced fields (`order_status`/`purchase_date`/
    `amazon_last_updated_at`) on an existing row; `solicitation_status`/`solicitation_sent`/
    `solicitation_sent_at`/`next_check_at`/claim fields/`check_attempts` are never in its UPDATE
    payload, which is what makes "never reset a terminal row" and "never overwrite sent audit fields"
    true by construction, not by a runtime check. A genuine 23505 insert race falls back to the
    existing row (mirrors `addOrRestoreTrackedAsin`'s established concurrent-duplicate handling).
  - `findDueCandidates()` — `solicitation_sent=false`, non-terminal/non-in-flight status, `next_check_at
    <= now`, deterministic ordering, respects the batch-size limit.
  - `claimForEligibilityCheck()` / `recordEligibilityResult()` — a claim/finalize pair: claim is a
    guarded UPDATE to `'checking'` matched on the row's expected prior status (0 rows affected = another
    caller already claimed it); finalize is guarded to only apply if the row is still `'checking'`.
    `recordEligibilityResult()` **throws** if asked to write `sent`/`send_claimed` — a hard guard against
    this dry-run code ever touching either protected status, independent of caller discipline.
- `src/lib/amazon/spapi-client.ts` (additive) — `listOrders()` gained an optional `nextToken` param for
  pagination (per the real Orders API v0 contract: a `NextToken` call carries no other filters). No
  other function changed.
- `scripts/review-requests-catchup.ts` (new) — orchestration. A testable `runCatchup()` core (dependency-
  injected: `listOrdersFn`/`getSolicitationFn`/`sleepFn`/`nowFn`) plus a thin `main()` CLI entrypoint that
  wires real dependencies (same lazy-admin + entrypoint-guard pattern as every other script this
  session). Hard-clamps the catch-up window to **30 days max** in code (`Math.min(..., 30)`) regardless
  of `REVIEW_REQUESTS_CATCHUP_DAYS` misconfiguration — the "no 120-day backfill" rule cannot be
  overridden by an env var. Paginates Orders API safely (bounded to 50 pages as a defensive ceiling).
  Throttles Solicitations GET calls at the configured `REVIEW_REQUESTS_RATE_LIMIT_MS` (default 1100ms),
  once per candidate checked. **Contains no Solicitations POST code path at all** — logs
  `would-send (dry-run only, no POST)` with a masked order id when a row reaches `eligible_dry_run`,
  never calls anything resembling a send. `REVIEW_REQUESTS_ENABLED`/`REVIEW_REQUESTS_DRY_RUN` have zero
  effect on this script's behavior (it warns if it finds `ENABLED=true`, since that expectation would be
  wrong for a script that structurally cannot send) — those flags only matter for a future PR that adds
  real sending. Dry-run report (Part D shape) includes every field the founder specified: fetch window,
  pages/orders/candidates counts, all 9 status-outcome buckets (5 of which — `tooEarly`,
  `expired`, `alreadySolicited`, `ineligibleTerminal` — are always 0 in this PR's output, since nothing
  in the decision logic ever produces them from GET-only evidence; documented as intentional, not a bug),
  sanitized API-error-by-code map, elapsed time, estimated API calls, and the unconditional
  `postAttempted: false` / `reviewRequestsSent: 0`.
- `.env.local.example` (docs) — documents the 6 `REVIEW_REQUESTS_*` env vars with the founder-specified
  defaults, with an explicit note that they have no effect on this particular script.
- `scripts/test-review-requests.ts` (new) — **20/20 passing**, covering all 16 requested items plus 4
  extra: 30-day clamp, pagination (2-page follow-through), duplicate upsert (both the simple-repeat case
  and a true simulated 23505 insert race), terminal-status preservation on upsert, sent-row protection on
  upsert, eligible/not-eligible classification, `eligible_dry_run` non-terminal, terminal-status-requires-
  evidence (direct repository call proves the schema/repository *can* reach `expired` given confident
  evidence, while the catch-up's own classifiers prove they never produce it), retry scheduling (future
  timestamp, ≥1h out), terminal-clears-`next_check_at` (all 5 terminal statuses), batch-size enforcement,
  rate-limit throttle (asserted call count and exact configured delay), PII-allowlist proof (adversarial
  input, exact-keys assertion), order-id masking, POST-function-does-not-exist (re-verified, same
  assertion style as the PR #31 probe test), protected-status write refusal, unconditional
  `postAttempted`/`reviewRequestsSent` zero-state, and concurrent double-claim safety (exactly one of two
  simultaneous claims succeeds; a second finalize attempt on an already-finalized row correctly fails).

**Checks run:** `npx tsc --noEmit` — pass. `npx eslint` on all 5 changed/new code files — pass, zero
warnings. Full regression: `test-track-asin.ts` 5/5, `test-stuck-job-reclaim.ts` 6/6,
`test-retry-or-fail-update.ts` 6/6, `test-review-automation-permission-probe.ts` 9/9,
`test-review-requests.ts` 20/20 — **46/46 total, all passing.**

**Explicitly not done in this PR (at code-review time):** the live catch-up had not yet been run against
production Amazon (code tested against fakes only). No daily cron. No protected sending route. No live
mode. No migration change. No Solicitations POST function anywhere in the codebase (re-verified by test).

### §18 update (2026-07-12) — Live 3-day sample run (founder-approved, 2 passes, both clean)

Founder approved a small live sample before merging PR #34: 3-day window (not 30), max 10 candidates,
GET-only. Settings explicitly confirmed before running: `REVIEW_REQUESTS_ENABLED=false`,
`REVIEW_REQUESTS_DRY_RUN=true`, `REVIEW_REQUESTS_MARKETPLACE_ID=A21TJRUUN4KGV`,
`REVIEW_REQUESTS_CATCHUP_DAYS=3`, `REVIEW_REQUESTS_BATCH_SIZE=10`, `REVIEW_REQUESTS_RATE_LIMIT_MS=1100`.

**Baseline (before run 1):** `review_solicitation_orders` was empty — 0 rows, 0 sent, no status
breakdown.

**Operational note (non-blocking, flagged for future 30-day-run planning):** run 1's shell command hit
the tool's 2-minute output-capture timeout before the underlying script finished; the script itself kept
running to completion in the background (unaffected, since it's a plain long-running Node process, not
killed by the parent shell exiting) and finished cleanly — verified by watching row counts stabilize and
by the founder confirming the reported PIDs had already exited by the time a manual `taskkill` was run.
**No data corruption or partial-write risk resulted** — the repository's guarded-write design means an
interrupted run simply leaves rows in their last-completed state, never a torn/partial write — but this
surfaced a real timing fact: **a 3-day/~420-order window's order-upsert phase alone took ~2m49s–~3m05s**
(sequential per-order Supabase round trips, by design, not a bug). A full 30-day window will contain
substantially more orders and should be expected to take proportionally longer — run 2, captured properly
end-to-end this time, reports `elapsedMs: 184606` (~3m05s) for the same 3-day window. This is important
context for deciding how (and whether, in one shot) to run the eventual real 30-day catch-up — flagged as
evidence for that future decision, not acted on here.

**Run 1 results (sanitized aggregates only — no order IDs, no raw responses, matches what the script
itself prints):**
- Orders: window = 3 days (respected — spot-checked `purchase_date` range against the DB, oldest order
  matched the 3-day cutoff, no order older than the window present).
- Database after run 1: 419 rows total, 0 with `solicitation_sent = true`, 0 duplicate
  `(workspace_id, marketplace_id, amazon_order_id)` groups.
- Eligibility: exactly 10 candidates checked (batch size respected) — all 10 → `not_eligible_retryable`
  (0 → `eligible_dry_run`, 0 → `failed_retryable`, 0 API errors). `last_eligibility_response` on all 10
  contains **exactly** the 5 allowlisted keys (`actionNames`, `checkedAt`, `sanitizedReason`,
  `amazonStatusCode`, `amazonErrorCode`) and nothing else — verified via `jsonb_object_keys` across every
  row with a non-null value.
- Throttle: 1100ms sleep applied before each Solicitations call as configured; the observed gap between
  consecutive `last_checked_at` timestamps (~1.9–2.5s) is larger than 1100ms because it also includes the
  real network/DB round-trip time for the call and the write-back, not because the throttle itself was
  wrong — the configured delay value was confirmed correct at the code level in this session's earlier
  unit tests (exact-value assertion).
- Absolute safety: `postAttempted: false`, `reviewRequestsSent: 0` (script's own report), 0 rows with
  `solicitation_sent = true` in the DB independently, no `createProductReviewAndSellerFeedbackSolicitation`
  function exists anywhere in the codebase (unchanged from PR #31/#34's verification).

**Run 2 (idempotency pass, same 3-day sample, run only after run 1 was confirmed clean) — full JSON
report** (this run was captured as a properly tracked background task from the start, avoiding run 1's
capture issue):
```json
{
  "fetchWindowDays": 3,
  "ordersApiPagesFetched": 6,
  "ordersReceived": 421,
  "ordersInserted": 3,
  "ordersUpdated": 418,
  "candidatesChecked": 10,
  "eligibleDryRun": 0,
  "notEligibleRetryable": 10,
  "tooEarly": 0, "expired": 0, "alreadySolicited": 0, "ineligibleTerminal": 0,
  "failedRetryable": 0, "failedTerminal": 0,
  "skippedTerminal": 0, "skippedAlreadySent": 0,
  "apiErrorsByCode": {},
  "elapsedMs": 184606,
  "estimatedApiCalls": 16,
  "postAttempted": false,
  "reviewRequestsSent": 0
}
```
- Database after run 2: **422 rows** (419 + 3 newly-appeared orders since run 1, minutes apart — expected,
  not a bug), 0 sent, **0 duplicate groups** (confirmed idempotent — re-upserting the same 419 orders
  updated them in place, created no duplicates).
- Status breakdown after run 2: `pending`=402, `not_eligible_retryable`=20 (the original 10 from run 1
  plus 10 *different* rows from run 2) — `sum(check_attempts)` across all rows = 20, and **0 rows have
  `check_attempts > 1`**, proving run 2 correctly selected 10 **new** due candidates rather than
  re-checking run 1's 10 rows (which had already been scheduled a ~3-day-out `next_check_at` and were
  correctly excluded from "due" selection on the same day). This is exactly the intended idempotent/
  scheduling behavior, not a coincidence.
- Terminal/sent fields: still 0 rows `sent`, still 0 rows in any terminal status — nothing in either run
  produced a terminal outcome (consistent with the documented "GET-only cannot confidently detect
  terminal conditions" design), so terminal-field protection was not separately exercised by *this* live
  run (already proven at the unit-test and migration-synthetic-test level in earlier steps).

**Conclusion: both passes clean, no bug found, nothing fixed.** No code change was made to PR #34 as a
result of this live test — the implementation behaved exactly as designed on real production data.

**PR:** #34 updated with this section (sanitized aggregates only — no order IDs, no raw API responses
committed). Still open, not merged, not deployed. No cron created. No env vars changed permanently
(only exported for the duration of each manual run). No credentials/scopes/tokens changed.

### §18 update (2026-07-14) — Daily forward workflow built (opened as PR, not merged, not run live)

**Product decision recorded:** the 3-day dry-run sample above remains sufficient for now — the 30-day
catch-up stays deferred, not run. Priority shifted to **daily forward automation**: EasyHOME receives
~100–150 orders/day and new eligible orders must not be missed while the 30-day backfill question stays
open. Built from latest `origin/master` (`eb3beaa`, PR #41's merge) on a new isolated branch
`feat/review-requests-daily-forward`. Live sending stays disabled by default in every environment.

**New/changed files:**
- `src/lib/amazon/spapi-client.ts` — added `createProductReviewAndSellerFeedbackSolicitation()`: the
  first POST/send function in this codebase (`POST /solicitations/v1/orders/{id}/solicitations/
  productReviewAndSellerFeedback`, no body — Amazon owns the message content). `{ok, statusCode,
  amazonErrorCode}` return shape, never throws, matches every other client call.
- `src/lib/review-requests/policy.ts` — added `classifySendOutcome(statusCode, amazonErrorCode)`: 429/5xx
  → `failed_retryable` (transient; re-verified via a fresh GET before any retry), non-429 4xx →
  `failed_terminal` (bounds retries on a request that will keep failing identically). Never infers
  `already_solicited` from an error code — same conservative discipline as the existing GET classifier.
- `src/lib/review-requests/repository.ts` — added the second guarded claim/finalize pair the migration
  059 comment block explicitly anticipated: `claimForSendAttempt(admin, id, fromStatus='eligible_dry_run',
  claimedBy, ...)` (guarded UPDATE, re-verifies `solicitation_sent=false` atomically at claim time —
  immediately before any POST is attempted) and `recordSendResult()` (guarded `send_claimed` → final
  status; the only function in the codebase that ever sets `solicitation_sent=true`/
  `solicitation_sent_at`). Both follow the exact verify-after-write / row-count-check pattern as the
  existing `claimForEligibilityCheck`/`recordEligibilityResult`.
- `src/lib/review-requests/daily-run.ts` (NEW) — `runDailyForward()`, the testable orchestration core.
  **Phase 1:** rolling-overlap order fetch (`REVIEW_REQUESTS_OVERLAP_DAYS`, default 3 days) +
  `upsertDiscoveredOrder` (idempotent — a failed/delayed run can never create a gap or a duplicate row).
  **Phase 2:** per due candidate, a *fresh* Solicitations GET (never a cached/reused signal, per the
  original spec's design) → eligible action present → records `eligible_dry_run` unconditionally, then
  — **only when both `REVIEW_REQUESTS_ENABLED=true` and `REVIEW_REQUESTS_DRY_RUN=false`** — attempts
  `claimForSendAttempt` → `createProductReviewAndSellerFeedbackSolicitation` POST →
  `recordSendResult`. One candidate throwing is caught, counted, and never aborts the rest of the batch.
  Report is sanitized aggregate counts only (fetch window, orders fetched/inserted/updated/duplicates
  prevented, candidates checked, eligible_dry_run/not_eligible_retryable/sent/failed counts, Amazon
  errors by safe code, duration, live-send-active flag) — no order ids, no PII, ever.
- `src/lib/review-requests/cron-auth.ts` (NEW) — pure `isValidCronBearer()` bearer-token check, no
  `server-only` import, extracted specifically so cron authentication is directly unit-testable (mirrors
  the existing `buy-box-status.ts` pure-extraction pattern).
- `src/app/api/review-requests/jobs/run/route.ts` (NEW) — protected `POST` worker route. Auth via the
  existing `resolveJobsAuth()` (background-worker secret header for cron/system calls, or an
  authenticated workspace session) — identical convention to `/api/asins/jobs/process-next`. Reads
  `REVIEW_REQUESTS_ENABLED`/`REVIEW_REQUESTS_DRY_RUN` at the call site; committed defaults
  (`false`/`true`) keep it dry-run-only everywhere until both are explicitly changed.
- `src/app/api/cron/review-requests/daily-run/route.ts` (NEW) — Vercel Cron `GET` entry point, mirrors
  `/api/cron/asins/process-product-snapshots/route.ts` byte-for-byte in structure: `CRON_SECRET` bearer
  check, then a single internal call to the protected worker route above using the background-worker
  secret header, with the same redirect-detection / content-type / JSON-body verification that fixed the
  2026-07-09 Vercel-SSO silent-no-op incident on the ASIN cron (see §16) — never trusts a redirected or
  non-JSON response as success.
- `vercel.json` — added **one new** cron entry: `{"path": "/api/cron/review-requests/daily-run",
  "schedule": "0 3 * * *"}` (once daily). The existing ASIN-checker cron entry and its 2-hour cadence are
  completely untouched.
- `.env.local.example` — added `REVIEW_REQUESTS_OVERLAP_DAYS=3`. All 6 pre-existing `REVIEW_REQUESTS_*`
  vars unchanged; `REVIEW_REQUESTS_ENABLED=false` / `REVIEW_REQUESTS_DRY_RUN=true` remain the committed
  defaults.
- `scripts/review-requests-daily.ts` (NEW) — CLI convenience wrapper around the same `runDailyForward()`
  core (manual/local runs only, not the production entry point). **Not executed against production in
  this task.**
- `scripts/test-review-requests-daily.ts` (NEW) — 13/13 passing: all 12 founder-requested cases (rolling
  3-day overlap is idempotent; dry-run never POSTs; live POST requires both
  `REVIEW_REQUESTS_ENABLED`/`REVIEW_REQUESTS_DRY_RUN` gates — all 4 combinations tested; an eligible GET
  action allows a POST; a missing action never POSTs, live-send active or not; an already-sent row is
  never re-selected/re-POSTed; two concurrent workers racing `claimForSendAttempt`/`recordSendResult`
  cannot both send; every terminal status is excluded from `findDueCandidates`; one candidate throwing
  never aborts the batch; the rate limiter is applied once per candidate checked; cron bearer-auth is
  enforced; a 150-order/day estimate stays inside the 280s route budget) plus a `classifySendOutcome`
  unit test.
- Two pre-existing tests updated for accuracy (their premise — "the send function does not exist in this
  codebase" — was correct scoped to those specific PRs, but is now stale for the codebase as a whole):
  `scripts/test-review-requests.ts` and `scripts/test-review-automation-permission-probe.ts` now assert
  the function exists on the SP-API client but is never referenced by that script specifically
  (`review-requests-catchup.ts` / `probe-review-automation-permissions.ts`, confirmed via a source-text
  scan, not just an export check).

**Checks:** `npx tsc --noEmit` clean. `npx eslint` clean on every changed/new file. `npm run build` clean
— both new routes (`/api/review-requests/jobs/run`, `/api/cron/review-requests/daily-run`) appear
correctly in the production route tree. Full regression **90/90** across every test suite in the repo
(13+10+8+6+9+13+20+6+5).

**Not done / explicitly deferred, per the task's own scope:** the 30-day catch-up was not run. Live
sending was not enabled anywhere — `REVIEW_REQUESTS_ENABLED`/`REVIEW_REQUESTS_DRY_RUN` remain at their
safe committed defaults in every environment; no review request was sent during this work. No live
supervised dry run of the new daily workflow was executed against production this round (recommended
next step, pending approval, before relying on the cron in production). No SP-API scope was found
missing — the existing Orders/Solicitations GET connection already proven live in the earlier §18 3-day
sample covers everything this workflow needs; the Solicitations POST itself has not yet been exercised
live (by design — that requires the founder to explicitly enable live mode first). No credentials/scopes
changed. Ads, payments, replenishment, the ASIN checker, ASIN UI, the Render ASIN cron, and the Report
Reuse Gate are all untouched — no file under any of those areas appears in this change.

### §18 update (2026-07-16) — PR #42 reviewed + merged; production promotion blocked

**Review (independent, not trust-the-PR-description):** re-ran everything myself in a worktree checkout
of the PR branch. Full regression **90/90** passing, `tsc --noEmit` clean, `eslint` clean, `npm run
build` clean with both new routes present in the route tree. Diff-stat confirmed scope: only
`review-requests/*`, `spapi-client.ts`, the 2 new routes, `vercel.json`, `.env.local.example`, and the 2
tracker docs — no Ads/payments/replenishment/ASIN checker/ASIN UI/Render ASIN cron/Report Reuse Gate
file appears. **Merged to `master` as `69afbbc`** (standard merge commit).

**Production promotion: blocked, not completed, founder decision = stop for now.**
`list_deployments` (Vercel MCP, which worked normally throughout) confirms production (`target:
"production"`) is still serving `eb3beaa` — one commit behind, from PR #41. A `READY` build for
`69afbbc` already exists (`dpl_13wA24MP76CUdxwEj85C5AMKjx8A`, auto-built off the `master` push) but its
`target` is `null` — never promoted/aliased to the public production alias. Because of this, the new
routes do not exist on production yet, so **Steps 2–4 of the deploy-and-verify task (env-safety check,
route checks, one supervised dry-run invocation) could not be attempted.**

Root cause of the block: no promote/alias tool exists in the available Vercel MCP toolset (only
list/read tools plus `deploy_to_vercel`, which builds an entirely new deployment from an uploaded file
tree rather than promoting an existing one); `get_project`/`get_deployment`/`web_fetch_vercel_url` all
failed consistently with `"MCP tool call requires approval"` (4 attempts, while `list_teams`/
`list_projects`/`list_deployments` worked fine every time); no `vercel` CLI or token exists in this
sandbox. A from-scratch `deploy_to_vercel` upload was deliberately not attempted as a workaround — with
`get_project` blocked, the project's real build/env settings could not be read first, so reconstructing
them by guesswork for a production deploy was judged too risky to do unilaterally. Asked the founder;
**decision: stop here for now**, do not attempt the risky from-scratch path.

**Nothing risky occurred:** no env var was changed anywhere (`REVIEW_REQUESTS_ENABLED`/`DRY_RUN`
untouched, still `false`/`true`), no Amazon API call was made, no review request was sent, no DB row was
written, no migration ran. The only production-adjacent actions this round were read-only Vercel list
calls plus the one GitHub merge (code only).

**Next step (needs the founder):** promote `dpl_13wA24MP76CUdxwEj85C5AMKjx8A` to production (`vercel
promote dpl_13wA24MP76CUdxwEj85C5AMKjx8A` from an authenticated machine, or the dashboard's "Promote to
Production" action). Once production is confirmed on `69afbbc` or newer, Steps 2–4 can proceed exactly
as scoped — still dry-run only, still no live sending.

### §18 update (2026-07-17) — Production verified live on `8ef0ecd`; first natural cron run observed, timed out mid-batch, one stuck row found

**Production promotion confirmed done (by the founder, outside this session).** `get_project`/
`get_deployment` (Vercel MCP) confirm `esolz-app.vercel.app` now serves `dpl_4u3RJr6YvrCW1V3iQjo8VTGyrRpM`,
commit `8ef0ecd80673357f8a38238d6f4857f9c6ed70ce` (`target: "production"`, `readyState: READY`). PR #43
(`8ef0ecd`, one commit past the `69afbbc` merge) is also live.

**Steps 2–4 (env-safety, route protection, code-level send-gate verification) completed from a new clean
worktree** (`C:\Vinay\amazon-seller-toolkit-review-verification`, branch `verify/review-automation-local`,
tracking `origin/master`; the dirty `intern/asins-page-work` checkout was never touched). Findings:
- Code-verified: live POST requires both `REVIEW_REQUESTS_ENABLED=true` and `REVIEW_REQUESTS_DRY_RUN=false`
  (`daily-run.ts`'s `liveSendActive` gate); unset/false defaults cannot send; the send function
  (`createProductReviewAndSellerFeedbackSolicitation`) is unreachable unless both gates pass; every
  eligibility decision comes from a fresh GET, never cached; a missing `productReviewAndSellerFeedback`
  action or a terminal/already-sent row cannot reach the send path; `claimForSendAttempt` is a guarded
  atomic claim.
- `vercel env ls production` (names only, no values pulled): **none of the 6 `REVIEW_REQUESTS_*` vars are
  set in production** — every one runs on its safe committed default. `CRON_SECRET`,
  `BACKGROUND_WORKER_SECRET`, `APP_BASE_URL` all confirmed present.
- Route protection confirmed live: unauthenticated `GET /api/cron/review-requests/daily-run` → 401,
  unauthenticated `POST /api/review-requests/jobs/run` → 401, `GET` on that same route → 405.

**Manual supervised invocation attempted, then deliberately abandoned in favor of the natural cron.**
Pulling `CRON_SECRET` to fire one invocation manually was blocked by the local Claude Code auto-mode
permission classifier (flagged as secret-inspection) partway through diagnosing an extraction bug — no
secret value was ever printed or persisted, and the temp env file was deleted both times it was pulled.
Rather than change any permission rule (explicitly forbidden), the founder chose to wait for Vercel's own
`0 3 * * *` cron to fire naturally and verify that instead.

**A one-time scheduled check was created to verify the natural run automatically; it failed to run at
all** — the scheduled session (`review-requests-natural-cron-verify`) started at 2026-07-17T05:14:14Z (over
2h after its target time, consistent with "app was closed, ran on next launch") but crashed immediately
with `API Error: Unable to connect to API (ENOTFOUND)` before making a single tool call. Not a permission
block — a network/API connectivity failure. Verification was then performed directly in this session
instead, using the same read-only method (Vercel runtime logs + read-only Supabase queries), per fallback
instruction.

**The natural cron DID fire, on schedule, on the correct (`8ef0ecd`) production deployment — but did not
complete.** Vercel runtime logs show, at `2026-07-17T03:01:06Z` on `dpl_4u3RJr6YvrCW1V3iQjo8VTGyrRpM`:
`POST /api/review-requests/jobs/run` → **504**, `Vercel Runtime Timeout Error: Task timed out after 280
seconds`; `GET /api/cron/review-requests/daily-run` → **502**, body
`{"ok":false,"reason":"This operation was aborted"}` (the cron route's own internal-call abort, exactly the
behavior documented in that route's code comment for this failure mode). **Discrepancy honestly noted, not
resolved:** Supabase evidence (below) shows real write activity continuing through `03:05:46–03:05:47Z`,
about 4.5 minutes after the logged timeout timestamp — most likely Vercel's error-aggregation timestamp
lagging the true kill moment, but not confirmed with certainty; the DB timestamps are treated as
authoritative since they are first-party and directly queried.

**Read-only Supabase diff against the pre-run baseline** (`review_solicitation_orders`, workspace
`55a321c9-…`, marketplace `A21TJRUUN4KGV`; baseline: 422 rows, 0 sent, 402 `pending`, 20
`not_eligible_retryable`, last activity `2026-07-12 14:44:38Z`, from the earlier manual 3-day sample —
this was genuinely the first natural run of this code in production):
- **463 new orders discovered and inserted** (Phase 1, rolling 3-day window fetch), **20 existing orders
  re-touched** (metadata refresh only, no solicitation fields changed — matches `upsertDiscoveredOrder`'s
  guarantee).
- **21 candidates claimed for an eligibility check; 20 completed** (`18 → not_eligible_retryable`, `2 →
  eligible_dry_run` — 2 genuinely eligible orders, correctly recorded dry-run-only, never sent). **1 row is
  now stuck in `checking`** — claimed but never finalized before the function was killed. This is a real,
  new finding: `claimForEligibilityCheck` has no `claim_expires_at`/TTL or reclaim job (unlike the later
  send-claim, which does), so this row is permanently excluded from `findDueCandidates()` (which excludes
  `checking` by design) until someone manually resets it or a reclaim mechanism is added. **Not fixed here**
  — would be a DB write, out of scope for a read-only verification task.
- **0 duplicate `(workspace_id, marketplace_id, amazon_order_id)` groups** (also structurally guaranteed by
  the unique constraint, empirically confirmed).
- **0 rows with `solicitation_sent = true`** (unchanged from baseline) — **0 POST attempts, 0 review
  requests sent**, matching the code+env analysis above.
- **0 Amazon error codes** among the 20 finalized checks (`last_error_code` null on all 20) — all 20 were
  clean, successful Solicitations GET calls.
- **PII allowlist check: PASS.** `last_eligibility_response` on all 20 touched rows contains exactly the 5
  approved keys (`actionNames`, `checkedAt`, `sanitizedReason`, `amazonStatusCode`, `amazonErrorCode`) —
  keys only inspected, no row content printed anywhere in this verification.
- Re-confirmed post-run: `REVIEW_REQUESTS_*` vars still absent from production — live sending remained
  structurally impossible throughout.

**Root cause of the timeout (assessment, not yet fixed):** this was a cold-start backlog spike, not a
steady-state failure — the entire pre-existing 402-row `pending` pool plus 463 newly-discovered orders all
became due simultaneously because no natural run had ever executed this code before. Combined with the
default `REVIEW_REQUESTS_BATCH_SIZE=300`, the sequential per-order Phase 1 upsert (previously measured at
~3 minutes for a 3-day/~420-order window), and the 1100ms-rate-limited sequential Phase 2 GET loop, the
full workflow cannot complete inside Vercel's 280s serverless ceiling on a backlogged first run.

**Two real findings need a founder decision before this cron can be relied on unattended:**
1. The 1 stuck `checking` row needs either a one-off manual fix or, better, a code-level stale-claim
   reclaim (mirroring `claimForSendAttempt`'s `claim_expires_at` pattern, or the ASIN checker's
   `reclaimStuckJob()`/`cleanupStuckJobs()`). Neither was attempted here (would require a DB write or a code
   change, both out of scope for this read-only task).
2. The backlog has not been cleared — **845 rows remain `pending`** after this run. The same timeout risk
   is likely to recur on the next natural cycle (`2026-07-18T03:00Z`) unless batch size, phasing
   (splitting order-fetch from eligibility-check into separate invocations), or the timeout budget is
   revisited. Not changed here — needs explicit approval, same as every other change to this workstream.

**Confirmed NOT done this session:** no `CRON_SECRET`/`BACKGROUND_WORKER_SECRET` value inspected, printed,
or logged; no Bash/Claude Code permission rule changed; no environment variable changed; no route invoked
manually; no live sending enabled; no 30-day catch-up run; no database row written, updated, or deleted;
the dirty `intern/asins-page-work` checkout was never touched.

**Next step (needs the founder):** decide how to handle the stuck `checking` row and the timeout/backlog
risk before the next natural cycle. This update (tracker + `WORK_DONE_SUMMARY.md`) is being opened as a
docs-only PR from the clean worktree, not merged without approval.

### §18 update (2026-07-17, later same day) — PR #44 merged; worker split into ingestion + bounded eligibility processor, opened as a PR

**PR #44 (the natural-cron-run findings above) merged** to `master` as `abb3ab4` (standard merge commit).
Founder approved this exact architecture direction: keep the stuck `checking` row untouched (recovered
through code, not manual SQL), fix the timeout/stale-claim behavior properly before the next natural cycle
(2026-07-18T03:00Z), and defer the Pincode Checker work.

**New clean worktree:** `C:\Vinay\amazon-seller-toolkit-review-worker-fix`, branch
`fix/review-request-worker-timeout`, created from latest `origin/master` (`abb3ab4`). The dirty
`intern/asins-page-work` checkout and the `review-verification` worktree were never touched. Ads,
payments, replenishment, ASIN checker, ASIN UI, Report Reuse Gate, and Amazon auth/tokens are all
untouched by this change — diff scope is `review-requests/*`, the two new/changed route trees, `vercel.json`,
`.env.local.example`, and this tracker + `WORK_DONE_SUMMARY.md`.

**Root cause of the 280s timeout, confirmed by direct calculation:** the former combined worker's default
`REVIEW_REQUESTS_BATCH_SIZE=300` at the `REVIEW_REQUESTS_RATE_LIMIT_MS=1100` rate limit is
`300 × 1100ms = 330s` of *mandatory* sequential throttling alone — already past Vercel's 280s function
ceiling before a single GET call or DB write. The combined workflow (order ingestion + eligibility
checking in one invocation) made this worse by also running the multi-minute Phase 1 order-fetch first.
This was not a fluke of the first backlogged run; it was structurally guaranteed to time out at anything
close to the old default batch size.

**Architecture: split into two independently-scheduled, independently-bounded phases** (former combined
`daily-run.ts` and its 2 routes deleted, not deprecated-in-place — no cron references the old combined
workflow anymore):

1. **Daily order ingestion** (`src/lib/review-requests/order-ingestion.ts`, `runOrderIngestion()`) —
   rolling 3-day Orders API fetch + idempotent upsert only, unchanged logic from the former Phase 1. Never
   claims, checks eligibility, or sends — structurally cannot (its deps type has no
   Solicitations-GET/POST parameter at all). Cron: `GET /api/cron/review-requests/daily-ingest`,
   `0 3 * * *` (once daily, unchanged cadence). Worker: `POST /api/review-requests/jobs/ingest`.
2. **Bounded eligibility processor** (`src/lib/review-requests/eligibility-processor.ts`,
   `runEligibilityProcessing()`) — the former Phase 2 logic (fresh GET as the only eligibility source of
   truth, 1100ms rate limiter, guarded claim/finalize, live-send gated identically to before), now with two
   new safety mechanisms:
   - **Runtime budget** (`REVIEW_REQUESTS_RUNTIME_BUDGET_MS`, default 220,000ms): checked *before* claiming
     each new candidate, never mid-candidate — once tripped, the loop stops claiming, finishes finalizing
     whichever candidate is already claimed, and returns HTTP 200 with an accurate partial-run summary
     (`candidatesSelected`, `candidatesCompleted`, `remaining`, `stoppedDueToRuntimeBudget`, `durationMs`).
     Never depends on Vercel force-killing the function.
   - **Stale `checking` claim reclaim** (`repository.ts#reclaimStaleCheckingClaims`, new): runs first, before
     selecting new candidates, every invocation. Recovers a row a prior run claimed but never finalized
     (runtime-budget stop or hard platform kill) back to `pending` (a valid, always-safe
     `DUE_CANDIDATE_STATUS`) with `next_check_at` reset to now. Uses the *existing* `updated_at` column —
     reliably bumped by the DB's own `trg_review_solicitation_orders_updated_at` trigger on the exact
     UPDATE `claimForEligibilityCheck()` performs — **no migration added**, per instruction, since the
     existing schema already supports this. Guarded to match only `solicitation_status='checking' AND
     updated_at < staleBeforeIso` (default TTL 15 min via `REVIEW_REQUESTS_STALE_CLAIM_TTL_MINUTES`) — a
     fresh/active claim is never touched, and this scope never overlaps `send_claimed` (a fully separate
     status/claim pair), so reclaim cannot interfere with an in-flight send claim or cause a duplicate send.
   Default batch size lowered `300 → 120` (`REVIEW_REQUESTS_BATCH_SIZE`, same env var, repurposed — it now
   only controls the eligibility processor, since ingestion has no candidate-batch concept). Cron:
   `GET /api/cron/review-requests/process-eligibility`, `0 */4 * * *` (every 4 hours, new). Worker:
   `POST /api/review-requests/jobs/process-eligibility`.
3. **Shared cron-relay helper** (`src/lib/review-requests/cron-relay.ts`, new) — the
   CRON_SECRET-check-then-relay-with-redirect/content-type/JSON verification logic (previously duplicated
   inline in the one combined cron route) extracted once, used by both new cron routes, per this repo's
   "reuse before rewrite" standing rule (sec17).

**The currently-stuck `checking` row was NOT touched manually.** It will be recovered by
`reclaimStaleCheckingClaims()` the first time the new `process-eligibility` cron runs after this deploys
(its `updated_at` is already `2026-07-17T03:0x:xxZ`, already well past any reasonable TTL by the next
cycle) — exactly the "recovered through code, not manual SQL" requirement.

**Capacity, proved by calculation and asserted in tests** (see
`scripts/test-review-requests-eligibility-processor.ts`, test 13): batch 120 × 1100ms = ~132s of mandatory
throttling, comfortably inside the 220s internal budget (leaves ~88s for GET/DB overhead) and comfortably
inside Vercel's 280s hard ceiling. 6 runs/day (every 4h) × 120 = **720 candidates/day of capacity**,
against an expected 100-150 new orders/day — enough headroom for the existing ~845-row `pending` backlog to
decline over time instead of growing, even accounting for the runtime budget occasionally cutting a run
short.

**Safety — unchanged, re-verified:** committed defaults remain `REVIEW_REQUESTS_ENABLED=false` /
`REVIEW_REQUESTS_DRY_RUN=true` (`.env.local.example`, unchanged values, only the batch-size default and
2 new budget/TTL vars added). No solicitation POST is reachable in dry-run — same
`liveSendEnabled && !dryRun` gate as before, now guarding `runEligibilityProcessing()` instead of
`runDailyForward()`. No live sending enabled, no 30-day catch-up run or referenced, no production
environment value changed, no manual production invocation, no historical row mutated, no order
ID/buyer info printed anywhere (same masking/allowlist discipline as before), no secret printed.

**Tests: 95/95 passing** across all 10 suites in the repo (8 pre-existing + 2 new —
`test-review-requests-ingestion.ts` 3/3, `test-review-requests-eligibility-processor.ts` 15/15, covering
all 13 required cases: ingestion/processing separation, batch cap, runtime-budget graceful stop, accurate
partial-run counts, stale-claim reclaim, fresh-claim non-reclaim, reclaim-cannot-duplicate-send, dry-run
never POSTs, terminal/already-sent excluded, one-failure-doesn't-abort, cron auth enforced,
every-4-hours capacity, and all pre-existing coverage ported/still passing). `npx tsc --noEmit` clean,
`eslint` clean on every changed/new file, `npm run build` clean — new route tree confirmed
(`/api/cron/review-requests/daily-ingest`, `/api/cron/review-requests/process-eligibility`,
`/api/review-requests/jobs/ingest`, `/api/review-requests/jobs/process-eligibility`), old combined routes
confirmed absent from the build output.

**Opened as a PR from `fix/review-request-worker-timeout`, not merged, not deployed.**

**Next step (needs the founder):** review and approve; once merged, needs a real production deploy +
promotion (the same manual step every prior PR in this workstream has needed) before the split cron
actually replaces the old one in production — until then, production continues running whatever was last
promoted (`8ef0ecd`, the old combined-workflow cron, still safely dry-run). After promotion, the very next
`process-eligibility` cycle (within 4h) should recover the stuck row via reclaim — worth a quick read-only
check afterward, same pattern as this session.

### §18 update (2026-07-17, later still) — PR #45 amended: 3 reliability/reporting gaps closed before merge

**PR #45 not merged.** Founder approved the split architecture in principle but flagged three gaps found
during review, all fixed in place on the same branch (`fix/review-request-worker-timeout`) — no second
branch or PR created, per instruction.

**Gap 1 — ingestion was still sequential and close to the platform limit.** The natural production run did
483 order upserts (Phase 1) and only 20 eligibility checks (Phase 2) before the 280s kill; eligibility
throttling alone only accounted for ~22s, so the sequential upsert loop was consuming most of the runtime
even after the split. A normal 3-day/100-150-orders-per-day window can still be 300-450 orders — fast
enough throughput needed to be the primary fix, not just a runtime guard.
- `runOrderIngestion()` now processes upserts in bounded chunks of `REVIEW_REQUESTS_INGEST_CONCURRENCY`
  (default 8) via a small `processInBoundedChunks()` helper — never a single unbounded `Promise.all` over
  the whole page. `upsertDiscoveredOrder()` itself is unchanged (idempotency, solicitation-progress
  preservation, and the rolling 3-day overlap are all untouched).
- One failed upsert is caught, counted in a new `ordersFailed` field, and never aborts the run or logs an
  order id — same "one failure doesn't abort the batch" discipline as the eligibility processor.
- A new internal runtime guard (`REVIEW_REQUESTS_INGEST_RUNTIME_BUDGET_MS`, default 220,000ms), checked
  before fetching each new page and before each concurrency chunk (never mid-chunk), stops the run
  gracefully rather than depending on a platform kill. On a partial stop: returns HTTP 200,
  `paginationComplete=false`, `pagesCompleted`/`ordersCompleted` report exactly how far it got, and a new
  `partialIngestionNote` string explains — since every run restarts pagination from page 1 with no
  persisted cursor — that a *recurring* partial stop could repeatedly under-serve tail pages, and should be
  investigated rather than ignored. **Deliberately did not add a persisted pagination cursor** — that is
  real added complexity/risk for a problem bounded concurrency should already make rare; per instruction,
  reporting honestly when the rare partial case happens is preferred over an unsafe partial-ingestion
  design.
- Proven, not assumed: a new test (`test-review-requests-ingestion.ts`) runs 483 synthetic orders through
  the real chunking logic with an instrumented fake DB layer and asserts both full completion
  (`ordersCompleted === 483`, `paginationComplete === true`) and that observed simultaneous DB calls never
  exceeded the configured concurrency of 8.

**Gap 2 — `candidatesCompleted` was incremented too early.** It previously incremented immediately after
the Solicitations GET succeeded, before the DB finalize write (`recordEligibilityResult`/
`recordSendResult`) was confirmed applied — so a GET that succeeded but whose DB write then failed or threw
was still counted as "completed," even though the row was left stuck in `checking`.
- Redefined precisely: a candidate counts as completed only when its claim has been resolved out of
  `checking` AND the finalize write is confirmed applied (`recordEligibilityResult`/`recordSendResult`
  returning `true`). Every finalize call site now checks its own return value before incrementing.
  Exception paths and lost-claim races were already correctly excluded (unchanged).
- New test: GET succeeds, the DB finalize write is forced to fail (via a scoped fake-admin failure
  injector), and confirms `candidatesCompleted` stays `0`, the row remains in `checking`, and
  `reclaimStaleCheckingClaims()` still recovers it later — proving the "not completed" case is not a data
  black hole, just correctly deferred to the existing reclaim path.
- Same correction applied to the `sent` counter for consistency (it also now only counts once
  `recordSendResult` confirms the write applied) — this is a live-send-path-only code path, unreachable
  under committed defaults, but was carrying the identical bug.

**Gap 3 — `remaining` was ambiguous.** Renamed to `selectedCandidatesRemaining` (this batch's selected-minus-
completed only — never the total DB backlog). Added an optional, genuinely cheap `dueBacklogRemaining`
field: `repository.ts#countDueCandidates()`, an index-only `COUNT` (same filter shape and same partial
index, `review_solicitation_orders_due_idx`, as `findDueCandidates()`) called once at the end of every
eligibility-processor run — cheap enough to always include, and gives an honest read on whether the backlog
is actually declining over time, which `selectedCandidatesRemaining` alone cannot answer.

**Tests: 104/104 passing** across all 10 suites (8 pre-existing unchanged + 2 updated in place —
`test-review-requests-ingestion.ts` grew 3→10 tests, `test-review-requests-eligibility-processor.ts` grew
15→17 tests). `npx tsc --noEmit` clean, `eslint` clean on every changed file, `npm run build` clean — all 4
split routes still present in the route tree.

**Still true, unchanged by this amendment:** live sending remains disabled by committed default
(`REVIEW_REQUESTS_ENABLED=false` / `REVIEW_REQUESTS_DRY_RUN=true`); no production environment value
changed; no manual production invocation; the stuck `checking` row still not touched manually (still
recovered only through `reclaimStaleCheckingClaims()` on the first real `process-eligibility` run after
deploy); no 30-day catch-up run or referenced; Pincode Checker work not resumed; Ads, payments,
replenishment, ASIN checker, ASIN UI, Report Reuse Gate, and Amazon auth/tokens all untouched; the dirty
`intern/asins-page-work` checkout and the `review-verification` worktree both untouched; `git add .` not
used anywhere in this session.

**PR #45 description updated to reflect all of the above. Still not merged, not deployed.**

**Next step (needs the founder):** review the amended PR #45; once merged, still needs the same manual
production deploy + promotion step as before.

---

## 19. ASIN Page Live-Data Diagnosis (2026-07-12)

**Scope: inspection only, no code/cron/Render/Vercel changes, no SQL mutations.** Triggered by a live
screenshot showing confusing/empty values on `/dashboard/asins` (My Products tab) despite the ASIN
cron/stuck-job fixes from §16 being verified. Builds on a prior static-code-only audit,
`ASIN_PAGE_DATA_AUDIT.md` (found in the intern's local checkout at `amazon-seller-toolkit-clean-sync`,
read-only per the CLAUDE.md "do not touch ASIN UI files" rule — not committed anywhere).

**Audit validity check (important):** the intern's local working tree at `amazon-seller-toolkit-clean-sync`
has uncommitted edits to these exact files, but they are **cosmetic only** — a dev-only mock-mode toggle
(`getMockAmazonListingsResponse`, gated behind `NODE_ENV !== 'production'`) plus matching UI wiring. The
actual price/BSR/Buy Box/availability/deal-tag computation logic is **byte-identical** to `origin/master`
(confirmed via `git diff origin/master` — 0 diff on `catalog.ts`/`pricing.ts`, and the `listings/route.ts`
diff is exactly the 13-line mock-mode block). The remote `intern/asins-page-work` branch has **zero commits
ahead of master** — it's a stale pointer, never pushed with real changes. **Conclusion: what's live in
production is what's described below**, and the prior audit's findings (which read the same, functionally-
unchanged logic) are corroborated, not superseded.

### Column-by-column

**Price**
- Current source: `asin_snapshots.price`, coalesced as `snapshots.find(s => s.price !== null)` — the most
  recent snapshot that actually has a price, not simply the latest snapshot (`listings/route.ts:212,225`).
- Why blank/confusing: genuinely correct behavior when blank — "—" means no Pricing call has **ever**
  succeeded for that ASIN, not that the latest check merely failed. When a price **is** shown from an old
  snapshot, the coalescing is working correctly (verified live — see below).
- Missing in DB or display logic: **Missing in DB** (Pricing API rate-limited) when blank; when a stale
  price shows, it's real historical data, correctly surfaced.
- Seller-friendly replacement: keep the value + `last_successful_price_checked_at` sub-line (already
  exists in the API response, `listings/route.ts:233`) more prominently in the UI — the mechanism is sound,
  the labeling ("Pricing rate-limited") could be softer ("Price last confirmed {date}; latest check was
  throttled by Amazon").
- Fix priority: **Low** — this column is trustworthy as designed.

**BSR**
- Current source: `asin_snapshots.bsr`, coalesced the same way as price (`bsrSnapshot`,
  `listings/route.ts:213,226`), from SP-API Catalog Items (`getCatalogItemForAsin`, independent of Pricing).
- Why blank/confusing: for most sampled products, BSR is **not** blank — it refreshes successfully every
  cycle even while Pricing is rate-limited (see live sample below), which is correct/expected since
  Catalog and Pricing are separate SP-API calls with separate rate limits. A small subset (2 of 10 sampled)
  have `bsr = null` on every recorded check going back at least a week — a genuine, per-ASIN Catalog lookup
  failure, not a rate-limit artifact.
- Missing in DB or display logic: **Missing in DB**, but only for a minority of ASINs; most have real,
  frequently-refreshed BSR.
- Seller-friendly replacement: "BSR unavailable from Catalog source" is accurate for the affected minority;
  no change needed for the majority where BSR is actually populated and fresh.
- Fix priority: **Low** for the general mechanism; **Medium** to investigate why a specific subset of ASINs
  never gets a Catalog match (out of scope for this inspection — would need per-ASIN SP-API Catalog
  response inspection).

**Buy Box**
- Current source: `asin_snapshots.buy_box_status` / `buy_box_owner`, coalesced via `pricingSnapshot =
  snapshots.find(s => s.price !== null || s.buy_box_owner !== null || s.buy_box_status !== null ||
  s.availability_score !== null)` (`listings/route.ts:214-219,227-228`).
- Why blank/confusing: **this is a real, previously-undocumented bug.** When Pricing is rate-limited,
  `process-next/route.ts:312` writes `buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'` — a
  **non-null placeholder string**, not `null`. Because the coalescing search looks for the most recent
  **non-null** value, and `'unknown'` is non-null, every rate-limited check **overwrites and permanently
  hides** any genuine prior Buy Box status (`'won'`/`'lost'`) for that ASIN — unlike Price, which correctly
  stays `null` on a rate-limited attempt and lets the coalescing fall through to an older real value. Live
  verification: one sampled ASIN's most recent **30 consecutive snapshots** (2026-07-05 through 2026-07-11,
  a full week) are **all** `buy_box_status: "unknown"` with `scrape_status: partial_pricing_rate_limited` —
  Pricing has been rate-limited on every single check for at least a week straight for this ASIN.
- Missing in DB or display logic: **Both** — the underlying genuine value (if it ever existed) is masked in
  the DB by the `'unknown'` placeholder, and the display logic trusts that placeholder as if it were real
  data.
- Seller-friendly replacement: change the write path (`process-next/route.ts:312`) to write `null` instead
  of `'unknown'` when Pricing is skipped/rate-limited, so the same coalescing logic that already protects
  Price protects Buy Box too. Until fixed, relabel "Buy Box seller unknown" to something that doesn't imply
  a fresh check happened, e.g. "Buy Box not recently confirmed (Pricing throttled)".
- Fix priority: **High** — this is a real data-hiding bug, not just a labeling problem, and the fix is small
  and low-risk (change one fallback value from a string to `null`).

**Availability**
- Current source: `asin_snapshots.availability_score`, computed by `availabilityScoreFor(buyBoxStatus)`
  (`process-next/route.ts:86-91`): `won`/`lost` → 100, `no_buybox` → 0, `unknown`/`partial_success` → 50,
  else `null`. Same coalescing bug as Buy Box (same `pricingSnapshot` lookup, same non-null `'unknown'`
  placeholder feeding into a non-null score of 50).
- Why blank/confusing: "Availability 50%" does not mean "50% in stock" or any real stock/delivery signal —
  it means "Buy Box status came back ambiguous or defaulted to unknown," which per the bug above happens on
  **every** rate-limited check, not just genuinely ambiguous ones. It looks like a precise, real metric and
  isn't one.
- Missing in DB or display logic: **Display/semantic** — a value is present, but it doesn't mean what its
  presentation implies. Same underlying masking issue as Buy Box.
- Seller-friendly replacement: **remove the percentage entirely.** It has no relationship to real
  stock/offer/pincode availability (a genuine, disconnected data source — `pincode_checks` — exists but
  isn't joined here). Replace with a plain status word ("Buy Box: Ours / Competitor / No Buy Box / Not
  recently checked") once the Buy Box masking bug above is fixed.
- Fix priority: **High** for hiding the percentage (quick UI change, stops an actively misleading number);
  **Medium** for wiring in a real availability signal later (redesign-scope, not urgent).

**Deal Tag**
- Current source: none — hardcoded literal string `"Deal checker not implemented yet"`
  (`listings/route.ts:242`).
- Why blank/confusing: it's not blank, it's an honest placeholder — no bug, working as labeled.
- Missing in DB or display logic: **Feature doesn't exist.** No deal/coupon detection code path exists
  anywhere (confirmed in a prior session: "Amazon deal/coupon badges are NOT exposed by SP-API" per
  CLAUDE.md's known-state notes).
- Seller-friendly replacement: hide the column/badge entirely rather than showing a "not implemented"
  message on every single row — it adds visual noise for a feature that doesn't exist yet.
- Fix priority: **Low** (cosmetic — hide it), but easy and worth doing alongside the Buy Box/Availability
  fixes above since it's a one-line UI change.

### Answers to the specific questions

**1. Is "Cron not configured" wrong? Yes — confirmed wrong, and confirmed to be firing right now.**
The message comes from `listings/route.ts:289-295`:
```
if (checkerSummary.processing > 0) return 'Processing active'
if (checkerSummary.queueDueNow > 0) return 'Cron not configured — start processor to clear queue'
...
```
This is a **snapshot-in-time heuristic**, not a real cron-health check: it fires whenever nothing is
`status='running'` at the exact instant the page loads **and** there's any backlog due. Both Vercel Cron
(2h) and Render Cron (4h) are confirmed configured and healthy (§16 D.10, verified across 3+ clean cycles
this session) — but each only runs for a few seconds every 2–4 hours, so `processing=0` is true the vast
majority of the time by design, not because no cron exists. Live-verified right now: `status='running'`
count = **0**, `queued` = 451, all 451 with `run_after <= now()` (`queueDueNow = 451`) — this combination
guarantees the message fires continuously given current throughput (queue backlog grows faster than the
existing cron cadence drains it — the same known R11.2b throughput gap already tracked in §16, not a new
issue). **The message should be removed or rewritten** to reflect actual queue depth/age rather than
inferring cron existence from a point-in-time `processing` count.

**2. Are rate-limited rows overwriting/hiding older successful values?**
**Split answer: no for Price, yes for Buy Box and Availability.** Price correctly stays `null` on a
rate-limited attempt, so the "most recent non-null" coalescing correctly falls back to an older real price
— verified live (a sampled ASIN shows a real ₹209.00 price from 2026-06-23 surfacing correctly through 19
days of subsequent rate-limited checks). Buy Box status and Availability score are **not** null on a
rate-limited attempt — they get a placeholder (`'unknown'`, `50`) that the same coalescing logic treats as
genuine, non-null data, so they **do** overwrite/hide any older real value. This is the single highest-value
finding of this inspection (see "Buy Box" column above).

**3. What exact backend data exists for the first 10 visible products?** (My Products tab, ordered by
`item_name` ascending, matching the page's actual query — ASIN identifiers omitted here per the
aggregate-only reporting convention, product names are business data not PII/secrets so kept for context):
All 10 have `scrape_status = 'partial_pricing_rate_limited'` on their latest check. **Price:** 3 of 10 show
a real (stale, 3–19 days old) price via correct coalescing; 7 of 10 have never had a successful price.
**BSR:** 8 of 10 have real, frequently-refreshed BSR values (changing check-to-check, confirming Catalog is
genuinely working); 2 of 10 have never had a successful Catalog match. **Buy Box/Availability:** all 10
show `buy_box_status: "unknown"` / `availability_score: 50` — per finding above, this is the masking bug,
not a genuine "no data" state for all of them. **Queue status:** 9 of 10 have a `queued` job waiting for
its next scheduled attempt; 1 of 10 is in a permanent `failed` state (`last_error_safe: "stale processing
reset"` — very likely a casualty of the pre-PR#24/#26 stuck-job bug from earlier §16 work, now correctly
terminal but never automatically retried again). Workspace-wide: **76 of 482** `my_product` background job
rows (≈16%) are in this permanent `failed` state — a residual cleanup item, not a new bug, but worth
tracking since none of these 76 products will ever refresh again without a manual re-enqueue path.

**4. What should be fixed before UI redesign?**
1. The Buy Box/Availability masking bug (write `null` instead of `'unknown'` on rate-limited attempts) —
   this is a **data correctness** bug, not a cosmetic one; redesigning the UI on top of masked data would
   just make the wrong numbers look nicer.
2. The "Cron not configured" false-alarm message — actively erodes trust in a system that's actually
   working as designed; must not carry into a redesign unchanged.
3. A decision on the 76 permanently-`failed` `my_product` rows (≈16% of the catalog) — whether/how to
   re-surface them for a fresh attempt.
4. A decision on the two-tabs-two-tables fragmentation (`amazon_listing_items` vs `tracked_asins`,
   §9/§11 of the prior audit) — not blocking a My-Products-only redesign, but relevant if Competitors gets
   redesigned in the same pass.

**5. What can be hidden immediately because it's not implemented?**
- The Deal Tag "not implemented yet" message — hide the column/badge rather than displaying it.
- The Availability percentage — hide the number (not the concept) until the masking bug is fixed and/or a
  real signal is wired in; a raw, unexplained "50%" actively misleads in the meantime.
- Rating/review count (from the prior audit, still true — always `null`, never attempted) — already
  rendered as "—" everywhere, no change needed, but worth confirming no surface still implies a numeric
  rating exists.

### Trustworthy vs misleading columns

| Column | Trustworthy? | Why |
|---|---|---|
| Price | **Trustworthy** | Correct coalescing; blank = genuinely never priced, stale value = genuine history |
| BSR | **Trustworthy** (for most ASINs) | Refreshes independently of Pricing; small minority genuinely missing |
| Buy Box | **Misleading** | `'unknown'` placeholder masks real prior data on every rate-limited check |
| Availability % | **Misleading** | Not a real stock signal; inherits the Buy Box masking bug; looks precise, isn't |
| Deal Tag | **Honest placeholder** | Says exactly what it is, just shouldn't be shown on every row |
| "Cron not configured" | **Actively wrong** | Both crons are confirmed healthy; the heuristic is broken, not the crons |

### Immediate fix list (not implemented in this inspection — code change requires separate approval)

1. `process-next/route.ts:312` — write `null`, not `'unknown'`, as the Buy Box status fallback when Pricing
   is skipped/rate-limited. Small, targeted, same bug-fix pattern as the §16 `run_after` fixes.
2. `listings/route.ts:289-295` — remove or rework the `suggestedAction` cron-health heuristic; it does not
   measure what its message claims.
3. UI: hide the Deal Tag badge/column and the Availability percentage number rather than displaying a
   placeholder/misleading value on every row.
4. Operational (not code): decide what to do with the 76 permanently-`failed` `my_product` rows.

### Redesign prerequisites

- Items 1–2 above should land **before** any visual redesign, since a redesign would otherwise present the
  same masked/wrong data more confidently.
- The two-tabs-two-tables fragmentation (My Products vs Competitors, `amazon_listing_items` vs
  `tracked_asins`, independent `asin_snapshots` histories per §9/§11 of the prior audit) is a design
  decision for the redesign discussion, not a pre-redesign bug fix.
- Freshness/staleness UI is inconsistent across the three surfaces (My Products per-field status strings,
  Competitors single relative timestamp, `[asin]` detail page's 24h badge) — worth unifying in the
  redesign, not before it.

**Nothing in this section was implemented.** No code, cron, Render, Vercel, or SQL change was made. Read-
only inspection only, per instruction.

### §19 update (2026-07-12) — PR #35 merged; Buy Box masking fix implemented (opened, not merged)

**PR #35 (diagnosis docs): MERGED** (merge commit `3f8c599`). Confirmed documentation-only —
`BRAHMASTRA_MASTER_TRACKER.md` was the only file in the diff, no code/runtime changes, no deployment
required (a markdown-only merge activates nothing).

**Buy Box masking fix — implemented on `fix/buy-box-status-masking`, opened as a PR, not merged, not
deployed.** Fixes exactly the confirmed bug from the diagnosis above: `process-next/route.ts` was writing
the literal string `'unknown'` to `asin_snapshots.buy_box_status` whenever Pricing was rate-limited or
unavailable, which — because the read path coalesces the most recent **non-null** value per field —
permanently masked any older confirmed `won`/`lost` result. **Note on file scope:** this PR touches
`process-next/route.ts` and `listings/route.ts`, both named in CLAUDE.md's "do not edit ASIN UI files"
working-tree warning (about the intern's uncommitted local checkout at a different path,
`amazon-seller-toolkit-clean-sync`). This branch and PR are in the separate `track-asin-fix` worktree
against `origin/master` and do not touch, stage, or overwrite the intern's local files at all — flagging
transparently since the founder's explicit instruction for this exact fix, in this exact file, is what
authorized proceeding despite the standing caution.

**Files changed (4):**
- `src/lib/amazon/buy-box-status.ts` (new) — `resolveBuyBoxStatusToStore()`, a small, pure, side-effect-
  free function extracted out of the route handler specifically so it's testable without pulling in
  `server-only` (the route handler transitively imports it via `background-worker-auth.ts` and cannot be
  imported by a plain test script). Returns `null` when no Pricing call happened at all
  (`offersBuyBoxStatus` is `undefined`/`null`); returns the real value unchanged for a genuine successful
  call, including a genuinely-ambiguous `'unknown'`/`'no_buybox'`/`'partial_success'` result — the fix is
  narrowly "no call happened" → `null`, not "any ambiguous status" → `null`.
- `src/app/api/asins/jobs/process-next/route.ts` (write path) — split the old single `buyBoxStatus`
  local variable into two: `buyBoxStatusForAvailability` (unchanged behavior, still defaults to `'unknown'`,
  feeds `availabilityScoreFor()` exactly as before — **Availability is untouched, per instruction**) and
  `buyBoxStatusToStore` (the new, correct value actually written to the `buy_box_status` column, via
  `resolveBuyBoxStatusToStore()`).
- `src/app/api/asins/listings/route.ts` (read path) — extracted the previously-inline snapshot-finder
  lambdas into four named, exported, pure functions (`findPriceSnapshot`, `findBsrSnapshot`,
  `findPricingSnapshot` — all three **unchanged behavior**, just named for testability — and the new
  `findConfirmedBuyBoxSnapshot`, which coalesces **only** a snapshot whose `buy_box_status` is `'won'` or
  `'lost'`, skipping `null` and every ambiguous status). `buy_box_owner`/`buy_box_status` in the API
  response now come from `findConfirmedBuyBoxSnapshot`'s result instead of the old broad
  `pricingSnapshot`; a new `buy_box_confirmed_at` field returns that confirmed snapshot's timestamp.
  `buyBoxStatusLabel()` rewritten for the requested 3-state display: `"Won"` / `"Lost"` when the confirmed
  snapshot **is** the latest check; `"Won — last confirmed {timeAgo}"` / `"Lost — last confirmed {timeAgo}"`
  (via the existing `timeAgo()` helper from `src/lib/format.ts`) when it's older than the latest check;
  `"Not confirmed"` when no `won`/`lost` snapshot has ever been recorded — **never** infers a loss from an
  unconfirmed/unknown result, matching the instruction exactly. `availability_score` and
  `availabilityStatusLabel()` still use the old, unchanged `findPricingSnapshot()` lookup — Availability
  display is untouched, per instruction.
- `scripts/test-buy-box-status-fix.ts` (new) — **13/13 passing**: rate-limited/unavailable write stores
  `null` (not `'unknown'`); `won`/`lost` still store correctly; a genuine ambiguous successful result is
  preserved as-is (not over-nulled); a newer `null`/`unknown` snapshot does not mask an older confirmed
  `won` snapshot (direct proof of the bug fix); `no_buybox`/`partial_success` are correctly excluded from
  "confirmed"; no confirmed history anywhere returns `null` + `"Not confirmed"` label (never `"Lost"`);
  `"Not checked yet"` vs `"Not confirmed"` are distinct; fresh vs. stale confirmed-result label wording;
  the returned confirmed snapshot's timestamp exactly matches the specific row selected (not just any
  confirmed row); Price coalescing unaffected; BSR coalescing unaffected; Availability's broader lookup
  unaffected.

**Checks run:** `npx tsc --noEmit` — pass. `npx eslint` on all 4 changed/new files — pass, zero warnings.
Full regression: `test-track-asin.ts` 5/5, `test-stuck-job-reclaim.ts` 6/6, `test-retry-or-fail-update.ts`
6/6, `test-review-automation-permission-probe.ts` 9/9, `test-review-requests.ts` 20/20,
`test-buy-box-status-fix.ts` 13/13 — **59/59 total, all passing.**

**Explicitly not touched, per instruction:** Availability UI/percentage, Deal Tag UI, cron wording/message,
review automation, Ads, payments, replenishment, auth/tokens/profile selection, Report Reuse Gate. No
migration — this fix only changes what value gets written to an existing column and how existing rows are
read; historical rows are **not** mutated (an old row that already has `buy_box_status='unknown'` from
before this fix stays as-is; the fix only changes what future writes look like, and the read path simply
stops treating `'unknown'`-flavored rows as confirmed going forward).

**PR: opened, not merged, not deployed.**

### Remaining follow-ups from the §19 diagnosis (not started)

1. The "Cron not configured — start processor to clear queue" false-alarm message
   (`listings/route.ts:289-295`) — still live, still wrong, not addressed by this PR (this PR only fixed
   Buy Box; the cron-message heuristic is a separate, distinct fix).
2. Hide the Availability percentage in the UI (the underlying score computation is untouched by design in
   this PR, per instruction — this is a UI-only follow-up, not started).
3. Hide the Deal Tag "not implemented yet" badge/column (not started).
4. **Audit/decide what to do with the 76 permanently-`failed` `my_product` background-job rows (≈16% of
   the 482-product catalog) that will never automatically retry again — this is the next task.**
5. Review-request 30-day catch-up: **still not approved** — only the founder-approved 3-day/10-order
   sample has been run (§18); the full 30-day catch-up remains an explicit, separate approval gate.
6. **New, related, out-of-scope finding from this promotion's verification pass:** the same
   `buy_box_status: 'unknown'` fallback pattern this fix corrected also exists in a second, separate
   file — `src/app/api/asins/[asin]/refresh/route.ts:131` (the manual single-ASIN "refresh" route, not
   the automated checker's `process-next/route.ts` this PR fixed). Not touched, not in scope for PR #36 —
   flagged for a future, separately-approved fix if the same masking behavior matters there too.

### §19 update (2026-07-12) — PR #36 promoted to production, verified

**Promoted deployment:** `dpl_8UFTW9BzLiQGsob9dsRpk35xhbaL` (originally built from commit `e6cf0449`, PR
#36's merge). Promoted via `vercel promote dpl_8UFTW9BzLiQGsob9dsRpk35xhbaL` (Vercel CLI, already
authenticated as `vinay13893` on this machine — no MCP tool exists for promoting an *existing*
deployment, only for reading deployments or creating an entirely new one from an explicit file list,
which would not have been "this deployment"). Vercel recorded the promotion as its own event,
`dpl_4yVXrs6FaTcbLpmR64GBMexLnzgQ` (`meta.action: "promote"`, `meta.originalDeploymentId:
"dpl_8UFTW9BzLiQGsob9dsRpk35xhbaL"`), reusing the already-built output rather than rebuilding from
source. **No new commit was created, no branch other than `master`'s existing tip was involved, no code
was changed.**

**Verification (read-only only, per instruction — no forced heavy refresh):**

1. **Domain/commit:** confirmed via `get_deployment` on `dpl_4yVXrs6FaTcbLpmR64GBMexLnzgQ` —
   `state: READY`, `target: production`, `alias` includes `esolz-app.vercel.app`, `aliasError: null`,
   `githubCommitSha: e6cf0449113291cf04827ddaefc9ed0e360d48fd`. **`esolz-app.vercel.app` now serves commit
   `e6cf0449`.**
2. **Buy Box coalescing live — verified against real production data, not just unit tests.** Queried
   `asin_snapshots` directly for products whose *latest* snapshot has `buy_box_status` = `null`/`'unknown'`
   but which also have an *older* confirmed `won`/`lost` snapshot — found **5 real, live examples**
   (e.g. listing `010119c8-…`: latest check 2026-07-09 is `'unknown'`/`partial_pricing_rate_limited`, but
   a confirmed `'won'` snapshot exists from 2026-06-23). Per the new, unit-tested
   `findConfirmedBuyBoxSnapshot()` logic now live in production, loading the My Products page for any of
   these 5 will correctly surface the older confirmed result with "last confirmed … ago" wording instead
   of the old masked `'unknown'`/50%.
3. **Historical `unknown` skipped:** confirmed by the query above (the 5 examples exist and are exactly
   the masking scenario) plus the already-passing unit test `test-buy-box-status-fix.ts` ("a newer
   null/unknown snapshot does not mask an older confirmed won snapshot").
4. **No confirmed history → "Not confirmed":** covered by unit test, not independently re-verified against
   a specific production row in this pass (would require picking a specific product and confirming zero
   `won`/`lost` rows exist for it — the unit test already proves the logic; not repeated here to avoid an
   unnecessary extra query pass).
5. **Price/BSR regression: none expected and none introduced** — `findPriceSnapshot`/`findBsrSnapshot`
   are byte-identical in behavior to the pre-fix inline lambdas (confirmed by code diff and by the
   dedicated unit tests asserting Price/BSR/Availability coalescing is unaffected).
6. **Historical rows mutated: none — verified structurally, not just by row count.** Grepped every
   `.from('asin_snapshots')` call site across `src/`: every one is either `.select(...)` (read) or
   `.insert(...)` (append). **No `.update()` or `.delete()` targeting `asin_snapshots` exists anywhere in
   the codebase** — historical rows cannot be mutated by any code path, by construction, not merely by
   this fix's discipline. Row count (`13,577`) is consistent with normal organic growth since the last
   count taken earlier this session, not a bulk-mutation or data-loss signature.
7. **What was *not* safely live-tested:** the **write-path** half of the fix (`resolveBuyBoxStatusToStore`
   writing `null` instead of `'unknown'` on a rate-limited check) cannot yet be observed live — zero new
   `asin_snapshots` rows have been written since the promotion completed (`snapshots_since_promotion = 0`
   at verification time, only ~1 minute after promotion). This will only be observable once the next
   Vercel (2h) or Render (4h) cron cycle actually processes a rate-limited product. Also not exercised:
   the authenticated My Products page itself (`/dashboard/asins`) and the `GET /api/asins/listings` route
   directly — both require a logged-in session this verification pass did not have; the read-path fix's
   correctness was instead verified by (a) unit tests exercising the exact same exported functions the
   route calls, and (b) confirming real qualifying rows exist in production so the fix has actual, live
   data to act on the next time an authenticated user loads the page.

**No code changed in this verification pass** — read-only Supabase queries and Vercel API calls only.

### §19 update (2026-07-12) — Failed `my_product` jobs audit + write-path live-observation (inspection only)

**Read first for this pass:** `BRAHMASTRA_MASTER_TRACKER.md`, `ASIN_PAGE_DATA_AUDIT.md` (intern's local
checkout, read-only). **No code or DB rows changed in this pass** — SQL queries were all read-only.

#### 1–3. Failed `my_product` row count, breakdown, and root-cause classification

**Total: 76** (reconfirmed, unchanged from the earlier count), **all in one workspace**
(`55a321c9-…`, EasyHOME — the only workspace with `my_product` jobs). All 76 have
`attempt_count = 3 = max_attempts` — every one is a **genuine retry exhaustion**, not a premature/incorrect
failure.

`last_error_safe` breakdown:

| Reason | Count | Age range (completed_at) |
|---|---|---|
| `catalog_not_found` | 37 | 2026-06-23 → 2026-07-09 |
| `amazon_pricing_unavailable` | 23 | 2026-06-23 → 2026-07-11 |
| `stale processing reset` | 11 | **all 11 at exactly 2026-07-11 20:01:02.224** |
| `amazon_pricing_rate_limited` | 5 | 2026-06-23 → 2026-07-06 |

(No `last_error_code` column exists on `background_jobs` — that field only exists on the new,
unrelated `review_solicitation_orders` table from §18; `last_error_safe` is the only error field this
table has.)

**Root-cause classification (evidence-based, not guessed):**

- **`stale processing reset` (11) — confirmed identical count to the exact 11 stuck jobs from §16's
  `run_after` investigation earlier this session.** All 11 share one identical `completed_at`
  (2026-07-11 20:01:02.224) — a single batch event, consistent with these being the jobs that finally
  transitioned from stuck-`running` to terminal-`failed` once PR #24/#26's reclaim fix started working
  correctly and they'd already exhausted `max_attempts` by the time they were reclaimed. **Root cause:
  already fixed** (this session, earlier). Not a live code defect.
- **`amazon_pricing_rate_limited` (5)** — all from before 2026-07-06, i.e. predating this session's
  cooldown-backoff refinements. Likely stale casualties of an earlier, less-refined retry policy.
- **`catalog_not_found` (37) and `amazon_pricing_unavailable` (23) — sampled directly, not assumed.**
  Picked the target with the most historical failed rows (9, see below) and traced its **full job
  history**: `B0H6JJH1BH` ("Liltoes Reversible Baby PlayMat…", listing status `DISCOVERABLE`,
  marketplace `A21TJRUUN4KGV`, a syntactically valid ASIN) was **automatically re-enqueued and re-failed
  9 separate times over 18 days** (2026-06-23 → 2026-07-11), alternating between
  `amazon_pricing_unavailable` and `catalog_not_found`. Sampled 8 more `catalog_not_found` ASINs
  directly — all syntactically valid, all `DISCOVERABLE`, none deleted/archived. **Conclusion: these are
  genuine, persistent Amazon-side data gaps (Catalog Items API has no match, or no active offers to
  price) for specific ASINs — not malformed input, not marketplace mismatch, not an archived/deleted
  product, not an auth/token issue, and not a code defect.** The system is already discovering this the
  hard way, repeatedly, on its own.

#### 4. Linkage check

**All 76 `amazon_listing_item` rows still exist and are active** (`status = 'DISCOVERABLE'` for all 76,
0 deleted). No orphaned targets. `tracked_asins`/workspace linkage not applicable here (`my_product`
targets key off `amazon_listing_items` only, not `tracked_asins` — see the intern's audit §11).

#### 5. Retry-safe / terminal / archive / needs-code-fix counts

- **Retry-safe (transient, likely to succeed on a future attempt): 16** — the 5 `amazon_pricing_rate_limited`
  + 11 `stale processing reset` rows. Both root causes are already resolved/superseded; nothing about the
  ASINs themselves is problematic.
- **Terminal (Amazon-side, low probability of ever succeeding): ~60** — the 37 `catalog_not_found` + 23
  `amazon_pricing_unavailable`, based on the direct evidence above (one target failed the *same way* 9
  times over 18 days with no change). Framed as "low probability," not "certainly never," since this
  wasn't verified with a fresh live SP-API call per ASIN (out of scope for a read-only audit).
- **Archive/ignore: 0** — no listing is deleted, archived, or orphaned; there's nothing to archive on our
  side. All 76 are active listings simply pending Amazon's own data. 
- **Needs-code-fix: 0** — no live code defect is responsible for any of these 4 failure reasons.

#### 6. **Critical finding: no manual reset is needed at all — the system already retries these
automatically, without any duplicate/history/max-attempts risk, because it never reuses old failed rows.**

Traced the enqueue eligibility logic (`enqueue/route.ts:70-96`): its own `background_jobs` lookup query
is filtered to `status IN (queued, running) OR (status IN (completed, failed) AND completed_at >= 24h
ago)`. **A `failed` row older than 24h becomes invisible to the skip-logic entirely** — the target is
treated as brand-new-eligible and gets a **fresh row** on the next enqueue pass (the old row is left
untouched, never reused/reset). Confirmed live: **17 of the 76 target_ids already have more than one
historical `failed` row** (one has 9, several have 4-6) — direct proof the natural cadence has already
been re-attempting them repeatedly, all on its own. **6 of the 76 are, right now, already back in
`queued` status** for another attempt.

Answering the specific risk questions:
- **Duplicate jobs?** Not from the natural cadence (each cycle inserts a genuinely new row for a target
  that's had no `queued`/`running` row in >24h). Risk would only appear if someone manually flipped an
  *old* failed row back to `queued` while a newer natural-cadence row for the same target already exists
  (6 of the 76 are in exactly that state right now) — that would collide with the
  `background_jobs_active_target_uidx` partial unique index (`WHERE status IN ('queued','running')`) and
  error. **Recommendation: never manually touch these rows — the cadence already handles it correctly.**
- **Snapshot history preserved?** Yes, unconditionally — `asin_snapshots` is insert-only by construction
  (§19's earlier finding this session), completely independent of `background_jobs` row status.
- **Exceed max attempts incorrectly?** Only a risk if someone reset `status` without resetting
  `attempt_count` on an *old* row (it would immediately re-exhaust on the next claim). The natural cadence
  avoids this entirely by inserting a fresh row with `attempt_count=0` instead.
- **Re-trigger known poisoned inputs?** Yes, for the ~60 likely-terminal targets — but this is already
  happening every 24h via the normal cadence regardless of any manual action, at a bounded, small rate
  (76 rows across weeks, not a flood).

#### 7. Recommended cleanup plan (proposed only, **not run**)

**No SQL action is recommended for the 76 rows themselves.** They are not stuck, not orphaned, and not
evidence of a bug — they are the visible, moment-in-time tail of a retry cadence that is already working
correctly and self-healing (6 already re-queued; historical multi-attempt evidence for 17 targets proves
the cycle runs on its own). Recommended order, if anything is done at all:

1. **No immediate action required.** Optional: revisit in ~2 weeks to see whether the ~60 likely-terminal
   count has grown materially or stayed flat — flat/slow growth confirms this is a small, steady-state
   population of genuinely Amazon-unavailable ASINs, not a growing problem.
2. **Optional product decision (not urgent):** for targets that have failed the same way ≥3 times, consider
   either a longer backoff (to reduce wasted API/DB churn re-attempting known-persistent gaps) or a
   distinct UI status ("Amazon data unavailable for this ASIN") instead of the generic churn indicator —
   this is a UX/product call, not a bug fix, and was explicitly out of scope to implement here (touches
   ASIN UI).
3. **Optional housekeeping (low priority):** old failed rows accumulate indefinitely (no retention/pruning
   policy exists for `background_jobs`) — a future retention policy could be considered purely for table
   hygiene, unrelated to correctness.

#### 8. Buy Box write-path live observation — two significant, unexpected findings

Per instruction, observed the next normal cron cycles rather than forcing a refresh. **Two real cycles
occurred after PR #36's production promotion** (Vercel Cron at 16:00:42 and 18:00:42 UTC, confirmed via
`GET /api/cron/asins/process-product-snapshots` → `enqueue` → `process-next` in Vercel runtime logs) and
both wrote new `partial_pricing_rate_limited` snapshots — **but `buy_box_status` on all of them is still
`"unknown"`, not `null`.** The write-path fix is **not yet observably effective**, for two independent
reasons:

1. **Vercel Cron is invoking a stale, pre-fix deployment, despite the production alias being correct.**
   Runtime logs for both the 16:00 and 18:00 cycles show `dep=dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA` — a
   **much older deployment** (commit `3fa72fa2`, "Fix Track ASIN restore after archive," predating this
   entire session's PR #24 onward). Directly fetching `https://esolz-app.vercel.app/` (a plain page load,
   the one safe check the founder's instruction allowed) confirms the **public production alias itself
   correctly serves `dpl_4yVXrs6FaTcbLpmR64GBMexLnzgQ`** (the promoted fix — `data-dpl-id` in the served
   HTML matches exactly). So: **regular page loads and any interactively-triggered "Check Now" action get
   the fix; Vercel's Cron Job scheduler does not**, even after two cycles. Vercel's own docs confirm
   `vercel promote` explicitly **does not rebuild** the deployment; it appears Cron Job → deployment
   binding is not simply "whatever the production alias currently points to" and may require a full
   fresh production deploy (not a lightweight promote) to update, or may simply need more time to
   propagate than two cycles (4+ hours) allowed for. **Not resolved in this pass — flagging for a
   decision, not guessing further or taking action.**
2. **Independently, the Render cron script was never touched by PR #36 and has the identical, still-live
   bug.** `scripts/process-asin-checker-jobs.ts:587` has the exact same
   `offersResult?.buy_box_status ?? 'unknown'` pattern PR #36 fixed in `process-next/route.ts` — this is
   a **separate, independent reimplementation** of the same checker logic (see §16's dual-scheduler
   history) that PR #36's scope never included. Render's every-4h cron will keep writing the masking
   `'unknown'` value regardless of Vercel's binding issue above, until this file is separately fixed.

**Net effect:** the read-path fix (already verified live against 5 real rows in the prior update) is
fully effective today for any product whose masking snapshot was written *before* this fix — but new
rate-limited snapshots written by either scheduler going forward will **still** write the masking
`'unknown'` value until (a) Vercel's cron binding updates to the promoted deployment and (b) the Render
script gets the same fix applied. **This needs a decision, not a further inspection-only pass.**

### §19 update (2026-07-13) — PR #38 merged; Render masking fix implemented (opened, not merged)

**PR #38 (audit docs): MERGED** (merge commit `15f1172`). Confirmed documentation-only —
`BRAHMASTRA_MASTER_TRACKER.md` was the only file in the diff, no runtime/deployment required.

**Render masking fix — implemented on `fix/render-buy-box-status-masking`, opened as a PR, not merged.**
Fixes exactly the second half of the finding above: `scripts/process-asin-checker-jobs.ts:587` (the
Render cron's independent reimplementation of the checker logic) had the identical
`offersResult?.buy_box_status ?? 'unknown'` bug PR #36 already fixed on the Vercel side.

**Files changed (2):**
- `scripts/process-asin-checker-jobs.ts` — now imports and calls the same
  `resolveBuyBoxStatusToStore()` helper from `src/lib/amazon/buy-box-status.ts` that
  `process-next/route.ts` uses (PR #36) — **the exact same canonical helper, not a second copy of the
  logic.** Same split as the Vercel fix: `buyBoxStatusForAvailability` (unchanged, still feeds the
  local `availabilityScore()` exactly as before — Availability behavior untouched, per instruction) and
  `buyBoxStatusToStore` (the corrected value actually written to `asin_snapshots.buy_box_status`). Price
  and BSR computation (`livePrice`, `bsrValue`, and everything around them) is byte-for-byte unchanged —
  confirmed by a dedicated regression test, not just by not touching those lines.
- `scripts/test-render-buy-box-status-fix.ts` (new) — **8/8 passing**: Render rate-limited path resolves
  to `null`; confirmed `won`/`lost` still resolve correctly; a genuine ambiguous successful result is
  preserved as-is; **both files' source text is directly checked** to confirm each imports
  `resolveBuyBoxStatusToStore` from the shared lib and calls it (not a reimplementation), that neither
  file still writes the old buggy `buyBoxStatus` variable directly into `buy_box_status`, that both
  preserve the unchanged `buyBoxStatusForAvailability` split, and that neither file's Price/BSR
  expressions changed; plus an exhaustive equivalence check across every possible `BuyBoxOfferStatus`
  value.

**Checks run:** `npx tsc --noEmit` — pass. `npx eslint` on both changed files — 0 new warnings (1
pre-existing, unrelated `no-unused-vars` warning on `COOLDOWN_ACTIVE_REASON`, confirmed present before
this change too via `git stash`). Full regression: all 6 prior test suites (`test-track-asin.ts` 5/5,
`test-stuck-job-reclaim.ts` 6/6, `test-retry-or-fail-update.ts` 6/6,
`test-review-automation-permission-probe.ts` 9/9, `test-review-requests.ts` 20/20,
`test-buy-box-status-fix.ts` 13/13) plus the new suite — **67/67 total, all passing.**

**Explicitly not touched, per instruction:** queue semantics, cadence, batch size, retries, Render
settings, UI, review automation, Ads, payments, replenishment, auth/tokens, migrations, Report Reuse
Gate.

**Vercel fresh-deploy requirement — still open, not resolved by this PR.** The Render fix above closes
one of the two gaps from the prior update; the Vercel Cron-binding issue (still invoking
`dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA`, the stale pre-fix deployment, despite the production alias correctly
serving the promoted fix) is **unrelated to this PR and remains unresolved** — it needs either more
propagation time or an explicit full fresh production deploy (not a lightweight `vercel promote`), and
that decision has not been made yet.

**76 failed `my_product` rows: no action recommended (reconfirmed).** Per the completed audit above, all
76 are either already self-healing via the normal 24h enqueue cadence or genuine Amazon-side persistent
data gaps — no SQL, no reset, no code fix needed for these rows themselves.

**PR: opened, not merged, not deployed.**

### §19 update (2026-07-13) — PR #39 merged, deployed, Vercel cron-binding issue resolved and confirmed

**PR #39: MERGED** (merge commit `815cd6d`) — the Render Buy Box masking fix. Latest `master` commit
confirmed: `815cd6d`.

**Fresh Vercel production deploy triggered and verified.** `vercel promote` (used for PR #36) does not
rebuild, and the prior update found Vercel's Cron Job scheduler was still invoking a stale, pre-fix
deployment two cycles after that promote. Per instruction, triggered a genuine full production build this
time: `vercel deploy --prod` from the exact `815cd6d` commit.

**Mistake made and corrected during this step:** the first attempt ran from the wrong working directory
(`esolz-app/`, which doubled the project's configured root path) and, on retry from the repo root without
an explicit project link, Vercel auto-created and deployed to a **brand-new, incorrect project**
(`amazon-seller-toolkit-track-asin-fix`, misdetected as Flask) — **this never touched the real `esolz-app`
project or its production alias at all**, but it did leave an unwanted extra project/deployment in the
Vercel team account. Stopped immediately, removed the local (repo-only) `.vercel` linkage files, and asked
the founder how to handle it — **founder is deleting the erroneous project themselves.** Corrected the
approach by writing an explicit `.vercel/project.json` pointing at the real project ID
(`prj_B0AQXItWZSuQ2rcqYUYsABOBOEkl`) before retrying, which deployed correctly.

**Verification (read-only observation of the next natural cron cycles — no forced/manual trigger):**

1. **Fresh deployment confirmed:** `dpl_Eh8WTqut7a954johwW1BYgK5eoy2` — `state: READY`, `target:
   production`, `alias` includes `esolz-app.vercel.app`, `aliasError: null`,
   `gitCommitSha: 815cd6defa30e141bc8d97d0f83c268a6c4652fb` (exact match). A genuine full `next build` ran
   (confirmed via build log output — dependency install, TypeScript compile, static page generation — not
   a reused/promoted artifact).
2. **Vercel Cron-binding issue: confirmed resolved.** The next natural Vercel Cron cycle (04:01:11–04:01:16
   UTC, `GET /api/cron/asins/process-product-snapshots` → `enqueue` → `process-next`) now shows
   `dep=dpl_Eh8WTqut7a954johwW1BYgK5eoy2` in Vercel runtime logs — the **new** deployment, not the stale
   `dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA` from the prior update. A real fresh production deploy fixed the
   binding; a lightweight promote had not.
3. **Write-path fix confirmed live for Vercel.** Queried `asin_snapshots` for rows written after 04:00 UTC:
   **6 of 7 new rows** have `scrape_status: 'partial_pricing_rate_limited'` with `buy_box_status: null`
   (not `'unknown'`) and `availability_score: 50` (unchanged, as designed). The 7th row is a genuine
   successful Pricing call correctly preserving its real result (`buy_box_status: 'no_buybox'`,
   `scrape_status: 'success'`) — proving the fix does not over-null genuine data, exactly as intended.
4. **Render's cycle: fired, and its write-path fix is very likely also confirmed — with an honest caveat
   on attribution.** `background_jobs` shows **7 jobs completed** in this window, but Vercel's own
   `process-next` log explicitly reports `"processed": 5`. The 2 extra completions were not made by the
   Vercel route call captured in the logs — strong circumstantial evidence Render's cron (scheduled every
   4h at the top of the hour, i.e. also ~04:00 UTC) fired independently and processed 2 jobs of its own,
   consistent with the known dual-scheduler architecture (§16). **No `asin_snapshots` column identifies
   which scheduler wrote a given row, and no direct Render API/dashboard access exists in this
   environment** — so per-row attribution to Render specifically could not be made with certainty. What
   *can* be said with confidence: all 6 `partial_pricing_rate_limited` rows in this batch — regardless of
   which scheduler wrote which — show `buy_box_status: null`, none show `'unknown'`. This is strong,
   though not 100%-certain-by-row, evidence that Render's fix (PR #39) is also live and working.

**Net result: both halves of the write-path fix (Vercel binding + Render script) are now confirmed
resolved**, with the Render half resting on strong circumstantial evidence rather than direct,
row-level API confirmation (the honest limit of what's observable in this environment).

### §19 update (2026-07-14) — "Cron not configured" false-alarm fixed (opened, not merged)

**Fixes remaining follow-up #1** from the diagnosis above. Founder picked this as the next priority from
the published status board (see below).

**Root cause recap:** `suggestedAction` (`listings/route.ts:322-328`, old code) inferred "no cron exists"
from `processing === 0` at the exact instant the page's API request ran — true almost continuously by
design, since both schedulers (Vercel 2h, Render 4h) only run for a few seconds every cycle. It fired
whenever there was any backlog at all, which is the normal, expected state given current throughput.

**Fix — branch `fix/cron-status-message`, opened as a PR, not merged.** Replaced the point-in-time
heuristic with a question the data can actually answer: *has any worker touched any job recently?*
`lastAttemptedAt` (already computed — the max `updated_at`/`completed_at` across every job in the
workspace) is compared against a new `STALLED_QUEUE_HOURS = 6` constant — a generous multiple of the
slower (4h) Render cadence, chosen so a normal gap between ticks, or a deep backlog that simply hasn't
reached a given job yet, never trips a false positive. Extracted as a new pure, exported function,
`resolveSuggestedAction()`, matching this file's established testability pattern (`findConfirmedBuyBoxSnapshot`,
`buyBoxStatusLabel`, etc.).

**New messages (never "Cron not configured" again):**
- Healthy backlog, recent activity → `"Checks queued — next automatic run within a few hours"`
- Genuinely stale (no activity in >6h, including the case where nothing has ever been recorded at all)
  → `"No checks have run in over 6h — automation may be stalled"` — the one case where a real warning is
  now justified.
- `processing`, pricing-cooldown, and queue-healthy branches: **unchanged behavior**, only the previously-broken
  branch was touched.

**Files changed (2):** `src/app/api/asins/listings/route.ts` (the fix), `scripts/test-cron-status-message-fix.ts`
(new, **10/10 passing** — proves the exact real-world false-alarm scenario no longer fires (500 due-now
jobs + recent activity → healthy, not stalled), the boundary just under 6h stays healthy, just over 6h
correctly flags, a null `lastAttemptedAt` (never-run) case is correctly flagged rather than silently
ignored, `processing` still takes priority over everything, and the untouched branches (pricing cooldown,
queue healthy, no signal) are unchanged).

**Checks run:** `npx tsc --noEmit` — pass. `npx eslint` on both files — pass, zero warnings. Full
regression: all 7 prior suites (`test-track-asin.ts` 5/5, `test-stuck-job-reclaim.ts` 6/6,
`test-retry-or-fail-update.ts` 6/6, `test-review-automation-permission-probe.ts` 9/9,
`test-review-requests.ts` 20/20, `test-buy-box-status-fix.ts` 13/13, `test-render-buy-box-status-fix.ts`
8/8) plus the new suite — **77/77 total, all passing.**

**Explicitly not touched:** Availability %/Deal Tag UI (follow-ups #2/#3, untouched), cadence/batch
size/retries, review automation, Ads, payments, replenishment, auth/tokens, migrations, Report Reuse
Gate.

**PR: opened, not merged, not deployed.**

---

**Last updated:** 2026-07-12 (§16 D.9 — run_after follow-up fix opened as PR #28; §18 — standing decisions and
locked review-automation spec recorded; §16 D.10 — PR #28 three-cycle verification complete, scheduler
inventory and GET 500 `/` investigation recorded, both non-blocking; §18 update — full implementation-ready
Review Request Automation spec written as `REVIEW_REQUEST_AUTOMATION_SPEC.md`, inspection/planning only;
PR #31 merged — permission probe live, scopes confirmed sufficient; dry-run catch-up foundation
(repository/policy/script, 46/46 tests) opened as PR #34; live 3-day/10-order sample run twice (idempotency
pass), both clean, sanitized results recorded, no bug found, PR #34 still open not merged; PR #32 (migration 059, schema only)
opened, review-corrected, and merged; migration 059 applied to production Supabase (okxfwcfxxrtmijmvztdq)
and fully verified read-only (columns/constraints/indexes/RLS/trigger + synthetic insert/duplicate-reject/
isolation/updated_at/cleanup) — table exists, is empty, and nothing reads or writes it yet;
§18 update — Implementation PR #1 (permission probe) opened on `feat/review-automation-permission-probe`,
4 files, no migration/POST/env/cron, tests + tsc + eslint clean; live probe run confirms scopes sufficient
(Orders pass, Solicitations GET pass), PR #31 still open pending merge approval; **§19 new — ASIN page
live-data diagnosis: confirmed "Cron not configured" message is wrong (both crons healthy, message is a
broken point-in-time heuristic, live-verified firing right now), found a real Buy Box/Availability
data-masking bug (`'unknown'` fallback defeats the coalescing logic that correctly protects Price),
column-by-column trustworthy/misleading breakdown and an immediate fix list recorded — inspection only, no
code changed. **§19 update (later same day)** — PR #35 (diagnosis docs) merged, `3f8c599`; Buy Box masking
fix implemented (`resolveBuyBoxStatusToStore` writes null instead of 'unknown' on rate-limited pricing;
`findConfirmedBuyBoxSnapshot` coalesces only won/lost on read; 4 files, 59/59 tests total, tsc+eslint
clean), opened as a PR, not merged/deployed; 5 follow-ups (cron message, hide Availability %, hide Deal
Tag, audit 76 failed rows, 30-day catch-up still unapproved) recorded as not-yet-started. Also, PR #34
[review-request dry-run catch-up] merged earlier this session — footer above is stale on that point.
**§19 update (same day, final)** — PR #36 merged (`e6cf0449`) and **promoted to production**
(`esolz-app.vercel.app` now serves this commit, confirmed via `get_deployment`). Read-path fix verified
live against 5 real production rows exactly matching the masking scenario; `asin_snapshots` confirmed
insert-only by construction (no update/delete call site exists anywhere), so no historical row was or can
be mutated. Write-path fix not yet observable live (no new snapshot written since promotion) — pending the
next cron cycle. Next task: audit the 76 permanently-`failed` `my_product` rows.
**§19 update (audit complete)** — the 76 failed `my_product` rows need **no manual cleanup**: all are
genuine retry-exhaustion (attempt_count=3=max), all listings still exist/active, the enqueue cadence
already naturally re-attempts every one of them without any reset (17 targets already have multiple
historical failed rows proving this, 6 are already back in `queued` right now), and a directly-traced
9-attempt/18-day history for one target confirms `catalog_not_found`/`amazon_pricing_unavailable` (60 of
76) are genuine, persistent Amazon-side gaps, not a code defect. **Two significant, unresolved findings
from write-path live-observation:** (1) Vercel's Cron Job scheduler is still invoking a stale, pre-fix
deployment (`dpl_8mGnvVE7au9mLYkwTdzaKn8nLPpA`, commit `3fa72fa2`) two cycles after promotion, even
though the public production alias itself correctly serves the fix — needs a decision (wait longer, or a
full fresh deploy); (2) the Render cron script (`process-asin-checker-jobs.ts:587`) has the identical,
never-fixed bug, independent of the Vercel issue. Read-path fix remains fully effective for
already-existing rows regardless of both issues.
**§19 update (2026-07-13)** — PR #38 merged (`15f1172`, docs-only). Render masking fix implemented
(reuses the exact same `resolveBuyBoxStatusToStore()` helper as the Vercel fix — not a second copy — 2
files, 8/8 new tests, 67/67 total, tsc+eslint clean), opened as a PR, not merged. Vercel cron-binding
issue remains separately unresolved (not addressed by this PR). 76 failed-row audit conclusion
reconfirmed: no action needed.
**§19 update (2026-07-13, final)** — PR #39 merged (`815cd6d`). Fresh `vercel deploy --prod` triggered
(`dpl_Eh8WTqut7a954johwW1BYgK5eoy2`, real full build, commit-exact match, aliased to
`esolz-app.vercel.app`) after a corrected mistake (an initial wrong-directory attempt auto-created an
unrelated stray Vercel project, never touched real production, founder deleting it separately). Vercel
Cron-binding issue **confirmed resolved**: the next natural cycle's logs show the new deployment ID.
Write-path fix **confirmed live for Vercel** (6/7 new snapshots show `buy_box_status: null`, the 7th
correctly preserves a genuine real result). Render **very likely also confirmed live** (7 jobs completed
vs Vercel's own log showing only 5 processed — strong evidence of independent Render activity — all
`partial_pricing_rate_limited` rows in the batch show `null`), though row-level attribution to Render
specifically isn't possible without direct Render API access, honestly noted as a limit rather than
overclaimed.
**§19 update (2026-07-14)** — "Cron not configured" false-alarm fixed: replaced the point-in-time
`processing=0` heuristic with a `lastAttemptedAt` staleness check (6h threshold, generous over both
known cron cadences) via a new pure `resolveSuggestedAction()` function. 2 files, 10/10 new tests, 77/77
total, tsc+eslint clean. Opened as a PR, not merged. Availability %/Deal Tag UI, cadence/batch/retries,
and every other risky area untouched.)

---

## 20. Pincode Checker Product Audit (2026-07-17)

**Status: audit only, no implementation yet, needs founder approval before any fix.**

**Scope:** Static, read-only code audit of the Pincode Checker feature (all pincode-related pages, API
routes, checker-worker code, and DB tables), done in a dedicated worktree
(`C:\Vinay\amazon-seller-toolkit-pincode-cleanup`, branch `audit/pincode-checker-product-cleanup`, base
commit `43c457e`) kept deliberately separate from the review-automation reliability work (§18) — no
`review-requests` file was read or touched. Full report: `PINCODE_CHECKER_PRODUCT_AUDIT.md` at repo root.
No app code, migrations, or config changed. Every finding below was spot-checked directly against the
source before being trusted (three of the highest-stakes claims re-verified line-by-line in this session:
the dead-page redirect, the FBA/FBM hardcode, and the availability truthy-check bug — all confirmed
accurate).

### Headline finding

**Two separate, non-communicating pincode-checking systems are live at once.** The nav-linked bulk
"Pincode Checker" (`/dashboard/pincode-checker`) writes to `pincode_availability_results`, correctly
models 4 states (`available`/`unavailable`/`blocked`/`unknown`), and is the only system a seller can
intentionally navigate to — but its results feed **nothing else**: not alerts, not reports, not Sync
Health, not the dashboard KPIs. Every one of those instead reads `pincode_checks`, a table populated only
by a *third*, undocumented surface: a single-pincode widget embedded in the ASIN detail page (a second,
more built-out per-ASIN dashboard at `/dashboard/pincode` also targets `pincode_checks` but is dead —
its `layout.tsx` unconditionally redirects away before ever rendering). A seller running bulk checks gets
zero downstream credit for that work anywhere else in the product.

### P0 — actively misleading, blocks trusting this feature (2)

1. **Availability null-masking bug on the ASIN-detail widget + dashboard Recent Activity** — same bug
   class as the Buy Box status-masking bug already fixed in `b0a1c5b`/`c9ce4b3`. `pincode_checks.available`
   is correctly stored as a nullable boolean (`null` = failed/uncertain check, preserved by the write path's
   own comment: `// Preserve null from worker so uncertain checks are stored as failed/unknown, not
   unavailable`), but both render sites (`asins/[asin]/page.tsx:1145-1147,1192-1200` and
   `dashboard/page.tsx:372,374`) use a plain JS truthy check, so a worker outage/timeout/captcha block
   renders identically to a confirmed "not deliverable here" — exactly the failure mode the Buy Box fix was
   written to eliminate. The bulk Pincode Checker does not have this bug.
2. **Hardcoded `amazon_fulfilled: false` for worker-routed single checks**
   (`api/asins/[asin]/pincode/route.ts:158`) — every FBA product checked through this path is mislabeled
   FBM. A positive wrong-value claim, not just an unclear one.

### P1 — should fix soon (5): 
decide the fate of the dead `/dashboard/pincode` page and its parallel `pincode_checks` data model (or
consolidate all consumers onto one table); wire up or remove the decorative `pincode_checks_used` usage
counter and unenforced `pincode_check_limit` quota; re-enable or explicitly retire pincode alerts
(`PINCODE_ALERTS_PAUSED = true`, logic underneath is correct and already switched off); address the 80s
worker-trigger timeout vs. up-to-200×55s worst-case bulk-job duration mismatch (no retry/resume path for a
stuck job); de-duplicate `cleanDeliveryMessage()` (copy-pasted identically in 3 files).

### P2 — polish (4): 
surface `seller_name` in the bulk checker's on-screen table (already captured, only missing from CSV-only
export); make the bulk checker's Buy Box/Price columns status-aware for blocked/unknown rows; quarantine
or delete the unused `MOCK_PINCODE_RESULTS` fake dataset sitting in the same file as still-used utilities;
add a staleness indicator to the bulk checker (has none today, unlike the ASIN-detail widget and Sync
Health); add responsive column hiding to the bulk checker's results table.

**Totals: 2 P0, 5 P1, 4 P2.** Full evidence, file/line citations, and CONFIRMED/INFERRED/UNKNOWN tags for
every claim in `PINCODE_CHECKER_PRODUCT_AUDIT.md`.

**Next step (needs the founder):** review the audit and the docs-only PR; decide which P0/P1/P2 items to
approve for implementation. No fix has been made or proposed as code in this round — audit only.

### §20 update (2026-07-17, later) — PR #46 merged; both P0 bugs fixed, opened as a PR

**PR #46 (the audit above) merged** to `master` as `1a4188e` (standard merge commit). Approved next step:
implement only the 2 confirmed P0 correctness bugs; P1/P2 remain explicitly deferred.

**New clean worktree:** `C:\Vinay\amazon-seller-toolkit-pincode-p0-fix`, branch
`fix/pincode-checker-truth-correctness`, created fresh from latest `origin/master` (`1a4188e`) — the audit
branch was not reused, the dirty `intern/asins-page-work` checkout was not touched.

**P0-1 fixed — availability null-masking.** New shared, pure helper `src/lib/pincode-status.ts`:
`classifyPincodeAvailability(available, deliveryPromise)` returns one of 4 states —
`available` / `unavailable` / `failed` / `not_confirmed` — never collapsing `null` into `unavailable`.
`failed` vs `not_confirmed` is distinguished by the existing `"Check failed:"` marker text
`insertFailedCheck()` already writes on a thrown-exception failure (the only structured-enough signal the
current schema offers without a migration — both a hard failure and an uncertain-but-not-thrown worker
response store `available: null`). `getPincodeAvailabilityDisplay()` wraps this with the seller-facing
label/tone (`Available`/`Unavailable`/`Check failed`/`Not confirmed`). Applied to all 3 render sites the
audit identified:
- ASIN-detail widget's Latest Check summary (`asins/[asin]/page.tsx`)
- ASIN-detail widget's Recent Checks history table (same file) — the check/X icon column now shows a
  neutral `HelpCircle` icon for `failed`/`not_confirmed` instead of forcing green-check-or-red-X
- Dashboard Recent Activity (`dashboard/page.tsx`) — its `pincode_checks` query was extended to also select
  `delivery_promise` (previously omitted), so the same 4-state classifier can be used there with full
  fidelity, not a degraded 3-state version

**P0-2 fixed — FBA/FBM hardcode.** `api/asins/[asin]/pincode/route.ts`: the worker-routed branch now writes
`amazon_fulfilled: null` instead of a hardcoded `false` — confirmed via `PincodeResponse`
(`checker-worker-client.ts`) that the worker path has **no fulfillment signal at all**, so `null` is the
only honest value, not a guess. The downstream `fulfillmentType` derivation changed from a truthy check to
an explicit three-way `=== true ? 'FBA' : === false ? 'FBM' : null`. The dev-only local Python path
(`checkPincode()`/`amazon-pincode-adapter.ts`) genuinely does return a real `amazon_fulfilled: boolean`
signal and was left untouched — the bug was specific to the worker path. New
`getFulfillmentDisplay()` helper renders `fulfillment_type = null` as `"Not confirmed"` instead of the
previous `'—'` (which was ambiguous — could have meant "confirmed FBM" to a careless reader) or a bare
falsy-guessed `'FBM'`.

**No migration.** `pincode_checks.fulfillment_type` (TEXT) and `.available` (BOOLEAN) are both already
nullable with no CHECK constraint restricting values (confirmed via `supabase/migrations/001_initial_schema.sql`
and a repo-wide grep finding no later migration touches either column) — `null` was always a valid value
for both, just never correctly rendered as "not confirmed" until now.

**Explicitly not touched, per instruction:** `pincode_availability_results` (the bulk checker's table);
the dead `/dashboard/pincode` legacy page (not revived); `PINCODE_ALERTS_PAUSED` (still `true`, alerts not
re-enabled); billing/quota code; queue/worker runtime infrastructure, cadence, or Amazon auth/tokens; any
`review-requests` file (confirmed via diff scope — exactly 5 files changed, all pincode-specific).
Buy Box "Detected" wording left unchanged, as instructed (not a direct correctness regression on its own).

**Tests: 115/115 passing** across all 11 suites (10 pre-existing unchanged + 1 new,
`test-pincode-status.ts`, 11/11, covering all 13 required cases: confirmed available/unavailable, unknown
vs failed distinction, missing availability never renders unavailable, confirmed FBA/FBM, missing
fulfillment never renders FBM, a source-level regression guard confirming the route no longer contains the
old hardcoded-false pattern, a source-level guard confirming both renderers import the shared helper and
no longer contain the old raw-truthy-check patterns, and totality checks). `npx tsc --noEmit` clean,
`eslint` clean on every new/changed file (pre-existing lint issues found elsewhere in the two large touched
files are outside this diff's hunks, confirmed via `git diff` line-range comparison — not introduced by
this change). `npm run build` clean.

**Visual verification: not performed, honestly reported rather than fabricated.** This worktree has no
`.env.local` / Supabase credentials configured, and none were pulled from production for this purpose
(consistent with this project's standing discipline against unnecessary secret handling) — a real
`npm run dev` session with authenticated, seeded `pincode_checks` rows covering all 6 states was not
achievable in this environment. Verification instead relies on: a clean type-check and build (no
render-breaking errors), and unit tests that assert the exact label/tone-class string produced for every
input state — the same values the JSX now renders directly, with the specific old buggy patterns confirmed
absent via source-level regression-guard tests. Live browser visual verification remains a gap; the
founder or a session with real credentials can close it before/at merge time.

**Opened as a PR from `fix/pincode-checker-truth-correctness`, not merged, not deployed.**

**Next step (needs the founder):** review the PR; ideally close the visual-verification gap (real
`npm run dev` + login) before merging, given this is user-facing rendering logic. P1/P2 items from the
audit remain deferred, not part of this PR.

### §20 update (2026-07-17, final) — PR #48 merged, deployed, production visual verification attempted: GREEN

**PR #48 merged** to `master` as `b7ee9e7` (standard merge commit). Confirmed: exactly the expected 7
files changed, no migration, no `review-requests` file touched. Fresh `vercel deploy --prod` run from the
repo root of a linked worktree (`C:\Vinay\amazon-seller-toolkit-pincode-p0-fix`) — production deployment
`dpl_5VfcVZsca7pgkcCm3i4W1BNrZcYk` confirmed via Vercel MCP `get_deployment`: commit `b7ee9e7...` exact
match, `target: "production"`, aliased to `esolz-app.vercel.app`.

**Production visual verification, with an authenticated session (`test2026@sociomonkey.com`, the
documented internal test account — see sec15) provided later in the same session:**

- Confirmed via read-only Supabase queries that real historical `pincode_checks` rows exist covering
  `available=true`, `available=false`, `available=null` with the `"Check failed:"` marker, and
  `available=null` without it — 6 of 7 target states have real backing data somewhere in the database.
  Zero rows anywhere have `fulfillment_type='FBA'` (expected — the pre-fix worker path could never have
  written one).
- **However, none of that data is reachable through the authenticated account's own workspace view.** All
  55 EasyHOME-workspace `pincode_checks` rows join to `tracked_asins` rows with `status='archived'` — the
  ASIN detail page 404s ("ASIN not found") for an archived ASIN regardless of pincode history, a
  pre-existing, unrelated behavior (not part of this fix). The remaining 2 rows belong to a completely
  different, inaccessible workspace. Confirmed directly navigating to two real archived ASINs (masked in
  this record) both correctly 404'd, not crashed.
- **The authenticated account's own UI independently corroborates zero reachable data**: the dashboard KPI
  card reads "Pincode Checks: 0 used this month," and the Recent Activity feed shows zero pincode-related
  entries (only Buy Box and Keyword Rank events) — consistent with the DB-level finding, from a completely
  separate code path (a strong cross-check, not just my own SQL query).
- Per instruction, no synthetic pincode check was created, no bulk/manual check was triggered, and no
  database row was modified to manufacture a state — the gap is reported honestly rather than worked
  around.
- **What was confirmed clean:** the ASIN Tracking list page, the ASIN-detail 404 page (for archived ASINs),
  and the Dashboard Overview page (including its Recent Activity feed) all rendered correctly with no
  console errors, no runtime errors, and no broken layout on the live production deployment running the new
  code.

**Classification: GREEN.** No regression found — every page that could be reached rendered correctly and
error-free. The 7 target pincode states were not reachable with existing production data through this
account and were not visually confirmed; per standing instruction this does not block the classification,
since the underlying logic was already proven via 11/11 targeted unit tests asserting the exact rendered
string for every state, and no code was changed as a result of this verification pass.

**PR #48 and production are unchanged by this update — docs only.** Opened as a small docs-only PR from
`docs/pincode-p0-production-verification` (off latest master, not reusing the implementation or audit
branch). Not merged.

**Pincode Checker P0 workstream closed for now.** P1/P2 items from the audit (sec20 above) remain
deferred, not scheduled.

---

## 21. Keywords Tab Product Audit (2026-07-17)

**Status: audit only, no implementation yet, needs founder approval before any fix.** Drafted by a
background research agent, then **independently re-verified in the main session against source before
being trusted or committed** — 8+ of the highest-stakes claims (the P0 and its full causal chain, the
organic/sponsored separation, the decorative category dropdown, Ads-search-term isolation, the
never-shown-as-zero rank pattern, `mock-keywords.ts`'s dead-code status, the real `category` TEXT columns,
and the absence of any category-taxonomy table) were each re-read directly against source/migrations and
confirmed accurate. **Zero corrections were needed to the agent's draft.** New worktree
`C:\Vinay\amazon-seller-toolkit-keywords-audit`, branch `audit/keywords-tab-product-cleanup`, off latest
master. `review-requests` and `pincode` code untouched, per instructions. Full detail in
`KEYWORDS_TAB_PRODUCT_AUDIT.md` (665+ lines, sections A-G, every claim tagged CONFIRMED/INFERRED/UNKNOWN).

**Scope:** Full audit of the Keywords tab (`/dashboard/keywords`), its 2 rank-check API routes and 2
track/research API routes, the ASIN-detail page's Keyword Rank Snapshot widget, the checker-worker
keyword-rank checker, keyword-related Sync Health and alerts, and the boundary with Brand Analytics Search
Terms / Amazon Ads search-term data.

**Headline finding:** architecturally sounder than the Pincode audit — the three keyword-tracking surfaces
share the same two tables (`tracked_keywords`, `keyword_rank_snapshots`) consistently, not fragmented data
models. Organic and sponsored rank are cleanly separated everywhere (migration 022), no missing-rank-
shown-as-0 bug exists anywhere checked, no fabricated volume/CPC/difficulty is ever presented as fact, and
Amazon Ads search-term data never leaks into this page (confirmed siloed in both directions by direct
grep). The Keyword Research section's Category dropdown is fully decorative (sent to the API, never read
server-side) and populated with generic demo categories (grocery/health/kitchen/sports) unrelated to
EasyHOME's actual catalog.

**The one confirmed P0:** the ASIN-detail page's `KeywordsTable` "Found" column
(`asins/[asin]/page.tsx:245-254`) checks for `never_checked` and `failed` scrape statuses but omits
`checker_unavailable`, so a failed/unattempted rank check falls through to `kw.found ? Found : Not found`
and renders the factual claim **"Not found"** — even though the write path
(`asins/[asin]/keywords/refresh/route.ts`'s `insertFailedSnapshot`) always sets `found: false` on a
checker-unavailable snapshot, guaranteeing this false render. The adjacent Status column on the same row
(`:259-264`) correctly checks `checker_unavailable` and shows "Checker not connected" — the correct
information exists on the row, just not in the column a seller would most naturally read first. Same bug
class already found and fixed for Pincode/Buy Box, here narrower and partially self-mitigated by the
neighboring column.

**Counts: P0: 1. P1: 10. P2: 4. Deferred (new paid API/data source required): 3.**

**Category experience vs. the founder's stated direction (view all Amazon categories, multi-select, group
keywords category-wise, bulk-select, then filter product-wise):** no Amazon category taxonomy source
exists anywhere in this codebase today (confirmed: no browse-node/category-tree table in any migration).
"All Amazon categories" would require PA-API BrowseNodes or a paid third-party taxonomy feed — both
excluded by this tracker's standing "no new paid API for MVP" rule (sec1). A narrower, honest V1 is
buildable today with real data: group the seller's own tracked products by their existing
`tracked_asins.category`/`competitor_asins.category` TEXT field, explicitly labeled "Your product
categories," never "Amazon categories."

**Recommended Keywords V1 (5 conceptually separate areas, per the founder's own instruction not to merge
sources/meanings into one table):** Keyword Discovery (autocomplete only, honestly labeled, category
filter removed or rewired to real tracked-category data); My Tracked Keywords (existing core, keep, but
close the orphan-keyword dead end and stop blending "Average Organic Rank" across dissimilar keywords);
Organic Rank (existing trend chart/history, add a third "Checker unavailable" label to the Check History
table); Advertising Search Terms (do not merge into this page — add a clearly-labeled cross-link to the
existing, separate Brand Analytics Search Terms page instead); Category Opportunities (V1 scoped to "your
product categories" only, using real data, with true Amazon-wide category browsing explicitly deferred).

**Recommended first implementation scope (smallest safe, not implemented):** fix only the one P0 — add the
missing `scrape_status === 'checker_unavailable'` branch to `asins/[asin]/page.tsx`'s `KeywordsTable`
"Found" column, mirroring the exact pattern the main Keywords tab's `FoundStatusBadge` already uses
correctly. Single file, single render branch, precedented elsewhere in this same codebase. Every P1/P2
item (dead-code removal, the decorative dropdown, the orphan-keyword workflow decision, the Advertising
Search Terms cross-link, etc.) is a separate, independently-approvable decision and should not be bundled
with the P0 fix — matching exactly how the Pincode P0 fix was scoped and shipped separately from its
P1/P2 findings (sec20).

**Next step (needs the founder):** review the audit and the docs-only PR; decide whether to approve the
single P0 fix (same small, low-risk shape as the Pincode P0 fixes) and which P1/P2 items, if any, to
schedule separately. No fix has been made or proposed as code in this round — audit only.

### §21 update (2026-07-17, later) — PR #50 merged; the one confirmed P0 fixed, opened as a PR

**PR #50 (the audit above) merged** to `master` as `609311a` (standard merge commit). Approved scope:
implement only the one confirmed P0; nothing else from the audit.

**New clean worktree:** `C:\Vinay\amazon-seller-toolkit-keywords-p0-fix`, branch
`fix/keywords-checker-unavailable-truth`, created fresh from latest `origin/master` (`609311a`) — the
audit branch was not reused.

**P0 fixed.** New pure, independently-testable helper `src/lib/keyword-found-status.ts`:
`classifyKeywordFound({scrape_status, found})` returns one of 4 seller-facing states —
`found` / `not_found` / `check_unavailable` / `not_confirmed` — mirroring the *state meaning* the main
Keywords tab's `FoundStatusBadge` already used correctly (that component was left untouched — it had no
bug). Applied to the single confirmed defect site: `asins/[asin]/page.tsx`'s `KeywordsTable` "Found"
column (previously fell through to `kw.found ? Found : Not found` whenever `scrape_status` was
`checker_unavailable`, rendering a check the system never completed as the factual claim "Not found").
Seller-facing labels: **Found**, **Not found**, **Check unavailable**, **Not confirmed** — the last two
intentionally reuse "Not confirmed" terminology already established by the Pincode P0 fix (sec20), for
cross-feature consistency.

**Scope discipline confirmed:** the adjacent "Status" column on the same row (which already correctly
showed "Checker not connected" for `checker_unavailable`/`failed`) was left untouched — fixing it wasn't
broken. The main Keywords tab (`keywords/page.tsx`) was not modified at all. No rank-checker, worker,
Ads sync, Pincode, or review-requests file was touched (test-verified, see below). No migration —
`keyword_rank_snapshots.scrape_status`/`.found` were already the correct nullable/boolean shape.

**Tests: 126/126 passing** across all 12 suites (11 pre-existing unchanged + 1 new,
`test-keyword-found-status.ts`, 11/11, covering: confirmed found/not-found, `checker_unavailable` and
`failed` both correctly render "Check unavailable" and never the false-negative "Not found", never-checked
renders "Not confirmed", totality over every status×found combination, a source-level regression guard
confirming rank is never rendered via a `|| 0` truthy-coercion pattern on either the ASIN-detail widget or
the main tab, confirmation organic/sponsored rank are never combined on the main tab, confirmation the
ASIN-detail widget has no sponsored-rank field to combine in the first place, and a scope guard confirming
no Ads/Pincode/review-requests/rank-checker file was touched). `npx tsc --noEmit` clean, `eslint` clean on
every new/changed file (pre-existing issues elsewhere in the large touched file confirmed via `git diff`
hunk comparison to be outside this diff, not introduced). `npm run build` clean.

**Opened as a PR from `fix/keywords-checker-unavailable-truth`, not merged, not deployed.**

**Next step (needs the founder):** review the PR; once merged, a production deploy + verification would
follow the same pattern as the Pincode P0 work (fresh `vercel deploy --prod` from the repo root, then a
production visual/data check), pending approval at each step. P1/P2 items from the audit remain deferred.
