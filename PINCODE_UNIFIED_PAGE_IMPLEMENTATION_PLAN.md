# Pincode Checker — Unified Page Implementation Plan

**Status:** Plan only, amended. No code, no migration, no deployment in this round or the prior one.
**Companion:** `PINCODE_UNIFIED_PAGE_PRODUCT_SPEC.md`, `PINCODE_UNIFIED_PAGE_DATA_MODEL.md`.

**Amendment round 1 (2026-07-18):** the first draft's scheduler was not actually atomic (a Supabase/Next.js
client cannot safely `SELECT ... FOR UPDATE SKIP LOCKED` then `UPDATE` later and call it one transaction),
claimed 40 rows up front while checking the runtime budget per-unit (leaving unstarted rows stuck `checking`
on budget cutoff), reused review-request concurrency numbers for a checker with a measured 55s worst case
without modeling whether that fits the runtime budget, called append-only duplicate inserts "idempotent,"
made Manual Check Now synchronous (contradicting the founder's "queued" decision), and moved the
founder-required trustworthy Other Products lookup to P1. All corrected, marked **"Correction N
(2026-07-18)"** inline.

**Amendment round 2 (2026-07-18) — still not approved to merge.** Round 1's corrections were directionally
right but left real gaps: the finalize function's write order could let a reclaimed, stale worker response
corrupt a different claim's target; `claim_token` had no database-enforced uniqueness; the fairness mechanism
was described in prose without an implementable query; Manual Check Now's route still described
read-then-later-write races instead of one atomic RPC; the claim-function section contradicted itself about
a "target-id filter" parameter that was never actually defined; the cron/worker route names disagreed between
this document and the Product Spec; and the P0 scope was one undifferentiated implementation PR despite its
own size and risk. **Corrections 1–10 below** (this round's numbering restarts at 1, scoped to round 2 — see
each correction's own text for what it fixes) resolve these, using facts independently confirmed against
production: PostgreSQL 17.6 (column-specific `ON DELETE SET NULL` is supported, not merely hoped-for), and
the actual `pincode_availability_results` audit (18 `available`/no-error rows, 7 `unknown`/error rows, no
other combinations exist today). The founder's quota decision (capped enrollment, explicit `409` rejection)
is also locked in this round, closing round 1's open risk #2.

**Amendment round 3 (2026-07-18) — "close, but do not merge yet."** Round 2's RPC designs were directionally
correct but not yet safe under real concurrency or complete in scope: the enrollment quota was count-then-
insert (a genuine oversubscription race under concurrent requests), bulk enrollment's "one transaction per
product" contradicted its own all-or-nothing promise, no dedicated pause/resume RPC existed despite the spec
referencing "quota-safe resume behavior," `queue_pincode_manual_check` tested a `target.status = 'archived'`
value the target's status enum has never had, the archival reconciliation cascade would have tried to pause
an in-flight `'checking'` target (violating its own claim-consistency CHECK), no soft-removal state existed
for the UI's Remove Tracking action, this document described `claim_due_pincode_targets` twice with
different signatures, the fairness query applied row-locking to a windowed derived table rather than real
base rows, manual-check quota was computed outside the RPC's transaction (stale under concurrency), and two
concurrent legitimate finalize calls for the same still-valid token could be misdiagnosed as a stale attempt.
**Corrections 1–12 below** (round 3's own numbering, restarting at 1 again) fix all of these. The founder
also locked a new decision this round: **Manual Check Now does not consume the enrollment quota** — it has
its own separate, configurable outstanding-request limit (`DATA_MODEL.md` §2c).

**Amendment round 4 (2026-07-18) — final architecture consistency pass, still not approved to merge.** Round
3's individual pieces were each locally correct but not consistent with each other as a whole system: three
different RPCs used three different lock orders (a real deadlock risk under concurrency); the finalize
function's NULL handling relied on `IN (...)`/`NOT IN (...)` against parameters that could be actual SQL
`NULL`, which three-valued logic evaluates to neither TRUE nor FALSE — silently passing validation it should
have rejected; no RPC re-validated that a caller's claimed `workspace_id`/`marketplace_id` actually matched
the row it locked; the canonical claim RPC's signature had no allowlist parameter despite the rollout plan
requiring one; candidate selection in the claim RPC wasn't re-checked after locking, so a pause/remove/
archive committed in between could be silently overridden; manual-request priority could be lost across
workspaces once eligible-workspace count exceeded the chunk size; stale-claim reclaim always reset to
`'active'` regardless of the parent's actual state; no RPC existed for product-level removal despite one
being referenced; the reconciliation pass could overwrite a user-removed product back to `archived`; re-
adding a removed product left its existing targets stranded in `paused`; the result table's FKs used `SET
NULL` for tables this feature itself controls and should never hard-delete; a result's target and product IDs
could independently reference mismatched rows; the parent status enum conflated lifecycle state with a
display concept ("paused"); and no RPC validated its own parameter bounds. **Corrections 1–14 below** (round
4's own numbering) fix all of these — this round does not change product scope or add new decisions, it
makes the already-locked design internally consistent and safe under concurrency.

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

**What stays out of P0 despite this:** a *visible-position* Check Now queue ("3rd in line") — P0's Manual
Check Now is genuinely queued and coalesced (Correction 10, §2.10) but does not show a numeric queue
position, that's a P1 UX refinement — per-workspace configurable cadence (P0 ships one fixed default
cadence, configurable cadence is P1), and the Data-Health/monitoring dashboard integration (P1 — the
scheduler must be observable via logs/DB queries in P0, a dashboard is a separate consumer of that same
data). **Correction 10 (2026-07-18):** the first draft's "just synchronously triggered" language for Check
Now directly contradicted the founder's locked decision #9 ("safely queued and rate-controlled") and is
removed — see §2.10 for the corrected, genuinely-queued design.

---

## 2. Scheduler design

Modeled directly on `background_jobs` (migration `034`) for the claim/lock shape and on
`review-requests/eligibility-processor.ts` (this session's own shipped code) for the bounded-runtime +
stale-reclaim discipline. Operates on `pincode_tracking_targets` directly — no separate job-queue table;
the target row *is* the job, exactly as `review_solicitation_orders` rows are their own job (no separate
queue table was introduced for that worker either, and it has run cleanly in production).

### 2.0 One global database lock order — round 4, Correction 2 (2026-07-18)

**Round 3's individual RPC descriptions used conflicting lock orders** — `queue_pincode_manual_check` locked
target → parent → advisory lock; `enroll_pincode_monitored_products` acquired the advisory lock → then
parent/target; `finalize_pincode_check` locked target → parent; the archival reconciliation pass locked
parent → child targets. Different orderings across code paths that can run concurrently against the same
rows is a textbook deadlock setup (transaction A holds lock 1, waits for lock 2; transaction B holds lock 2,
waits for lock 1). **This section is the single, canonical statement of lock order for every Pincode
RPC/process in this document and in `DATA_MODEL.md` — every RPC body elsewhere in either document has been
rewritten to follow it, and no RPC description anywhere in the amended spec deviates from it:**

1. **Workspace+marketplace advisory transaction lock** (`pg_advisory_xact_lock`, deterministic key from
   `hashtextextended(workspace_id::text || ':' || marketplace_id, 0)`, `DATA_MODEL.md` §2a) — acquired
   **first**, and only by operations that need quota/manual-queue serialization (enrollment, resume, remove,
   manual-check-queue). Operations that don't affect quota or the manual-outstanding count (the scheduler's
   own claim and finalize) skip this step entirely — they were never part of the deadlock risk this lock
   exists to prevent, and acquiring it unnecessarily would only add contention.
2. **`pincode_monitored_products` (parent) rows, locked in `id` order** — always locked before any
   `pincode_tracking_targets` row it's the parent of, and always via a single query with `ORDER BY id FOR
   UPDATE` when a call touches multiple parents (never row-by-row in an application-code loop, which cannot
   guarantee ordering against a concurrent caller touching the same rows in a different order).
3. **`pincode_tracking_targets` (child) rows, locked in `id` order** — always after their locked parent(s),
   same "single query, `ORDER BY id`" discipline for multi-row operations.
4. **Result insertion/finalization** (`pincode_availability_results` INSERT + the owning target's final
   `UPDATE`, inside `finalize_pincode_check` only) — always last, after both parent and target are already
   locked.

**Applied to every RPC/process in this spec, without exception:**

| RPC/process | Step 1 (advisory) | Step 2 (parent) | Step 3 (target) | Step 4 (result) |
|---|---|---|---|---|
| `enroll_pincode_monitored_products` (`DATA_MODEL.md` §2a) | Yes | Yes, `ORDER BY id` | Yes, `ORDER BY id` | No |
| `set_pincode_tracking_state` (`DATA_MODEL.md` §3a) | Yes | Yes | Yes | No |
| `queue_pincode_manual_check` (§2.10) | Yes | Yes | Yes | No |
| `remove_pincode_monitored_products` (`DATA_MODEL.md` §3b) | Yes | Yes | Yes | No |
| `claim_due_pincode_targets` (§2.8) | No (not quota-affecting) | Yes (as part of candidate locking) | Yes | No |
| `finalize_pincode_check` (§2.7) | No (not quota-affecting) | Yes | Yes | Yes |
| Archival/reconciliation processing (`DATA_MODEL.md` §5) | No | Yes | Yes | No |
| Stale-claim reclaim (§2.4) | No | Yes, where parent-aware behavior requires it (round-4 Correction 7) | Yes | No |

**For `finalize_pincode_check` specifically** (the one case where "which row do I even have" isn't known
until after some lookup), the order is refined without violating the rule above:
1. A **non-locking** lookup by `claim_token` alone identifies the target/parent to operate on (this is a
   plain `SELECT`, not `FOR UPDATE` — it establishes *which* rows to lock next, it doesn't hold a lock across
   a decision point).
2. Lock the **parent** first (matching step 2 of the global order).
3. Lock the **target** second (step 3) and **revalidate** — `claim_token` still matches, `status =
   'checking'` still holds, and the target's `monitored_product_id` still equals the locked parent's `id` —
   before proceeding. If any revalidation fails, abort without writing (§2.7's `stale_check_attempt` path).
4. Continue only when every revalidation still matches; then perform step 4 (result insertion + target
   finalization).

**For `queue_pincode_manual_check` specifically**, restated in the RPC's own terms (§2.10 has the full body):
1. Acquire the advisory lock **first** (before any row lock — this differs from `finalize_pincode_check`
   because this RPC's target/parent identity is already known from its own parameters, there's no
   claim-token indirection to resolve first).
2. Lock the parent.
3. Lock the target.
4. Revalidate workspace, marketplace, and current state (Correction 3, below).
5. Count outstanding requests and queue atomically (Correction 9, §2.10).

**Required tests (round 4):** run `queue_pincode_manual_check`, `set_pincode_tracking_state` (pause),
`finalize_pincode_check`, and the archival reconciliation pass **concurrently against the same product** (
different connections, overlapping in time); assert no deadlock, no lock-wait timeout, and no invalid final
state (e.g. a target left simultaneously `'checking'` and orphaned, or a parent left in a state its children
disagree with).

### 2.1 Cadence
Fixed default: **24 hours** per target in P0 (`pincode_tracking_targets.cadence_hours` column exists from
day one per the Data Model, but the UI only exposes changing it starting P1 — P0 always writes `24`).
`next_check_at` is computed as `checked_at + (cadence_hours || '1 hour')::interval`, never derived by
re-adding to `now()` (avoids compounding drift if a cycle runs late).

### 2.2 Batch size and concurrency — Correction 6 (2026-07-18): must be measured, not reused

**The first draft's "batch size 40 / concurrency 8" was wrong to call proven for this checker.** It reused
`REVIEW_REQUESTS_INGEST_CONCURRENCY` on the reasoning that "pincode checks are also an external-scrape
operation" — but review-requests calls Amazon *APIs*; pincode checks drive
`checker-worker/src/checkers/pincodeAvailability.ts`, a Playwright storefront checker with a confirmed
**`OVERALL_TIMEOUT_MS = 55_000`** (read directly from the source, not assumed — `pincodeAvailability.ts:63`)
and the prior Pincode audit's own finding of "up to 200×55s worst-case job duration"
(`PINCODE_CHECKER_PRODUCT_AUDIT.md`, the "§9 80s trigger-timeout vs. up-to-200×55s worst-case job duration
mismatch" item) — a materially different latency and blocking-risk profile from an API call.

**The math the first draft skipped:** 40 targets at concurrency 8 is 5 sequential waves in the worst case;
5 × 55s (the checker's own worst-case timeout) = **275 seconds** before any DB/network overhead is added —
that does **not** fit inside the 220s runtime budget (§2.3) with any safety margin. Locking 40/8 as a
default would have been claiming a number as "production-proven" that the evidence actually contradicts.

**What this spec requires before the defaults are locked:**
1. Confirm `OVERALL_TIMEOUT_MS = 55_000` is still current at implementation time (re-read the constant, it
   may have changed since this spec round).
2. Pull realistic p50/p95 check duration from `checker-worker` logs (structured logs already exist per the
   worker's own logging discipline — this is a log query, not a new instrumentation project) rather than
   assuming every check takes the full 55s timeout. The worst-case number bounds safety; the p50/p95 numbers
   bound *expected* throughput.
3. Model the maximum safe wave count from both numbers: `safe_waves = floor((runtime_budget_ms -
   fixed_overhead_ms) / worst_case_check_ms)`, then `safe_batch_size = safe_waves × concurrency`, solved
   for a chosen `concurrency` that itself must leave headroom under the checker-worker's own concurrent-job
   ceiling (confirm that ceiling before implementation — not specified in this document, flagged as an
   implementation-time lookup, not assumed).
4. Document the resulting calculation directly in code comments next to the chosen constants, so a future
   reader sees the arithmetic, not just a number.
5. **Acceptance threshold:** the chosen batch/concurrency must leave at least a 20% runtime-budget safety
   margin against the *worst-case* (not average) duration for the full claimed chunk (§2.8's bounded chunk,
   not a 40-row batch) — i.e. `chunk_size × worst_case_check_ms / concurrency ≤ 0.8 × runtime_budget_ms`.

**Final numbers: to be finalized by pre-implementation benchmark.** This spec deliberately does not lock
`PINCODE_SCHEDULER_CONCURRENCY`/chunk size to a specific value — a conservative starting point consistent
with the acceptance threshold above, pending that benchmark, is **concurrency 4, chunk size 4** (one wave
per claim, §2.8's bounded-chunk design) — `4 × 55,000ms / 4 = 55,000ms` per chunk, comfortably inside a
220s budget with room for many chunks per invocation and the required safety margin. This starting point is
explicitly a floor to benchmark from, not a ceiling; it may be revised up once real p50/p95 data is
available, following the same calculation method. `PINCODE_SCHEDULER_CONCURRENCY` and the chunk size stay
env-overridable, but the override must be **clamped server-side** to a defensible range (e.g. concurrency
1–8) rather than accepting an arbitrary operator-supplied value that could blow the runtime budget.

### 2.3 Timeout / runtime budget
**`PINCODE_SCHEDULER_RUNTIME_BUDGET_MS`, default 220000** (220s) — identical to
`REVIEW_REQUESTS_INGEST_RUNTIME_BUDGET_MS`/`..._PROCESS_RUNTIME_BUDGET_MS`, deliberately kept under
Vercel's known ~280s hard function ceiling (the same ceiling this codebase already hit and fixed once for
review-requests — no reason to re-discover it here).

**Correction 5 (2026-07-18):** the first draft checked this budget "before claiming the next unit of work"
while also claiming a 40-row batch up front (§2.8 original) — those two statements don't fit together: if
40 rows are claimed at once but the budget is checked per-unit, a cutoff mid-batch leaves the *unstarted*
claimed rows sitting in `'checking'` with no worker actually processing them, which is exactly the "false
promise" state this whole spec exists to avoid. The budget check is corrected to operate at **chunk**
granularity, not per-unit within a large pre-claimed batch — see §2.8's bounded-chunk claim design, which
replaces the up-front batch claim entirely. Under the corrected design, a check that's already in flight
always finishes and is never left in `'checking'` by a budget cutoff; a target can only be left `'checking'`
by an actual crash/timeout, which is what stale-claim reclaim (§2.4) exists for.

### 2.4 Stale job reclaim — round 4, Correction 7: parent-aware, not a blind reset to `'active'`

**Round 3's reclaim always reset a stale `'checking'` row to `'active'` unconditionally.** That's wrong when
the parent went `archived`/`removed` during the crashed attempt — resetting to `'active'` would make the
target claimable again by `claim_due_pincode_targets` (§2.8), which itself filters on `p.status = 'active'`
at claim time, so in practice a stale reclaim under a non-active parent wouldn't actually get re-claimed —
but the target would sit in a **misleading** `'active'` state (implying "will be checked again soon") when
its parent says otherwise, until the next reconciliation cycle happened to catch and pause it. Corrected to
one atomic, parent-aware reclaim that gets the target into its *true* state immediately, not eventually:

Before claiming new targets, the worker runs one reclaim pass, following the global lock order (§2.0 — lock
the parent first, the target second, no advisory lock needed since reclaim doesn't affect quota):

```sql
-- One statement, parent-aware AND configuration-aware (PR #55 review
-- round addendum). Selects stale 'checking' targets, joins their locked
-- parent, and branches the reset behavior on the parent's CURRENT status
-- AND the target's own is_configured flag -- not a blind "always go back
-- to active."
WITH stale AS (
  SELECT t.id, t.monitored_product_id, t.manual_requested_at, t.manual_requested_by,
         t.manual_request_token, t.next_check_at AS prior_next_check_at,
         t.is_configured, p.status AS parent_status
  FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  WHERE t.status = 'checking'
    AND t.updated_at < now() - interval '15 minutes'  -- PINCODE_SCHEDULER_STALE_CLAIM_MINUTES
  ORDER BY p.id, t.id
  FOR UPDATE OF p, t
)
UPDATE public.pincode_tracking_targets t
SET status = CASE WHEN stale.parent_status = 'active' AND stale.is_configured THEN 'active' ELSE 'paused' END,
    claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
    next_check_at = CASE
      WHEN stale.parent_status = 'active' AND stale.is_configured THEN
        -- Preserve/pull forward next_check_at appropriately: a manual
        -- request stays immediately due (now()); a scheduled check
        -- becomes immediately due too, since a stale/crashed attempt
        -- means it didn't actually run on its prior schedule.
        now()
      ELSE NULL
    END,
    -- Correction 7 (round 4): preserve manual-request fields when the
    -- parent is still active, so a crashed MANUAL request can be retried
    -- by the next claim cycle rather than silently vanishing; clear them
    -- when the parent is archived/removed, since a manual check against a
    -- non-active product no longer makes sense (mirrors §3b's
    -- Remove-Tracking behavior). PR #55 addendum: also clear them when the
    -- target itself was unconfigured mid-flight (DATA_MODEL.md §3c) --
    -- a pincode the seller removed from the list should not have its
    -- manual request silently retried either.
    manual_requested_at = CASE WHEN stale.parent_status = 'active' AND stale.is_configured THEN stale.manual_requested_at ELSE NULL END,
    manual_requested_by = CASE WHEN stale.parent_status = 'active' AND stale.is_configured THEN stale.manual_requested_by ELSE NULL END,
    manual_request_token = CASE WHEN stale.parent_status = 'active' AND stale.is_configured THEN stale.manual_request_token ELSE NULL END
FROM stale
WHERE t.id = stale.id;
```

**Four outcomes, extended from round 4's parent-only branching (PR #55 review round adds the configuration-lifecycle case):**

- **`parent.status = 'active'` AND `is_configured = true`** — reset to `status = 'active'`, `next_check_at =
  now()` (immediately due — a stale/crashed attempt means the scheduled or manual check never actually
  completed, so it's re-queued rather than waiting out the rest of its original cadence). Manual-request
  fields are **preserved** if they were set, so a crashed manual check is retried, not silently dropped.
- **`parent.status IN ('archived', 'removed')`** — reset to `status = 'paused'`, `next_check_at = NULL`,
  manual-request fields cleared. **The target is never made claimable again** — this is the same terminal
  state the in-flight-safe archival/removal cascades (`DATA_MODEL.md` §5, §3b) already produce for a target
  that finalizes normally under a non-active parent; stale-claim reclaim now produces the identical outcome
  for a target that *doesn't* finalize normally, so both paths converge on the same truthful end state.
- **`parent.status = 'active'` AND `is_configured = false`** (PR #55 review round, `DATA_MODEL.md` §3c) — the
  seller removed this pincode from the product's configured list (via Edit Pincodes) while the check was
  in flight, but the crash means it never reached `finalize_pincode_check`'s own unconfigured-target
  handling. Same terminal outcome as the archived/removed case: `status = 'paused'`, `next_check_at = NULL`,
  manual-request fields cleared, never re-claimable — converges with the outcome a normal finalize on an
  unconfigured target would have produced.
- **No fifth case exists** — per `DATA_MODEL.md` §2 Correction 13, the parent lifecycle has exactly two
  non-active values (`archived`, `removed`); there is no parent-level `'paused'` to branch on separately.
  `is_configured` is a target-level, not parent-level, fact (§3c).

Clearing `claim_token` alongside the other claim fields in every branch is required by `DATA_MODEL.md` §3's
claim-field-consistency CHECK (a non-`'checking'` row must not retain any claim field) — unchanged from
round 3, still enforced regardless of which branch fires. This is the exact recovery path for the "crash
after external check but before finalize" case (§5 test #7): the row is safely reclaimed into its *correct*
state, never left stuck and never left misleadingly `'active'` under a dead product.

**Required tests (round 4):**
- Scheduled stale claim under an `active` parent — reclaimed to `'active'`, `next_check_at = now()`.
- Manual stale claim under an `active` parent — reclaimed to `'active'`, manual-request fields preserved, so
  the next claim cycle retries the manual check rather than losing it.
- Stale claim after the parent was archived mid-flight — reclaimed to `'paused'`, `next_check_at = NULL`,
  never re-claimable.
- Stale claim after the parent was user-removed mid-flight — same outcome as archival, confirming the two
  non-active parent states are handled identically by this reclaim pass.

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
**Correction 8 (2026-07-18):** writes `check_status = 'blocked'` (the corrected, dedicated column —
`DATA_MODEL.md` §4a — not the overloaded `availability_status` the first draft used) when a CAPTCHA/block
response is detected — an honest result, not a failure — and does **not** increment
`consecutive_failures` — being blocked is not the target's fault and retrying immediately would likely just
get blocked again. Instead: `next_check_at` is pushed out further than normal cadence on a block (`now() +
cadence_hours * 2`, a simple fixed multiplier — full adaptive backoff is P1) to naturally cool down without
a separate state machine.

### 2.7 True idempotency and atomic finalization — Correction 7 (2026-07-18)

**The first draft's "append-only INSERT, two rows for the same repeated check" was not idempotency** — it
was honestly labelled as tolerable duplication, but the correction is explicit that two rows for one
logical attempt is not an acceptable definition of idempotent, because it lets a retried finalize after a
lost response silently double-write history and potentially double-advance `next_check_at`/
`consecutive_failures`. Corrected design:

- Every claimed check carries a unique **`claim_token`** (`pincode_tracking_targets.claim_token`,
  `DATA_MODEL.md` §3 — minted fresh by `claim_due_pincode_targets`, §2.8 below, now backed by a database
  `UNIQUE` partial index, `DATA_MODEL.md` §3 Correction 2) — this is the **check-attempt identity**, not
  just a worker-identity marker.
- `pincode_availability_results` gains `check_attempt_id`, `tracking_target_id`, `monitored_product_id`
  columns (`DATA_MODEL.md` §4, Correction 1) — `check_attempt_id` carries a **`UNIQUE`** partial index, the
  idempotency key for result history, replacing plain append-only `INSERT`.

**Round-2 Correction 3 (2026-07-18) — the round-1 write order was unsafe.** The prior version inserted the
result *first*, then tried to update the target by `claim_token`, and treated a zero-row target update as
"already finalized, return the existing result." That ordering has a real race: if the target was already
**reclaimed** by stale-claim reclaim (§2.4) and re-claimed by a *different* attempt (a new `claim_token`) by
the time a slow/stale worker's response for the *original* attempt finally arrives, inserting first would
still succeed (the `check_attempt_id` is unique to that original attempt, so nothing stops the insert), and
only the target `UPDATE` would silently no-op — leaving a real result row on the books for an attempt that no
longer owned the target when it wrote, while never checking whether the target it's about to touch is even
still the same logical check. Corrected order — **validate before insert, not after**.

**Round 3 adds four more fixes to the same function** (Corrections 4, 5, 10, 11 — all incorporated into the
one body below, not four separate functions):

- **Correction 4** — the target's own `status` enum never had an `'archived'` value; the parent product's
  archived/removed state must be read from `pincode_monitored_products`, locked in the same transaction.
- **Correction 5** — if the parent went `archived`/`removed` while this check was in flight (§`DATA_MODEL.md`
  §5), the result is still recorded (a real check ran), but the target finalizes to `paused` with
  `next_check_at = NULL` instead of being rescheduled.
- **Correction 10** — two concurrent finalize calls carrying the **same still-valid** token can race: both
  see no existing result, one locks and finalizes first, the second's target lookup then finds nothing
  (the first call already changed `status` away from `'checking'`) — round 1's version would have
  incorrectly raised `stale_check_attempt` for this **legitimate** duplicate. Fixed: after a failed target
  lookup, re-query the result by `check_attempt_id` a second time before concluding it's stale — only raise
  `stale_check_attempt` if a result genuinely does not exist after that second check.
- **Correction 11** — validate the `(check_status, availability_status)` combination against
  `DATA_MODEL.md` §4a's mapping table *before* writing anything; reject invalid combinations outright (this
  is the actual write-integrity boundary the deferred CHECK constraint backstops, `DATA_MODEL.md` §4's
  Correction 11).

**Round 4 adds two more fixes to the same function:**

- **Correction 1** — the round-3 validation used `NOT IN (...)`/`IN (...)` directly against parameters that
  could be SQL `NULL`, which three-valued logic evaluates to `NULL` (neither TRUE nor FALSE) rather than
  rejecting — a plpgsql `IF` on a `NULL` condition is treated as false, so a `NULL` `check_status` would have
  silently passed every validation branch undetected. Every branch now starts with an explicit `IS NULL`
  check.
- **Correction 2 (global lock order, §2.0)** — round 3 locked the target before the parent (`SELECT ...
  FROM pincode_tracking_targets ... FOR UPDATE` first, then the parent). That's the reverse of every other
  RPC in this document, which lock parent-before-target — a real deadlock risk if this function and, say,
  `set_pincode_tracking_state` ever contend for the same parent+target pair concurrently. Corrected: a
  non-locking lookup identifies the parent first, the parent is locked, then the target is locked and
  revalidated against the now-locked parent.

```sql
CREATE OR REPLACE FUNCTION public.finalize_pincode_check(
  p_claim_token        uuid,
  p_check_status       text,
  p_availability_status text,
  p_delivery_message    text,
  p_error_code          text,
  p_error_message       text
)
RETURNS public.pincode_availability_results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing        public.pincode_availability_results;
  v_lookup_product_id uuid;
  v_target          public.pincode_tracking_targets;
  v_product         public.pincode_monitored_products;
  v_result          public.pincode_availability_results;
  v_next_status     text;
  v_next_check_at   timestamptz;
  v_consecutive     integer;
BEGIN
  -- Correction 11 (round 3), rewritten NULL-safe per round-4 Correction 1:
  -- validate the input combination FIRST, before any lookup or write -- an
  -- invalid combination is a caller bug, not a legitimate race, and must
  -- never reach the database in any row.
  --
  -- Round-4 fix: Postgres uses three-valued logic -- `x NOT IN (...)` and
  -- `x IN (...)` both evaluate to NULL (neither TRUE nor FALSE) when x IS
  -- NULL, and an `IF` condition that evaluates to NULL is treated as FALSE
  -- by plpgsql -- meaning `IF p_check_status NOT IN (...)` with
  -- p_check_status = NULL would NOT raise, silently letting a NULL
  -- check_status fall through every branch below undetected. Every branch
  -- now starts with an explicit `IS NULL` test before any `IN (...)`
  -- comparison, so a NULL input can never silently pass through.
  IF p_check_status IS NULL OR p_check_status NOT IN ('success', 'failed', 'blocked') THEN
    RAISE EXCEPTION 'invalid_check_status' USING ERRCODE = 'P0002';
  END IF;
  IF p_check_status = 'success' AND (
       p_availability_status IS NULL
       OR p_availability_status NOT IN ('available', 'unavailable', 'unknown')
     ) THEN
    RAISE EXCEPTION 'invalid_availability_for_success' USING ERRCODE = 'P0002';
  END IF;
  IF p_check_status IN ('failed', 'blocked') AND p_availability_status IS NOT NULL THEN
    RAISE EXCEPTION 'availability_must_be_null_for_non_success' USING ERRCODE = 'P0002';
  END IF;

  -- Step 1: idempotency check FIRST. If this exact attempt already
  -- recorded a result (a retried finalize call after the app lost the
  -- original response, but the transaction had already committed),
  -- return it immediately -- no lookup, no lock, no insert, nothing else.
  SELECT * INTO v_existing FROM public.pincode_availability_results
    WHERE check_attempt_id = p_claim_token;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Round-4 Correction 2 (global lock order, §2.0): a NON-LOCKING lookup
  -- identifies which parent to lock, BEFORE any row is locked -- this is
  -- what lets step 3 below lock the parent first, then the target second,
  -- rather than the round-3 version's target-first order (which could
  -- deadlock against other RPCs that always lock parent-then-target).
  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking';

  IF NOT FOUND THEN
    -- Correction 10: do NOT immediately conclude "stale." A concurrent
    -- finalize call for the SAME still-valid token may have already
    -- committed between this call's step 1 and this lookup. Re-check for
    -- the result a second time before deciding.
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;  -- legitimate concurrent duplicate -- same result, not an error
    END IF;
    -- Genuinely stale: this claim_token was reclaimed (stale-claim
    -- reclaim, §2.4) and possibly already re-claimed by a different
    -- attempt. Do NOT insert a result, do NOT touch any target.
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  -- Step 3 (lock order step 2): lock the PARENT first. Correction 4/5 --
  -- the target's own status enum has no 'archived' value; archived/
  -- removed is a fact about pincode_monitored_products, locked here so the
  -- scheduling decision below can react to a mid-flight archive/removal
  -- correctly, and so this RPC follows the same parent-before-target order
  -- as every other RPC in this document (§2.0).
  SELECT * INTO v_product FROM public.pincode_monitored_products
    WHERE id = v_lookup_product_id
    FOR UPDATE;

  -- Step 3 continued (lock order step 3): lock the TARGET second, and
  -- REVALIDATE against the now-locked parent -- claim_token still matches,
  -- status is still 'checking', AND monitored_product_id still equals the
  -- parent just locked (guards against a vanishingly unlikely but
  -- structurally possible reassignment between the non-locking lookup
  -- above and this lock).
  SELECT * INTO v_target FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking'
      AND monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Something changed between the non-locking lookup and this lock
    -- (e.g. reclaimed in the interim) -- same re-check-then-stale
    -- discipline as above, never assume stale without checking for a
    -- legitimate concurrent duplicate first.
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  -- Step 4: insert the one result row this attempt owns, now that the
  -- target lock proves this claim_token is still valid. The result is
  -- recorded regardless of parent status -- a real check ran and
  -- completed; that fact is never discarded.
  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status,
    delivery_message, error_code, error_message, checked_at
  ) VALUES (
    v_target.workspace_id, v_product.asin, v_target.pincode,
    v_target.monitored_product_id, v_target.id,
    p_claim_token, p_check_status, p_availability_status,
    p_delivery_message, p_error_code, p_error_message, now()
  ) RETURNING * INTO v_result;

  -- Step 5: compute the target's next state.
  IF v_product.status IN ('archived', 'removed') THEN
    -- Correction 5: parent went archived/removed while this check was in
    -- flight -- finalize to paused, never reschedule a product that's no
    -- longer active.
    v_next_status := 'paused';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures;  -- unchanged; this isn't a failure
  ELSIF p_check_status = 'blocked' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours * 2 || ' hours')::interval;  -- §2.6
    v_consecutive := v_target.consecutive_failures;  -- blocked does not increment failures, §2.6
  ELSIF p_check_status = 'failed' AND v_target.consecutive_failures + 1 >= <max_failures> THEN
    v_next_status := 'failed';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures + 1;
  ELSIF p_check_status = 'failed' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;  -- §2.5, flat retry delay
    v_consecutive := v_target.consecutive_failures + 1;
  ELSE
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;
    v_consecutive := 0;
  END IF;

  -- Step 6: finalize the SAME target this attempt validated in step 2 --
  -- clear all claim fields, clear manual-request fields (this was either a
  -- scheduled or manual check either way; both clear the same way).
  -- Correction 10's guarded WHERE clause: even though this row is already
  -- locked (FOR UPDATE, step 2) and cannot have changed underneath us,
  -- the explicit claim_token + status='checking' guard is retained as a
  -- second, defensive check -- if it were ever to affect zero rows despite
  -- the lock, that is itself a bug worth surfacing loudly rather than
  -- silently succeeding.
  UPDATE public.pincode_tracking_targets
  SET status = v_next_status,
      last_checked_at = now(),
      next_check_at = v_next_check_at,
      consecutive_failures = v_consecutive,
      last_error_code = p_error_code,
      claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL
  WHERE id = v_target.id AND claim_token = p_claim_token AND status = 'checking';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_target_update_affected_zero_rows_unexpectedly' USING ERRCODE = 'XX000';
  END IF;

  -- Step 7: insert + product lock + update commit together or not at all
  -- (implicit transaction, same function body).
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) TO service_role;
```

- A crash between the external Amazon/checker call completing and this RPC being invoked leaves the target
  still `'checking'` under its original `claim_token`, safely picked up by stale-claim reclaim (§2.4); a
  crash **during** this RPC is rolled back entirely by the transaction, so there is no partial state where a
  result exists but the target wasn't updated, or vice versa.
- **What stays outside the transaction, deliberately:** the external Amazon/checker-worker HTTP call itself.
  Only result persistence + target finalization are atomic and idempotent — the plan does not attempt to
  make an external network call transactional, that's not possible and isn't what "atomic finalization"
  means here.
- Cycle-level reporting is corrected to the fields Correction 5 requires (§2.13) — `targetsCompleted` is
  only incremented after `finalize_pincode_check` returns a result (fresh, already-recorded, or a legitimate
  concurrent duplicate), never assumed from the external call succeeding alone. A `stale_check_attempt`
  exception is counted separately — it means the worker did real work whose result cannot be safely
  recorded, not a target-level failure, so it must not increment `targetsFailed` either; log it distinctly.
- **Required tests:**
  - **Round 2's stale-reclaimed-attempt test (unchanged):** claim attempt A → force-reclaim A → claim
    attempt B (same target, new `claim_token`) → call `finalize_pincode_check` with A's now-stale token →
    assert it raises `stale_check_attempt`, inserts no result, and does not mutate B's claim or target state
    → finalize B normally → assert exactly one new `pincode_availability_results` row exists.
  - **Round 3, new — concurrent duplicate finalize with the same still-valid token** (Correction 10): claim
    one target, then fire two `finalize_pincode_check` calls with the **same** `claim_token` from two
    separate database connections, overlapping in time; assert exactly one `pincode_availability_results` row
    is created, both calls return the identical recorded result, and **neither** call raises
    `stale_check_attempt` — this is a legitimate race, not a stale attempt, and must be handled as such.
  - **Round 3, new — archival during an in-flight check** (Correction 5): claim a target, archive its parent
    product while the target is still `'checking'`, then finalize; assert the result is recorded normally but
    the target finalizes to `paused` with `next_check_at = NULL`, not a fresh schedule.
  - **Round 3, new — result-combination validation** (Correction 11): call `finalize_pincode_check` with each
    of the rejected combinations from `DATA_MODEL.md` §4's table (`success`+`NULL`, `failed`+`available`,
    `blocked`+`unavailable`, an unrecognized `check_status`); assert every one raises before any write.
  - **Round 4, new — NULL-safe validation with actual SQL `NULL`** (Correction 1): call
    `finalize_pincode_check` with `p_check_status` as an actual SQL `NULL` (not a missing/`undefined`
    application-layer value — the test must exercise the database function directly with a `NULL` argument),
    and separately with `p_check_status = 'success'` and `p_availability_status` as SQL `NULL`; assert both
    raise `invalid_check_status`/`invalid_availability_for_success` rather than silently passing validation.
  - **Round 4, new — lock order concurrency** (Correction 2, §2.0): run `finalize_pincode_check` concurrently
    with `set_pincode_tracking_state` (pause) and the archival reconciliation pass against the same
    product/target (two+ database connections, overlapping); assert no deadlock, no lock-wait timeout.

### 2.8 The one canonical claim RPC: atomic, base-row-locking, fair — Corrections 4, 5, 7, 8, 9 (round 1/2/3, unified)

**Round 3, Correction 7 — this document previously described `claim_due_pincode_targets` twice: an earlier
two-parameter version (round 1/2, `p_limit`, `p_invocation_id`) and a later three-parameter fairness version
(round 2, adding `p_excluded_workspace_ids`).** Two bodies for one function name is exactly the kind of
"which one is current" ambiguity Correction 7 requires removed. **There is now exactly one signature,
described once, in this section:**

```
claim_due_pincode_targets(
  p_limit                  integer,
  p_invocation_id          text,
  p_excluded_workspace_ids uuid[] DEFAULT '{}',
  p_allowed_workspace_ids  uuid[] DEFAULT NULL
)
```

**Round 4, Correction 4 adds the fourth parameter, `p_allowed_workspace_ids`.** The rollout plan (§6) has
always required allowed-workspace filtering during the internal-allowlist phase, but the canonical signature
never actually included a parameter for it — a real gap between what §6 promised and what this function
could enforce. Locked rules: `NULL` or empty `p_allowed_workspace_ids` returns **zero rows** (the allowlist
is authoritative and fails closed — a caller that forgets to pass it gets nothing claimed, never
"everything," which would be the dangerous failure direction); the candidate query includes `p.workspace_id
= ANY(p_allowed_workspace_ids)`; a non-allowlisted workspace's targets can never be claimed, full stop. The
worker passes the authoritative allowlist on every call (during the internal-workspace rollout phase, this
is the allowlist config itself; once broader rollout is approved, §6, it becomes "all workspaces" — but the
parameter and the check remain, they don't get removed post-launch).

Every other section of this document, the migration plan (`DATA_MODEL.md` §7), the test plan (§5), and the
route/worker code that calls it must use this exact four-parameter signature and no other — no section
describes a two- or three-parameter version as current.

**Correction 4 — the claim must be a real database transaction, not app-code SELECT-then-UPDATE.** A
Supabase/Next.js client issuing a `SELECT` over one round-trip and an `UPDATE` over a second round-trip is
two statements, not one transaction — Postgres-JS/PostgREST does not hold a transaction open across separate
client calls by default. The entire claim (selection + lock + update) happens inside one PL/pgSQL function
body, one implicit transaction.

**Round 3, Correction 8 — the locking shape itself was wrong, not just the transaction boundary.** The
round-2 body applied `FOR UPDATE SKIP LOCKED` to a **derived table** — a subquery containing a
`ROW_NUMBER() OVER (PARTITION BY workspace_id ...)` window function. `FOR UPDATE` on a windowed/aggregated
result is not a defensible base-row locking design: Postgres requires (and the round-2 SQL awkwardly worked
around, via correlated subqueries in the outer `ORDER BY`) locking to apply to the actual heap rows being
read, not to a computed window over them. Corrected to a **CTE chain that ranks candidates first (no lock),
then locks the exact real base-table rows by ID**.

**Final narrow correction (2026-07-18) — the function still didn't lock the parent it was joining.** Every
version through the prior amendment *joined* `pincode_monitored_products` to re-check `p.status = 'active'`
as part of the locking CTE's `WHERE` clause, but the `FOR UPDATE OF t SKIP LOCKED` clause named only `t` —
the parent was read, not locked. That does not fully enforce this document's own global lock order (§2.0:
parent before target): with no lock on the parent row, there is no serialization point between this claim
and a concurrent `remove_pincode_monitored_products`/archival-reconciliation/`set_pincode_tracking_state`
transaction that also touches that same parent — an archive or removal could commit at effectively the same
moment as the claim, and merely re-reading (not locking) `p.status` cannot guarantee which one the claim
transaction actually observes. Corrected to **two explicit locking phases in strict sequence**: lock the
distinct eligible parent rows first (`ORDER BY id`, plain `FOR UPDATE` — not `SKIP LOCKED`, see the code
comment below for why), revalidate their status/allowlist membership against the now-locked value, *then*
lock only the target rows whose parent survived that revalidation (`ORDER BY id`, `FOR UPDATE OF t SKIP
LOCKED`), revalidating the target itself a second time. This is the same two-step "lock parent, then lock
target, then revalidate" shape `finalize_pincode_check` (§2.7) and every mutating RPC in `DATA_MODEL.md`
already follow — the claim RPC was the one place that had drifted from it despite claiming to:

```sql
CREATE OR REPLACE FUNCTION public.claim_due_pincode_targets(
  p_limit                  integer,   -- bounded chunk size, NOT a large up-front batch -- §2.9 below
  p_invocation_id          text,
  p_excluded_workspace_ids uuid[] DEFAULT '{}',
  p_allowed_workspace_ids  uuid[] DEFAULT NULL
)
RETURNS SETOF public.pincode_tracking_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp  -- explicit, per Correction 4 -- never rely on the caller's search_path
AS $$
BEGIN
  -- Round-4 Correction 4: fail closed. NULL/empty allowlist claims
  -- nothing, ever -- never interpreted as "no restriction."
  IF p_allowed_workspace_ids IS NULL OR array_length(p_allowed_workspace_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    -- Step 1: rank candidates. Plain read, no lock -- Postgres is free to
    -- plan this however it likes against the due-index (DATA_MODEL.md §3).
    -- Joins the PARENT product and filters p.status='active' -- a target's
    -- own status enum has no 'archived' value (DATA_MODEL.md §2 Correction
    -- 13), so "is this claimable" genuinely requires the parent join, not
    -- a column on the target row alone. Also filters the allowlist here
    -- (Correction 4) so non-allowlisted workspaces never even become
    -- ranking candidates. Carries monitored_product_id out of this CTE too
    -- -- needed to drive the parent-locking step below.
    --
    -- Round-4 Correction 6: has_manual_request/next_check_at/workspace_id
    -- carried out of this CTE (not just used inside the window function)
    -- so the NEXT step can order by them globally -- see ranked_ids below.
    SELECT t.id, t.workspace_id, t.monitored_product_id,
           (t.manual_requested_at IS NOT NULL) AS has_manual_request,
           t.next_check_at,
           ROW_NUMBER() OVER (
             PARTITION BY t.workspace_id
             ORDER BY (t.manual_requested_at IS NOT NULL) DESC, t.next_check_at ASC
           ) AS rn
    FROM public.pincode_tracking_targets t
    JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
    WHERE t.status = 'active'
      AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
      AND p.status = 'active'
      AND p.workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (t.workspace_id = ANY (p_excluded_workspace_ids))
  ),
  ranked_ids AS (
    -- Step 2: exactly one target per workspace this fairness round
    -- (rn = 1). Round-4 Correction 6 fix: order the FINAL candidate set by
    -- has_manual_request DESC, next_check_at ASC, then workspace_id/id
    -- only as a deterministic tie-break -- NOT by id alone as round 3 did.
    -- Round 3's `ORDER BY id` lost manual-first priority globally: once
    -- the number of distinct eligible workspaces exceeds p_limit, a
    -- manual request in a workspace whose id sorts late could be dropped
    -- by LIMIT before a merely-scheduled check in an earlier-sorting
    -- workspace, even though manual requests must be globally preferred.
    -- Still just IDs -- no lock yet.
    SELECT id, monitored_product_id FROM candidates
    WHERE rn = 1
    ORDER BY has_manual_request DESC, next_check_at ASC, workspace_id, id
    LIMIT p_limit
  ),
  locked_parents AS (
    -- Round-4, final correction: lock order step 2 (§2.0) applied FOR
    -- REAL here -- the round-4-Correction-5 version of this function
    -- joined the parent to re-check its status but never actually LOCKED
    -- it, so an archive/remove transaction committing between the
    -- unlocked read and the target UPDATE below was not reliably excluded.
    -- Corrected: lock the DISTINCT eligible PARENT rows FIRST, ordered by
    -- id -- this is the real serialization point against
    -- enroll_pincode_monitored_products/set_pincode_tracking_state/
    -- remove_pincode_monitored_products/the archival reconciliation pass,
    -- every one of which also locks the parent before any target per the
    -- same global lock order. Deliberately plain FOR UPDATE, NOT SKIP
    -- LOCKED: skipping a locked parent would silently drop every one of
    -- its candidate targets from this chunk with no signal at all, whereas
    -- every parent-touching transaction in this schema is a short,
    -- single-row UPDATE (archive cascade, remove, pause, resume, manual-
    -- queue) -- briefly waiting for one to commit and then re-reading the
    -- fresh status is the correct, safe behavior, not a real stall risk.
    SELECT p.id, p.status, p.workspace_id
    FROM public.pincode_monitored_products p
    WHERE p.id IN (SELECT DISTINCT monitored_product_id FROM ranked_ids)
    ORDER BY p.id
    FOR UPDATE
  ),
  eligible_parents AS (
    -- Revalidate AFTER the parent lock -- status and allowlist/exclusion
    -- membership are re-checked against the fresh, now-locked value, not
    -- the unlocked read from step 1. A parent an archive/remove
    -- transaction just committed against is caught here and excluded.
    SELECT id FROM locked_parents
    WHERE status = 'active'
      AND workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (workspace_id = ANY (p_excluded_workspace_ids))
  ),
  locked_targets AS (
    -- Lock order step 3: lock the corresponding TARGET rows SECOND,
    -- ordered by id, restricted to targets whose parent survived
    -- revalidation above. FOR UPDATE OF t SKIP LOCKED is correct here --
    -- a target-row lock held by a concurrent claim/mutation is the
    -- ordinary SKIP LOCKED contention case (lose one row, not a
    -- correctness gap), unlike skipping an entire locked parent above.
    -- Revalidates the target itself too -- still 'active', still due,
    -- still actually pointing at a locked, still-active parent (same
    -- non-locking-lookup-then-lock-then-revalidate discipline as
    -- finalize_pincode_check, §2.7).
    SELECT t.id FROM public.pincode_tracking_targets t
    WHERE t.id IN (
      SELECT r.id FROM ranked_ids r
      JOIN eligible_parents ep ON ep.id = r.monitored_product_id
    )
      AND t.status = 'active'
      AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
      AND t.monitored_product_id IN (SELECT id FROM eligible_parents)
    ORDER BY t.id
    FOR UPDATE OF t SKIP LOCKED
  )
  -- Step 7: update only targets that survived both the parent lock/
  -- revalidation and the target lock/revalidation.
  UPDATE public.pincode_tracking_targets t
  SET status = 'checking',
      claimed_at = now(),
      claimed_by = p_invocation_id,
      claim_token = gen_random_uuid()
  FROM locked_targets
  WHERE t.id = locked_targets.id
  RETURNING t.*;
  -- Returns only rows successfully updated -- if a parent was locked by a
  -- concurrent transaction and its status changed, if SKIP LOCKED dropped
  -- some targets because a concurrent invocation already held their lock,
  -- or the revalidation predicates excluded some because their
  -- eligibility changed since ranking, fewer than p_limit rows come back
  -- -- never an incorrect double-claim, never a claim of a row whose
  -- parent is no longer active.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) TO service_role;
