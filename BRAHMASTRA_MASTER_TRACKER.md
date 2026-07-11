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

### Cheapest safe fix (proposed — still not implemented; SQL still not run, per instruction)

1. **Surgical, immediate (still recommended, still not run):** a one-time `UPDATE background_jobs SET
   status='failed', locked_at=NULL, locked_by=NULL WHERE job_type='product_page_snapshot' AND status='running'
   AND locked_by='render-cron' AND locked_at < now() - interval '1 hour'` — now that D.4 confirms Render's own
   reclaim isn't going to clear these on its own, this is the only mechanism that will actually unstick the 10
   rows. Still not executed this round, per explicit instruction.
2. **Code-level fix (root cause, now precisely identified):** add a result/error check to
   `cleanupStuckJobs()`'s per-row `.update(...)` call in `esolz-app/scripts/process-asin-checker-jobs.ts` so a
   failed reclaim write is surfaced instead of silently counted as a success — this is a real, narrow bug fix,
   not a redeploy or config change (Render is already confirmed current on `master`). Not implemented this
   round.
3. **Longer-term:** unchanged — decide whether to keep both workers or consolidate; informed by D.3's finding
   that Vercel-alone theoretical capacity already exceeds today's real combined throughput.

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

---

**Last updated:** 2026-07-11
