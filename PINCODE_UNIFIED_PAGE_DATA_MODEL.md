# Pincode Checker — Unified Page Data Model

**Status:** Schema proposal only. No migration applied in this round — this is the design to review before
one is written.
**Companion:** `PINCODE_UNIFIED_PAGE_PRODUCT_SPEC.md` (product flows this schema supports),
`PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md` (scheduler mechanics, phasing).

---

## 0. Confirmed facts this design relies on

Directly re-read from the actual migrations in this session before proposing anything (not assumed):

- `amazon_listing_items.id` is `uuid` (`supabase/migrations/007_amazon_account_data_foundation.sql:71`).
  `asin` on this table is **nullable** text, with a partial unique index
  `(workspace_id, asin, marketplace_id) WHERE asin IS NOT NULL` (`007...:92-94`) — a listing item is not
  guaranteed to have an ASIN yet.
- `tracked_asins.id` is `uuid` (`001_initial_schema.sql:102`). Unique on
  `(workspace_id, asin, marketplace)` (`001...:114`). No `target_type`/`source` column on this table
  (confirmed, §`PRODUCT_SPEC.md` §3).
- `pincode_checks` has only **single-column** indexes: `workspace_id`, `tracked_asin_id`, `pincode`,
  `checked_at DESC` (`001...:299-303`) — no composite index for "history of this exact product+pincode."
- `pincode_availability_results` **does** have a useful composite index:
  `(workspace_id, asin, pincode, checked_at DESC)` (`016_scraping_jobs_foundation.sql:50-51`) — but it's
  keyed on a raw `asin text` column, no FK to any product table.
- `background_jobs` (`034_product_page_snapshot_background_jobs.sql`) is this codebase's most recent,
  most battle-tested recurring-job precedent: `run_after`, `locked_at`/`locked_by`, `attempt_count`/
  `max_attempts`, a partial unique index preventing duplicate active jobs per target
  (`WHERE status IN ('queued','running')`), and a claim index `(job_type, status, run_after)`. The
  `review_solicitation_orders` design (this session's own earlier work, `059_review_solicitation_orders.sql`)
  adds a proven refinement on top: reclaim of stale claims via the existing `updated_at` trigger, no
  separate `claim_expires_at`-style column needed for the simple claim/finalize case. This spec's tables
  are modeled on the combination of both.
- No workspace-level settings table/column exists today (`workspaces` has only
  `id/owner_id/name/type`, `001...:43-50`) — default pincodes genuinely need new storage.
- No table anywhere in the 59 read migrations models a standing "check X against pincode set {...}"
  configuration — `pincode_checks` and `pincode_availability_results` are both one-row-per-check-event
  logs. A new configuration table is required regardless of which result table is kept (§4).

---

## 1. `workspace_default_pincodes`

```sql
CREATE TABLE public.workspace_default_pincodes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text        NOT NULL,
  pincode        text        NOT NULL,
  display_order  integer     NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workspace_default_pincodes_uidx
    UNIQUE (workspace_id, marketplace_id, pincode),
  CONSTRAINT workspace_default_pincodes_pincode_format_chk
    CHECK (pincode ~ '^[1-9][0-9]{5}$')  -- 6-digit Indian pincode, first digit 1-9
);

CREATE INDEX workspace_default_pincodes_workspace_mp_idx
  ON public.workspace_default_pincodes (workspace_id, marketplace_id)
  WHERE is_active = true;
```

`is_active` (rather than hard delete) lets a seller "remove" a default without losing the audit trail of
what was once configured, matching this codebase's general soft-state preference (`tracked_asins.status`,
`pincode_tracking_targets.status` below) over row deletion. The CHECK constraint enforces 6-digit Indian
pincode format at the database layer, not just client-side — matches the "validate six-digit Indian
Pincodes" requirement defensibly (client-side validation can be bypassed; a direct API call cannot bypass a
CHECK constraint).

---

## 2. `pincode_monitored_products`

The enrollment record — "this product should be pincode-tracked," independent of which pincodes or how
often.