```

`claim_token` is freshly minted per claim (`gen_random_uuid()`), giving every claim a unique check-attempt
token (round 1 Correction 7 / round 2 idempotency design, §2.7). The function is `SECURITY DEFINER` with
`search_path` pinned explicitly and its `EXECUTE` privilege is revoked from `PUBLIC` and granted only to
`service_role` — never exposed broadly to `authenticated` users.

**Required before this migration is finalized (Correction 8's explicit requirement, expanded round 4):**
- **Concurrency-tested with two database connections** — fire two concurrent `claim_due_pincode_targets`
  calls against an overlapping due set; assert the returned row sets are disjoint (no target claimed twice)
  and that `SKIP LOCKED` causes the second caller to simply get fewer/different rows, never to block
  indefinitely or error.
- **Checked with `EXPLAIN ANALYZE`** against realistic data volume (representative due-target count and
  workspace-count distribution) before the migration is finalized — the `ROW_NUMBER() OVER (PARTITION BY
  workspace_id)` ranking step's query plan, and the subsequent ID-list lock step, must both be confirmed to
  use the due-index (`DATA_MODEL.md` §3) efficiently, not assumed.
- **Round 4, Correction 4 — allowlist enforcement:** call with `p_allowed_workspace_ids = NULL` and
  separately with `'{}'`; assert zero rows returned in both cases even when real due targets exist. Call with
  a non-empty allowlist that excludes a workspace with real due targets; assert that workspace's targets are
  never returned.
- **Round 4, Correction 5 — eligibility revalidated after locking, not just at candidate selection:** seed a
  target as a ranking candidate, then — before the claim transaction's lock step runs (e.g. via a
  concurrent transaction that commits first) — pause it, remove its parent, or archive its parent; assert
  the claim transaction does **not** claim it, even though it was a valid candidate at ranking time. A
  pause/remove/archive that commits before the guarded final `UPDATE` must win.
- **Round 4, Correction 6 — manual priority preserved globally across workspaces:** seed more distinct
  eligible workspaces than `p_limit`, with a manual request in a workspace whose `id` sorts numerically after
  several purely-scheduled workspaces; assert the manual request's target is still claimed within the
  `p_limit`-bounded result (global `has_manual_request DESC` ordering, not workspace-id ordering, determines
  what survives the `LIMIT`).
- **Final narrow correction — claim genuinely serializes against parent-locking transactions, not just a
  re-read of parent status:**
  - **Claim vs. parent archival** — start a claim transaction concurrently with an archival-reconciliation
    transaction against the same product's parent row; assert whichever transaction locks the parent first
    completes, the other observes the post-commit state (the claim never claims a target whose parent the
    archival transaction just archived, regardless of statement interleaving).
  - **Claim vs. product removal** — same shape, with `remove_pincode_monitored_products` in place of
    archival; assert the same outcome.
  - **Claim vs. pause** — same shape, with `set_pincode_tracking_state` (pause) in place of archival; a
    concurrent pause of the target itself (not just the parent) must also be observed correctly by the claim.
  - **No deadlock** — run claim concurrently with each of the above, and with `finalize_pincode_check` and
    `queue_pincode_manual_check`, against overlapping products; assert none of these combinations deadlock or
    lock-wait-timeout, confirming the claim RPC's now-explicit parent-then-target locking is consistent with
    every other RPC's lock order (§2.0).
  - **Non-active parent is never claimed** — directly assert, across many randomized concurrent
    interleavings, that no claimed row's parent is ever observed to be non-`active` at the moment the claim's
    `UPDATE` commits — the correctness property this whole correction exists to guarantee, not just its
    individual test cases.

**Correction 7 (round 2, restated here since this is now the canonical location) — Manual Check Now uses
this same one claim path, not a second hidden one.** A manual request becomes eligible the moment
`manual_requested_at IS NOT NULL` and `next_check_at` is pulled forward to `now()` (set atomically by
`queue_pincode_manual_check`, §2.10) — the `ROW_NUMBER() ... ORDER BY (manual_requested_at IS NOT NULL) DESC`
clause above already prioritizes it within its workspace's turn. There is no `p_limit = 1`/target-id-filter
variant of this function anywhere — that was a round-1 description of a parameter that was never actually
added, corrected in round 2, restated here for clarity since this section is the signature's single source
of truth.

**Correction 5 — do not claim a large batch up front while checking budget per-unit.** The first draft
claimed `LIMIT 40` rows, then checked the runtime budget before processing each one — a cutoff mid-batch
leaves the *remaining already-claimed* rows stuck in `'checking'` with no worker touching them until
stale-claim reclaim eventually notices (15 minutes later, §2.4). Corrected to **bounded chunk claims**:

1. Call `claim_due_pincode_targets(p_limit = <chunk size, ≤ concurrency, §2.2>, p_invocation_id,
   p_excluded_workspace_ids, p_allowed_workspace_ids)` — all four canonical parameters, every call.
2. Process and **fully finalize** every row in that chunk (via `finalize_pincode_check`, §2.7) before doing
   anything else — a chunk is never left partially processed.
3. Check the runtime budget.
4. If sufficient safe budget remains (enough for at least one more full chunk at the worst-case duration
   from §2.2's calculation), claim another chunk and repeat. If not, stop cleanly — **zero** targets are left
   `'checking'` merely because the runtime guard stopped the cycle normally, because no chunk is ever claimed
   without the worker immediately, synchronously processing it to completion.
5. (Documented alternative, not chosen: explicitly release every unprocessed claim before returning, i.e.
   `UPDATE ... SET status='active', claimed_at=NULL, ... WHERE claim_token = ANY(...)` for any row claimed
   but not finalized. **Bounded chunk claims are preferred** — per the correction's own reasoning, they
   naturally keep claimed work aligned with work actually about to start, rather than requiring a
   release-on-the-way-out safety net for a scenario bounded claiming makes structurally impossible.)

This changes the batch/concurrency relationship from "one 40-row claim, 8-wide worker pool" to "many small
claims, each sized to fit inside one wave of the chosen concurrency" — consistent with §2.2's corrected,
benchmark-pending default (concurrency 4, chunk size 4 as the starting point).

### 2.9 Per-workspace limits and fairness — Correction 9 (round 2), fairness mechanism (round 2 Correction 6, round 3 Correction 8)

**The first draft's cap was a no-op.** `PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_PER_CYCLE, default
200` cannot do anything when the per-invocation batch size is 40 (§2.2's first-draft number) — a single
workspace fills the *entire* batch at 40 targets, 5x under its own 200 cap, and every other workspace's due
targets simply wait, cap or no cap. The cap was solving a problem the batch size made structurally
impossible to reach.

**The round-2 fairness design was not actually implementable** (Correction 6) — it referred to "a
per-workspace cap per invocation" and reasoned about "workspaces already claimed once this invocation," but
`finalize_pincode_check` (§2.7) clears `claimed_by`/`claim_token` on every completed target — by design, so a
finalized row doesn't look perpetually claimed. That means the **database alone cannot tell**, by looking at
current target rows, which workspaces this invocation already served — the information doesn't persist
anywhere once a chunk finalizes. Corrected to a mechanism where the **worker process**, not the database,
holds invocation-scoped fairness state, and the canonical claim RPC (§2.8, now with its locking shape also
fixed per round-3 Correction 8) is given that state explicitly on each call:

1. The worker (not the database) maintains a **served-workspace set** in memory, scoped to the current
   invocation, empty at invocation start, plus the invocation's authoritative `p_allowed_workspace_ids`
   (round-4 Correction 4 — sourced from the feature-flag/allowlist config during the internal-workspace
   rollout phase, §6).
2. Each call to `claim_due_pincode_targets` (§2.8's one canonical four-parameter signature) claims **at most
   one target per distinct, non-excluded, allowlisted workspace** — one fairness round, with manual requests
   preferred **globally** across the whole round, not just within each workspace's own slot (round-4
   Correction 6 — see §2.8's `ranked_ids` ordering).
3. After each chunk returns, the worker adds every distinct `workspace_id` present in the returned rows to
   its in-memory excluded set and calls again with the updated `p_excluded_workspace_ids` (and the same,
   unchanged `p_allowed_workspace_ids` every call within the invocation).
4. When a call returns **zero rows** (every workspace with due work has now had a claim this round, or no
   due work remains), the worker **clears the excluded set** and begins another round — provided runtime
   budget remains (§2.3/§2.8) and `dueBacklogRemaining` (§2.13) is still nonzero.
5. A per-workspace-per-invocation processed-count cap (`PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_PER_
   CYCLE`) remains as **defense-in-depth** on top of the round-robin mechanism above — even with fair
   round-robin claiming, a single very-large workspace could still consume many rounds' worth of capacity
   over a long invocation; the cap bounds that independent of how fair each individual round is. Default set
   relative to the benchmark-pending chunk size/invocation budget (§2.2), not an arbitrary number a small
   batch could never reach.

This makes "no single workspace's backlog starves another's" an actual, testable property of the algorithm
(round-robin across workspaces, one target per workspace per round, locking real base rows per Correction 8)
rather than an emergent hope from `ORDER BY next_check_at`. Required test: fair selection across multiple
workspaces with simultaneously due backlogs (§5 test #8) — assert no single workspace's backlog starves
another's within one invocation, using the round mechanism above, not a vaguer "assert fairness" check.

Full quota-tiering by plan remains explicitly P1 (ties into "shared tracking quota," decision #6 — now
**locked** for P0 as a single configurable capped-enrollment limit, `DATA_MODEL.md` §2b — commercial
per-plan tiers are the P1 item, separate from this per-cycle scheduler fairness mechanism).

### 2.10 Manual "Check Now" — genuinely queued via an atomic RPC, corrected through round 3

**Round 1 fixed "synchronous" but left a race** — cooldown/quota/status reads in the route, then a separate
service-role `UPDATE`, letting a concurrent second click pass the route's own checks before the first
click's write commits. **Round 2 fixed that with one atomic RPC, but left two more problems, both closed in
round 3:**

- **Correction 4** — the RPC tested `v_target.status = 'archived'`, but the target's own status enum has no
  such value; archived is a fact about the **parent** `pincode_monitored_products` row.
- **Correction 9** — `p_manual_quota_remaining` was computed by the calling route **outside** the RPC's
  transaction, so it was stale the instant a concurrent request changed the count between the route's read
  and the RPC's write.

**Round 3 also incorporates the founder's locked manual-quota decision (`DATA_MODEL.md` §2c): Manual Check
Now does not consume the enrollment quota at all** — it has its own, separate outstanding-request limit,
computed atomically inside this same RPC.

**Round 4 also fixes the lock order (Correction 2, §2.0) and adds explicit workspace/marketplace
revalidation (Correction 3) — this RPC was the specific case Correction 3 called out: the supplied
`p_marketplace_id` controls the advisory-lock key and the outstanding-count pool, but round 3 never actually
validated it against the target's real parent.** Round 3 also locked the target before the parent and
acquired the advisory lock last, both backwards from the canonical order.

```sql
CREATE OR REPLACE FUNCTION public.queue_pincode_manual_check(
  p_target_id uuid,
  p_workspace_id uuid,
  p_marketplace_id text,
  p_user_id uuid,
  p_cooldown_seconds integer,
  p_manual_pending_limit integer  -- the CONFIGURED limit only -- current usage is computed inside, not passed in
)
RETURNS jsonb  -- { result: 'queued'|'already_queued'|'checking'|'invalid_status'|'cooldown'|'quota_exceeded', ... }
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lookup_product_id uuid;
  v_target  public.pincode_tracking_targets;
  v_product public.pincode_monitored_products;
  v_outstanding integer;
