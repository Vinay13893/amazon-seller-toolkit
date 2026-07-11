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

### Merged but not yet confirmed live

#### PR #15 — Cron base URL loud-failure fix

- **Merge commit:** `1e829b6`
- **Deployment:** `dpl_9HvE25HKZr4fSRnZ44py6VRGxUgL`
- **Build state:** READY
- **Production promotion:** Pending
- **Environment variable:** `APP_BASE_URL=https://esolz-app.vercel.app` reported as set in Vercel Production

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

**Status:** Pending  
**Why it blocks later work:** Price, BSR, and Buy Box freshness depend on the ASIN snapshot pipeline. The current queue has been stuck because the cron's internal calls did not reach the handlers.

### Required actions

1. Promote deployment `dpl_9HvE25HKZr4fSRnZ44py6VRGxUgL`.
2. Verify production points to commit `1e829b6`.
3. Wait for the next scheduled cron run.
4. Confirm logs show calls to:
   - `/api/asins/jobs/enqueue`
   - `/api/asins/jobs/process-next`
5. Confirm new `asin_snapshots` rows appear.
6. Confirm the queued `background_jobs` count starts falling.
7. Confirm the cron no longer returns `{ ok: true, enqueue: null, process: null }`.

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
- PR #15: merged cron base URL loud-failure fix; production promotion pending
- Product strategy and trust-readiness architecture completed

---

## 13. Exact Next Action

### Next task now

**Promote PR #15 deployment and verify the next cron run.**

Use deployment:

`dpl_9HvE25HKZr4fSRnZ44py6VRGxUgL`

Expected production commit:

`1e829b6`

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

**Last updated:** 2026-07-11
