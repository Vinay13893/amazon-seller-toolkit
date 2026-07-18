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
still the same logical check. Corrected order — **validate before insert, not after**:

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
  v_existing public.pincode_availability_results;
  v_target   public.pincode_tracking_targets;
  v_result   public.pincode_availability_results;
BEGIN
  -- Step 1: idempotency check FIRST. If this exact attempt already
  -- recorded a result (a retried finalize call after the app lost the
  -- original response, but the transaction had already committed),
  -- return it immediately -- no target lookup, no insert, nothing else.
  SELECT * INTO v_existing FROM public.pincode_availability_results
    WHERE check_attempt_id = p_claim_token;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Step 2: lock and validate the target BEFORE writing anything. The
  -- target must currently be 'checking', owned by exactly this
  -- claim_token. FOR UPDATE takes the row lock so a concurrent
  -- reclaim/re-claim can't interleave between this check and the writes
  -- below.
  SELECT * INTO v_target FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking'
    FOR UPDATE;

  -- Step 3: no currently-owned target -- this claim_token was reclaimed
  -- (stale-claim reclaim, §2.4) and possibly already re-claimed by a
  -- different attempt. Do NOT insert a result, do NOT touch any target --
  -- the caller must treat this as a stale attempt, not a success.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  -- Step 4: insert the one result row this attempt owns, now that the
  -- target lock proves this claim_token is still valid.
  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status,
    delivery_message, error_code, error_message, checked_at
  ) VALUES (
    v_target.workspace_id,
    (SELECT asin FROM public.pincode_monitored_products WHERE id = v_target.monitored_product_id),
    v_target.pincode, v_target.monitored_product_id, v_target.id,
    p_claim_token, p_check_status, p_availability_status,
    p_delivery_message, p_error_code, p_error_message, now()
  ) RETURNING * INTO v_result;

  -- Step 5: finalize the SAME target this attempt validated in step 2 --
  -- clear all claim fields, compute next_check_at/consecutive_failures per
  -- §2.5/§2.6, clear manual-request fields if this was a manual check
  -- (§2.10).
  UPDATE public.pincode_tracking_targets
  SET status = CASE WHEN p_check_status = 'failed' AND consecutive_failures + 1 >= <max_failures>
                     THEN 'failed' ELSE 'active' END,
      last_checked_at = now(),
      next_check_at = <computed per §2.5/§2.6>,
      consecutive_failures = CASE WHEN p_check_status = 'failed'
                                   THEN consecutive_failures + 1 ELSE 0 END,
      last_error_code = p_error_code,
      claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL
  WHERE id = v_target.id;

  -- Step 6: insert + update commit together or not at all (implicit
  -- transaction, same function body).
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
  only incremented after `finalize_pincode_check` returns a result (fresh or already-recorded, step 1),
  never assumed from the external call succeeding alone. A `stale_check_attempt` exception (step 3) is
  counted separately — it means the worker did real work whose result cannot be safely recorded, not a
  target-level failure, so it must not increment `targetsFailed` either; log it distinctly.
- **Required race test (round 2, replaces the round-1 idempotent-retry test with a stronger version):** claim
  attempt A → force-reclaim A (simulate stale-claim reclaim firing) → claim attempt B (same target, new
  `claim_token`) → call `finalize_pincode_check` with A's now-stale token → assert it raises
  `stale_check_attempt`, inserts no result, and does not mutate B's claim or target state → finalize B
  normally → assert exactly one new `pincode_availability_results` row exists, owned by B's `check_attempt_id`.

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
`authenticated` users, satisfying Correction 4's explicit requirement.

**Round-2 Correction 7 (2026-07-18) — removes a contradiction.** The round-1 text here claimed Manual Check
Now uses "the same function (with `p_limit = 1` and a target-id filter)," but `claim_due_pincode_targets`
was never given a target-id parameter, and §2.10's own corrected design (below) doesn't queue manual
requests through a second, target-specific claim call at all — it makes them eligible through the **same**
due-query Manual Check Now shares with the normal scheduler. There is **one** claim path
(`claim_due_pincode_targets`, unmodified signature — `p_limit`, `p_invocation_id`), not two: a manual
request becomes visible to it the moment `manual_requested_at IS NOT NULL` and `next_check_at` is pulled
forward to `now()` (set atomically by the new `queue_pincode_manual_check` RPC, §2.10) — it is claimed by the
ordinary due-query, optionally prioritized within a chunk, never claimed through a separate hidden path.

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