BEGIN
  -- Round-4 Correction 14: parameter bounds, before any lock or query.
  -- An environment-variable typo must never produce an unbounded
  -- cooldown or an effectively-unlimited manual queue.
  IF p_cooldown_seconds IS NULL OR p_cooldown_seconds < 0 OR p_cooldown_seconds > 3600 THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'invalid_cooldown_seconds');
  END IF;
  IF p_manual_pending_limit IS NULL OR p_manual_pending_limit <= 0 THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'invalid_manual_pending_limit');
  END IF;

  -- Round-4 Correction 2 (global lock order, §2.0): acquire the advisory
  -- lock FIRST for this RPC (unlike finalize_pincode_check, this RPC's
  -- target/parent identity is already known from its own parameters --
  -- there's no claim-token indirection to resolve before deciding which
  -- lock to take).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Non-locking lookup to identify which parent to lock (same discipline
  -- as finalize_pincode_check, §2.7) -- also the first opportunity to
  -- reject an unknown/wrong-workspace target before taking any row lock.
  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE id = p_target_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  -- Lock order step 2: lock the PARENT first.
  SELECT p.* INTO v_product FROM public.pincode_monitored_products p
    WHERE p.id = v_lookup_product_id
    FOR UPDATE;

  -- Round-4 Correction 3: re-validate the locked parent's own
  -- workspace_id/marketplace_id actually match what the caller claimed --
  -- do not trust p_workspace_id/p_marketplace_id merely because the
  -- (trusted) route supplied them. This is the specific gap Correction 3
  -- named: p_marketplace_id controls the advisory-lock key and the
  -- outstanding-count pool below, so an unvalidated mismatch here would
  -- let a caller manipulate which quota pool a request counts against.
  IF v_product.workspace_id <> p_workspace_id OR v_product.marketplace_id <> p_marketplace_id THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'workspace_marketplace_mismatch');
  END IF;

  -- Lock order step 3: lock the TARGET second, re-validating the
  -- parent-child relationship in the same WHERE clause (Correction 3
  -- again -- the target's own workspace_id and monitored_product_id must
  -- still agree with what was just locked).
  SELECT t.* INTO v_target FROM public.pincode_tracking_targets t
    WHERE t.id = p_target_id
      AND t.workspace_id = p_workspace_id
      AND t.monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  -- Lock order step 4: revalidate current state, corrected status-test
  -- matrix (parent status checked FIRST and independently of target
  -- status -- an archived/removed parent rejects regardless of what the
  -- target's own status happens to be).
  IF v_product.status IN ('archived', 'removed') THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'product_archived_or_removed');
  END IF;

  IF v_target.status = 'checking' THEN
    RETURN jsonb_build_object('result', 'checking');  -- already in flight, do not create another request
  ELSIF v_target.status = 'paused' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'paused_requires_resume');
  ELSIF v_target.status = 'failed' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'failed_requires_resume');
  END IF;
  -- Only (parent active, target active) reaches here.

  IF v_target.manual_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_queued', 'manual_request_token', v_target.manual_request_token);
  END IF;

  IF v_target.last_checked_at IS NOT NULL
     AND v_target.last_checked_at > now() - make_interval(secs => p_cooldown_seconds) THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_seconds', p_cooldown_seconds - extract(epoch FROM now() - v_target.last_checked_at)::int);
  END IF;

  -- Lock order step 5: count outstanding requests and queue atomically.
  -- The advisory lock was already acquired first (above), so this count
  -- can't race a concurrent queue_pincode_manual_check call for a
  -- DIFFERENT target in the same workspace+marketplace.
  --
  -- "Outstanding" per DATA_MODEL.md §2c: queued (manual_requested_at set,
  -- not yet checking) OR checking (manual_requested_at set, status =
  -- 'checking'). Both count.
  SELECT count(*) INTO v_outstanding
  FROM public.pincode_tracking_targets t2
  JOIN public.pincode_monitored_products p2 ON p2.id = t2.monitored_product_id
  WHERE p2.workspace_id = p_workspace_id
    AND p2.marketplace_id = p_marketplace_id
    AND t2.manual_requested_at IS NOT NULL;

  IF v_outstanding >= p_manual_pending_limit THEN
    RETURN jsonb_build_object('result', 'quota_exceeded',
      'currentOutstanding', v_outstanding, 'limit', p_manual_pending_limit);
  END IF;

  UPDATE public.pincode_tracking_targets
  SET manual_requested_at = now(),
      manual_requested_by = p_user_id,
      manual_request_token = gen_random_uuid(),
      next_check_at = now()
  WHERE id = p_target_id AND workspace_id = p_workspace_id AND status = 'active'
  RETURNING manual_request_token INTO STRICT v_target.manual_request_token;

  RETURN jsonb_build_object('result', 'queued', 'manual_request_token', v_target.manual_request_token);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, text, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, text, uuid, integer, integer) TO service_role;
