# Pincode Checker — Unified Page Implementation Plan

**Status:** Plan only. No code, no migration, no deployment in this round.
**Companion:** `PINCODE_UNIFIED_PAGE_PRODUCT_SPEC.md`, `PINCODE_UNIFIED_PAGE_DATA_MODEL.md`.

---

## 1. The trade-off the founder decisions force — flagged explicitly, not silently resolved

Founder decision #8 states plainly: **"Recurring standing tracking IS in V1 scope, not just manual-check
history."** That is not a phasing suggestion, it's a locked product requirement.

A naive phasing instinct (mine included, on a first pass) is to treat "the scheduler" as inherently a P1 —
ship the manual-check UI and enrollment flow first, add automation later. **That instinct is wrong given
decision #8 and must not be followed.** If the unified page ships with only a manual "Check Now" button and
no recurring engine, it does not deliver the product decision #8 actually locked — it delivers a
different, smaller product (an ad-hoc checker) wearing the unified page's UI. A seller who enrolls a
product expecting standing tracking, and instead gets a page that silently never checks again unless they
click a button, is a worse outcome than not shipping the page at all — it is a false promise embedded in
the UI itself (the enrollment flow, tracker table, and "last checked" columns all visually imply ongoing
tracking is happening).

**Resolution: a minimal, correctly-bounded recurring scheduler moves into P0.** Not the full scheduler
surface (no adaptive cadence, no per-plan tiering, no admin monitoring dashboard — those stay P1/P2), but
the core loop that makes "recurring" true: claim due targets, check them, write results, compute the next
`next_check_at`, retry with backoff, self-heal stale claims. This is the same bounded-scope discipline
already proven in this codebase's review-requests split (`order-ingestion.ts` +
`eligibility-processor.ts`) — a full-featured version was not required to be correct and safe, a
minimal, budget-respecting, idempotent version was required, and extra sophistication was deferred without
weakening the core promise.

**What stays out of P0 despite this:** manual "Check Now" priority queueing (P0 can serve Check Now through
the same claim path as scheduled checks, just synchronously triggered — a separate priority lane is a P1
refinement, not a correctness requirement), per-workspace configurable cadence (P0 ships one fixed default
cadence, configurable cadence is P1), and the Data-Health/monitoring dashboard integration (P1 — the
scheduler must be observable via logs/DB queries in P0, a dashboard is a separate consumer of that same
data).

---

## 2. Scheduler design

Modeled directly on `background_jobs` (migration `034`) for the claim/lock shape and on
`review-requests/eligibility-processor.ts` (this session's own shipped code) for the bounded-runtime +
stale-reclaim discipline. Operates on `pincode_tracking_targets` directly — no separate job-queue table;
the target row *is* the job, exactly as `review_solicitation_orders` rows are their own job (no separate
queue table was introduced for that worker either, and it has run cleanly in production).

### 2.1 Cadence
Fixed default: **24 hours** per target in P0 (`pincode_tracking_targets.cadence_hours` column exists from
day one per the Data Model, but the UI only exposes changing it starting P1 — P0 always writes `24`).
`next_check_at` is computed as `checked_at + (cadence_hours || '1 hour')::interval`, never derived by
re-adding to `now()` (avoids compounding drift if a cycle runs late).

### 2.2 Batch size and concurrency
Reuses the exact numbers already proven safe in this codebase for scraping-style work
(`REVIEW_REQUESTS_INGEST_CONCURRENCY`, default 8) rather than inventing new ones: **batch size 40 claimed
targets per cron invocation, concurrency 8** (`PINCODE_SCHEDULER_CONCURRENCY`, env-overridable, same
pattern as the review-requests workers). Pincode checks are itself an external-scrape operation (Amazon
storefront pincode lookup), same risk profile as the review-requests ASIN/order API calls that this
concurrency figure was already tuned for.

### 2.3 Timeout / runtime budget
**`PINCODE_SCHEDULER_RUNTIME_BUDGET_MS`, default 220000** (220s) — identical to
`REVIEW_REQUESTS_INGEST_RUNTIME_BUDGET_MS`/`..._PROCESS_RUNTIME_BUDGET_MS`, deliberately kept under
Vercel's known ~280s hard function ceiling (the same ceiling this codebase already hit and fixed once for
review-requests — no reason to re-discover it here). Budget is checked **before** claiming the next unit
of work, never mid-check, so a check that's already in flight always finishes and is never left in
`'checking'` by a budget cutoff (it can only be left `'checking'` by an actual crash/timeout, which is
exactly what stale-claim reclaim exists for).