**Round-2 Correction 6 (2026-07-18) — the round-1 fairness design was not actually implementable.** It
referred to "a per-workspace cap per invocation" and reasoned about "workspaces already claimed once this
invocation," but `finalize_pincode_check` (§2.7) clears `claimed_by`/`claim_token` on every completed target
— by design, so a finalized row doesn't look perpetually claimed. That means the **database alone cannot
tell**, by looking at current target rows, which workspaces this invocation already served — the information
doesn't persist anywhere once a chunk finalizes. A fairness rule that implicitly assumes the database can
infer "already served this invocation" from row state was underspecified, not a real algorithm. Corrected to
a mechanism where the **worker process**, not the database, holds invocation-scoped fairness state, and the
claim RPC is given that state explicitly on each call:

1. The worker (not the database) maintains a **served-workspace set** in memory, scoped to the current
   invocation, empty at invocation start.
2. `claim_due_pincode_targets` gains two new parameters:
   `claim_due_pincode_targets(p_limit integer, p_invocation_id text, p_excluded_workspace_ids uuid[])`.
3. **One fairness round** = one call claiming **at most one target per distinct workspace** among the due
   set, excluding any workspace already in `p_excluded_workspace_ids`, manually-requested targets
   prioritized first within the round:

```sql
CREATE OR REPLACE FUNCTION public.claim_due_pincode_targets(
  p_limit                  integer,
  p_invocation_id          text,
  p_excluded_workspace_ids uuid[] DEFAULT '{}'
)
RETURNS SETOF public.pincode_tracking_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.pincode_tracking_targets t
  SET status = 'checking',
      claimed_at = now(),
      claimed_by = p_invocation_id,
      claim_token = gen_random_uuid()
  FROM (
    SELECT id FROM (
      SELECT id, workspace_id,
             ROW_NUMBER() OVER (
               PARTITION BY workspace_id
               ORDER BY (manual_requested_at IS NOT NULL) DESC, next_check_at ASC
             ) AS rn
      FROM public.pincode_tracking_targets
      WHERE status = 'active'
        AND next_check_at IS NOT NULL AND next_check_at <= now()
        AND NOT (workspace_id = ANY (p_excluded_workspace_ids))
    ) ranked
    WHERE rn = 1  -- exactly one target per workspace this round
    ORDER BY (SELECT manual_requested_at IS NOT NULL FROM public.pincode_tracking_targets WHERE id = ranked.id) DESC,
             (SELECT next_check_at FROM public.pincode_tracking_targets WHERE id = ranked.id) ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) AS due
  WHERE t.id = due.id
  RETURNING t.*;
END;
$$;
```

   (The `ROW_NUMBER() OVER (PARTITION BY workspace_id ...)` shape is equivalent to `DISTINCT ON
   (workspace_id) ... ORDER BY (manual_requested_at IS NOT NULL) DESC, next_check_at ASC` — either is
   acceptable; `ROW_NUMBER()` is written out above because it composes more readably with the outer `LIMIT
   p_limit`/`FOR UPDATE SKIP LOCKED`. Whichever form is implemented, it must be validated with `EXPLAIN
   ANALYZE` against realistic data volume before being locked — the *algorithm* (one target per workspace per
   round, manual-first ordering) is what this spec fixes, not the exact query text, since index-usage
   characteristics should be confirmed against real cardinality.)

4. After each chunk returns, the worker adds every distinct `workspace_id` present in the returned rows to
   its in-memory excluded set and calls again with the updated `p_excluded_workspace_ids`.
5. When a call returns **zero rows** (every workspace with due work has now had a claim this round, or no
   due work remains), the worker **clears the excluded set** and begins another round — provided runtime
   budget remains (§2.3/§2.8) and `dueBacklogRemaining` (§2.13) is still nonzero.
6. A per-workspace-per-invocation processed-count cap (`PINCODE_SCHEDULER_MAX_TARGETS_PER_WORKSPACE_PER_
   CYCLE`) remains as **defense-in-depth** on top of the round-robin mechanism above — even with fair
   round-robin claiming, a single very-large workspace could still consume many rounds' worth of capacity
   over a long invocation; the cap bounds that independent of how fair each individual round is. Default set
   relative to the benchmark-pending chunk size/invocation budget (§2.2), not an arbitrary number a small
   batch could never reach.

