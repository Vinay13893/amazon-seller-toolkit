# Pincode Checker — Unified Page Implementation Plan

**Status:** Plan only, amended. No code, no migration, no deployment in this round or the prior one.
**Companion:** `PINCODE_UNIFIED_PAGE_PRODUCT_SPEC.md`, `PINCODE_UNIFIED_PAGE_DATA_MODEL.md`.

**Amendment (2026-07-18):** the first draft's scheduler was not actually atomic (a Supabase/Next.js client
cannot safely `SELECT ... FOR UPDATE SKIP LOCKED` then `UPDATE` later and call it one transaction), claimed
40 rows up front while checking the runtime budget per-unit (leaving unstarted rows stuck `checking` on
budget cutoff), reused review-request concurrency numbers for a checker with a measured 55s worst case
without modeling whether that fits the runtime budget, called append-only duplicate inserts "idempotent,"
made Manual Check Now synchronous (contradicting the founder's "queued" decision), and moved the
founder-required trustworthy Other Products lookup to P1. All corrected below, marked **"Correction N
(2026-07-18)"** inline.

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

### 2.4 Stale job reclaim
Before claiming new targets, the worker runs one reclaim pass: any `pincode_tracking_targets` row with
`status = 'checking'` and `updated_at` older than a threshold (`PINCODE_SCHEDULER_STALE_CLAIM_MINUTES`,
default 15 — long enough that no legitimate single pincode check should still be running, short enough that
a genuinely crashed claim doesn't block that target for hours) is reset to `status = 'active'`. This is a
plain `UPDATE ... SET status = 'active', claimed_at = NULL, claimed_by = NULL, claim_token = NULL WHERE
status = 'checking' AND updated_at < now() - interval '15 minutes'` — clearing `claim_token` alongside the
other claim fields is required by `DATA_MODEL.md` §3's claim-field-consistency CHECK (Correction 13: a
non-`'checking'` row must not retain any claim field). Relies on the same `updated_at`-bumps-on-every-UPDATE
trigger already used for `review_solicitation_orders` reclaim — no new trigger needed, the pattern is
proven. This is the exact recovery path for Correction 7's "crash after external check but before finalize"
case (§5 test #7): the row is safely reclaimed and re-checked, never left stuck.

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
  `DATA_MODEL.md` §3 — minted fresh by `claim_due_pincode_targets`, §2.8 below) — this is the
  **check-attempt identity**, not just a worker-identity marker.
- `pincode_availability_results` gains a `check_attempt_id uuid` column (additive) with a **`UNIQUE`**
  constraint — this is the idempotency key for result history, replacing plain append-only `INSERT`.
- Finalization — writing the result **and** updating the target — happens through **one atomic RPC**,
  `finalize_pincode_check(claim_token, check_status, availability_status, ...)`:
  1. `INSERT INTO pincode_availability_results (..., check_attempt_id) VALUES (..., claim_token) ON
     CONFLICT (check_attempt_id) DO NOTHING RETURNING id` — if this attempt was already recorded (a retried
     finalize call after the app lost the original response, but the transaction had already committed),
     the `INSERT` is a no-op and the function returns the **already-recorded** result rather than raising or
     inserting a duplicate.
  2. In the same transaction: `UPDATE pincode_tracking_targets SET status = <next status>, last_checked_at =
     now(), next_check_at = <computed>, consecutive_failures = <updated>, claimed_at = NULL, claimed_by =
     NULL, claim_token = NULL WHERE id = <target id> AND claim_token = <the same token>` — the `WHERE
     ... AND claim_token = ...` guard means a finalize call carrying a stale/already-cleared token
     (because a previous call already completed it) affects zero rows instead of corrupting a
     *different* claim's state; the RPC checks the row count and, if zero, returns the already-recorded
     result from step 1 rather than erroring.
  3. Both steps commit together or not at all — a crash between the external Amazon/checker call completing
     and this RPC being invoked leaves the target still `'checking'` under its original `claim_token`,
     safely picked up by stale-claim reclaim (§2.4); a crash **during** this RPC is rolled back entirely by
     the transaction, so there is no partial state where a result exists but the target wasn't updated, or
     vice versa.
- **What stays outside the transaction, deliberately:** the external Amazon/checker-worker HTTP call itself.
  Only result persistence + target finalization are atomic and idempotent — the plan does not attempt to
  make an external network call transactional, that's not possible and isn't what "atomic finalization"
  means here.
- Cycle-level reporting is corrected to the fields Correction 5 requires (§2.13) — `targetsCompleted` is
  only incremented after `finalize_pincode_check` confirms (whether it inserted fresh or returned an
  already-recorded result), never assumed from the external call succeeding alone.

### 2.8 Atomic claim RPC and bounded chunk claims — Corrections 4 and 5 (2026-07-18)

**Correction 4 — the claim must be a real database transaction, not app-code SELECT-then-UPDATE.** The
first draft's `SELECT ... FOR UPDATE SKIP LOCKED` followed by "the same transaction sets status='checking'"
described the right Postgres primitive but the wrong boundary: a Supabase/Next.js client issuing a `SELECT`
over one round-trip and an `UPDATE` over a second round-trip is **two statements**, not one transaction —
Postgres-JS/PostgREST does not hold a transaction open across separate client calls by default. Corrected to
a single database function:

```sql
CREATE OR REPLACE FUNCTION public.claim_due_pincode_targets(
  p_limit         integer,   -- bounded chunk size, NOT a large up-front batch -- see below
  p_invocation_id text
)
RETURNS SETOF public.pincode_tracking_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp  -- explicit, per Correction 4 -- never rely on the caller's search_path
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.pincode_tracking_targets t
  SET status = 'checking',
      claimed_at = now(),
      claimed_by = p_invocation_id,
      claim_token = gen_random_uuid()
  FROM (
    SELECT id FROM public.pincode_tracking_targets
    WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= now()
    ORDER BY next_check_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) AS due
  WHERE t.id = due.id
  RETURNING t.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text) TO service_role;
```

The `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` shape runs the row-lock selection and the guarded
update **inside one PL/pgSQL function body, inside one implicit transaction** — this is the actual atomic
primitive Correction 4 requires, not the two-round-trip version. `claim_token` is freshly minted per claim
(`gen_random_uuid()`), giving every claim a unique check-attempt token per Correction 7. The function is
`SECURITY DEFINER` with `search_path` pinned explicitly (never left to resolve against the caller's
session-mutable `search_path` — a documented Postgres `SECURITY DEFINER` footgun) and its `EXECUTE`
privilege is revoked from `PUBLIC` and granted only to `service_role` — it is **never** exposed broadly to
`authenticated` users, satisfying Correction 4's explicit requirement. Manual Check Now (§2.10) uses the
same function (with `p_limit = 1` and a target-id filter, see §2.10) rather than a separate, divergent claim
path — one atomic primitive, two callers.

**Correction 5 — do not claim a large batch up front while checking budget per-unit.** The first draft
claimed `LIMIT 40` rows, then checked the runtime budget before processing each one — a cutoff mid-batch
leaves the *remaining already-claimed* rows stuck in `'checking'` with no worker touching them until
stale-claim reclaim eventually notices (15 minutes later, §2.4). Corrected to **bounded chunk claims**:

1. Call `claim_due_pincode_targets(p_limit = <chunk size, ≤ concurrency, §2.2>, p_invocation_id)`.
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

### 2.9 Per-workspace limits and fairness — Correction 9 (2026-07-18)

**The first draft's cap was a no-op.** `PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_PER_CYCLE, default
200` cannot do anything when the per-invocation batch size is 40 (§2.2's first-draft number) — a single
workspace fills the *entire* batch at 40 targets, 5x under its own 200 cap, and every other workspace's due
targets simply wait, cap or no cap. The cap was solving a problem the batch size made structurally
impossible to reach.

**Corrected fairness design**, aligned with the corrected due-index (`DATA_MODEL.md` §3 — `(next_check_at,
workspace_id)`, a genuinely global, cross-workspace ordering) and the bounded chunk claims (§2.8):

- `claim_due_pincode_targets` (§2.8) claims a small chunk (≤ concurrency, §2.2) per call, many times per
  cron invocation — this alone already reduces one workspace's ability to monopolize a single claim compared
  to one large 40-row grab, but ordering alone (`ORDER BY next_check_at ASC`) can still let one workspace
  with many overdue targets dominate consecutive chunks within one invocation.
- Add an explicit **per-workspace share inside the claim function**: extend `claim_due_pincode_targets` to
  accept a per-workspace cap *per invocation* (not per chunk) — e.g. round-robin across distinct
  `workspace_id`s present in the due set before taking a second target from any workspace already claimed
  once this invocation, implemented as a `DISTINCT ON (workspace_id)`-ordered pre-selection inside the CTE,
  falling back to plain `next_check_at ASC` once every workspace with due work has had at least one claim
  this invocation. Document the exact query in the migration's own comments when implemented — this spec
  fixes the algorithm (round-robin/partitioned selection, not a raw global cap), not the literal SQL text,
  since the exact CTE shape should be validated against `EXPLAIN ANALYZE` on realistic data before being
  locked.
- Keep a per-workspace-per-invocation cap as defense-in-depth (`PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_
  PER_CYCLE`), but set its default relative to the **corrected, benchmark-pending** chunk size/invocation
  budget (§2.2) rather than an arbitrary 200 that a 40-row batch could never reach — e.g. no more than
  roughly half of one invocation's total processed-target budget, revisited once the benchmark in §2.2
  lands.
- Required test: fair selection across multiple workspaces with simultaneously due backlogs (§5 test #8) —
  assert no single workspace's backlog starves another's within one invocation.

Full quota-tiering by plan remains explicitly P1 (ties into "shared tracking quota," decision #6, which the
Product Spec already flags as needing its own limit-enforcement design at enrollment time, separate from
this per-cycle scheduler fairness mechanism).

### 2.10 Manual "Check Now" — genuinely queued, Correction 10 (2026-07-18)

**The first draft's "direct, synchronous claim-and-check" contradicted founder decision #9 and the
corrections' explicit instruction.** A browser request blocking on a live storefront check (worst case 55s,
§2.2) is exactly the kind of unbounded-wait UX decision #9 rules out, and it also bypasses the atomic
claim/finalize discipline (§2.7/§2.8) by inventing a second, divergent check path. Corrected flow:

1. Seller clicks Check Now (product-level or single-pincode) → `POST /api/pincode-monitoring/check-now`.
2. The route validates: authenticated session, workspace membership + role (not `viewer`,
   `DATA_MODEL.md` §6), and cooldown/quota — reject (clear "try again in N seconds") if this target was
   manually checked within `PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS` (default 60) or if the workspace has hit
   its manual-check quota window (ties into decision #6's shared quota, enforcement point still owned by the
   enrollment-time quota design flagged in §8).
3. The route atomically records the request: `UPDATE pincode_tracking_targets SET manual_requested_at =
   now(), manual_requested_by = :user_id, manual_request_token = gen_random_uuid(), next_check_at = now()
   WHERE id = :target_id AND manual_request_token IS NULL RETURNING manual_request_token` (service-role
   client). The `WHERE manual_request_token IS NULL` guard **coalesces duplicate requests**: a second click
   while one is already pending/checking affects zero rows and the route returns the existing pending
   request's status instead of creating a second one.
4. The route returns **`202 Accepted` / `{ status: 'queued' }` immediately** — it does not wait for the
   check to run.
5. The scheduler (§2.8's claim function, or a dedicated higher-priority claim pass reading `WHERE
   manual_requested_at IS NOT NULL` first) picks the request up on its normal or next-soonest cycle —
   setting `next_check_at = now()` in step 3 already makes it immediately due, so no special-cased priority
   query is strictly required for P0, though the claim function may optionally order manual requests first
   within a chunk as a small quality-of-life improvement, not a correctness requirement.
6. `finalize_pincode_check` (§2.7) clears `manual_requested_at`/`manual_request_token` alongside the normal
   claim fields on completion.
7. The UI polls or subscribes for the target's status and renders **Queued → Checking → Complete/Failed** —
   never a numeric queue position in P0 (that stays P1, per §1).

This satisfies decision #9 ("safely queued and rate-controlled") literally — the browser never blocks on the
external check, the same atomic claim/finalize discipline is reused rather than duplicated, and duplicate
clicks are coalesced structurally by the unique-token guard, not by client-side debouncing alone.

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

### 2.14 Cron wiring
Two new `vercel.json` cron entries, following the existing two-entry review-requests precedent exactly:
- `/api/cron/pincode/scheduler` — runs the due-check batch (§2.1–2.12). Suggested cadence: hourly
  (`0 * * * *`) — frequent enough that a 24h-cadence target is never more than ~1h late, infrequent enough
  to stay well within any reasonable invocation budget.
- No second cron entry is needed for reconciliation (§`DATA_MODEL.md` §5's archived-product cascade) — it
  runs as a cheap pre-step inside the same scheduler invocation, not a separate cron, since it only needs to
  run about as often as the scheduler itself already does.

---

## 3. Phasing (revised 2026-07-18)

### P0 — must ship together, this is the minimum that honors the 13 locked decisions, corrected
1. Migration: precondition composite-FK-target constraints on `amazon_listing_items`/`tracked_asins`
   (`DATA_MODEL.md` §2, Correction 2).
2. Migration: `workspace_default_pincodes`, `pincode_monitored_products`, `pincode_tracking_targets` + RLS
   (corrected — SELECT-only for members on the two automation-touching tables, Correction 3) + `updated_at`
   triggers (Correction 13) (`DATA_MODEL.md` §1–3, §6).
3. Migration: `pincode_availability_results.monitored_product_id` + `.check_status` additive columns +
   indexes (`DATA_MODEL.md` §4/§4a) — **not** the `check_status` CHECK constraint, which is gated on the
   read-only production audit (Correction 8, `DATA_MODEL.md` §4a).
4. Migration: `claim_due_pincode_targets`, `finalize_pincode_check`, `enroll_pincode_monitored_products` RPC
   functions — `SECURITY DEFINER`, explicit `search_path`, `service_role`-only `EXECUTE` (Corrections 1, 4,
   7; `DATA_MODEL.md` §7).
5. Route `/dashboard/pincode-checker` + nav item + legacy redirect confirmation (`PRODUCT_SPEC.md` §4).
6. My Products tab: list from `amazon_listing_items`, bulk-enroll via `enroll_pincode_monitored_products`
   (`PRODUCT_SPEC.md` §5.1, `DATA_MODEL.md` §2a).
7. Other Products tab: single-ASIN enrollment with a **real SP-API lookup and preview**
   (`PRODUCT_SPEC.md` §6, Correction 11 — moved from P1 into P0, see the corrected §4 below), plus
   Other→Owned promotion (`PRODUCT_SPEC.md` §5.2 Correction 1, `DATA_MODEL.md` §5).
8. Pincode Settings panel: `workspace_default_pincodes` CRUD, still member-writable directly per
   `DATA_MODEL.md` §6 (unchanged — no automation fields on this table) (`PRODUCT_SPEC.md` §5.3).
9. Tracker table: product→pincode expansion, corrected five-state renders (`PRODUCT_SPEC.md` §7–8,
   Correction 8).
10. **Minimal recurring scheduler**, corrected: atomic bounded-chunk claim RPC, atomic idempotent finalize
    RPC, workspace-fair selection, honest disambiguated reporting (§2 of this document, all subsections) —
    per the trade-off resolution in §1, this is P0, not deferred.
11. Manual Check Now — **genuinely queued** (§2.10, Correction 10), with cooldown/quota.
12. Archived-product cascade reconciliation, extended for the owned-FK-null and Other→Owned cases
    (`DATA_MODEL.md` §5, Correction 1).
13. **Internal-workspace feature flag / allowlist** gating enrollment and the scheduler cron until the
    staged rollout (§6, Correction 12) reaches GREEN.
14. Constraints and validation from Correction 13 (`DATA_MODEL.md` §2/§3): cadence bounds, non-negative
    failure counts, claim-field consistency, ASIN/pincode format, `updated_at` triggers.

### P1 — real but not blocking the core promise
- Per-workspace configurable cadence (schema already supports it, §2.1).
- Exponential backoff on retry (§2.5) and adaptive backoff on block detection (§2.6).
- True priority/visible-position queue for Check Now (§2.10 already ships genuinely queued in P0; only the
  numeric position UI is deferred).
- Full quota-tiering by plan for shared tracking quota (decision #6).
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

## 5. Test plan (expanded 2026-07-18 — 18 required tests, corrections-driven)

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
  2. **Unauthorized direct scheduler-state mutation rejection** (Correction 3) — as an authenticated member
     (not service-role), attempt a direct table `UPDATE` of `status='checking'`/`claimed_at`/`next_check_at`
     on `pincode_tracking_targets`; assert RLS rejects it (no member-facing UPDATE policy exists).
  3. **Atomic chunk claim with concurrent invocations** (Correction 4) — fire `claim_due_pincode_targets`
     from two concurrent connections against the same due set; assert the row sets returned are disjoint.
  4. **No duplicate claim** (Correction 4/8) — assert a target claimed by one invocation is invisible to a
     second concurrent claim call until released/finalized.
  5. **Runtime stop leaves zero normally-unprocessed checking rows** (Correction 5) — force a tiny runtime
     budget mid-run; assert every claimed chunk was fully finalized before the invocation stopped, and zero
     `'checking'` rows exist immediately after a `stoppedDueToRuntimeBudget: true` invocation.
  6. **Idempotent finalize retry creates one result only** (Correction 7) — call `finalize_pincode_check`
     twice with the same `claim_token`; assert exactly one `pincode_availability_results` row exists and the
     second call returns the first call's recorded outcome, not an error and not a duplicate.
  7. **Crash after external check but before finalize is safely recoverable** (Correction 7) — simulate a
     claimed target with no corresponding finalize call and an old `updated_at`; run stale-claim reclaim;
     assert it's reset to `'active'` (claim fields cleared) and re-claimable, with no orphaned result row.
  8. **Fair selection across multiple workspaces** (Correction 9) — seed simultaneously-due backlogs in
     workspace A (large) and workspace B (small); run one invocation; assert workspace B's due targets are
     not starved by workspace A's backlog.
  9. **Queued Manual Check Now coalescing** (Correction 10) — fire two concurrent Check Now requests for the
     same target; assert only one `manual_request_token` is ever set and the second request's response
     reflects the first's pending state, not a second request.
  10. **Cooldown/quota enforcement** (Correction 10) — request Check Now twice within the cooldown window;
      assert the second is rejected with a clear retry-after response, not silently queued twice.
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

The feature flag/allowlist is the single gate controlling both "can this workspace see the enrollment UI"
and "will the scheduler claim this workspace's targets" — there is no path where a workspace can enroll
without the scheduler already being live and verified for it.

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
2. **Shared tracking quota enforcement point is not fully designed** — decision #6 locks the concept but
   this plan only specifies a per-cycle scheduler cap (§2.9), not the enrollment-time quota check/UX (what
   happens when a seller tries to enroll product #201). Needs a decision before P0 enrollment UI ships:
   either enrollment is unlimited and only the scheduler throttles silently (checks just run later than
   ideal), or enrollment itself is capped and rejects with a clear message. Recommend the latter for
   honesty with the seller, but this needs explicit confirmation, not silent assumption. Unchanged by this
   correction round — still open.
3. **Real-world block/CAPTCHA rate is unknown** — §2.6's fixed 2x cooldown multiplier is a reasonable
   starting guess, not measured against actual Amazon-storefront-scrape block rates for this feature. May
   need tuning after the first week of production data. Unchanged by this correction round.
4. **Capacity (batch/concurrency) is explicitly deferred to a pre-implementation benchmark, not a risk to
   silently carry into production** (Correction 6, §2.2) — this replaces the first draft's "cron frequency
   vs. actual check-latency budget is unverified at scale" risk with an actual required step: the benchmark
   and its acceptance threshold (≥20% runtime-budget safety margin against worst-case duration) must be
   completed and documented *before* the scheduler cron is enabled even for the internal test workspace
   (§6 step 4). This is now a gating requirement, not an open risk carried into rollout.
5. **`check_status` production-value audit outcome is unknown until performed** (Correction 8, `DATA_MODEL.md`
   §4a) — the audit method and backfill rule are specified, but the actual distinct values present in
   production haven't been read yet in this spec round; flagged honestly as an implementation-time step that
   could surface an unanticipated legacy value requiring a decision, not assumed to be clean.
6. **Per-workspace fairness algorithm's exact CTE shape is not locked** (Correction 9, §2.9) — the
   round-robin/partitioned-selection *approach* is specified, but the literal SQL should be validated with
   `EXPLAIN ANALYZE` against realistic data volume before being written into the migration, since a naive
   `DISTINCT ON`-based approach's performance at scale is not yet measured.