### 2.4 Stale job reclaim
Before claiming new targets, the worker runs one reclaim pass: any `pincode_tracking_targets` row with
`status = 'checking'` and `updated_at` older than a threshold (`PINCODE_SCHEDULER_STALE_CLAIM_MINUTES`,
default 15 — long enough that no legitimate single pincode check should still be running, short enough that
a genuinely crashed claim doesn't block that target for hours) is reset to `status = 'active'`. This is a
plain `UPDATE ... WHERE status = 'checking' AND updated_at < now() - interval '15 minutes'`, relying on the
same `updated_at`-bumps-on-every-UPDATE trigger already used for `review_solicitation_orders` reclaim — no
new trigger needed, the pattern is proven.

### 2.5 Retry policy
`consecutive_failures` increments on any failed check (network error, unexpected response shape, timeout —
**not** a successful check that resolves to `unavailable`, which is a valid result, not a failure).
Threshold: **`PINCODE_SCHEDULER_MAX_CONSECUTIVE_FAILURES`, default 5**. On exceeding it, the target's
`status` moves to `'failed'` (a real, seller-visible state per the Data Model — the tracker table must
render this, not hide it) and `next_check_at` is cleared (so the due-index simply excludes it — a
`'failed'` target is not `'active'`, so it was never actually eligible via the partial index's `WHERE
status = 'active'` predicate in the first place; setting `next_check_at = NULL` is defense-in-depth in case
a future refactor loosens that predicate). Between failures (not yet at threshold), a **fixed** retry delay
is used for P0, not exponential backoff: `next_check_at = now() + cadence_hours` (i.e., just fold into the
normal cadence rather than a separate retry-interval concept) — simpler, and this codebase's own
`review_solicitation_orders` retry logic (migration 059) also does not use exponential backoff, it uses a
flat next-attempt delay. Exponential backoff is a reasonable P1 refinement, not a P0 requirement.

### 2.6 CAPTCHA / blocked-state handling
The existing `pincode_availability_results.availability_status` already has a `'blocked'` value (confirmed
in the Data Model's index research — this state already exists in the current schema, it is not new). A
check that detects a CAPTCHA/block response writes `availability_status = 'blocked'` (an honest result, not
a failure) and does **not** increment `consecutive_failures` — being blocked is not the target's fault and
retrying immediately would likely just get blocked again. Instead: `next_check_at` is pushed out further
than normal cadence on a block (`now() + cadence_hours * 2`, a simple fixed multiplier — full adaptive
backoff is P1) to naturally cool down without a separate state machine.

### 2.7 Partial completion / idempotency
Every check write is a plain `INSERT` into `pincode_availability_results` (append-only, never an upsert) —
idempotent in the sense that re-running a check for the same target twice just produces two honest history
rows, never corrupts state. The target's own `last_checked_at`/`next_check_at`/`status` update is the only
mutable state, and it's always a last-write-wins single-row `UPDATE` keyed by the target's own `id` — safe
under the claim/finalize pattern because only the worker holding the claim (`status = 'checking'`) performs
that update. If the worker crashes between the `INSERT` and the target `UPDATE`, the history row is real and
correct, and the stale-claim reclaim (§2.4) picks the target back up on the next cycle — worst case is one
extra check earlier than the ideal cadence, never a lost or corrupted result. Cycle-level partial completion
follows the exact reporting discipline from `eligibility-processor.ts`: `targetsClaimed`,
`targetsCompleted` (only incremented after the `INSERT` + `UPDATE` both confirm), `staleClaimsReclaimed`,
`stoppedDueToRuntimeBudget` — honest, never silently swallowed.

### 2.8 `next_check_at` selection / due-work query
```sql
SELECT id FROM pincode_tracking_targets
WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= now()
ORDER BY next_check_at ASC
LIMIT 40
FOR UPDATE SKIP LOCKED;
```
`FOR UPDATE SKIP LOCKED` (not a manual `claimed_by` token compare-and-swap) is the simpler, Postgres-native
claim primitive and is safe for this worker's single-cron-invocation-at-a-time deployment model — matches
what `background_jobs`' claim index is designed to support efficiently. Immediately after the `SELECT`,
the same transaction sets `status = 'checking'`, `claimed_at = now()`, `claimed_by = <invocation id>` before
committing, so a concurrent invocation (if the cron ever double-fires) cannot double-claim the same rows.

### 2.9 Per-workspace limits
P0 ships a single hard cap: **`PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_PER_CYCLE`, default 200** —
prevents one workspace with a very large enrolled-product×pincode matrix from starving every other
workspace's due checks in a single cycle. Implemented as a simple per-workspace counter inside the batch
loop (skip claiming further targets for a workspace once its 200 is hit this cycle; they simply remain due
and get picked up next cycle). Full quota-tiering by plan is explicitly P1 (ties into "shared tracking
quota," decision #6, which the Product Spec already flags as needing its own limit-enforcement design at
enrollment time, separate from this per-cycle scheduler cap).

### 2.10 Manual "Check Now" priority
P0: a Check Now click performs a direct, synchronous claim-and-check of that **one** target (same
claim/finalize function the scheduler uses, just invoked with `target_id` instead of a batch query) —
correct and safe, but not prioritized over the background scheduler in any special queue sense because
there is no queue to prioritize against; it competes for the same rate limit only in the sense that both go
through the same "is this ASIN/pincode pair currently blocked/backed-off" check (§2.6). Rate-limited per
decision #7 ("rate-limited/queued manual Check Now") via a simple per-workspace cooldown: reject (with a
clear "try again in N seconds" response) a Check Now if that same target was checked within the last
`PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS` (default 60). A true priority queue with visible position ("3rd in
queue") is a P1 UX enhancement — P0's synchronous-with-cooldown approach satisfies "rate-limited," the
"queued" visual affordance is deferred.

### 2.11 Duplicate-check protection
The `pincode_tracking_targets_uidx UNIQUE (monitored_product_id, pincode)` constraint (Data Model §3)
already makes a duplicate *target* structurally impossible. Duplicate *simultaneous checks* of the same
target are prevented by the claim step itself (§2.8) — a target already `status = 'checking'` is invisible
to both the scheduler's due-query (`WHERE status = 'active'`) and a concurrent Check Now click (which
should check current status first and reject with "check already in progress" rather than double-claiming).

### 2.12 Batch splitting
Not needed as a separate mechanism in P0 — the per-cycle batch size (40, §2.2) combined with cron frequency
(hourly, so a backlog drains within a few cycles even at max concurrency) is the batch-splitting mechanism.
A dedicated backlog-drain accelerator (matching the review-requests "no longer wait 4 hours after a failed
cycle" pattern this session applied operationally) is available as an operational tool if backlog ever
grows unexpectedly, without needing new code — the same worker can simply be invoked again immediately.

### 2.13 Monitoring
P0 requirement (not P1): the cycle summary (targetsClaimed/Completed/Failed/staleClaimsReclaimed/
stoppedDueToRuntimeBudget) must be logged in a structured, greppable form on every invocation, exactly like
the review-requests workers already do — this is what let this session verify 3 consecutive production
cron cycles for that feature without any dashboard. A Data-Health dashboard *card* surfacing this is P1;
the underlying observability is P0 because shipping a scheduler with zero visibility into whether it's
actually running would repeat exactly the kind of silent-failure risk this whole audit-first methodology
exists to prevent.

### 2.14 Cron wiring
Two new `vercel.json` cron entries, following the existing two-entry review-requests precedent exactly:
- `/api/cron/pincode/scheduler` — runs the due-check batch (§2.1–2.12). Suggested cadence: hourly
  (`0 * * * *`) — frequent enough that a 24h-cadence target is never more than ~1h late, infrequent enough
  to stay well within any reasonable invocation budget.
- No second cron entry is needed for reconciliation (§`DATA_MODEL.md` §5's archived-product cascade) — it
  runs as a cheap pre-step inside the same scheduler invocation, not a separate cron, since it only needs to
  run about as often as the scheduler itself already does.

---

## 3. Phasing

### P0 — must ship together, this is the minimum that honors the 13 locked decisions
1. Migration: `workspace_default_pincodes`, `pincode_monitored_products`, `pincode_tracking_targets` + RLS
   (`DATA_MODEL.md` §1–3, §6).
2. Migration: `pincode_availability_results.monitored_product_id` additive column + index
   (`DATA_MODEL.md` §4).
3. Route `/dashboard/pincode-checker` + nav item + legacy redirect confirmation (`PRODUCT_SPEC.md` §4).
4. My Products tab: list from `amazon_listing_items`, bulk-enroll into `pincode_monitored_products` +
   `pincode_tracking_targets` (`PRODUCT_SPEC.md` §5.1).
5. Other Products tab: single-ASIN enrollment flow, duplicate-prevention against My Products
   (`PRODUCT_SPEC.md` §5.2) — **using the existing `AddAsinDialog`-style manual entry, not a real SP-API
   catalog lookup** (§4 below flags this explicitly as a P0/P1 boundary, separate from the scheduler
   trade-off).
6. Pincode Settings panel: `workspace_default_pincodes` CRUD (`PRODUCT_SPEC.md` §5.3).
7. Tracker table: product→pincode expansion, all state renders (`PRODUCT_SPEC.md` §7–8).
8. **Minimal recurring scheduler** (§2 of this document, all subsections) — per the trade-off resolution in
   §1, this is P0, not deferred.
9. Manual Check Now (synchronous claim path, §2.10, with cooldown).
10. Archived-product cascade reconciliation (`DATA_MODEL.md` §5).

### P1 — real but not blocking the core promise
- Per-workspace configurable cadence (schema already supports it, §2.1).
- SP-API-backed catalog lookup replacing manual ASIN entry for Other Products (`PRODUCT_SPEC.md` §6 flags
  the exact helper as unconfirmed — this needs its own short research pass before implementation, separate
  from this spec round).
- Exponential backoff on retry (§2.5) and adaptive backoff on block detection (§2.6).
- True priority/visible-position queue for Check Now (§2.10).
- Full quota-tiering by plan for shared tracking quota (decision #6).
- Data-Health dashboard card surfacing scheduler cycle summaries (§2.13).
- CSV/export of tracker table.

### P2
- Alerts (explicitly stays disabled per decision #13 — this is a "someday," not scheduled).
- Historical trend charts per product×pincode.
- Bulk pincode-set templates (e.g., "top 20 metro pincodes") beyond the flat default-pincode list.

---

## 4. A second, separate flag: Other Products lookup path is not a scheduler problem

Distinct from §1's trade-off: `PRODUCT_SPEC.md` §6 already noted that the current `AddAsinDialog`/
`addTrackedAsin` path does not perform a real SP-API catalog lookup, and that the exact helper function for
a real lookup was **not verified** in the research pass. This is called out again here because it affects
P0 scope directly — P0's Other Products enrollment (§3 item 5) ships with manual ASIN-entry-and-trust (the
seller types an ASIN, the system does not verify it resolves to a real product before creating the
enrollment row), which is an honest, shippable P0 experience (matches today's existing `tracked_asins`
add-flow) but is explicitly weaker than a "search and confirm" experience. This is a UX gap, not a
correctness/data-integrity gap (the `pincode_monitored_products` row is still valid schema-wise even if the
ASIN turns out to be wrong — the seller just sees checks fail or the product/title snapshot never
populate), so it does not carry the same "must move to P0" force as the scheduler does.

---

## 5. Test plan

- **Unit-level (scripts/*.ts convention, matches `test-keyword-found-status.ts` / `test-pincode-status.ts`
  precedent):**
  - `classifyPincodeAvailability`/`classifyFulfillment` reuse — no new tests needed, already covered.
  - New: scheduler pure-logic tests — `next_check_at` computation (normal, retry, blocked-cooldown paths),
    `consecutive_failures` threshold transition to `'failed'`, due-query predicate correctness (mock rows
    covering every status × next_check_at combination, assert exactly the expected subset is "due").
  - New: `pincode_monitored_products` enrollment dedup logic (My Products bulk-enroll skips ASINs already
    enrolled; Other Products rejects an ASIN that's already in My Products, per `PRODUCT_SPEC.md` §5.2).
- **Integration (against a scratch/staging Supabase branch, never production):**
  - Full claim → check → finalize cycle with a mocked/stubbed pincode-check function (no real Amazon
    scraping in CI) — assert exactly one `pincode_availability_results` row per check, correct
    `next_check_at` afterward.
  - Stale-claim reclaim: manually set a target to `'checking'` with an old `updated_at`, run the worker,
    assert it's reclaimed and re-checked in the same or next invocation.
  - Runtime-budget cutoff: force a tiny budget, assert the worker stops cleanly mid-batch and reports
    `stoppedDueToRuntimeBudget: true` with an accurate partial count, never a crash.
  - Archived-product cascade: archive a source `amazon_listing_items`/`tracked_asins` row, run
    reconciliation, assert `pincode_monitored_products.status` and all child targets flip to
    `'archived'`/`'paused'` and history remains queryable.
- **Manual/production verification (after deploy, before declaring done — same discipline as the Keywords
  and Pincode P0 rounds):**
  - Visual check of all product/pincode state combinations reachable through a real authenticated account;
    honestly report any state not observable (same rule the user set for Keywords P0 — **do not manufacture
    synthetic enrollment/tracking data merely for visual verification**).
  - One full natural cron cycle observed end-to-end via structured logs, same as the 3-cycle review-requests
    verification precedent.

---

## 6. Rollout plan
1. Migrations first (additive only, zero risk to existing tables — `DATA_MODEL.md` §7), deployed and
   verified via `execute_sql` schema checks before any app code ships.
2. App code (route, tabs, tracker table, enrollment flows) behind the new route — does not touch or risk
   the existing `/dashboard/asins/[asin]` Pincode widget or `/dashboard/pincode` (legacy) at all, so this
   can ship to 100% of production immediately without a feature flag; no other page depends on the new
   tables yet.
3. Scheduler cron wiring **last**, only after enrollment flows have been live long enough to have at least
   one real `pincode_tracking_targets` row to exercise against — avoids "cron fires against an empty table
   and nobody notices it's broken" as a false-positive green signal.
4. First scheduler cron cycle observed manually (not just trusted) before considering the rollout complete,
   matching the review-requests 3-cycle verification bar.

## 7. Rollback plan
- App code: standard Vercel rollback to the prior deployment — the new route is additive and unlinked from
  existing nav paths until explicitly wired, so a rollback here has zero blast radius on existing features.
- Scheduler cron: can be disabled independently of the app code by removing its `vercel.json` entry and
  redeploying — targets simply stop advancing `next_check_at`, no data loss, resumable at any later time
  (all `pincode_tracking_targets` rows just accumulate a growing "overdue" gap, self-heals once the cron
  resumes).
- Migrations: additive-only by design (`DATA_MODEL.md` §7) — no rollback migration is anticipated to be
  necessary; if ever needed, the new tables can be dropped independently without touching
  `pincode_checks`/`pincode_availability_results`/`tracked_asins`/`amazon_listing_items`, none of which this
  plan modifies destructively.

## 8. Unresolved risks (carried forward honestly, not hidden)
1. **SP-API catalog lookup helper is unconfirmed** (§4) — P1 item depends on a short research pass this
   spec round did not complete.
2. **Shared tracking quota enforcement point is not fully designed** — decision #6 locks the concept but
   this plan only specifies a per-cycle scheduler cap (§2.9), not the enrollment-time quota check/UX (what
   happens when a seller tries to enroll product #201). Needs a decision before P0 enrollment UI ships:
   either enrollment is unlimited and only the scheduler throttles silently (checks just run later than
   ideal), or enrollment itself is capped and rejects with a clear message. Recommend the latter for
   honesty with the seller, but this needs explicit confirmation, not silent assumption.
3. **Real-world block/CAPTCHA rate is unknown** — §2.6's fixed 2x cooldown multiplier is a reasonable
   starting guess, not measured against actual Amazon-storefront-scrape block rates for this feature. May
   need tuning after the first week of production data.
4. **Cron frequency (hourly) vs. actual check-latency budget is unverified at scale** — with a 24h cadence,
   200/workspace/cycle cap, and unknown total enrolled-target count across all workspaces at launch, the
   plan has not modeled whether hourly cycles will comfortably drain the full due-backlog. Recommend
   checking actual enrollment counts before the scheduler cron is turned on (rollout step 3 already sequences
   this correctly — the risk is in under-provisioning batch size/frequency, not in when they're turned on).