This makes "no single workspace's backlog starves another's" an actual, testable property of the algorithm
(round-robin across workspaces, one target per workspace per round) rather than an emergent hope from
`ORDER BY next_check_at`. Required test: fair selection across multiple workspaces with simultaneously due
backlogs (§5 test #8) — assert no single workspace's backlog starves another's within one invocation, using
the round mechanism above, not a vaguer "assert fairness" check.

Full quota-tiering by plan remains explicitly P1 (ties into "shared tracking quota," decision #6 — now
**locked** for P0 as a single configurable capped-enrollment limit, `DATA_MODEL.md` §2b — commercial
per-plan tiers are the P1 item, separate from this per-cycle scheduler fairness mechanism).

### 2.10 Manual "Check Now" — genuinely queued via an atomic RPC, round-2 Correction 4 (2026-07-18)

**Round 1 fixed "synchronous" but left a race.** The round-1 design had the API route perform cooldown/quota/
status reads, then a *separate* service-role `UPDATE ... WHERE manual_request_token IS NULL` — two steps,
not one transaction, so a concurrent second click could pass the route's own cooldown/quota read before the
first click's `UPDATE` commits, defeating the coalescing guard under real concurrency. Corrected to a single
service-role-only RPC that does everything atomically:

```sql
CREATE OR REPLACE FUNCTION public.queue_pincode_manual_check(
  p_target_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_cooldown_seconds integer,
  p_manual_quota_remaining integer  -- computed by the caller from workspace quota state, §DATA_MODEL.md §2b
)
RETURNS jsonb  -- { result: 'queued'|'already_queued'|'checking'|'cooldown'|'quota_exceeded'|'invalid_status', ... }
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target public.pincode_tracking_targets;
BEGIN
  SELECT * INTO v_target FROM public.pincode_tracking_targets
    WHERE id = p_target_id AND workspace_id = p_workspace_id
    FOR UPDATE;  -- lock the target for the duration of this check+write

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  -- Locked P0 status behavior (this correction):
  IF v_target.status = 'checking' THEN
    RETURN jsonb_build_object('result', 'checking');  -- already in flight, do not create another request
  ELSIF v_target.status = 'paused' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'paused_requires_resume');
  ELSIF v_target.status = 'failed' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'failed_requires_resume');
  ELSIF v_target.status = 'archived' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'archived_cannot_check');
  END IF;
  -- Only 'active' reaches here.

  IF v_target.manual_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_queued', 'manual_request_token', v_target.manual_request_token);
  END IF;

  IF v_target.last_checked_at IS NOT NULL
     AND v_target.last_checked_at > now() - make_interval(secs => p_cooldown_seconds) THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_seconds', p_cooldown_seconds - extract(epoch FROM now() - v_target.last_checked_at)::int);
  END IF;

  IF p_manual_quota_remaining <= 0 THEN
    RETURN jsonb_build_object('result', 'quota_exceeded');
  END IF;

  UPDATE public.pincode_tracking_targets
  SET manual_requested_at = now(),
      manual_requested_by = p_user_id,
      manual_request_token = gen_random_uuid(),
      next_check_at = now()
  WHERE id = p_target_id
  RETURNING manual_request_token INTO STRICT v_target.manual_request_token;

  RETURN jsonb_build_object('result', 'queued', 'manual_request_token', v_target.manual_request_token);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, uuid, integer, integer) TO service_role;
```

**Locked P0 status behavior** (the row-lock via `FOR UPDATE` at the top makes every branch below atomic with
respect to concurrent calls on the same target — two concurrent clicks cannot both observe "no existing
manual request" and both proceed to the `UPDATE`):

| Target status | Behavior |
|---|---|
| `active` | May queue (subject to cooldown/quota checks above). |
| `checking` | Returns `already_checking`-equivalent (`result: 'checking'`) — **does not** create another request. |
| `paused` | Rejected — requires Resume first (a separate, existing mutation, not silently auto-resumed by Check Now). |
| `failed` | Rejected — requires Resume first (same reasoning — Check Now is not a backdoor around the failed-state's explicit resume requirement, §2.5). |
| `archived` | Rejected — cannot check an archived target at all. |

**Route contract:** `POST /api/pincode-monitoring/check-now` validates session, workspace membership, and
role (not `viewer`, `DATA_MODEL.md` §6), computes `p_manual_quota_remaining` from the workspace's current
quota state (`DATA_MODEL.md` §2b), then calls `queue_pincode_manual_check` via the service-role client and
maps its `result` field to HTTP: **`202 Accepted` only when `result = 'queued'`**; `result = 'already_queued'`
or `'checking'` → `200` with the current status (not an error — the request is legitimately already in
flight, coalesced); `'cooldown'` → `429` with `retry_after_seconds`; `'quota_exceeded'` → `409` (same shape
as `DATA_MODEL.md` §2b's enrollment quota error); `'invalid_status'` → `409` with the specific reason.
**Concurrent clicks are guaranteed to produce exactly one `manual_request_token`** — the `FOR UPDATE` lock
inside the RPC, not client-side debouncing or a separate read-then-write pair, is what makes this true.

The scheduler's normal due-query (§2.8/§2.9) picks the request up — `next_check_at = now()` makes it
immediately due, and the fairness round-robin (§2.9's corrected mechanism) orders manually-requested targets
first within each workspace's turn. `finalize_pincode_check` (§2.7) clears `manual_requested_at`/
`manual_requested_by`/`manual_request_token` alongside the normal claim fields on completion (see the
function body in §2.7).

The UI polls or subscribes for the target's status and renders **Queued → Checking → Complete/Failed** —
never a numeric queue position in P0 (that stays P1, per §1).

This satisfies decision #9 ("safely queued and rate-controlled") literally — the browser never blocks on the
external check, one atomic RPC (not a read-then-write pair) makes cooldown/quota/status/coalescing checks
race-free, and the same claim/finalize discipline (§2.7/§2.8) processes manual requests through the one
scheduler claim path, per Correction 7 above.

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

**Round 2: this list is now sequenced into 4 separately-reviewed implementation PRs (P0-A/B/C/D) — see §9.
The items below are unchanged in substance from round 1's P0 scope, plus this round's additions (item 4 now
lists 4 RPCs, item 8 is corrected to SELECT-only per Correction 5, item 11 references the atomic queue RPC,
a new item 15 locks the quota decision) — §9 is the authority on sequencing, this list is the authority on
scope.**

1. Migration: precondition composite-FK-target constraints on `amazon_listing_items`/`tracked_asins`
   (`DATA_MODEL.md` §2, Correction 2).
2. Migration: `workspace_default_pincodes`, `pincode_monitored_products`, `pincode_tracking_targets` + RLS
   (corrected — `SELECT`-only for members on **all three** tables, round-2 Correction 5) + `updated_at`
   triggers (Correction 13) + the `claim_token` partial unique index (round-2 Correction 2) (`DATA_MODEL.md`
   §1–3, §6).
3. Migration: `pincode_availability_results.monitored_product_id` + `.tracking_target_id` +
   `.check_attempt_id` + `.check_status` additive columns + indexes (`DATA_MODEL.md` §4/§4a, round-2
   Correction 1) — **not** the `check_status` CHECK constraint, which is gated on the read-only production
   audit's backfill (Correction 8, now recorded with real numbers, `DATA_MODEL.md` §4a).
4. Migration: `claim_due_pincode_targets`, `finalize_pincode_check`, `enroll_pincode_monitored_products`, and
   `queue_pincode_manual_check` RPC functions (**4**, not 3 — round-2 Correction 4 adds the manual-queue RPC)
   — `SECURITY DEFINER`, explicit `search_path`, `service_role`-only `EXECUTE` (Corrections 1, 4, 7;
   `DATA_MODEL.md` §7).
5. Route `/dashboard/pincode-checker` + nav item + legacy redirect confirmation (`PRODUCT_SPEC.md` §4).
6. My Products tab: list from `amazon_listing_items`, bulk-enroll via `enroll_pincode_monitored_products`
   (`PRODUCT_SPEC.md` §5.1, `DATA_MODEL.md` §2a) — quota-checked per item 15 below.
7. Other Products tab: single-ASIN enrollment with a **real SP-API lookup and preview**
   (`PRODUCT_SPEC.md` §6, Correction 11 — moved from P1 into P0, see the corrected §4 below), plus
   Other→Owned promotion (`PRODUCT_SPEC.md` §5.2 Correction 1, `DATA_MODEL.md` §5).
8. Pincode Settings panel: `workspace_default_pincodes` CRUD via authenticated server routes — **corrected,
   round-2 Correction 5: `SELECT`-only RLS, no direct member table writes**, matching the other two tables
   (`PRODUCT_SPEC.md` §5.3, `DATA_MODEL.md` §6).
9. Tracker table: product→pincode expansion, corrected five-state renders (`PRODUCT_SPEC.md` §7–8,
   Correction 8).
10. **Minimal recurring scheduler**, corrected: atomic bounded-chunk claim RPC with round-robin workspace
    fairness (round-2 Correction 6), atomic idempotent finalize RPC with validate-before-insert ordering
    (round-2 Correction 3), honest disambiguated reporting (§2 of this document, all subsections) — per the
    trade-off resolution in §1, this is P0, not deferred.
11. Manual Check Now — **genuinely queued through one atomic RPC** (`queue_pincode_manual_check`, round-2
    Correction 4), with cooldown/quota and the locked per-status behavior table (§2.10).
12. Archived-product cascade reconciliation, extended for the owned-FK-null and Other→Owned cases
    (`DATA_MODEL.md` §5, Correction 1).
13. **Internal-workspace feature flag / allowlist** gating enrollment and the scheduler cron until the
    staged rollout (§6, Correction 12) reaches GREEN.
14. Constraints and validation from Correction 13 (`DATA_MODEL.md` §2/§3): cadence bounds, non-negative
    failure counts, claim-field consistency, ASIN/pincode format, `updated_at` triggers.
15. **Capped enrollment quota, locked founder decision** (`DATA_MODEL.md` §2b) — one active
    product×pincode target per workspace+marketplace as the quota unit, enforced atomically inside
    enrollment and resume, `409 pincode_tracking_quota_exceeded` on rejection, one configurable
    internal-workspace limit for P0 (exact number set alongside the P0-A implementation PR, not invented in
    this spec).

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
6. **Per-workspace fairness algorithm's exact query shape is specified but not benchmarked** (round-2
   Correction 6, §2.9) — the round-robin-via-`ROW_NUMBER() OVER (PARTITION BY workspace_id)` algorithm is now
   concretely written out (not left as unspecified prose), but its performance at realistic data volume
   (`EXPLAIN ANALYZE` against a representative due-target count and workspace-count distribution) is not yet
   measured. This is a narrower risk than round 1's "fairness is undefined" — the algorithm is locked, only
   its query-plan performance needs validating before the migration is finalized.
7. **Manual quota computation (`p_manual_quota_remaining` passed into `queue_pincode_manual_check`, §2.10)
   is not itself specified as its own quota pool** — this spec treats manual-check cooldown/quota as a
   parameter the calling route computes and passes in, without defining whether "manual quota" is a separate
   counter from the enrollment quota (`DATA_MODEL.md` §2b) or ties into it. Needs a decision before the
   P0-B API layer (§9) is implemented — flagged honestly rather than assumed.

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
  new tables + RLS + triggers + `claim_token` uniqueness, the 4 additive `pincode_availability_results`
  columns + indexes, the 4 RPC functions.
- Composite FKs (workspace-scoped, `DATA_MODEL.md` §2/§3/§4).
- RLS (`SELECT`-only for members on all three new tables, `DATA_MODEL.md` §6).
- Quota enforcement wired into `enroll_pincode_monitored_products` and the resume path (`DATA_MODEL.md` §2b).
- `enroll_pincode_monitored_products`, `queue_pincode_manual_check`, `claim_due_pincode_targets`,
  `finalize_pincode_check` RPCs, matching this document's corrected specs exactly (§2.7, §2.8, §2.9, §2.10,
  `DATA_MODEL.md` §2a).
- Scratch/staging integration tests — the 18 tests from §5, at minimum tests #1–7 and #12–17 (the
  schema/RPC-level ones; the scheduler-runtime ones (#5, #8, #18) can run against P0-A's RPCs directly, ahead
  of P0-D's full worker).
- Feature disabled — no route, no UI, nothing user-reachable yet. This PR is pure database + RPC surface.

### P0-B — API and data-access layer
- Lookup route (`POST /api/pincode-monitoring/lookup-asin`, `PRODUCT_SPEC.md` §6/§11).
- Enrollment routes (`POST /api/pincode-monitoring/products`, calling `enroll_pincode_monitored_products`).
- Defaults routes (`GET`/`PUT /api/pincode-monitoring/default-pincodes`).
- Tracker query route (`GET /api/pincode-monitoring/tracker`).
- Pause/resume/remove routes (`PATCH /api/pincode-monitoring/products/[id]`, quota re-check on resume per
  `DATA_MODEL.md` §2b).
- Check Now route (`POST /api/pincode-monitoring/check-now`, calling `queue_pincode_manual_check`).
- All routes enforce the role model from `DATA_MODEL.md` §6 (session → membership → role, `viewer` → `403`).
- No public UI enablement — these routes are reachable only by direct authenticated call (e.g. from tests or
  internal tooling) until P0-C ships the UI that calls them.

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