```

**Corrected status-behavior matrix (Correction 4 — parent-first, not a `target.status = 'archived'` test that
never could have matched anything):**

| Parent product status | Target status | Behavior |
|---|---|---|
| `active` | `active` | May queue (subject to cooldown/outstanding-limit checks above). |
| `active` | `checking` | Returns `result: 'checking'` — **does not** create another request. |
| `active` | `paused` | Rejected — requires Resume first. |
| `active` | `failed` | Rejected — requires Resume first (Check Now is not a backdoor around the failed-state's explicit resume requirement, §2.5). |
| `archived` or `removed` | *(any)* | Rejected — cannot check, regardless of the target's own status. |

**Route contract:** `POST /api/pincode-monitoring/check-now` validates session, workspace membership, and
role (not `viewer`, `DATA_MODEL.md` §6), then calls `queue_pincode_manual_check` via the service-role client
supplying only the **configured** `p_manual_pending_limit` (`PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_
MARKETPLACE`, `DATA_MODEL.md` §2c) — never a precomputed usage count, which the round-2 design got wrong and
this round fixes — and maps the RPC's `result` field to HTTP: **`202 Accepted` only when `result =
'queued'`**; `'already_queued'` or `'checking'` → `200` with the current status (not an error — the request
is legitimately already in flight, coalesced); `'cooldown'` → `429` with `retry_after_seconds`;
`'quota_exceeded'` → **`409 { errorCode: 'pincode_manual_queue_limit_reached', currentOutstanding, limit }`**
— a **distinct `errorCode` from `DATA_MODEL.md` §2b's `pincode_tracking_quota_exceeded`**, since enrollment
capacity and manual-queue pressure are different concepts a seller should be able to tell apart, per the
founder's explicit instruction not to reuse the enrollment error; `'invalid_status'` → `409` with the
specific reason. **Concurrent clicks are guaranteed to produce exactly one `manual_request_token`** — the
`FOR UPDATE` lock inside the RPC, not client-side debouncing or a separate read-then-write pair, is what
makes this true.

The scheduler's normal due-query (§2.8/§2.9) picks the request up — `next_check_at = now()` makes it
immediately due, and the fairness round-robin (§2.9's corrected mechanism) orders manually-requested targets
first within each workspace's turn. `finalize_pincode_check` (§2.7) clears `manual_requested_at`/
`manual_requested_by`/`manual_request_token` alongside the normal claim fields on completion.

The UI polls or subscribes for the target's status and renders **Queued → Checking → Complete/Failed** —
never a numeric queue position in P0 (that stays P1, per §1).

This satisfies decision #9 ("safely queued and rate-controlled") literally — the browser never blocks on the
external check, one atomic RPC (not a read-then-write pair, not a stale precomputed value) makes
cooldown/outstanding-limit/status/coalescing checks race-free, and the same claim/finalize discipline
(§2.7/§2.8) processes manual requests through the one scheduler claim path.

**Required tests (round 3):**
- Manual status-behavior matrix — call `queue_pincode_manual_check` against every (parent status × target
  status) combination in the table above; assert each returns the exact locked `result` value.
- Outstanding-limit enforcement computed atomically — fire enough concurrent `queue_pincode_manual_check`
  calls across different targets in the same workspace+marketplace to exceed
  `PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE`; assert exactly the configured number succeed
  and the rest return `quota_exceeded` with an accurate `currentOutstanding` — never more than the limit
  queued due to a race.
- Manual quota is independent of enrollment quota — exhaust the enrollment quota (`DATA_MODEL.md` §2b) for a
  workspace+marketplace, then assert Manual Check Now on an already-enrolled, already-active target still
  succeeds (subject only to its own cooldown/outstanding limit) — confirms the two pools never interfere.

**Required tests (round 4):**
- Workspace/marketplace mismatch rejection (Correction 3) — call with a `p_marketplace_id` that doesn't
  match the target's actual parent's `marketplace_id`; assert `workspace_marketplace_mismatch`, not a
  successful queue against the wrong quota pool.
- Parameter bounds (Correction 14) — call with `p_cooldown_seconds = -1`, `p_cooldown_seconds = 999999`, and
  `p_manual_pending_limit = 0`; assert each is rejected before any lock or query, never silently clamped or
  treated as "unlimited."
- Lock order — run `queue_pincode_manual_check` concurrently with `finalize_pincode_check` and
  `set_pincode_tracking_state` against the same target (§2.0's required deadlock test applies here too).

### 2.11 Duplicate-check protection
The `pincode_tracking_targets_uidx UNIQUE (monitored_product_id, pincode)` constraint (Data Model §3)
already makes a duplicate *target* structurally impossible. Duplicate *simultaneous checks* of the same
target are prevented by the claim RPC itself (§2.8) — a target already `status = 'checking'` is invisible to
`claim_due_pincode_targets`'s due-query (`WHERE status = 'active'`), and a concurrent Manual Check Now
request against an already-checking target is coalesced by §2.10's `manual_request_token IS NULL` guard
rather than double-claiming.

### 2.12 Chunk cadence within an invocation
Corrected per §2.8 — bounded chunk claims (not a single large batch) are themselves the mechanism that
keeps one invocation's work aligned with its runtime budget; §2.2's benchmark determines chunk size and the
number of chunks one invocation can safely process. Cron frequency (hourly, §2.14) combined with repeated
chunk claims within each invocation drains the due backlog across cycles even at conservative concurrency.
A dedicated backlog-drain accelerator (matching the review-requests "no longer wait 4 hours after a failed
cycle" pattern this session applied operationally) is available as an operational tool if backlog ever
grows unexpectedly, without needing new code — the same worker can simply be invoked again immediately.

### 2.13 Monitoring — Correction 5 (2026-07-18): honest, disambiguated reporting
P0 requirement (not P1): every invocation logs a structured, greppable cycle summary — this is what let this
session verify 3 consecutive production cron cycles for review-requests without any dashboard, and the same
discipline applies here. The first draft's `targetsClaimed/Completed/Failed/staleClaimsReclaimed/
stoppedDueToRuntimeBudget` set is corrected/expanded so "stopped normally" can never be confused with "left
work stuck":

- `targetsSelected` — how many due targets were visible to select from at query time (before claiming).
- `targetsClaimed` — how many were actually claimed this invocation, across all chunks.
- `targetsCompleted` — claimed **and** successfully finalized (§2.7).
- `targetsFailed` — claimed, finalized, but the check itself resulted in `check_status = 'failed'`.
- `targetsReleased` — claimed but explicitly released without a check running (should be ~0 under the
  bounded-chunk design, §2.8 — a nonzero value here is itself a signal worth alerting on).
- `dueBacklogRemaining` — how many targets are still due after this invocation ends (lets an operator see
  backlog trend without a dashboard).
- `stoppedDueToRuntimeBudget` — boolean, true only when the invocation stopped because it declined to claim
  another chunk (never because a claimed chunk was abandoned mid-flight — under §2.8's design, a `true` here
  is always paired with zero stuck `'checking'` rows, and `IMPLEMENTATION_PLAN.md` §5 test #5 verifies this
  invariant directly).

A Data-Health dashboard *card* surfacing this is P1; the underlying structured-log observability above is
P0 because shipping a scheduler with zero visibility into whether it's actually running would repeat exactly
the kind of silent-failure risk this whole audit-first methodology exists to prevent.

### 2.14 Cron wiring — Correction 8 (2026-07-18): route names unified

**The round-1 draft used a different scheduler route name here (`/api/cron/pincode/scheduler`) than the
Product Spec used in its own route map (`/api/cron/pincode-monitoring/process-eligibility` +
`/api/pincode-monitoring/jobs/process-eligibility`), and this section additionally overstated the cron entry
count as "two new `vercel.json` cron entries" when only one is actually described.** Both are corrected and
**locked** here, and must match `PRODUCT_SPEC.md` §11 exactly (that document is amended to the same names in
this round):

- **Cron relay:** `GET /api/cron/pincode-monitoring/scheduler`
- **Protected worker:** `POST /api/pincode-monitoring/jobs/scheduler`

There is **one new Vercel cron entry** (the relay above) and **one protected worker route** it calls — not
two cron entries. Suggested cadence for the one cron entry: hourly (`0 * * * *`) — frequent enough that a
24h-cadence target is never more than ~1h late, infrequent enough to stay well within any reasonable
invocation budget. No second cron entry is needed for reconciliation (`DATA_MODEL.md` §5's archived-product
cascade) — it runs as a cheap pre-step inside the same scheduler invocation, not a separate cron, since it
only needs to run about as often as the scheduler itself already does.

---

## 3. Phasing (revised 2026-07-18)

### P0 — must ship together, this is the minimum that honors the 13 locked decisions, corrected

**Round 2 sequenced this list into 4 separately-reviewed implementation PRs (P0-A/B/C/D) — see §9. Round 3
added items 16 (pause/resume RPC), 17 (removed-status), and 18 (feature-flag enforcement at every layer).
Round 4 revises item 4 to **6** RPCs, item 17 to the new dedicated remove RPC, and adds items 19–21 (global
lock order, three-value parent lifecycle, composite/RESTRICT history FKs) — §9 is the authority on
sequencing, this list is the authority on scope.**

1. Migration: precondition composite-FK-target constraints on `amazon_listing_items`/`tracked_asins`
   (`DATA_MODEL.md` §2, Correction 2).
2. Migration: `workspace_default_pincodes`, `pincode_monitored_products` (including `.removed_at`/
   `.removal_reason`, round-3 Correction 6), `pincode_tracking_targets` + RLS (`SELECT`-only for members on
   **all three** tables) + `updated_at` triggers + the `claim_token` partial unique index (`DATA_MODEL.md`
   §1–3, §6).
3. Migration: `pincode_availability_results.monitored_product_id` + `.tracking_target_id` +
   `.check_attempt_id` + `.check_status` additive columns + indexes + **the two immediately-addable CHECK
   constraints from round-3 Correction 11** (identity-consistency, new-row-result-consistency)
   (`DATA_MODEL.md` §4/§4a) — **not** the `check_status`-format CHECK constraint, which alone is gated on the
   read-only production audit's backfill (now recorded with real numbers, `DATA_MODEL.md` §4a).
4. Migration: **six** RPC functions — `claim_due_pincode_targets` (§2.8, the one canonical four-parameter
   signature, now including `p_allowed_workspace_ids` per round-4 Correction 4), `finalize_pincode_check`
   (§2.7, round-4 NULL-safe validation + corrected lock order), `enroll_pincode_monitored_products`
   (`DATA_MODEL.md` §2a — bulk, all-or-nothing, advisory-lock-serialized, atomic re-add restore per round-4
   Correction 10), `queue_pincode_manual_check` (§2.10, round-4 workspace/marketplace revalidation +
   corrected lock order), `set_pincode_tracking_state` (`DATA_MODEL.md` §3a, pause/resume), and
   **`remove_pincode_monitored_products` (`DATA_MODEL.md` §3b, round-4 Correction 8 — new this round,
   product-level soft removal)** — all six `SECURITY DEFINER`, explicit `search_path`, `service_role`-only
   `EXECUTE`, all following the one global lock order (§2.0) and validating their own parameters before any
   lock or query (round-4 Correction 14) (`DATA_MODEL.md` §7).
5. Route `/dashboard/pincode-checker` + nav item + legacy redirect confirmation (`PRODUCT_SPEC.md` §4).
6. My Products tab: list from `amazon_listing_items`, bulk-enroll via `enroll_pincode_monitored_products`
   (`PRODUCT_SPEC.md` §5.1, `DATA_MODEL.md` §2a) — quota-checked per item 15 below, **all-or-nothing per
   round-3 Correction 2** (a 5-product bulk request is never partially enrolled).
7. Other Products tab: single-ASIN enrollment with a **real SP-API lookup and preview**
   (`PRODUCT_SPEC.md` §6, Correction 11 round 2 — moved from P1 into P0, see §4 below), plus Other→Owned
   promotion (`PRODUCT_SPEC.md` §5.2 Correction 1, `DATA_MODEL.md` §5).
8. Pincode Settings panel: `workspace_default_pincodes` CRUD via authenticated server routes — `SELECT`-only
   RLS, no direct member table writes, matching the other two tables (`PRODUCT_SPEC.md` §5.3, `DATA_MODEL.md`
   §6).
9. Tracker table: product→pincode expansion, corrected five-state renders (`PRODUCT_SPEC.md` §7–8,
   Correction 8 round 1), **plus a Removed filter alongside the existing Archived filter** (round-3
   Correction 6).
10. **Minimal recurring scheduler**, corrected: the one canonical atomic bounded-chunk claim RPC with
    base-row-locking round-robin workspace fairness (round-3 Corrections 7/8), atomic idempotent finalize RPC
    with validate-before-insert ordering and parent-aware in-flight-archival handling (round-3 Corrections
    4/5/10/11), honest disambiguated reporting (§2 of this document, all subsections) — per the trade-off
    resolution in §1, this is P0, not deferred.
11. Manual Check Now — **genuinely queued through one atomic RPC** (`queue_pincode_manual_check`), with
    per-target cooldown and a **separate, configurable outstanding-request limit that does NOT draw from the
    enrollment quota** (round-3 locked founder decision, `DATA_MODEL.md` §2c) and the corrected,
    parent-aware per-status behavior table (§2.10).
12. Archived-product cascade reconciliation, extended for the owned-FK-null and Other→Owned cases
    (`DATA_MODEL.md` §5, Correction 1 round 1) **and corrected to leave in-flight `checking` targets alone**
    (round-3 Correction 5).
13. **Internal-workspace feature flag / allowlist** gating enrollment and the scheduler cron until the
    staged rollout (§6, Correction 12 round 1) reaches GREEN — **enforced at every API/RPC layer, not just
    the UI** (round-3 Correction 12, item 18 below).
14. Constraints and validation (`DATA_MODEL.md` §2/§3): cadence bounds, non-negative failure counts,
    claim-field consistency, ASIN/pincode format, `updated_at` triggers.
15. **Capped enrollment quota, locked founder decision** (`DATA_MODEL.md` §2b) — one active
    product×pincode target per workspace+marketplace as the quota unit, enforced atomically (advisory-lock
    serialized, round-3 Correction 1) inside enrollment and resume, `409 pincode_tracking_quota_exceeded` on
    rejection, one configurable internal-workspace limit for P0 (exact number set alongside the P0-A
    implementation PR, not invented in this spec).
16. **Pause/resume via the fifth RPC** (`set_pincode_tracking_state`, `DATA_MODEL.md` §3a, round-3
    Correction 3) — bulk, atomic, quota-checked on resume, in-flight-safe on pause (`checking` targets
    rejected with `409 check_in_progress`, never yanked out from under the worker).
17. **Soft "Remove Tracking" via the sixth RPC** (`remove_pincode_monitored_products`, `DATA_MODEL.md` §3b,
    round-4 Correction 8 — atomic product-level mutation, not independent route-level updates) —
    distinguishable from source-driven `archived` (round-4 Correction 9: `removed` takes precedence, the
    reconciliation pass never overwrites a removed product back to `archived`), preserves history,
    quota-freeing, restorable on re-add via the same atomic path as enrollment (round-4 Correction 10).
18. **Feature flag enforced at every layer, not just the hidden UI** (round-3 Correction 12) — see §6's
    rollout plan.
19. **One global database lock order** (§2.0, round-4 Correction 2) applied to every RPC without exception —
    prevents the cross-RPC deadlock risk the round-3 designs' inconsistent lock orders created.
20. **Parent lifecycle simplified to three states** (`active`/`archived`/`removed`, round-4 Correction 13) —
    "Paused"/"Failed"/"Partially active" at the product level are derived from child target statuses, never
    a fourth parent-level lifecycle value.
21. **Composite target identity + `RESTRICT` history FKs** (round-4 Corrections 11/12) — proves a result's
    `tracking_target_id` and `monitored_product_id` actually agree with each other, and a hard delete of a
    monitored product/target with history is rejected outright rather than silently nulling the reference.

### P1 — real but not blocking the core promise
- Per-workspace configurable cadence (schema already supports it, §2.1).
- Exponential backoff on retry (§2.5) and adaptive backoff on block detection (§2.6).
- True priority/visible-position queue for Check Now (§2.10 already ships genuinely queued in P0; only the
  numeric position UI is deferred).
- Full commercial quota-tiering by plan (decision #6's per-plan variant) — P0 ships one configurable
  internal-workspace limit (item 15 above, `DATA_MODEL.md` §2b); different limits per subscription plan is
  the P1 refinement.
- Data-Health dashboard card surfacing scheduler cycle summaries (§2.13).
- CSV/export of tracker table.
- Broader (beyond-internal-workspace) rollout, gated on GREEN verification per §6.

### P2
- Alerts (explicitly stays disabled per decision #13 — this is a "someday," not scheduled).
- Historical trend charts per product×pincode.
- Bulk pincode-set templates (e.g., "top 20 metro pincodes") beyond the flat default-pincode list.
- Eventual `pincode_checks`/`pincode_availability_results` history-table consolidation (explicitly not this
  phase, decision #11).

---

## 4. Other Products lookup path — corrected: this is P0, not a P1 deferral (Correction 11, 2026-07-18)

**The first draft contradicted itself.** `PRODUCT_SPEC.md` §6 (before this amendment) said the exact SP-API
lookup helper was "unconfirmed" and needed "its own short research pass," while this section then quietly
concluded that manual ASIN-entry-and-trust was "an honest, shippable P0 experience" and moved the real
lookup to P1. That let P0 enroll an ASIN Amazon never confirmed exists — directly against the founder's
instruction ("if Amazon cannot confirm the ASIN, do not enroll it as a valid product") and the explicit
request for "search by ASIN, preview the product, select it, then track it" as one flow, not a two-phase
rollout.

**Resolved:** the research pass this section said was missing has now been done, in this correction round —
`src/lib/amazon/catalog.ts`'s `getCatalogItemForAsin()` is a real, already-shipped, already-reused (3
existing call sites) SP-API Catalog Items helper. There is no remaining "unconfirmed helper" blocker.
`PRODUCT_SPEC.md` §6 (Correction 11) now specifies the exact P0 flow: real lookup, honest
found/not-found/lookup-failed states, no enrollment of an unconfirmed ASIN, no scraping, no user cookies, no
fabricated metadata. This is **P0 scope item 7** above, not a P1 item — the contradiction is closed, not
just documented.

What genuinely does stay P1: caching/pre-fetching lookup results for autocomplete-style search-as-you-type
(the founder's "search by ASIN" is satisfied by a single confirm-on-submit lookup in P0; a richer
type-ahead search experience is a UX enhancement, not part of the trustworthiness requirement).

---

## 5. Test plan (expanded across 4 amendment rounds, 2026-07-18 — corrections-driven; the original 18 plus
round 2's #19–25, round 3's inline RPC-section tests, and round 4's global lock-order, NULL-safety,
allowlist, eligibility-revalidation, manual-priority, parent-aware-reclaim, atomic-restore, and
removed-precedence tests, listed inline throughout §2 and summarized where each RPC is specified)

- **Unit-level (scripts/*.ts convention, matches `test-keyword-found-status.ts` / `test-pincode-status.ts`
  precedent):**
  - `classifyPincodeAvailability`/`classifyFulfillment` reuse — no new tests needed, already covered.
  - New: scheduler pure-logic tests — `next_check_at` computation (normal, retry, blocked-cooldown paths),
    `consecutive_failures` threshold transition to `'failed'`, due-query predicate correctness (mock rows
    covering every status × next_check_at combination, assert exactly the expected subset is "due").
  - New: `pincode_monitored_products` enrollment dedup logic (My Products bulk-enroll skips ASINs already
    enrolled; Other Products rejects an ASIN that's already in My Products, per `PRODUCT_SPEC.md` §5.2).
- **Integration (against a scratch/staging Supabase branch, never production) — the 18 required tests from
  the 2026-07-18 correction round:**
  1. **Cross-workspace FK rejection** (Correction 2) — attempt to set `amazon_listing_item_id`/
     `tracked_asin_id`/`monitored_product_id` on a row from workspace A to a real row belonging to workspace
     B; assert the composite FK rejects it.
  2. **Unauthorized direct mutation rejection, all three tables** (Correction 3, strengthened round-2
     Correction 5) — as an authenticated `viewer`-role member, attempt a direct table `UPDATE`/`INSERT` on
     each of `pincode_tracking_targets` (`status='checking'`/`claimed_at`/`next_check_at`),
     `pincode_monitored_products` (`status`), **and `workspace_default_pincodes`** (add/remove a pincode);
     assert RLS rejects all three (no member-facing write policy exists on any of them) — this specifically
     closes the round-1 gap where `workspace_default_pincodes` still had a member-CRUD RLS policy a `viewer`
     could have used to bypass its server route's role check.
  3. **Atomic chunk claim with concurrent invocations** (Correction 4) — fire `claim_due_pincode_targets`
     from two concurrent connections against the same due set; assert the row sets returned are disjoint.
  4. **No duplicate claim** (Correction 4/8) — assert a target claimed by one invocation is invisible to a
     second concurrent claim call until released/finalized.
  5. **Runtime stop leaves zero normally-unprocessed checking rows** (Correction 5) — force a tiny runtime
     budget mid-run; assert every claimed chunk was fully finalized before the invocation stopped, and zero
     `'checking'` rows exist immediately after a `stoppedDueToRuntimeBudget: true` invocation.
  6. **Idempotent finalize retry creates one result only** (Correction 7, round-2 Correction 3) — call
     `finalize_pincode_check` twice with the same `claim_token` while the target is still owned by that
     token; assert exactly one `pincode_availability_results` row exists and the second call returns the
     first call's recorded outcome, not an error and not a duplicate.
  7. **Crash after external check but before finalize is safely recoverable** (Correction 7) — simulate a
     claimed target with no corresponding finalize call and an old `updated_at`; run stale-claim reclaim;
     assert it's reset to `'active'` (claim fields cleared) and re-claimable, with no orphaned result row.
  7a. **Stale finalize after reclaim cannot corrupt a new claim** (round-2 Correction 3's required race test)
      — claim attempt A (token T_A) → force stale-claim reclaim on that target → claim attempt B (new token
      T_B, same target) → call `finalize_pincode_check(T_A, ...)`; assert it raises `stale_check_attempt`,
      inserts **zero** result rows, and leaves B's claim/target state completely unmodified → then call
      `finalize_pincode_check(T_B, ...)` normally; assert it succeeds and exactly **one** new
      `pincode_availability_results` row exists, owned by T_B's `check_attempt_id`. This is stronger than
      test #6 — #6 covers a retried call with the *same* still-valid token; this covers a *stale* token whose
      target has moved on to a different claim.
  8. **Fair selection across multiple workspaces** (Correction 9, round-2 Correction 6) — seed
     simultaneously-due backlogs in workspace A (large) and workspace B (small); run the round-robin claim
     mechanism (§2.9) for one invocation; assert workspace B's due targets are claimed within the first
     round, not starved by workspace A's larger backlog — this must exercise the actual
     `p_excluded_workspace_ids` round mechanism, not just assert an aggregate outcome.
  9. **Queued Manual Check Now coalescing via the atomic RPC** (Correction 10, round-2 Correction 4) — fire
     two concurrent `queue_pincode_manual_check` calls for the same target; assert only one
     `manual_request_token` is ever set (the `FOR UPDATE` row lock inside the RPC, not client debouncing,
     must be what prevents the second call from creating a second token) and the second call's `result` is
     `'already_queued'`, not a new queue entry.
  9a. **Manual Check Now status-behavior matrix** (round-2 Correction 4's locked table, §2.10) — call
      `queue_pincode_manual_check` against a target in each of the five statuses (`active`, `checking`,
      `paused`, `failed`, `archived`); assert each returns exactly the locked `result` value (`queued`,
      `checking`, `invalid_status`/`paused_requires_resume`, `invalid_status`/`failed_requires_resume`,
      `invalid_status`/`archived_cannot_check` respectively) and that only the `active` case ever creates a
      `manual_request_token`.
  10. **Cooldown/quota enforcement, both dimensions** (Correction 10, round-2 Correction 4) — request Check
      Now twice within the cooldown window; assert the second returns `result: 'cooldown'` with an accurate
      `retry_after_seconds`, not silently queued twice. Separately, exhaust a workspace's enrollment quota
      (`DATA_MODEL.md` §2b) and assert both a further enrollment attempt **and** a resume-of-a-paused-target
      attempt return exactly the locked `409 { errorCode: 'pincode_tracking_quota_exceeded',
      currentActiveTargets, requestedAdditionalTargets, limit }` shape — not a generic error, not a silent
      partial enrollment.
  11. **SP-API lookup success/failure** (Correction 11) — mock `getCatalogItemForAsin` returning a real
      item, a 404 (`catalog_not_found`), and a transient error (`catalog_unavailable`); assert each renders
      its own distinct, honest UI state and only the success case is enrollable.
  12. **Existing owned ASIN entered as Other does not duplicate** (Correction 1) — enroll an ASIN as "My
      Product," then attempt Other Products enrollment of the same ASIN; assert the existing row is returned/
      reused, no duplicate `pincode_monitored_products` row is created.
  13. **Other Product later becoming owned preserves history** (Correction 1) — enroll an ASIN as "Other,"
      accumulate `pincode_availability_results` history, then simulate the ASIN appearing in
      `amazon_listing_items`; run the reconciliation promotion; assert `product_source` flips to `'owned'`,
      the row `id` is unchanged, and all prior history rows still join correctly.
  14. **Archive/source deletion preserves history** (Correction 1) — hard-delete a source `amazon_listing_
      items` row referenced by an owned monitored product; assert the FK nulls per `ON DELETE SET NULL`, the
      reconciliation pass archives the monitored product, and its full history remains queryable.
  15. **Legacy result rows remain readable** (Correction 8) — assert pre-existing `pincode_availability_
      results` rows (predating `check_status`) are still selectable and do not violate any new constraint
      after the additive-column migration (before the CHECK constraint migration is even applied).
  16. **Existing result-status values are migration-compatible** (Correction 8) — run the read-only audit
      query from `DATA_MODEL.md` §4a against a snapshot of current production-shaped data; assert every
      distinct `availability_status`/`error_code` combination found maps cleanly to the documented
      `check_status` backfill rule, or is explicitly reported as an exception requiring a decision before the
      CHECK-constraint migration is written.
  17. **Blocked, failed, unknown, and unavailable remain distinct** (Correction 8) — assert the five-state
      mapping table in `DATA_MODEL.md` §4a renders four visually and semantically distinct UI states for
      `blocked`/`failed`/`unknown`/`unavailable` inputs — no two collapse to the same rendered label/tone.
  18. **Measured capacity stays inside runtime budget with safety margin** (Correction 6) — using the
      benchmarked p95 (or worst-case 55s if p95 data is unavailable at test time) and the chosen chunk
      size/concurrency, assert the modeled worst-case duration for the maximum number of chunks one
      invocation could claim stays at or under 80% of `PINCODE_SCHEDULER_RUNTIME_BUDGET_MS` (the acceptance
      threshold from §2.2).
  - Also retained from the first draft: full claim → check → finalize cycle with a mocked/stubbed
    pincode-check function (no real Amazon scraping in CI); archived-product cascade end-to-end.
- **Round 3 additions (2026-07-18) — required, in addition to the 18 above:**
  19. **Bulk enrollment is genuinely all-or-nothing** (Correction 2) — submit a 5-product×6-pincode bulk
      enrollment where the total would exceed quota by a small margin; assert **zero** rows are created for
      **any** product/pincode in the batch, not a partially-applied subset.
  20. **Concurrent enrollment/resume requests serialize correctly under quota pressure** (Correction 1) —
      fire two concurrent enrollment (or resume) requests that would jointly exceed quota if both succeeded
      naively; assert they serialize on the advisory lock and the final active-target count never exceeds
      the configured limit, regardless of which request "wins."
  21. **Pause/resume bulk atomicity and in-flight safety** (Correction 3) — bulk-resume a mix of `paused` and
      `failed` targets where the projected count would exceed quota; assert the whole operation is rejected,
      none resumed. Separately, bulk-pause a mix including one `checking` target; assert the `checking`
      target is rejected with `409 check_in_progress` and (per this RPC's all-or-nothing discipline) the
      whole batch is rejected, not a partial pause.
  22. **Manual Check Now parent-vs-target status matrix** (Correction 4) — covered in detail under §2.10's
      own required-tests list; referenced here for completeness of the full required-test count.
  23. **Removed vs. archived stay distinguishable** (Correction 6) — remove a product via the user-facing
      Remove Tracking action; assert `removed_at`/`removal_reason` are set, the product is hidden from the
      default tracker view but visible under a Removed filter, and it renders with a label distinct from an
      `archived` product in the same list. Separately, re-add a previously-removed ASIN; assert the same
      `pincode_monitored_products.id` and full history are restored, not a new row.
  24. **`claim_due_pincode_targets` concurrency and query-plan validation** (Correction 8) — covered in detail
      under §2.8's own required-tests list (two-connection concurrency test, `EXPLAIN ANALYZE`); referenced
      here for completeness.
  25. **Feature-flag bypass rejection at every layer** (Correction 12) — for a workspace **not** on the
      internal allowlist, attempt a direct authenticated call to each of: the lookup route, the enrollment
      route, the defaults routes, the pause/resume/remove routes, `queue_pincode_manual_check`, and confirm
      `claim_due_pincode_targets` never returns that workspace's targets even if rows exist for it (e.g. from
      before it was removed from the allowlist) — assert every layer rejects independently, not relying on
      "the UI is hidden" as the only boundary.
- **Manual/production verification (after deploy, before declaring done — same discipline as the Keywords
  and Pincode P0 rounds):**
  - Visual check of all five product/pincode state combinations reachable through a real authenticated
    account; honestly report any state not observable (same rule the user set for Keywords P0 — **do not
    manufacture synthetic enrollment/tracking data merely for visual verification**).
  - One full natural cron cycle observed end-to-end via structured logs, same as the 3-cycle review-requests
    verification precedent — performed only against the internal-workspace feature flag (Correction 12, §6),
    never broad production data, until GREEN.

---

## 6. Rollout plan — corrected: staged, feature-flagged, never broad-before-scheduler (Correction 12, 2026-07-18)

**The first draft's sequencing created a false promise.** Shipping the enrollment UI to 100% of production
before the scheduler cron was wired ("scheduler cron wiring last, only after enrollment flows have been live
long enough to have at least one real row") meant real sellers could enroll real products, see "recurring
tracking" implied by the UI, and have **no scheduler actually running yet** — exactly the false-promise
failure mode Correction 12 flags, and exactly what §1 of this document argues the whole recurring-scheduler
P0 decision exists to prevent. Corrected to a staged rollout with an explicit gate:

1. **Additive migrations** (`DATA_MODEL.md` §7, all 4 steps) — deployed and verified via `execute_sql`
   schema checks before any app code ships. Zero risk to existing tables, as before.
2. **Backend APIs and worker deployed with the feature disabled** — all new routes and the scheduler
   worker code ship to production, but gated behind a feature flag/workspace allowlist (below) that keeps
   them inert for every workspace except the internal test workspace. No enrollment UI is reachable yet.
3. **Scheduler route deployed and protected** — the cron entry exists and can run, but its due-query and
   claim function only ever see rows created under the allowlist gate (step 2), so there is nothing for it
   to falsely promise against yet.
4. **Scheduler verified against controlled non-production/staging fixtures** — a scratch/staging Supabase
   branch (never production data) exercises the full claim → check (mocked) → finalize cycle, the fairness
   algorithm (§2.9), and the runtime-budget-stop invariant (§5 test #5) before any real cron invocation
   against live data.
5. **Unified UI enabled for the internal test workspace only** — implemented as a feature flag/workspace
   allowlist check (same shape as `PINCODE_ALERTS_PAUSED` and the existing internal-test-account pattern,
   `023_assign_internal_test_account.sql`) gating both the enrollment UI's visibility and the
   `enroll_pincode_monitored_products` RPC's acceptance of new enrollments.
6. **Enroll a small real test set** — a handful of real products/pincodes in the internal workspace, through
   the actual UI, not synthetic rows inserted directly.
7. **Observe the first natural production cycle** — the scheduler cron fires on its normal schedule against
   this real (but internal-only) data; structured logs (§2.13) are checked, not just trusted, matching the
   review-requests 3-cycle verification bar carried over from the first draft.
8. **Expand rollout after GREEN verification** — only once step 7 is confirmed GREEN (claims are atomic, no
   stuck `'checking'` rows, results are truthful, fairness holds) does the feature flag/allowlist widen
   beyond the internal workspace — this expansion is itself a P1 rollout step (§3), not automatic, and
   requires separate approval, consistent with "do not expose recurring enrollment broadly while the
   scheduler is absent" and this doc's own "do not implement without separate explicit approval" framing.

**Round 3, Correction 12 — the flag must protect every layer, not just the hidden UI.** P0-B (`IMPLEMENTATION_
PLAN.md` §9) ships the API routes before P0-C ships the UI that calls them — meaning the routes are
technically reachable (a direct authenticated call, bypassing the UI entirely) before there's any UI gate to
hide behind. **"No enrollment UI is reachable yet" (step 2 above) is necessary but not sufficient** — a
caller who already knows the route shapes could otherwise enroll, request a manual check, or read tracker
data for a non-allowlisted workspace by calling the API directly. Every layer below must independently
enforce the same internal-workspace allowlist, not just the UI's own visibility check:

- **Lookup route** (`POST /api/pincode-monitoring/lookup-asin`) — rejects for a non-allowlisted workspace.
- **Enrollment route/RPC** (`enroll_pincode_monitored_products`) — rejects for a non-allowlisted workspace;
  this was already true per step 5 above ("gating ... the RPC's acceptance of new enrollments"), restated
  here as one instance of the general rule, not a special case.
- **Defaults mutation routes** (`workspace_default_pincodes` CRUD) — rejects for a non-allowlisted workspace.
- **Pause/resume/remove routes** (`set_pincode_tracking_state`, `DATA_MODEL.md` §3a) — rejects for a
  non-allowlisted workspace.
- **Manual Check Now queue RPC** (`queue_pincode_manual_check`) — rejects for a non-allowlisted workspace.
- **Scheduler claim RPC** (`claim_due_pincode_targets`) — must receive or derive the allowed-workspace scope
  and **never claim a target belonging to a non-allowlisted workspace**, even if one somehow exists (e.g. a
  workspace was allowlisted, enrolled targets, then was removed from the allowlist before broader rollout
  approval) — implemented as an additional `AND p.workspace_id = ANY(p_allowed_workspace_ids)` predicate (or
  equivalent) in the candidates CTE (§2.8), sourced from the same allowlist config every other layer reads,
  not a separately-maintained list that could drift out of sync.

A caller must not be able to bypass the hidden UI by directly invoking a route or RPC — every mutation and
every claim path checks the allowlist independently, so the UI being hidden is a convenience for normal
users, not the actual security/scope boundary.

The feature flag/allowlist is the single gate controlling "can this workspace see the enrollment UI," "will
any API route accept a request for this workspace," and "will the scheduler claim this workspace's
targets" — there is no path where a workspace can enroll, mutate, or get claimed by the scheduler without
that same allowlist check passing at every layer independently.

## 7. Rollback plan
- App code: standard Vercel rollback to the prior deployment — the new route is additive and, under the
  corrected staged rollout (§6), never exposed beyond the internal-workspace allowlist until GREEN, so a
  rollback has zero blast radius on any real seller's data at any rollout stage.
- Feature flag/allowlist: can be narrowed or disabled instantly (no deployment needed) if an issue surfaces
  after expansion — the fastest rollback lever, checked first before a full app-code rollback.
- Scheduler cron: can be disabled independently of the app code by removing its `vercel.json` entry and
  redeploying — targets simply stop advancing `next_check_at`, no data loss, resumable at any later time
  (all `pincode_tracking_targets` rows just accumulate a growing "overdue" gap, self-heals once the cron
  resumes).
- Migrations: additive-only by design (`DATA_MODEL.md` §7) — no rollback migration is anticipated to be
  necessary; if ever needed, the new tables can be dropped independently without touching
  `pincode_checks`/`pincode_availability_results`/`tracked_asins`/`amazon_listing_items`, none of which this
  plan modifies destructively. The precondition `UNIQUE (workspace_id, id)` constraints added to
  `amazon_listing_items`/`tracked_asins` (`DATA_MODEL.md` §2) are themselves trivially droppable without
  data loss if ever needed, since they add no new data, only a constraint on already-unique columns.

## 8. Unresolved risks (carried forward honestly, not hidden — updated 2026-07-18)
1. ~~SP-API catalog lookup helper is unconfirmed~~ — **resolved by this correction round.**
   `getCatalogItemForAsin()` in `src/lib/amazon/catalog.ts` is confirmed real and already in production use
   at 3 call sites (§4, Correction 11). No longer a risk; moved to P0 scope.
2. ~~Shared tracking quota enforcement point is not fully designed~~ — **resolved: founder decision locked,
   round 2.** Capped enrollment with explicit `409 pincode_tracking_quota_exceeded` rejection, quota unit =
   one active product×pincode target per workspace+marketplace, enforced atomically inside the enrollment
   and resume RPCs (`DATA_MODEL.md` §2b). The exact numeric limit remains a config value set alongside the
   P0-A implementation PR (§9), not invented in this spec — that narrow piece (the *number*, not the
   *design*) is the only part still open.
3. **Real-world block/CAPTCHA rate is unknown** — §2.6's fixed 2x cooldown multiplier is a reasonable
   starting guess, not measured against actual Amazon-storefront-scrape block rates for this feature. May
   need tuning after the first week of production data. Unchanged by this correction round.
4. **Capacity (batch/concurrency) is explicitly deferred to a pre-implementation benchmark, not a risk to
   silently carry into production** (Correction 6, §2.2) — this replaces the first draft's "cron frequency
   vs. actual check-latency budget is unverified at scale" risk with an actual required step: the benchmark
   and its acceptance threshold (≥20% runtime-budget safety margin against worst-case duration) must be
   completed and documented *before* the scheduler cron is enabled even for the internal test workspace
   (§6 step 4). This is now a gating requirement, not an open risk carried into rollout.
5. ~~`check_status` production-value audit outcome is unknown until performed~~ — **resolved, round 2.** Audit
   run against production: 18 rows `available`/no-error, 7 rows `unknown`/error, no other combination exists
   (`DATA_MODEL.md` §4a). Residual, smaller risk: a row written between the 2026-07-18 audit and whenever the
   backfill migration actually runs could theoretically fall outside these two buckets — the migration must
   re-run the audit query immediately before backfilling, not trust this document's numbers as still current
   after time has passed.
6. **Per-workspace fairness algorithm's exact query shape is now locked (round 3, Corrections 7/8) but still
   not benchmarked** — the round-2 windowed-derived-table locking flaw is fixed (§2.8 now locks real base
   rows via a CTE chain), and there is now exactly one canonical function signature, but its performance at
   realistic data volume (`EXPLAIN ANALYZE` against a representative due-target count and workspace-count
   distribution) is still not yet measured. This is now purely a benchmarking task, not a design gap — both
   the locking correctness and the algorithm are locked; only query-plan performance needs validating before
   the migration is finalized (§2.8's explicit requirement).
7. ~~Manual quota computation is not itself specified as its own quota pool~~ — **resolved, round 3, founder
   decision locked.** Manual Check Now does **not** draw from the enrollment quota at all — it has its own
   separate, configurable outstanding-request limit (`PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_
   MARKETPLACE`), computed atomically inside `queue_pincode_manual_check` itself under the same advisory lock
   discipline as enrollment (`DATA_MODEL.md` §2c). No longer open.
8. **`set_pincode_tracking_state`'s bulk-pause "reject the whole batch if any target is `checking`" behavior
   has UX implications not fully explored** (round 3, `DATA_MODEL.md` §3a) — rejecting an entire bulk pause
   because one of many selected targets happens to be mid-check is correct for safety but could be a mildly
   frustrating UX if a seller selects 50 targets and 1 is checking; the spec's chosen behavior (reject whole
   batch, let the UI prompt to retry without the in-flight target) is a reasonable P0 default but hasn't been
   validated against a real multi-select UI mockup — flagged for P0-C's UI implementation to confirm the
   error messaging is clear enough that this doesn't read as a confusing failure.
9. **Advisory lock key collisions across truly unrelated workspaces are theoretically possible but
   unmeasured in practice** (round 3, Correction 1) — `hashtextextended` is a 64-bit hash; collision
   probability for realistic workspace/marketplace cardinality is astronomically low, but the spec has not
   run a birthday-bound calculation against expected production scale. Flagged for completeness — the
   consequence of a collision is harmless extra serialization (§2a), never incorrect quota enforcement, so
   this is a performance risk at worst, not a correctness one.

---

## 9. Locked implementation sequence — Correction 10 (2026-07-18): P0 splits into 4 reviewable PRs

**P0's scope (§3) is too large and too risky for one implementation PR** — it spans schema/RPC design,
server-side API surface, a full UI, and a live scheduler with real external side effects (storefront
checks). One undifferentiated PR would force a single review pass to simultaneously validate SQL correctness,
API contract correctness, UI correctness, and scheduler runtime behavior, with no natural checkpoint to
catch a problem in an earlier layer before it's built on by a later one. **Locked sequence, each stage its
own separately reviewed and approved PR — no stage starts until the prior stage is approved, and no
migration is applied merely because the spec (this document) is being built or amended:**

### P0-A — Data audit and schema/RPC foundation
- Production-value read-only audit recorded (done in this document, §4a of `DATA_MODEL.md` — the PR
  re-confirms it's still current before backfilling).
- Additive migrations (`DATA_MODEL.md` §7, all 4 steps): precondition composite-FK-target constraints, the 3
  new tables (including `pincode_monitored_products.removed_at`/`.removal_reason`, and the **three-value**
  parent `status` CHECK per round-4 Correction 13) + RLS + triggers + `claim_token` uniqueness + the
  composite `pincode_tracking_targets_identity_uidx` (round-4 Correction 12), the 4 additive
  `pincode_availability_results` columns + `RESTRICT`-not-`SET NULL` FKs (round-4 Correction 11) + indexes +
  the immediately-addable CHECK constraints (identity-consistency, NULL-safe new-row-result-consistency per
  round-4 Correction 1), the **six** RPC functions.
- Composite FKs (workspace-scoped, `DATA_MODEL.md` §2/§3/§4), including the three-column composite proving a
  result's target and product agree (round-4 Correction 12).
- RLS (`SELECT`-only for members on all three new tables, `DATA_MODEL.md` §6).
- Quota enforcement wired into `enroll_pincode_monitored_products` and `set_pincode_tracking_state`'s resume
  path, both serialized on the same deterministic advisory lock (`DATA_MODEL.md` §2a/§2b) — manual-check
  quota (`DATA_MODEL.md` §2c) wired separately, does not draw from this pool.
- **Six** RPCs, all following the one global lock order (§2.0, round-4 Correction 2) and validating their own
  parameters up front (round-4 Correction 14): `enroll_pincode_monitored_products` (bulk, all-or-nothing,
  concurrency-safe, atomic re-add restore, round-4 Corrections 1/2/10), `set_pincode_tracking_state`
  (pause/resume), `remove_pincode_monitored_products` (product-level soft removal, round-4 Correction 8, new
  this round), `queue_pincode_manual_check` (workspace/marketplace-revalidated, round-4 Correction 3),
  `claim_due_pincode_targets` (the one canonical four-parameter signature with allowlist enforcement and
  post-lock eligibility revalidation, round-4 Corrections 4/5/6), `finalize_pincode_check` (NULL-safe
  validation, corrected lock order, round-4 Corrections 1/2) — matching this document's and `DATA_MODEL.md`'s
  corrected specs exactly (§2.0, §2.7, §2.8, §2.9, §2.10, `DATA_MODEL.md` §2a/§3a/§3b).
- **Allowlist scoping wired into every RPC from the start** (Correction 12, round 3) — `claim_due_pincode_
  targets`'s `p_allowed_workspace_ids` parameter (round-4 Correction 4) and every mutating RPC's own
  workspace/marketplace revalidation (round-4 Correction 3) are both P0-A-stage requirements, not bolted on
  later.
- Scratch/staging integration tests — the test plan from §5, including round-4's additions: the global
  lock-order deadlock test (§2.0), NULL-safe finalize validation with actual SQL `NULL` inputs, allowlist
  fail-closed tests, post-lock eligibility revalidation, global manual-priority preservation, parent-aware
  stale-claim reclaim (all four branches), the atomic re-add-restore test, removed-precedence-over-archived,
  the remove-RPC's in-flight-checking-target behavior, and parameter-bounds rejection tests — plus every
  test carried forward from rounds 1–3.
- Feature disabled — no route, no UI, nothing user-reachable yet. This PR is pure database + RPC surface.

### P0-B — API and data-access layer
- Lookup route (`POST /api/pincode-monitoring/lookup-asin`, `PRODUCT_SPEC.md` §6/§11).
- Enrollment routes (`POST /api/pincode-monitoring/products`, calling `enroll_pincode_monitored_products`
  with the full bulk payload, never split into per-product calls). **PR #55 review round, Correction 1:**
  every distinct `productSource: 'other'` ASIN is confirmed server-side (via the same Catalog Items helper as
  the lookup route, connection/token loaded once per request, bounded concurrency) BEFORE this RPC ever
  runs — the RPC has no SP-API access of its own and cannot verify anything, and a caller reaching this
  route directly (skipping a prior lookup-asin call) must not be able to enroll a blind, unconfirmed ASIN.
  The whole bulk request is rejected if any Other Product fails to confirm; only Amazon-confirmed metadata is
  ever written for an 'other'-source product, never a client-supplied snapshot.
- Edit Pincodes route (`PATCH /api/pincode-monitoring/products/[id]/pincodes`, calling the new
  `replace_pincode_product_targets` RPC, `DATA_MODEL.md` §3c) — **PR #55 review round, Correction 2: this
  route was missing entirely from the original P0-B implementation** despite being in this locked route map
  since P0-B's own scope was first written; found and closed in review.
- Defaults routes (`GET`/`PUT /api/pincode-monitoring/default-pincodes`, `PUT` now calling the new atomic
  `replace_workspace_default_pincodes` RPC, `DATA_MODEL.md` §1 — **PR #55 review round, Correction 3:** the
  original implementation issued two separate, non-atomic PostgREST write requests).
- Tracker query route (`GET /api/pincode-monitoring/tracker`, now backed by the bounded
  `get_pincode_target_results` RPC, `DATA_MODEL.md` §3d — **PR #55 review round, Correction 4:** the original
  implementation fetched every historical result row for a page's targets and deduplicated in application
  code, unbounded and silently wrong beyond the query layer's default response cap; replaced with a bounded,
  indexed, database-side read returning `latestAttempt` and `lastConfirmedAvailability` as two explicit,
  never-conflated facts).
- Pause/resume routes (calling `set_pincode_tracking_state`, `DATA_MODEL.md` §3a) and a Remove Tracking route
  (setting `pincode_monitored_products.status = 'removed'`, round-3 Correction 6, distinct from the
  archival-only reconciliation path). **PR #55 review round, Correction 6:** both are strictly product-scoped
  to the URL's `[id]` — an optional request-body ID array may only NARROW the URL product's own target/
  product set, never widen it to another product; the prior round's `productIds`/unrestricted `targetIds`
  override let a product-scoped URL act as a hidden cross-product bulk endpoint, closed this round. No
  dedicated cross-product bulk endpoint exists in P0-B.
- Check Now route (`POST /api/pincode-monitoring/check-now`, calling `queue_pincode_manual_check`).
- All routes enforce the role model from `DATA_MODEL.md` §6 (session → membership → role, `viewer` → `403`)
  **and independently enforce the internal-workspace allowlist** (round-3 Correction 12, §6's updated
  rollout plan) — every route rejects a non-allowlisted workspace on its own, not relying on the UI being
  hidden as the only gate. **PR #55 review round, Correction 5:** the access gate additionally validates
  `workspaceId` is a syntactically valid UUID before any query, validates the requested marketplace is
  actually authorized for that exact workspace (the canonical source: `amazon_connections`, one row per
  workspace, its own `marketplace_id` column — 006 migration), and checks role against an explicit runtime
  allowlist (`owner`/`admin`/`member` write, `viewer` read-only, any OTHER role value rejected outright as
  `unknown_role` rather than treated as either).
- No public UI enablement — these routes are reachable only by direct authenticated call (e.g. from tests or
  internal tooling) until P0-C ships the UI that calls them; the allowlist check above is what actually
  prevents a non-allowlisted caller from using them even at this stage, not merely the absence of a UI link.

### P0-C — Internal-workspace UI
- Unified page (`/dashboard/pincode-checker`, `PRODUCT_SPEC.md` §4).
- My Products tab, Other Products tab (with the real SP-API lookup/preview from P0-B wired in).
- Default pincode management panel.
- Expandable tracker table, corrected five-state renders (`PRODUCT_SPEC.md` §7–8).
- Gated behind the **internal-workspace allowlist only** (§6's rollout step 5) — no broader visibility yet.
- No scheduler is running yet at this stage — enrolling here creates real rows with real `next_check_at`
  values, but nothing claims them until P0-D ships; this is acceptable *only* because it's confined to the
  internal allowlist, never exposed broadly (this is exactly the ordering §6's rollout plan exists to
  enforce).

### P0-D — Scheduler and rollout
- Checker adapter reuse (the existing `checker-worker` pincode checker, wired to `finalize_pincode_check`'s
  inputs — no new checker logic, reuse what §2.2's benchmark already measured).
- Bounded worker implementing §2.8's chunk-claim loop + §2.9's fairness rounds.
- Cron relay (`GET /api/cron/pincode-monitoring/scheduler`) + protected worker (`POST
  /api/pincode-monitoring/jobs/scheduler`) — the unified names from §2.14.
- Structured logs (§2.13's full field set).
- Benchmark-derived concurrency/chunk defaults (§2.2's required pre-implementation benchmark happens here,
  before this PR's scheduler is ever pointed at real due data).
- First controlled test set — a handful of real enrollments in the internal workspace (§6 rollout step 6).
- Natural production cycle verification — observed, not just trusted (§6 rollout step 7).
- Broader rollout remains **blocked** until GREEN (§6 rollout step 8) — expanding the feature flag/allowlist
  beyond the internal workspace is a decision made *after* this PR merges and verifies GREEN, not part of
  the PR itself.

**Each of the four PRs requires its own separate review and approval** — approving this spec (the current
PR) is not approval to merge all four implementation PRs; each is its own gate. No migration from P0-A is
applied, and no code from P0-B/C/D is written, while this spec document itself is still being built, amended,
or reviewed — this document's own repeated "do not implement, do not migrate, do not deploy" instruction
applies to all four stages, not just the first.