```sql
CREATE TABLE public.pincode_monitored_products (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id        text        NOT NULL,
  asin                  text        NOT NULL,
  product_source        text        NOT NULL,  -- 'owned' | 'other'

  amazon_listing_item_id uuid       REFERENCES public.amazon_listing_items(id) ON DELETE SET NULL,
  tracked_asin_id        uuid       REFERENCES public.tracked_asins(id) ON DELETE SET NULL,

  title_snapshot        text,
  image_url_snapshot     text,
  brand_snapshot         text,

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'archived'

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_monitored_products_uidx
    UNIQUE (workspace_id, marketplace_id, asin),
  CONSTRAINT pincode_monitored_products_source_chk
    CHECK (product_source IN ('owned', 'other')),
  CONSTRAINT pincode_monitored_products_status_chk
    CHECK (status IN ('active', 'paused', 'archived')),
  -- Defensible, non-polymorphic FK discipline: an 'owned' row should
  -- reference amazon_listing_items (its FK may still be null if the
  -- listing was later removed from the sync -- ON DELETE SET NULL, not
  -- a hard requirement); an 'other' row's amazon_listing_item_id is
  -- expected null but not hard-forbidden (an Other Product that later
  -- turns out to already be in the seller's own catalog can still gain
  -- this reference without changing product_source retroactively -- see
  -- §5). tracked_asin_id is opportunistic on either source and always
  -- optional, per founder decision #5.
  CONSTRAINT pincode_monitored_products_owned_has_listing_ref_chk
    CHECK (product_source <> 'owned' OR amazon_listing_item_id IS NOT NULL)
);

CREATE INDEX pincode_monitored_products_workspace_status_idx
  ON public.pincode_monitored_products (workspace_id, status);
CREATE INDEX pincode_monitored_products_listing_item_idx
  ON public.pincode_monitored_products (amazon_listing_item_id) WHERE amazon_listing_item_id IS NOT NULL;
CREATE INDEX pincode_monitored_products_tracked_asin_idx
  ON public.pincode_monitored_products (tracked_asin_id) WHERE tracked_asin_id IS NOT NULL;
```

**Why two nullable FKs instead of a polymorphic `(source_table, source_id)` pair:** a polymorphic ID
(storing a table name as a string alongside a raw UUID) cannot be validated by a real foreign key
constraint — the database can never guarantee the referenced row actually exists, which is exactly the
"unsafe polymorphic ID" the instructions warn against. Two real, nullable, `ON DELETE SET NULL` foreign
keys let Postgres enforce referential integrity for whichever one is populated, while the
`product_source` CHECK constraint (plus the `owned_has_listing_ref` constraint) keeps the *meaning*
unambiguous — this is the same "narrow, explicit CHECK over a loose polymorphic shape" discipline already
used in this codebase (e.g. `competitor_asins_source_type_check`, migration `024`).

`title_snapshot`/`image_url_snapshot`/`brand_snapshot` exist so an "Other Product" enrollment (which has no
guaranteed live catalog row to join against later) still displays sensibly even if the original lookup
result is never re-fetched — mirrors the existing `tracked_asins.product_title/brand/image_url` pattern
(migration `001`).

---

## 3. `pincode_tracking_targets`

The **recurring configuration** — "this monitored product should be checked against this pincode, on this
cadence." This is the table `PRODUCT_SPEC.md` §9's "missing `next_check_at` is not due now" rule binds to.

```sql
CREATE TABLE public.pincode_tracking_targets (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  monitored_product_id  uuid        NOT NULL REFERENCES public.pincode_monitored_products(id) ON DELETE CASCADE,
  pincode               text        NOT NULL,

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'failed'
  cadence_hours         integer     NOT NULL DEFAULT 24,

  -- Claim fields, same guarded-UPDATE discipline as
  -- review_solicitation_orders (migration 059) and background_jobs
  -- (migration 034) -- claimed_at/claimed_by exist for the worker's
  -- claim-before-check step; no separate claim_expires_at column is
  -- needed because the existing updated_at trigger (see fn_set_updated_at
  -- precedent) already gives a reliable stale-claim timestamp, exactly
  -- like the review-requests eligibility processor's reclaim design.
  claimed_at            timestamptz,
  claimed_by            text,

  last_checked_at       timestamptz,
  next_check_at         timestamptz,           -- NULL = not yet scheduled, never "due now" by default
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_error_code       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_tracking_targets_uidx
    UNIQUE (monitored_product_id, pincode),
  CONSTRAINT pincode_tracking_targets_status_chk
    CHECK (status IN ('active', 'paused', 'failed', 'checking')),
  CONSTRAINT pincode_tracking_targets_pincode_format_chk
    CHECK (pincode ~ '^[1-9][0-9]{5}$')
);

-- Due-work selection: mirrors review_solicitation_orders_due_idx
-- (migration 059) exactly -- partial index, excludes terminal/in-flight
-- statuses, so the claim query stays small and correct by construction.
CREATE INDEX pincode_tracking_targets_due_idx
  ON public.pincode_tracking_targets (workspace_id, next_check_at)
  WHERE status = 'active' AND next_check_at IS NOT NULL;

CREATE INDEX pincode_tracking_targets_monitored_product_idx
  ON public.pincode_tracking_targets (monitored_product_id);
```

`status = 'checking'` is intentionally listed in the CHECK constraint but excluded from the due-index's
partial predicate — same "claimed rows are invisible to new claims, but not a separate terminal state"
pattern as `review_solicitation_orders`. `'failed'` is a real, distinct terminal-ish state (exceeded
`consecutive_failures` threshold, see `IMPLEMENTATION_PLAN.md` §Scheduler retry policy) — a seller must
explicitly resume it (clears `consecutive_failures`, sets `status='active'`), it does not silently retry
forever.

---

## 4. Check-result history — which table to use

**Recommendation: `pincode_availability_results`, extended, not `pincode_checks`, and not a third table.**

| Criterion | `pincode_checks` | `pincode_availability_results` |
|---|---|---|
| Supports My Products today | Yes (via `tracked_asin_id`) | No FK at all — raw `asin text` |
| Supports Other Products | Only if forced into `tracked_asins` (exactly what decision #5 forbids) | Already ASIN-text-keyed, source-agnostic by construction |
| Four-state correctness | Fixed in the earlier P0 round (`available` nullable bool, correct) | Already the **more correct** of the two per the original audit — `availability_status` already models 4 states (`available`/`unavailable`/`blocked`/`unknown`) end-to-end, no P0 bug was ever found here |
| History index | Single-column only — a new composite index would be needed regardless | Already has `(workspace_id, asin, pincode, checked_at DESC)` — cheap history today |
| Existing downstream consumers | Alerts, reports, Sync Health, dashboard KPIs, Recent Activity (all read this table today) | None (per the original audit, this is the "island" table nothing else reads) |
| FK limitation | `tracked_asin_id` only — cannot represent an unlinked Other Product without violating decision #5 | `job_id`/`asin text` — needs a new nullable `monitored_product_id` FK added (small, additive) |

**The recommendation is not "use whichever already has more callers" — it's the opposite.** `pincode_checks`
is entangled with 5 existing downstream consumers (alerts, reports, Sync Health, dashboard KPI, Recent
Activity) that were all built assuming its current shape and its `tracked_asin_id`-only key. Bolting Other
Products support onto it would either (a) force Other Products into `tracked_asins` after all — directly
violating decision #5 — or (b) require loosening its FK, which risks quietly breaking one of those 5
consumers' assumptions. `pincode_availability_results` is architecturally *already* the more correct table
(better state model, better index, ASIN-text-keyed so it never needed a `tracked_asins` dependency in the
first place) and has **zero** existing consumers to risk breaking.

**Minimum additive change required (still no migration in this round, documented for the next phase):**
add one nullable FK, `monitored_product_id uuid REFERENCES pincode_monitored_products(id) ON DELETE SET
NULL`, plus an index `(monitored_product_id, pincode, checked_at DESC)` for the unified page's per-target
history queries. `job_id` stays nullable and optional — a scheduler-originated check populates
`monitored_product_id` and leaves `job_id` null (this isn't a `scraping_jobs`-queue check anymore, it's a
new scheduler, see `IMPLEMENTATION_PLAN.md`); a legacy bulk-checker-originated check keeps working exactly
as today, `job_id` populated, `monitored_product_id` null. **No backfill of historical rows is required or
recommended** — decision #11 preserves both legacy tables untouched; old rows simply predate the new FK and
stay queryable by their existing keys.

**`pincode_checks` is not deleted, not migrated, not touched.** It remains the ASIN-detail widget's data
source exactly as today (out of scope, §`PRODUCT_SPEC.md` §4) and continues serving its 5 existing
consumers unmodified.

---

## 5. Archived-product cascade behavior

Directly addresses the research finding that `getAsinDetail()`/`getTrackedAsins()` silently exclude
archived rows (`.neq('status', 'archived')`, `src/lib/supabase/asins.ts:288-294,449-463`) — confirmed via
this session's own production testing (two real archived ASINs both 404'd on the ASIN-detail page).

`pincode_monitored_products.status` is **independent** of `amazon_listing_items`/`tracked_asins` archive
state — it is not derived by a live join at read time, it is a **maintained** column, updated by an
application-level (not database-trigger) reconciliation step that:

1. Runs as part of the same recurring scheduler cycle (cheap: one query per cycle checking whether any
   linked `amazon_listing_item_id`/`tracked_asin_id`'s source row went archived/removed since the last
   check).
2. On detecting an archived source: sets `pincode_monitored_products.status = 'archived'` and cascades
   `pincode_tracking_targets.status = 'paused'` for every target under it (a plain `UPDATE ... WHERE
   monitored_product_id = ...`, not a database trigger, so it's inspectable/testable the same way the
   review-requests reclaim logic is).
3. History (`pincode_availability_results` rows referencing this `monitored_product_id`) is **never**
   deleted or altered — satisfies decision #10 exactly ("preserve history... never silently disappear with
   inaccessible history").
4. The Archived filter on the tracker table queries `pincode_monitored_products.status = 'archived'`
   directly — it does not need to re-join `amazon_listing_items`/`tracked_asins` at read time, so an
   archived product's row (and its full pincode history) stays visible and correctly labeled even after its
   source row is gone.

A database trigger was considered and rejected for this step: the archive event happens on
`amazon_listing_items`/`tracked_asins`, tables this feature does not own and should not attach triggers to
without a much stronger justification than convenience — an application-level reconciliation pass inside
an already-scheduled, already-idempotent worker cycle is simpler to reason about and matches this
codebase's existing preference (no other cross-table archive-cascade trigger was found anywhere in the 59
read migrations).

---

## 6. RLS

All three new tables follow the exact member-CRUD pattern already used for `tracked_asins`
(`001_initial_schema.sql:417-432` — `SELECT`/`INSERT`/`UPDATE`/`DELETE`, all gated on
`workspace_id IN (SELECT public.user_workspace_ids())`), **not** the stricter
`review_solicitation_orders`-style SELECT-only-for-members pattern — because, unlike the review-automation
workstream (fully backend-automation-driven, no user-triggered writes), sellers directly add/pause/
edit/remove their own Pincode enrollments through the UI, so member write access is a real product
requirement, not a gap to guard against.

```sql
ALTER TABLE public.workspace_default_pincodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_monitored_products  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_tracking_targets    ENABLE ROW LEVEL SECURITY;

-- Repeated per table (workspace_default_pincodes / pincode_monitored_products / pincode_tracking_targets):
CREATE POLICY "<table>: member select" ON public.<table> FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
CREATE POLICY "<table>: member insert" ON public.<table> FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));
CREATE POLICY "<table>: member update" ON public.<table> FOR UPDATE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
CREATE POLICY "<table>: member delete" ON public.<table> FOR DELETE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
```

`pincode_tracking_targets` does **not** carry its own `workspace_id` column redundantly for RLS simplicity
at the cost of one extra join — it inherits scoping through `monitored_product_id`'s FK, **except** this
spec includes `workspace_id` directly on it anyway (see §3 schema) purely so the RLS policy above and the
due-work index (§3) can both avoid a join, matching the same denormalization-for-RLS-and-index-simplicity
pattern already used by `keyword_rank_snapshots.workspace_id` (present despite also having
`tracked_keyword_id`) and `review_solicitation_orders.workspace_id`.

The scheduler's own reads/writes go through the service-role client (`createAdminClient()`, same as every
other worker in this codebase), which bypasses RLS entirely — consistent with every existing background
worker.

---

## 7. Migration count

**3 new tables + 1 additive column, across an estimated 2 migrations** (not committed to exact numbering —
next available migration number to be confirmed at implementation time, since other work may land first):

1. One migration: `workspace_default_pincodes`, `pincode_monitored_products`, `pincode_tracking_targets` —
   all three together, since `pincode_tracking_targets` FKs to `pincode_monitored_products` and both are
   new, they belong in one migration (matches this codebase's existing convention of grouping tightly
   coupled new tables, e.g. migration `059` created `review_solicitation_orders` alone since nothing else
   depended on it that same migration; migration `016` created `scraping_jobs` +
   `pincode_availability_results` together since the latter FKs the former).
2. One migration: `ALTER TABLE pincode_availability_results ADD COLUMN monitored_product_id uuid
   REFERENCES pincode_monitored_products(id) ON DELETE SET NULL` + its index — kept separate from #1 so the
   new tables can be reviewed/applied independently of touching an existing, already-in-use table.

**No migration is proposed or applied in this round** — this section exists to size the work, not to
schedule it.
