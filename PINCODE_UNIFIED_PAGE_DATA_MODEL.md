# Pincode Checker — Unified Page Data Model

**Status:** Schema proposal only, amended. No migration applied in this round or the prior one — this
remains the design to review before one is written.
**Companion:** `PINCODE_UNIFIED_PAGE_PRODUCT_SPEC.md` (product flows this schema supports),
`PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md` (scheduler mechanics, phasing).

**Amendment (2026-07-18):** the first draft had a self-contradictory CHECK constraint (§2), no
cross-workspace FK enforcement (§2/§3), an RLS model that let ordinary members write scheduler-owned fields
(§6), a due-index misaligned with its own stated query shape (§3), and an unconstrained result-state column
that couldn't actually enforce the claimed four/five-state vocabulary (§4). All are corrected below; changes
are marked **"Correction N (2026-07-18)"** inline. Two additive facts confirmed directly from this
session's own code reads, relied on throughout this amendment:

- `checker-worker/src/checkers/pincodeAvailability.ts:63` — `const OVERALL_TIMEOUT_MS = 55_000`. This is the
  real, current upper bound on a single pincode check's duration, referenced by
  `IMPLEMENTATION_PLAN.md` §2.2's capacity recalculation — not an assumption.
- `esolz-app/supabase/migrations/001_initial_schema.sql:16` — `CREATE TYPE public.member_role AS ENUM
  ('owner', 'admin', 'member', 'viewer')`. This codebase's actual role model has four roles named
  **owner/admin/member/viewer** — there is no distinct "Analyst" role. §6 documents access by these four
  real roles, not the "Owner/Admin/Analyst/Viewer" naming used in the correction request.

**Amendment 2 (2026-07-18) — confirmed against production, not re-derived:**

- **PostgreSQL version: 17.6 (`server_version_num = 170006`)**, confirmed by independent production check.
  §2's `ON DELETE SET NULL (column_name)` column-specific syntax (PG15+) is therefore **supported, not a
  risk to hedge on** — the composite-FK design in §2/§3/§4 is the primary path, not a "recommended if
  available" one. The PG-version fallback (trigger-based enforcement) remains documented for portability
  (e.g. a future non-Supabase or downgraded environment) but is explicitly **not a blocker for this
  project**.
- **Read-only production audit of `pincode_availability_results` (Correction 8/§4a), actual counts:**
  `availability_status = 'available'` with `error_code` absent: **18 rows**; `availability_status =
  'unknown'` with `error_code` present: **7 rows**. No other `(availability_status, error_code presence)`
  combination currently exists in production. §4a's backfill rule is updated to these exact facts, not a
  hypothetical value set.

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

-- Correction 13 (2026-07-18): every new mutable table gets the existing,
-- proven updated_at trigger (same function as migrations 018/029/039/059) --
-- do not rely on application code to keep updated_at honest.
CREATE TRIGGER trg_workspace_default_pincodes_updated_at
  BEFORE UPDATE ON public.workspace_default_pincodes
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
```

`is_active` (rather than hard delete) lets a seller "remove" a default without losing the audit trail of
what was once configured, matching this codebase's general soft-state preference (`tracked_asins.status`,
`pincode_tracking_targets.status` below) over row deletion. The CHECK constraint enforces 6-digit Indian
pincode format at the database layer, not just client-side — matches the "validate six-digit Indian
Pincodes" requirement defensibly (client-side validation can be bypassed; a direct API call cannot bypass a
CHECK constraint).

**Correction (PR #55 review round): replacement is now atomic.** The P0-B API route originally issued two
separate PostgREST write requests (an upsert, then a separate deactivate) to implement "replace the full
default list" — not atomic; a crash/timeout between the two could leave the active set inconsistent with what
the caller asked for. `replace_workspace_default_pincodes(p_workspace_id uuid, p_marketplace_id text,
p_pincodes jsonb)` — `SECURITY DEFINER`, `search_path` pinned, `service_role`-only `EXECUTE` — now performs
the entire replacement (validate → lock existing rows for this workspace+marketplace → upsert every supplied
pincode as active → deactivate every currently-active pincode not in the new list) as one transaction,
rejecting the whole call (no partial write) on any invalid/duplicate pincode or malformed `displayOrder`.
Unlike Edit Pincodes (§3c), an **empty list IS allowed** here — it deactivates every default, atomically,
never a hard delete. Required tests: atomic replacement; rollback (zero partial mutation) on an invalid list
mixed with otherwise-valid entries; duplicate-pincode rejection; empty-list acceptance.

---

## 2. `pincode_monitored_products`

The enrollment record — "this product should be pincode-tracked," independent of which pincodes or how
often.

**Correction 1 (2026-07-18) — the owned-FK contradiction is fixed.** The first draft's
`pincode_monitored_products_owned_has_listing_ref_chk` CHECK (`product_source <> 'owned' OR
amazon_listing_item_id IS NOT NULL`) directly contradicted the same table's own `ON DELETE SET NULL` on
that column: the moment a source listing row was deleted, the FK would null itself and the CHECK would then
reject *every subsequent UPDATE to that row* (including the archival reconciliation UPDATE meant to handle
exactly this case) — a self-defeating design. **`product_source` means the product's current
relationship to the seller** (`'owned'` or `'other'`), not "has a currently-live FK." The permanent
CHECK forbidding a null `amazon_listing_item_id` on an owned row is **removed**. In its place:

- The owned-listing requirement is enforced **once, at enrollment time**, inside the atomic enrollment
  RPC/server route (§2a below) — not as a standing database CHECK.
- After enrollment, `amazon_listing_item_id` may legitimately become `NULL` (`ON DELETE SET NULL`, unchanged)
  if the source listing is later removed from the sync. The monitored-product row, its `product_source`
  label, and its full `pincode_availability_results` history are preserved — the row does **not** get
  deleted, re-created, or silently relabelled `'other'`.
- The reconciliation pass (§5) is extended: an owned row whose `amazon_listing_item_id` has gone `NULL`
  (source listing removed) is moved to `status = 'archived'`, same as any other archived-source case.
- **Correction 2 (2026-07-18) — cross-workspace FK integrity.** The first draft's FKs
  (`amazon_listing_item_id uuid REFERENCES amazon_listing_items(id)`, `tracked_asin_id uuid REFERENCES
  tracked_asins(id)`) validate that the referenced row *exists*, but never that it belongs to the **same
  workspace** — a single-column FK cannot express that. A malicious or buggy write could set
  `amazon_listing_item_id` to a real row belonging to a different workspace's catalog, and the FK alone
  would accept it; only RLS (a filter on reads, not a constraint on writes across tables) would stand in the
  way, and RLS is not referential integrity. Corrected to **workspace-scoped composite FKs**:

```sql
-- Preconditions on the two existing referenced tables (additive, safe --
-- both tables' id columns already carry a PRIMARY KEY, so
-- (workspace_id, id) is trivially unique; this just exposes that as an
-- FK target). Neither statement rewrites or locks existing data in a way
-- that risks the tables' current consumers.
ALTER TABLE public.amazon_listing_items
  ADD CONSTRAINT amazon_listing_items_workspace_id_uidx UNIQUE (workspace_id, id);
ALTER TABLE public.tracked_asins
  ADD CONSTRAINT tracked_asins_workspace_id_uidx UNIQUE (workspace_id, id);

CREATE TABLE public.pincode_monitored_products (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id        text        NOT NULL,
  asin                  text        NOT NULL,
  product_source        text        NOT NULL,  -- 'owned' | 'other'

  amazon_listing_item_id uuid,
  tracked_asin_id        uuid,

  title_snapshot        text,
  image_url_snapshot     text,
  brand_snapshot         text,

  -- Correction 13 (2026-07-18, round 4): the PARENT lifecycle has exactly
  -- three states -- 'active' | 'archived' | 'removed'. There is no
  -- parent-level 'paused'. "Paused"/"Failed"/"Partially active" are
  -- DERIVED UI states computed from the child pincode_tracking_targets'
  -- own statuses (which DO have 'paused' -- that enum is unchanged, §3) --
  -- see the dedicated discussion after this table for the full reasoning
  -- and the tracker-derivation formula.
  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'archived' | 'removed'

  -- Correction 6 (2026-07-18, round 3): soft user-removal, distinct from
  -- source-driven archival (below) -- see the dedicated discussion after
  -- this table for why both states exist and must stay distinguishable.
  removed_at            timestamptz,
  removal_reason        text,  -- narrow, application-defined code, e.g. 'user_requested'

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_monitored_products_uidx
    UNIQUE (workspace_id, marketplace_id, asin),
  -- FK target for pincode_tracking_targets / pincode_availability_results (§3/§4) --
  -- lets THOSE tables' own composite FKs prove same-workspace, not just same-row.
  CONSTRAINT pincode_monitored_products_workspace_id_uidx
    UNIQUE (workspace_id, id),
  CONSTRAINT pincode_monitored_products_source_chk
    CHECK (product_source IN ('owned', 'other')),
  CONSTRAINT pincode_monitored_products_status_chk
    CHECK (status IN ('active', 'archived', 'removed')),
  CONSTRAINT pincode_monitored_products_asin_format_chk
    CHECK (asin ~ '^[A-Z0-9]{10}$'),
  -- Correction 6: removed_at/removal_reason are set together with status
  -- transitioning to 'removed', and only then -- prevents a row claiming
  -- removal metadata while not actually being in the removed state, or
  -- vice versa.
  CONSTRAINT pincode_monitored_products_removed_consistency_chk
    CHECK (
      (status = 'removed' AND removed_at IS NOT NULL)
      OR
      (status <> 'removed' AND removed_at IS NULL AND removal_reason IS NULL)
    ),

  -- Workspace-scoped composite FKs (Correction 2): the referenced row must
  -- belong to the SAME workspace_id, enforced by Postgres, not just RLS.
  -- ON DELETE SET NULL (<col>) is PostgreSQL 15+ syntax that nulls only the
  -- named column, never workspace_id itself -- CONFIRMED SUPPORTED: this
  -- production project runs PostgreSQL 17.6 (server_version_num=170006,
  -- independently verified 2026-07-18). This is the primary design, not a
  -- version-gated one. The trigger-based fallback below is kept only for
  -- portability to a hypothetical future non-PG15+ environment, not because
  -- this project needs it.
  CONSTRAINT pincode_monitored_products_listing_fk
    FOREIGN KEY (workspace_id, amazon_listing_item_id)
    REFERENCES public.amazon_listing_items (workspace_id, id)
    ON DELETE SET NULL (amazon_listing_item_id),
  CONSTRAINT pincode_monitored_products_tracked_asin_fk
    FOREIGN KEY (workspace_id, tracked_asin_id)
    REFERENCES public.tracked_asins (workspace_id, id)
    ON DELETE SET NULL (tracked_asin_id)
  -- Note: the owned-row-must-have-a-listing-ref requirement from the first
  -- draft is intentionally NOT a CHECK here -- see the correction note
  -- above §2 and the enrollment RPC in §2a.
);

CREATE INDEX pincode_monitored_products_workspace_status_idx
  ON public.pincode_monitored_products (workspace_id, status);
CREATE INDEX pincode_monitored_products_listing_item_idx
  ON public.pincode_monitored_products (amazon_listing_item_id) WHERE amazon_listing_item_id IS NOT NULL;
CREATE INDEX pincode_monitored_products_tracked_asin_idx
  ON public.pincode_monitored_products (tracked_asin_id) WHERE tracked_asin_id IS NOT NULL;

CREATE TRIGGER trg_pincode_monitored_products_updated_at
  BEFORE UPDATE ON public.pincode_monitored_products
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
```

**Correction 13 (2026-07-18, round 4) — the parent's `status` is a lifecycle field, not a display field; do
not overload it with "paused."** Round 3's enum (`active`/`paused`/`archived`/`removed`) let a parent's own
`status` mean two different things depending on context: sometimes "the product's relationship to its
source" (owned/archived/removed) and sometimes "did the seller pause this product's checks." That ambiguity
is exactly what caused round 3's own archival-cascade bug (§5) — code that reasoned about "the parent's
status" had to guess which meaning applied. **Locked: the parent lifecycle contains exactly three states —
`active`, `archived`, `removed`.** There is no parent-level `paused`.

- **Product-level "Paused," "Failed," and "Partially active" are *derived* UI states**, computed by reading
  the child `pincode_tracking_targets` rows under an `active`-lifecycle parent (target `status` keeps its own
  unchanged four-value enum — `active`/`paused`/`failed`/`checking`, §3):
  - **Paused** (product-level): parent is `active`, and every non-`checking` child target is `paused`.
  - **Failed** (product-level): parent is `active`, and every "should be running" child target (i.e. every
    target that isn't itself individually `paused`) is `failed`.
  - **Partially active** (product-level, a new, honestly-named state — not a synonym for "Active"): parent is
    `active`, and its child targets are a genuine mix of `active`/`paused`/`failed` — some checks are running,
    some aren't, and collapsing that into a single "Active" or "Paused" label would misrepresent the actual
    state to the seller.
  - **Active** (product-level, unchanged meaning): parent is `active`, and at least one child target is
    `active` or `checking`, with no `paused`/`failed` targets present (a clean, fully-running product).
- **"Product-level Pause" is a UI convenience, not a new parent state** — clicking Pause on a product row
  bulk-pauses its child targets via `set_pincode_tracking_state` (§3a), exactly as if the seller had
  multi-selected every pincode row individually. The parent's own `status` never changes to reflect this —
  it stays `'active'` the entire time, because from the *lifecycle* perspective (does this product still have
  a valid source / has the seller removed it) nothing has changed, only its checks have.
- **Claim filtering is unaffected by this correction** — `claim_due_pincode_targets` (`IMPLEMENTATION_PLAN.md`
  §2.8) already filters on `p.status = 'active'` at the parent level and `t.status = 'active'` at the target
  level independently; removing `'paused'` from the parent enum doesn't change that predicate's meaning, it
  just removes a value that predicate never needed to check for in the first place (a target-level pause was
  always sufficient to make a target unclaimable, with or without a parent-level pause concept).
- **Manual Check Now's status-test matrix is corrected accordingly** (`IMPLEMENTATION_PLAN.md` §2.10) — it
  already tested parent `status IN ('archived', 'removed')` as the rejection condition, which remains correct
  and requires no further change; it never had a parent-`'paused'` branch to remove.

`pincode_monitored_products_status_chk` above enforces this directly — a write attempting `status = 'paused'`
on this table is rejected at the database layer, not just discouraged by convention.

**Correction 6 (2026-07-18, round 3) — `archived` and `removed` are deliberately two different states, not
one.** The UI's "Remove Tracking" action needs a truthful soft-removal state, and the schema had none — only
`archived`, which is **source-driven** (the underlying `amazon_listing_items`/`tracked_asins` row went away
or was archived, §5) and happens without any user action on this feature at all. Conflating the two would
mean a seller's deliberate "stop tracking this" action renders identically to "Amazon's data disappeared out
from under you," which is exactly the kind of misleading-state problem this spec's data-truth rules exist to
prevent (`PRODUCT_SPEC.md` §9). Hard-deleting the row instead of adding `removed` was rejected because it
would null every history FK pointing at it (`DATA_MODEL.md` §4), lose the direct product/target association
for every historical result, and make the audit trail harder to inspect — exactly the reasons decision #10
already established for preserving archived-product history.

**Required behavior for `removed`:**
- Set only via an explicit user action (a dedicated server route → `set_pincode_tracking_state` RPC, §2a
  below) — never by any automated/reconciliation process (that's what `archived` is for).
- All future checks pause immediately — every child `pincode_tracking_targets` row transitions per the same
  in-flight-safe rule as archival (§5's corrected cascade: `active`/`paused`/`failed` targets go `paused`
  immediately; a `checking` target is left alone until its current attempt finalizes or is reclaimed, never
  yanked out from under the worker).
- Any pending `manual_requested_at`/`manual_request_token` is cleared — a removed product has no business
  having a queued manual check outlive the removal.
- Removed targets **do not** consume quota (§2b) — same as `archived`/`paused`.
- History (`pincode_availability_results` rows) remains joined to the same `monitored_product_id`/
  `tracking_target_id` — untouched, exactly like the archival case.
- Removed products are hidden from the default tracker view; a dedicated **Removed filter** (mirroring the
  existing Archived filter) surfaces them, same as decision #10's "never silently disappear" requirement
  applied to a user-initiated removal, not just a source-side one.
- **Re-adding a previously-removed product restores the same `pincode_monitored_products` row** (transitions
  `status` back to `'active'`, clears `removed_at`/`removal_reason`, re-quota-checks per §2b) rather than
  inserting a new row — the `pincode_monitored_products_uidx UNIQUE (workspace_id, marketplace_id, asin)`
  constraint already makes this the natural path: a re-add attempt collides with the existing removed row and
  the enrollment RPC (§2a) must detect and restore it, not error or silently no-op.

`archived` and `removed` stay fully distinguishable in the UI (different labels, different filters) and at
the data layer (`removed_at`/`removal_reason` populated only for user-initiated removal; the archival cascade
in §5 never sets them).

**Portability fallback (not needed for this project — production is confirmed PG17.6):** if this schema were
ever ported to a Postgres <15 environment, replace the two composite FKs' `ON DELETE SET NULL (<col>)`
clause with plain `ON DELETE NO ACTION`, keep the single-column `amazon_listing_item_id uuid REFERENCES
amazon_listing_items(id) ON DELETE SET NULL` FK **in addition** to the composite one for the actual
null-on-delete behavior, and add a `BEFORE INSERT OR UPDATE` trigger that rejects any row where
`amazon_listing_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM amazon_listing_items WHERE id =
NEW.amazon_listing_item_id AND workspace_id = NEW.workspace_id)` (same for `tracked_asin_id`) — equally
strong, database-enforced, just trigger-based instead of a single composite FK. This is retained purely for
documentation completeness/portability; implementation should use the composite-FK form above directly, with
no version-gating logic, since the version is already confirmed.

**Marketplace consistency (Correction 2, "confirm whether required"):** `amazon_listing_items.marketplace_id`
is nullable (`007_amazon_account_data_foundation.sql:77`), so it cannot be folded into the composite FK
above without risking rejecting valid listings that haven't synced a marketplace yet. Recommendation:
enforce marketplace match (`pincode_monitored_products.marketplace_id = amazon_listing_items.marketplace_id`
at the referenced row) at the **enrollment RPC** layer (§2a), the same place the owned-listing requirement
itself is enforced, rather than as a standing DB constraint — flagged explicitly rather than silently
assumed, and the enrollment integration tests (§`IMPLEMENTATION_PLAN.md` §5) must cover a
marketplace-mismatch rejection case.

**Why two nullable FKs instead of a polymorphic `(source_table, source_id)` pair:** unchanged from the first
draft — a polymorphic ID (storing a table name as a string alongside a raw UUID) cannot be validated by a
real foreign key constraint. Two real, nullable, workspace-scoped composite foreign keys let Postgres
enforce referential integrity *and* tenant isolation for whichever one is populated, while the
`product_source` CHECK constraint keeps the *meaning* unambiguous — matching the "narrow, explicit CHECK
over a loose polymorphic shape" discipline already used in this codebase (e.g.
`competitor_asins_source_type_check`, migration `024`).

`title_snapshot`/`image_url_snapshot`/`brand_snapshot` exist so an "Other Product" enrollment (which has no
guaranteed live catalog row to join against later) still displays sensibly even if the original lookup
result is never re-fetched — mirrors the existing `tracked_asins.product_title/brand/image_url` pattern
(migration `001`).

---

## 2a. Atomic, concurrency-safe, all-or-nothing bulk enrollment

**Round 3 rewrite.** Two gaps in the round-2 design, both closed here:

- **Correction 1 — quota was count-then-insert, not concurrency-safe.** Two concurrent enrollment/resume
  requests could both `SELECT count(*)`, both see room under the limit, and both insert/resume — jointly
  oversubscribing the quota. Every operation that increases the active-target count must serialize on the
  same workspace+marketplace lock: **`pg_advisory_xact_lock`**, keyed deterministically from
  `(workspace_id, marketplace_id)`, acquired inside each RPC's transaction. Chosen over a dedicated
  quota-settings row (`FOR UPDATE`) because no such table is otherwise needed for P0 — an advisory lock adds
  zero schema. A hash collision between two different `(workspace_id, marketplace_id)` pairs would cause
  harmless additional serialization (one waits briefly for the other's unrelated transaction), never
  incorrect oversubscription — the lock is a safety mechanism, a false conflict is merely slower, never
  wrong.
- **Correction 2 — "one transaction per product" contradicted "bulk requests never partially enroll."** A
  5-products × 6-pincodes request must be evaluated and written as **one** unit: all 30 candidate targets
  validated first, one quota decision made against the total, then either every genuinely-new target is
  created or none are.

**Deterministic advisory lock key**, shared by every RPC in this section and §2c/§3a below (must be
identical across all of them — a different derivation per RPC would defeat the whole point of the lock):

```sql
-- Deterministic 64-bit key from (workspace_id, marketplace_id). hashtextextended
-- is stable across calls with the same inputs within one Postgres version/build,
-- which is sufficient for advisory-lock purposes (it need not be stable across
-- Postgres versions, since the lock is purely in-memory/session-scoped, never
-- persisted).
SELECT pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));
```

**`enroll_pincode_monitored_products(p_workspace_id uuid, p_marketplace_id text, p_products jsonb, p_quota_limit integer)`**
— the single atomic bulk-enrollment RPC, `SECURITY DEFINER`, `search_path` pinned, `service_role`-only
`EXECUTE`.

**Round 4 rewrite — follows the one global lock order (`IMPLEMENTATION_PLAN.md` §2.0), re-validates
workspace/marketplace on every locked row (Correction 3), reactivates a re-added removed product's existing
targets atomically instead of requiring a second Resume call (Correction 10), and validates its own
parameters before doing anything else (Correction 14):**

- `p_products` is a JSONB array, one element per product:
  `{ "product_source": "owned"|"other", "amazon_listing_item_id": uuid|null, "tracked_asin_id": uuid|null,
  "asin": text, "title_snapshot": text|null, "image_url_snapshot": text|null, "brand_snapshot": text|null,
  "pincodes": text[] }` — the caller (server route) has already resolved the listing/lookup for each product
  before calling this RPC (§6's approved lookup path, `enroll_pincode_monitored_products` itself does not
  call SP-API).
- **Transaction body:**
  0. **Correction 14 — parameter validation, before any lock or query:** `p_products` array length must be
     ≤ a bounded maximum (e.g. 200 products per call — bulk, not unbounded); each element's `pincodes` array
     must also be bounded (e.g. ≤ 100); `p_quota_limit` must be a positive integer (reject `NULL`, `0`,
     negative — an environment-variable typo must never silently become "unlimited"); every `pincode` string
     must match the pincode format, every `asin` the ASIN format (defense-in-depth alongside the target/
     product table's own CHECK constraints, §1/§2/§3); **duplicate `(asin, pincode)` pairs within the same
     request are normalized (de-duplicated) before quota calculation** — a caller submitting the same pincode
     twice for the same product must not be double-counted against quota.
  1. **Lock order step 1:** `SELECT pg_advisory_xact_lock(...)` using the deterministic key above — held for
     the remainder of this transaction, released automatically on commit/rollback.
  2. **Lock order step 2 — lock parent rows first, ordered by `id`:** for every element of `p_products`,
     resolve or create the parent `pincode_monitored_products` row and lock it: `SELECT * FROM
     pincode_monitored_products WHERE workspace_id = :workspace_id AND marketplace_id = :marketplace_id AND
     asin = :asin FOR UPDATE` (existing row) — **all such locks acquired in a single query ordered by `id`**
     (`... ORDER BY id FOR UPDATE`) to respect the global lock order and avoid a self-deadlock within this
     same call when the batch touches multiple products. For a product with no existing row, no lock is
     needed yet (it will be created in step 6).
  3. **Correction 3 — re-validate, don't just trust the caller's parameters:** for every locked existing
     parent row, confirm `parent.workspace_id = p_workspace_id AND parent.marketplace_id = p_marketplace_id`
     — this is already guaranteed by the `WHERE` clause in step 2 (the lookup itself is scoped), stated here
     explicitly because it is the same discipline every other RPC in this document must follow, not a gap
     specific to this one.
  4. If `product_source = 'owned'`: `SELECT id, marketplace_id FROM amazon_listing_items WHERE id =
     :amazon_listing_item_id AND workspace_id = :workspace_id FOR SHARE` — if not found, or its
     `marketplace_id` doesn't match `p_marketplace_id` (the marketplace-consistency check, §2), **reject the
     entire request**, do not write anything for any product in the batch.
  5. **Lock order step 3 — lock target rows second, ordered by `id`:** for every `(product, pincode)` pair in
     the batch, `SELECT t.* FROM pincode_tracking_targets t JOIN pincode_monitored_products p ON p.id =
     t.monitored_product_id WHERE p.workspace_id = :workspace_id AND p.asin = :asin AND t.pincode = :pincode
     ORDER BY t.id FOR UPDATE` — classify each pair:
     - **No existing target** → genuinely new, will be `INSERT`ed as `active`.
     - **Existing target, `status = 'active'` or `'checking'`** → no-op, does not count as additional quota
       (it's already counted in the current total).
     - **Existing target, `status IN ('paused', 'failed')`, and the parent was `'removed'` before this call**
       → **Correction 10: a re-add reactivation**, not a separate Resume call. This request already implies
       "bring this product back," so its previously-paused/failed targets for the pincodes selected in this
       same request are reactivated (`status = 'active'`, and for a `'failed'` target,
       `consecutive_failures = 0`) **inside this same transaction**, counted as additional quota below,
       exactly like a genuinely-new target.
     - **Existing target, `status IN ('paused', 'failed')`, parent was already `'active'`** → **not**
       reactivated by this RPC (a seller re-enrolling into an already-active product's existing paused
       pincode is a deliberate Resume action, routed to `set_pincode_tracking_state`, §3a — this RPC does not
       silently resume targets under an already-active parent, only under the specific re-add-a-removed-
       product case above, where reactivation is the whole point of the request).
     - Any pincode from `p_products` **not** present among the batch's existing targets, for a product that
       already has *other* historical targets not selected in this request, is left untouched — "unselected
       historical targets remain paused" (Correction 10's explicit requirement).
  6. Count genuinely-new targets **plus** re-add reactivations from step 5 → `v_requested_additional`.
  7. `SELECT count(*) FROM pincode_tracking_targets t JOIN pincode_monitored_products p ON p.id =
     t.monitored_product_id WHERE p.workspace_id = :workspace_id AND p.marketplace_id = :marketplace_id AND
     t.status IN ('active', 'checking')` → `v_current_active` (§2b — this counts the **target** table only,
     whose status enum is `active`/`paused`/`failed`/`checking`; a target's *product* lifecycle state is a
     separate, parent-level fact per Correction 13, not part of this count's own `WHERE` clause).
  8. If `v_current_active + v_requested_additional > p_quota_limit`, **raise/return** the locked quota error
     (§2b) — no `INSERT`/`UPDATE` for *any* product, pincode, or reactivation in the batch, even the ones
     that individually would have fit. Never create a subset unless the caller submits a new, smaller
     request.
  9. Otherwise, perform the **complete** write in the same transaction: for each product, `INSERT ... ON
     CONFLICT (workspace_id, marketplace_id, asin) DO UPDATE` (unchanged Other→Owned promotion logic from
     round 1/2) against `pincode_monitored_products` — **when the conflicting existing row is `status =
     'removed'`, the `DO UPDATE` also clears `removed_at`/`removal_reason` and sets `status = 'active'`
     (Correction 10 — the parent restore happens atomically here, in the same statement, not a separate
     call)**; for each genuinely-new `(product, pincode)` pair, `INSERT` into `pincode_tracking_targets`
     (`status = 'active'`, `next_check_at = now()`); for each re-add reactivation identified in step 5,
     `UPDATE` that exact locked target row (`status = 'active'`, `next_check_at = now()`, and
     `consecutive_failures = 0` if it was `'failed'`) — **no second Resume request is required after a
     re-add**, satisfying Correction 10's explicit requirement.
  10. Commit. The advisory lock releases automatically. **Lock order step 4** (result insertion/finalization)
      does not apply to this RPC — enrollment never writes to `pincode_availability_results`.
- **Marketplace consistency** (round 1's flagged-but-deferred item) is enforced directly in step 4 above,
  inside the same atomic pass.
- **Archived products are explicitly out of scope for this "re-add" reactivation path** — Correction 10 also
  requires "equivalent behavior when an archived product becomes valid and is explicitly re-enrolled from a
  confirmed owned catalog listing": the same `ON CONFLICT ... DO UPDATE` branch applies when the conflicting
  existing row is `status = 'archived'` (not just `'removed'`) **and** the enrollment attempt is `'owned'`
  with a freshly-verified listing (step 4 above) — the parent is restored to `'active'` and its
  paused/failed targets for the selected pincodes are reactivated by the same step-5/9 logic, since from the
  seller's perspective "the listing came back and I'm re-enrolling it" is the same shape of event as "I
  un-removed a product I'd removed myself."

**Every quota-increasing path uses this same lock discipline** — not just fresh enrollment:

| Path | RPC | Locks |
|---|---|---|
| New enrollment (bulk or single) | `enroll_pincode_monitored_products` | Advisory lock (above) |
| Adding pincodes to an already-enrolled product | `enroll_pincode_monitored_products` (same RPC — a pincode-add is structurally identical to enrolling a product with 1 element, `p_products` already includes the product's existing `amazon_listing_item_id`/`tracked_asin_id` so no re-verification is skipped) | Advisory lock (above) |
| Resuming a paused/failed target under an already-`active` parent | `set_pincode_tracking_state` (§3a) | Same advisory lock, same key derivation |
| Re-adding a `removed`/`archived` parent, reactivating its selected existing targets | `enroll_pincode_monitored_products` (Correction 10 — atomic in the same call, not a separate Resume) | Same advisory lock, same key derivation |
| Bulk enrollment | `enroll_pincode_monitored_products` | Advisory lock (above), one lock acquisition for the whole batch, not per-product |

Integration tests (required, `IMPLEMENTATION_PLAN.md` §5) must cover: enrolling an owned product with a
valid listing succeeds; enrolling an owned product with a fabricated/foreign-workspace listing ID is
rejected; enrolling the same ASIN as owned after it was already "other" performs the promotion in place and
does not duplicate history; a 5-product×6-pincode bulk request where only some pairs fit under quota is
rejected in full, not partially applied; two concurrent enrollment requests that would jointly exceed quota
serialize correctly and exactly one succeeds (or both succeed if there was room for both, but never both
succeeding when only one should have); **duplicate `(asin, pincode)` pairs within one request are
normalized and not double-counted against quota (Correction 14); a bulk request exceeding the bounded array
length is rejected outright (Correction 14); re-adding a previously-removed product with 3 of its 5
historical pincodes selected reactivates exactly those 3 targets and restores the parent to `active` in one
call, with no second Resume request needed, and the projected quota calculation correctly includes the
reactivated targets, not just the genuinely-new ones (Correction 10).**

---

## 2b. Enrollment quota — locked founder decision, round-3-corrected

**Locked:** capped enrollment with explicit rejection. Unlimited enrollment followed by silent scheduler
throttling is **not** the P0 design.

**Quota unit:** one **active** `pincode_tracking_targets` row, scoped `(workspace_id, marketplace_id)`.

- My Products and Other Products consume the **same** quota pool — `product_source` is irrelevant to the
  count.
- **Correction 4 (2026-07-18, round 3) fixes a wrong reference here:** the round-2 text said `status IN
  ('paused', 'archived')` targets don't count — but `pincode_tracking_targets.status` **has no `'archived'`
  value** (§3's enum is `active`/`paused`/`failed`/`checking` only; `archived`/`removed` are states of the
  **parent** `pincode_monitored_products` row, §2). Corrected: `paused` and `failed` targets do not count
  toward the active total (only `t.status IN ('active', 'checking')` counts, per the query below — this was
  always what the SQL itself said, only the prose bullet was wrong). A target whose *parent product* has
  gone `archived`/`removed` is cascaded to `paused` by the reconciliation pass or the removal RPC (§5, §2
  above) — at that point it stops counting because its own `status` is `paused`, not because of any direct
  reference to the parent's state in this count.
- `status = 'checking'` targets **do** count (they're still an active, currently-in-flight target; excluding
  them would let a seller enroll past the limit by racing the scheduler).
- Resuming a paused target (`status: 'paused' → 'active'`) **re-checks** quota exactly like a fresh
  enrollment — quota is not a one-time gate at initial enrollment only.
- **Manual Check Now does NOT consume this quota** — locked founder decision, round 3, see §2c immediately
  below. A manually-checked target is already enrolled and already counted here; Manual Check Now doesn't
  create a new target, it just prioritizes an existing one's next check.

**Enforcement point:** `enroll_pincode_monitored_products` (§2a) and `set_pincode_tracking_state` (§3a) both
acquire the **same deterministic advisory lock** (§2a) before counting, so concurrent callers serialize
instead of both reading a stale count (Correction 1, round 3 — fixes the round-2 count-then-insert race):

```sql
-- Inside the advisory-lock-held transaction (§2a step 1):
SELECT count(*) FROM pincode_tracking_targets t
JOIN pincode_monitored_products p ON p.id = t.monitored_product_id
WHERE p.workspace_id = :workspace_id
  AND p.marketplace_id = :marketplace_id
  AND t.status IN ('active', 'checking');
```

If `current_count + requested_additional_count > limit`, the enrollment/resume is **rejected in the same
transaction** — no partial enrollment (e.g. 3 of 5 requested pincodes succeeding, 2 silently dropped) is
created (Correction 2, round 3 — see §2a's full bulk-validation sequencing). Required response shape
(service-role RPC raises a distinguishable error; the calling server route maps it to HTTP):

```
HTTP 409
{
  "errorCode": "pincode_tracking_quota_exceeded",
  "currentActiveTargets": <int>,
  "requestedAdditionalTargets": <int>,
  "limit": <int>
}
```

**The limit itself is config-driven, not a schema value.** P0 ships **one configurable internal-workspace
limit** (an environment variable, e.g. `PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE`, read by the
enrollment/resume RPC's calling server route and passed as a parameter — not hardcoded inside the RPC, so it
can be tuned without a migration) — the exact numeric value is **not invented in this spec**, it is a
product/ops decision to be set alongside the P0-A implementation PR (`IMPLEMENTATION_PLAN.md` §9). Commercial
plan-specific quota tiers (different limits per subscription plan) stay explicitly P1 — P0's single
configurable limit does not attempt to model per-plan tiering.

---

## 2c. Manual Check Now rate control — separate from enrollment quota, locked founder decision (round 3)

**Locked:** Manual Check Now does **not** consume the enrollment quota (§2b). Reason, stated by the founder:
the target is already enrolled and already consumes standing recurring-check capacity — charging it against
the enrollment quota a second time for being manually checked would double-count the same capacity.

**P0 Manual Check Now rate control consists of exactly two mechanisms, both already partially specified in
round 2 and confirmed here as the complete P0 set:**

1. **Per-target cooldown** (`PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS`, unchanged from round 2,
   `IMPLEMENTATION_PLAN.md` §2.10).
2. **A configurable maximum number of outstanding manual requests per `(workspace_id, marketplace_id)`** —
   new this round, config `PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE`.

**"Outstanding" is defined precisely, not left implicit:**
- **Queued:** `manual_requested_at IS NOT NULL` and the target's `status` is not yet `'checking'` (i.e. it's
  recorded but the scheduler hasn't claimed it yet).
- **Checking:** `manual_requested_at IS NOT NULL` and `status = 'checking'` (the scheduler has claimed it and
  a check is actively in flight).
- Both count toward the outstanding total — a request stops being outstanding only once
  `finalize_pincode_check` clears `manual_requested_at` (`IMPLEMENTATION_PLAN.md` §2.7).

**Enforcement:** computed **inside** `queue_pincode_manual_check` itself, under the same deterministic
advisory lock as §2a/§2b (same key derivation, same `(workspace_id, marketplace_id)` scope) — never
precomputed by the calling route and passed in as a value, which would be stale the instant a concurrent
request changes the count. Full RPC body in `IMPLEMENTATION_PLAN.md` §2.10 (round-3 Correction 9). Required
response shape on rejection — **deliberately a different `errorCode` from §2b's enrollment quota**, since
enrollment capacity and manual-queue pressure are different concepts a seller should be able to tell apart:

```
HTTP 409
{
  "errorCode": "pincode_manual_queue_limit_reached",
  "currentOutstanding": <int>,
  "limit": <int>
}
```

**No separate daily/monthly manual-request pool exists in P0** — only the outstanding-count limit above.
Commercial usage-based limits (e.g. "100 manual checks per month on the free plan") stay explicitly P1, same
deferral pattern as §2b's per-plan enrollment tiers.

---

## 3. `pincode_tracking_targets`

The **recurring configuration** — "this monitored product should be checked against this pincode, on this
cadence." This is the table `PRODUCT_SPEC.md` §9's "missing `next_check_at` is not due now" rule binds to.

**Corrections applied here (2026-07-18):** Correction 2 (workspace-scoped composite FK to
`pincode_monitored_products`), Correction 4/7 (a real `claim_token` for atomic-claim + idempotent-finalize,
§`IMPLEMENTATION_PLAN.md` §2), Correction 9 (due-index column order fixed to match the actual global query,
plus a second workspace-scoped index), Correction 13 (cadence/failure-count/claim-consistency CHECKs,
`updated_at` trigger), and manual-request fields for Correction 10 (genuinely queued Check Now).

```sql
CREATE TABLE public.pincode_tracking_targets (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  monitored_product_id  uuid        NOT NULL,
  pincode               text        NOT NULL,

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'failed' | 'checking'
  cadence_hours         integer     NOT NULL DEFAULT 24,

  -- Claim fields. Correction 4/7: claimed_at/claimed_by remain (worker
  -- identity + claim timestamp, used by stale-claim reclaim, §2.4 of the
  -- Implementation Plan), PLUS a claim_token -- a fresh, unique token minted
  -- by the atomic claim RPC per claim attempt. The token (not claimed_by
  -- alone) is what the finalize RPC uses as the idempotency key: retrying a
  -- finalize call with the same claim_token is a no-op if that token's
  -- result was already recorded (§4's check_attempt_id unique constraint).
  claimed_at            timestamptz,
  claimed_by            text,
  claim_token           uuid,

  -- Correction 10: genuinely queued Manual Check Now. A manual request is
  -- recorded here atomically and coalesced (a second click while one is
  -- already pending/checking is a no-op, not a second request) rather than
  -- firing a synchronous check from the browser request.
  manual_requested_at   timestamptz,
  manual_requested_by   uuid,
  manual_request_token  uuid,

  last_checked_at       timestamptz,
  next_check_at         timestamptz,           -- NULL = not yet scheduled, never "due now" by default
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_error_code       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_tracking_targets_uidx
    UNIQUE (monitored_product_id, pincode),
  CONSTRAINT pincode_tracking_targets_workspace_id_uidx
    UNIQUE (workspace_id, id),  -- FK target for pincode_availability_results (§4)
  -- Correction 12 (2026-07-18, round 4): composite identity proving a
  -- target's (workspace_id, id) pair, together with the product it
  -- belongs to, is internally consistent. This is the FK target
  -- pincode_availability_results uses (§4) to prove a result's
  -- tracking_target_id and monitored_product_id actually agree with each
  -- other, not just that each independently belongs to the right
  -- workspace.
  CONSTRAINT pincode_tracking_targets_identity_uidx
    UNIQUE (workspace_id, id, monitored_product_id),
  CONSTRAINT pincode_tracking_targets_status_chk
    CHECK (status IN ('active', 'paused', 'failed', 'checking')),
  CONSTRAINT pincode_tracking_targets_pincode_format_chk
    CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  -- Correction 13: bounded, defensible cadence -- must be positive and
  -- capped (7 days is a generous upper bound for a "recurring" feature;
  -- anything longer isn't meaningfully "standing tracking" anymore).
  CONSTRAINT pincode_tracking_targets_cadence_chk
    CHECK (cadence_hours > 0 AND cadence_hours <= 168),
  CONSTRAINT pincode_tracking_targets_failures_chk
    CHECK (consecutive_failures >= 0),
  -- Correction 13: claim-field consistency -- a 'checking' row must carry
  -- its claim token/time; a non-'checking' row must not retain them (a
  -- released/finalized claim clears these fields, so a stale UPDATE can
  -- never leave a target looking claimed when it isn't).
  CONSTRAINT pincode_tracking_targets_claim_consistency_chk
    CHECK (
      (status = 'checking' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL AND claim_token IS NOT NULL)
      OR
      (status <> 'checking' AND claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL)
    ),
  -- Workspace-scoped composite FK (Correction 2) -- a target cannot
  -- reference a monitored product in a different workspace.
  CONSTRAINT pincode_tracking_targets_monitored_product_fk
    FOREIGN KEY (workspace_id, monitored_product_id)
    REFERENCES public.pincode_monitored_products (workspace_id, id)
    ON DELETE CASCADE
);

-- Correction 9: the due-work query (see below) is GLOBAL -- it selects
-- across all workspaces, ordered by next_check_at, then applies
-- per-workspace fairness inside the claim RPC (IMPLEMENTATION_PLAN.md
-- §2.8/§2.9). An index starting with workspace_id cannot serve a
-- workspace-agnostic ORDER BY next_check_at efficiently -- Postgres would
-- have to scan per-workspace and merge. Corrected to lead with
-- next_check_at, matching the query's actual access pattern:
CREATE INDEX pincode_tracking_targets_due_idx
  ON public.pincode_tracking_targets (next_check_at, workspace_id)
  WHERE status = 'active' AND next_check_at IS NOT NULL;

-- Second, distinct index for workspace-scoped reads (the tracker table's
-- own "my workspace's due count" query, and the per-workspace cap check
-- inside the claim RPC) -- kept separate rather than trying to make one
-- index serve both shapes well.
CREATE INDEX pincode_tracking_targets_workspace_due_idx
  ON public.pincode_tracking_targets (workspace_id, next_check_at)
  WHERE status = 'active' AND next_check_at IS NOT NULL;

CREATE INDEX pincode_tracking_targets_monitored_product_idx
  ON public.pincode_tracking_targets (monitored_product_id);

CREATE UNIQUE INDEX pincode_tracking_targets_manual_request_idx
  ON public.pincode_tracking_targets (manual_request_token) WHERE manual_request_token IS NOT NULL;

-- Correction 2 (2026-07-18): claim_token must be database-enforced unique,
-- not just assumed collision-free by virtue of being a UUID. The finalize
-- RPC (IMPLEMENTATION_PLAN.md §2.7) locates exactly one claimed target by
-- claim_token alone -- without this index, that lookup is only
-- probabilistically safe, not provably safe.
CREATE UNIQUE INDEX pincode_tracking_targets_claim_token_uidx
  ON public.pincode_tracking_targets (claim_token) WHERE claim_token IS NOT NULL;

CREATE TRIGGER trg_pincode_tracking_targets_updated_at
  BEFORE UPDATE ON public.pincode_tracking_targets
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
```

`status = 'checking'` is intentionally listed in the CHECK constraint but excluded from both due-index's
partial predicates — same "claimed rows are invisible to new claims, but not a separate terminal state"
pattern as `review_solicitation_orders`. `'failed'` is a real, distinct terminal-ish state (exceeded
`consecutive_failures` threshold, see `IMPLEMENTATION_PLAN.md` §Scheduler retry policy) — a seller must
explicitly resume it (clears `consecutive_failures`, sets `status='active'`), it does not silently retry
forever.

---

## 3a. Pause/resume — the fifth trusted RPC (Correction 3, round 3)

**Round 2's spec referenced "quota-safe resume behavior" but never actually added a dedicated RPC for it —
this closes that gap.** Fifth RPC (bringing the P0-A total to 5, `IMPLEMENTATION_PLAN.md` §9):
**`set_pincode_tracking_state(p_workspace_id uuid, p_marketplace_id text, p_target_ids uuid[], p_action text, p_quota_limit integer)`**
— `SECURITY DEFINER`, `search_path` pinned, `service_role`-only `EXECUTE`. `p_action` is `'pause'` or
`'resume'`; bulk (`p_target_ids`, an array, not a single ID) so a multi-target pause/resume from the tracker
table's bulk actions is also one atomic operation, never partially applied.

**Round 4 rewrite — follows the one global lock order (`IMPLEMENTATION_PLAN.md` §2.0), re-validates
workspace/marketplace on every locked row (Correction 3), and validates its own parameters up front
(Correction 14):**

0. **Correction 14 — parameter validation, before any lock or query:** `p_target_ids` must be non-empty and
   bounded (e.g. ≤ 500 targets per call); `p_action` must be exactly `'pause'` or `'resume'` — any other
   string is rejected outright, not silently ignored; `p_quota_limit` must be a positive integer (only
   relevant for `'resume'`, but validated regardless of action to keep the check unconditional and simple);
   duplicate IDs within `p_target_ids` are normalized (de-duplicated) before any counting.

**Resume (`p_action = 'resume'`):**
1. **Lock order step 1:** acquire the same deterministic advisory lock as §2a/§2b/§2c
   (`(workspace_id, marketplace_id)`).
2. **Lock order step 2 — lock parent rows first:** `SELECT DISTINCT p.* FROM pincode_monitored_products p
   JOIN pincode_tracking_targets t ON t.monitored_product_id = p.id WHERE t.id = ANY(p_target_ids) ORDER BY
   p.id FOR UPDATE`.
3. **Correction 3 — re-validate every locked parent belongs to the caller's stated scope:** for each locked
   parent, confirm `p.workspace_id = p_workspace_id AND p.marketplace_id = p_marketplace_id`; if any parent
   fails this check, **reject the entire operation** — a caller cannot resume targets belonging to a
   different workspace/marketplace than it claims to be operating in, even if `p_target_ids` happened to
   include such a row (defense-in-depth beyond the composite FK, since the FK proves referential integrity
   at write time, not that *this specific call's* claimed scope matches at read time).
4. If any locked parent's `status` is `archived` or `removed`, **reject the entire operation** —
   "archived/removed product cannot resume" (a resume attempt against a product whose source is gone or that
   the seller explicitly removed makes no sense; the seller must re-add, not resume, per §2a's re-add-restore
   path). Per Correction 13, a parent is never `'paused'`, so there is no such branch to consider here.
5. **Lock order step 3 — lock target rows second:** `SELECT * FROM pincode_tracking_targets WHERE id =
   ANY(p_target_ids) ORDER BY id FOR UPDATE` — re-validate `t.workspace_id = p_workspace_id AND
   t.monitored_product_id = <the corresponding locked parent's id>` for each (same defense-in-depth as step
   3, now at the target level).
6. Calculate the projected active-target count (current `active`/`checking` count, §2b, plus every target in
   this batch that is currently `paused` or `failed` and about to become `active`).
7. If the projection exceeds `p_quota_limit`, **reject the entire operation** with the locked `409
   pincode_tracking_quota_exceeded` shape (§2b) — never partially resume a bulk request.
8. Otherwise, for each target: if it was `failed`, reset `consecutive_failures = 0` (an explicit resume is
   the seller's signal that they want a clean retry, not a continuation of the failure count); set `status =
   'active'`, `next_check_at = now()` (immediately due, same "resuming re-schedules" behavior as a fresh
   enrollment).
9. Commit.

**Pause (`p_action = 'pause'`):**
1. **Lock order step 1:** acquire the same advisory lock (pausing doesn't strictly need it for correctness —
   pausing only *frees* quota, it can't oversubscribe — but using the same lock uniformly avoids a second,
   divergent locking discipline to reason about, and keeps this RPC's lock acquisition order identical to
   every other one regardless of action).
2. **Lock order step 2 — lock parent rows first**, same shape as Resume step 2, re-validated per Correction 3
   the same way.
3. **Lock order step 3 — lock target rows second**, same shape as Resume step 5, re-validated the same way.
4. For each target, branch on its **current** `status`:
   - **`active` or a queued manual request** (i.e. not yet `checking`): set `status = 'paused'`, clear
     `manual_requested_at`/`manual_requested_by`/`manual_request_token`, clear `next_check_at`.
   - **`checking`**: **reject that target** with `409 { errorCode: 'check_in_progress' }` in P0 — do not
     invalidate an in-flight claim out from under the worker currently holding it (the same in-flight-safety
     principle as §5's archival cascade). The seller can pause again once the check finalizes. If the bulk
     request mixes pausable and in-progress targets, P0 rejects the **whole** batch with the
     `check_in_progress` error naming which target(s) are in flight, rather than silently pausing a subset —
     consistent with this RPC's all-or-nothing discipline elsewhere; the UI can prompt the seller to retry
     without the in-flight target(s).
   - **`paused`/`failed`**: no-op (already not running), does not error.
5. Commit.

Both actions share the "the caller always gets an explicit, complete success or an explicit, complete
rejection — never a silent partial result" discipline as `enroll_pincode_monitored_products` (§2a). Neither
action writes to `pincode_availability_results`, so lock-order step 4 (result insertion/finalization) does
not apply to this RPC.

---

## 3b. Remove Tracking — the sixth trusted RPC (Correction 8, round 4)

**`set_pincode_tracking_state` (§3a) only operates on individual targets — it cannot truthfully implement
product-level "Remove Tracking," which is a *parent* lifecycle transition (`status → 'removed'`, §2), not a
target-level pause.** Using target-level pause alone to fake removal would leave the parent's `status`
untouched (still `'active'` per Correction 13's derived-state model) with no `removed_at`/`removal_reason`
recorded anywhere — indistinguishable from a seller who just paused every pincode individually. A dedicated
sixth RPC closes this gap:

**`remove_pincode_monitored_products(p_workspace_id uuid, p_marketplace_id text, p_monitored_product_ids uuid[], p_removal_reason text)`**
— `SECURITY DEFINER`, `search_path` pinned, `service_role`-only `EXECUTE`. Bulk (`p_monitored_product_ids`,
an array) so a multi-select Remove Tracking action is also one atomic operation.

1. **Correction 14 — parameter validation:** `p_monitored_product_ids` non-empty and bounded (e.g. ≤ 200);
   `p_removal_reason` must be one of a narrow, application-defined allowed-value set (e.g.
   `'user_requested'` — never an arbitrary free-text string written unchecked into the database); duplicate
   IDs normalized before processing.
2. **Lock order step 1:** acquire the deterministic advisory lock (§2a) — removal frees quota (same
   reasoning as Pause, §3a, for using the lock uniformly even though removal alone can't oversubscribe).
3. **Lock order step 2 — lock parent rows first:** `SELECT * FROM pincode_monitored_products WHERE id =
   ANY(p_monitored_product_ids) ORDER BY id FOR UPDATE`. **Correction 3:** re-validate every locked parent's
   `workspace_id = p_workspace_id AND marketplace_id = p_marketplace_id`; reject the entire operation on any
   mismatch.
4. If any locked parent is already `status = 'removed'`, treat that specific product as a no-op (idempotent
   — removing an already-removed product is not an error) rather than failing the whole batch; if any locked
   parent is `status = 'archived'`, it may still be removed (a seller can explicitly remove a product whose
   source already disappeared — the two states are not mutually exclusive as a matter of *sequence*, only
   `removed_at`/`removal_reason` win once set, per Correction 9 below).
5. **Lock order step 3 — lock target rows second:** `SELECT * FROM pincode_tracking_targets WHERE
   monitored_product_id = ANY(p_monitored_product_ids) ORDER BY id FOR UPDATE`.
6. **Preferred P0 in-flight behavior (chosen over rejecting the whole batch on any `checking` child target):**
   unlike Pause (§3a), Remove Tracking does **not** reject the operation when a child target is `checking` —
   removal is a stronger, more final action than pause, and making a seller wait for every in-flight check
   across a potentially large product before they can remove it would be poor UX for a "get this off my
   tracker" action. Instead:
   - **`checking` targets are left `checking`** — not touched by this step at all. The parent is still moved
     to `'removed'` in the same transaction (step 7). `finalize_pincode_check`
     (`IMPLEMENTATION_PLAN.md` §2.7) already re-reads the parent's locked status at finalize time and, seeing
     `'removed'`, records the current valid result but finalizes that target to `paused` with `next_check_at
     = NULL` instead of rescheduling — the exact same mechanism Correction 5 already built for archival,
     reused here without modification.
   - **Non-`checking` children** (`active`, `paused`, `failed`) pause immediately: `status = 'paused'`,
     `next_check_at = NULL`, and any pending `manual_requested_at`/`manual_requested_by`/`manual_request_token`
     cleared.
7. Update each parent: `status = 'removed'`, `removed_at = now()`, `removal_reason = p_removal_reason`.
8. Commit. No row is hard-deleted at any point — `pincode_monitored_products`, every child
   `pincode_tracking_targets` row, and all `pincode_availability_results` history remain fully intact and
   joined exactly as before.

This is **one atomic product-level mutation**, not independent route-level updates to the parent and each
child separately — a crash or error partway through rolls back the whole batch, never leaving some products
removed and others not from a single bulk Remove Tracking click.

Required tests (`IMPLEMENTATION_PLAN.md` §5): removing a product with an in-flight `checking` target leaves
that target `checking` and the parent `removed` in the same transaction; a subsequent finalize on that target
records the result and pauses it, never rescheduling; removing an already-removed product is a no-op, not an
error; removing an already-archived product succeeds and sets `removed_at`/`removal_reason`.

---

## 3c. Target configuration lifecycle and "Edit Pincodes" — the seventh trusted RPC (PR #55 review round)

**Gap found in review: the locked route map (`PRODUCT_SPEC.md` §11) always required `PATCH .../products/
[id]/pincodes`, but no RPC or route ever implemented it.** Editing which pincodes a product tracks needs to
distinguish two genuinely different facts the existing `pincode_tracking_targets.status` enum (`active`/
`paused`/`failed`/`checking`, §3) cannot represent together: "this pincode is temporarily paused but still
part of what the seller wants tracked" vs. "this pincode was removed from the product's configured list
entirely." Adding a `'removed'`/`'unconfigured'` value to `status` would conflate an *operational* fact
(is a check currently running/paused/failed) with a *configuration* fact (is this pincode still requested at
all) into one column — the same anti-pattern round-4 Correction 13 already rejected once for the parent
table's own status column. Corrected with a second, orthogonal pair of columns instead:

```sql
ALTER TABLE public.pincode_tracking_targets
  ADD COLUMN is_configured   boolean     NOT NULL DEFAULT true,
  ADD COLUMN unconfigured_at timestamptz NULL;

ALTER TABLE public.pincode_tracking_targets
  ADD CONSTRAINT pincode_tracking_targets_configured_consistency_chk
  CHECK (
    (is_configured = true  AND unconfigured_at IS NULL)
    OR
    (is_configured = false AND unconfigured_at IS NOT NULL)
  );
```

A target's full state is now the CROSS PRODUCT of `status` (operational) and `is_configured` (configuration)
— e.g. `status='paused', is_configured=true` (seller-paused, still wanted) is a different, distinguishable
fact from `status='paused', is_configured=false` (removed from the pincode list). History (`pincode_
availability_results`) is never affected by either column — every row remains queryable regardless of a
target's current configuration state, matching this schema's standing "never delete, only reclassify"
discipline (§2, §3b).

**`replace_pincode_product_targets(p_workspace_id uuid, p_marketplace_id text, p_monitored_product_id uuid,
p_pincodes text[], p_quota_limit integer)`** — `SECURITY DEFINER`, `search_path` pinned, `service_role`-only
`EXECUTE`. Whole-list replacement for ONE product's configured pincodes (bulk across products is explicitly
out of scope for this RPC — see `IMPLEMENTATION_PLAN.md` §9's P0-B note on why the route stays product-
scoped).

1. **Parameter validation:** pincodes bounded (≤100, matching `enroll_pincode_monitored_products`'
   MAX_PINCODES_PER_PRODUCT) and each regex-validated, deduplicated. **Locked P0 decision: an empty list is
   REJECTED outright** (`invalid_parameters`/`empty_pincodes_use_remove_tracking`), not treated as "unconfigure
   every target." Removing an entire product from tracking is Remove Tracking's job (§3b); this RPC only ever
   replaces a non-empty configured set — deliberately narrower than the RPC could technically support, chosen
   over the alternative (silently allowing an empty list to unconfigure everything) because "remove all
   pincodes" and "remove this product" are different seller intents that deserve different, explicit actions.
2. **Lock order:** advisory lock → parent (single row, must be `status = 'active'` — an archived/removed
   product's pincode list is not user-editable) → every EXISTING target row for the product, ordered by id.
3. **Quota impact = genuinely new targets (no existing row for that pincode) + reconfigured targets not
   currently `checking`** (an in-flight reconfigured target doesn't change the active/checking count — it was
   already counted). Same deterministic advisory lock and `current + additional > limit` rejection shape as
   enrollment/resume (§2a/§2b, §3a).
4. **Write phase (all three happen together or not at all):**
   - Genuinely new pincodes → new `pincode_tracking_targets` rows, `is_configured=true`, `status='active'`.
   - Previously-unconfigured, now-requested pincodes → **reconfigured**: `is_configured=true`,
     `unconfigured_at=NULL`; if the target is currently `checking`, its status/claim/schedule are left
     untouched (only the configuration columns change); otherwise `status='active'`, rescheduled immediately,
     `consecutive_failures` reset — the same "fresh start" semantics as Resume (§3a).
   - Currently-configured pincodes NOT in the new list → **unconfigured**: `is_configured=false`,
     `unconfigured_at=now()`, pending manual requests cleared, unconditionally. If the target is `checking`,
     **it is not interrupted** — status/claim/schedule stay untouched, and `finalize_pincode_check`
     (`IMPLEMENTATION_PLAN.md` §2.7, amended this round) parks it `paused`/unscheduled once the in-flight check
     completes, honestly recording its result first. If not `checking`, it becomes `paused`/unscheduled
     immediately (same "non-checking targets pause immediately" shape as Remove Tracking, §3b).
5. Target IDs and all history are preserved throughout — this RPC only ever `UPDATE`s existing rows or
   `INSERT`s genuinely new ones, never deletes or recreates a row for a pincode the product has ever tracked.

**Amendments to the RPCs already documented above, all edited in place (none of migrations 060-064 have been
applied anywhere yet):**
- `claim_due_pincode_targets` (§2.8-equivalent, `IMPLEMENTATION_PLAN.md` §2.8): candidates CTE gains an
  explicit `t.is_configured = true` predicate — structurally redundant with the existing `status='active'`
  filter (an unconfigured, non-checking target is always `paused`) but added anyway as defense-in-depth
  documentation, with a matching partial index.
- `queue_pincode_manual_check` (`IMPLEMENTATION_PLAN.md` §2.10): rejects `is_configured=false` with
  `invalid_status`/`target_unconfigured`, checked alongside the existing status-test matrix.
- `set_pincode_tracking_state` (§3a) resume path: rejects the whole batch with `invalid_status`/
  `target_unconfigured` if any requested target is unconfigured — Edit Pincodes (reconfiguring) is the only
  way back for a removed pincode, not Resume. Pause is unaffected (pausing an already-paused unconfigured
  target is already a harmless no-op).
- `finalize_pincode_check` (`IMPLEMENTATION_PLAN.md` §2.7): step 5's next-state computation gains a new
  branch, checked immediately after the existing archived/removed-parent branch — `NOT v_target.is_configured`
  also parks the target `paused`/unscheduled instead of rescheduling, the same "this target left the running
  set while in flight" treatment as an archived/removed parent.

**Tracker read behavior (`IMPLEMENTATION_PLAN.md` §9 P0-B, `get_pincode_target_results` below):** the
standing tracker view surfaces only `is_configured=true` targets by default — an unconfigured target is not
part of "what the seller is currently tracking." Its full check history remains in `pincode_availability_
results`, never deleted, and remains queryable (just not surfaced by the default tracker list in this PR).

Required tests: configured→unconfigured transition; unconfigured→configured re-add (reconfigure) on the SAME
target ID; quota re-checked on reconfiguration; whole-list-replace is all-or-nothing (no partial pincode-list
update on validation/quota failure); in-flight unconfiguration followed by finalize parks the target paused/
unscheduled without interrupting the check; an unconfigured target is never claimed, manually queued, or
resumed; target ID and result-history rows are preserved (never deleted/recreated) across the whole cycle.

---

## 3d. Bounded tracker-result read — `get_pincode_target_results` (PR #55 review round)

**Gap found in review: the P0-B tracker route fetched every historical `pincode_availability_results` row for
a page's targets and picked the latest in application code** — unbounded, and silently incorrect once a
target accumulated more history rows than the query layer's own default response cap (PostgREST defaults to
1,000 rows per response) could return in one page; a target with more history than that could have its
"latest" result picked from a truncated, non-latest subset.

**`get_pincode_target_results(p_workspace_id uuid, p_target_ids uuid[])`** — `SECURITY DEFINER`, `search_path`
pinned, `service_role`-only `EXECUTE`, `RETURNS TABLE`. Bounded (`p_target_ids` capped at 500, matching
`set_pincode_tracking_state`'s own `MAX_TARGET_IDS`) and computed entirely in the database via two `LATERAL`
subqueries per target, each `ORDER BY checked_at DESC LIMIT 1` — index-assisted by the existing
`pincode_availability_results_tracking_target_idx (tracking_target_id, checked_at DESC)` (062 migration), so
each fact costs one index-scan-and-stop per target, never a full-history download:

- **Latest attempt** (any outcome): `check_status`, `availability_status`, `checked_at`, `delivery_message`,
  `error_code`, `error_message` of the single most recent result row, whatever its outcome.
- **Last confirmed availability**: the single most recent result row whose `check_status = 'success' AND
  availability_status IN ('available', 'unavailable')` — i.e. a result that actually confirmed availability
  one way or the other, never a `failed`/`blocked`/`unknown` row.

These are surfaced to the API caller as two **explicitly separate** facts (`latestAttempt` /
`lastConfirmedAvailability`) — never conflated. A `failed`/`blocked` latest attempt does not hide or overwrite
an older confirmed result; both are returned together, so a seller can see "the last check failed" and "the
last time we actually confirmed availability was 3 days ago, and it was available" as two honest, distinct
facts. The previous P0-B implementation's `isLastConfirmedResult: latest !== null` field conflated "a result
row exists at all" with "that result confirmed availability" — removed entirely, not merely deprecated.

Required tests: latest attempt and last-confirmed-availability are returned as distinct facts; a failed/
blocked latest attempt does not hide an older confirmed result; correctness holds at volume (>1,000 history
rows for one target, beyond PostgREST's default response cap); an over-limit `p_target_ids` array returns
zero rows rather than processing an arbitrary truncated subset.

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

**Correction 1 (2026-07-18) — the first draft's additive-column list was incomplete.** The Implementation
Plan's idempotent-finalize design (`IMPLEMENTATION_PLAN.md` §2.7) requires `check_attempt_id` to exist on
this table, and the atomic finalize RPC needs a direct FK to the specific `pincode_tracking_targets` row
(not just the parent monitored product) so it can insert one result row with everything the RPC already
knows in a single statement — neither of these were actually added to the schema in the prior round, only
described in prose. Corrected: **four** additive columns, not one, all workspace-scoped where they reference
another table:

```sql
ALTER TABLE public.pincode_availability_results
  ADD COLUMN monitored_product_id uuid,
  ADD COLUMN tracking_target_id   uuid,
  ADD COLUMN check_attempt_id     uuid,
  ADD COLUMN check_status         text;  -- 'success' | 'failed' | 'blocked' -- see §4a

-- Correction 11 (2026-07-18, round 4): RESTRICT/NO ACTION, not SET NULL.
-- Round 3 used ON DELETE SET NULL here, matching the pattern used
-- elsewhere in this doc for the amazon_listing_items/tracked_asins FKs on
-- pincode_monitored_products (§2) -- but those two situations are NOT
-- analogous. amazon_listing_items/tracked_asins are EXTERNAL source
-- tables this feature doesn't own, hard-deleted by other subsystems
-- outside this feature's control, so SET NULL is the correct reaction
-- there. pincode_monitored_products/pincode_tracking_targets, by
-- contrast, are THIS feature's own tables, and Correction 6/8 (§2, §3b)
-- established that normal operation NEVER hard-deletes them -- removal is
-- always the soft 'removed' state, never a DELETE statement. A hard
-- DELETE against either of these two tables is therefore not a normal
-- event this schema should silently absorb by nulling history references
-- -- it should be flatly rejected, so that if it ever happens (an
-- operational mistake, a manual psql session, a future bug), the
-- rejection is loud and the history/FK relationship is never silently
-- severed. Workspace-level cascade (ON DELETE CASCADE from workspaces,
-- unchanged, §2/§3) is unaffected -- deleting an entire workspace still
-- cascades through normally, since that's a real, intentional,
-- whole-tenant deletion, not a per-row one this feature would ever
-- trigger on its own.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_monitored_product_fk
  FOREIGN KEY (workspace_id, monitored_product_id)
  REFERENCES public.pincode_monitored_products (workspace_id, id)
  ON DELETE RESTRICT;

-- Correction 12 (2026-07-18, round 4): composite FK against the target's
-- OWN composite identity (DATA_MODEL.md §3's
-- pincode_tracking_targets_identity_uidx), not just (workspace_id, id).
-- A separate same-workspace-only FK on tracking_target_id (as round 3
-- had) still permits a malformed row where monitored_product_id points to
-- product A while tracking_target_id points to a real target belonging to
-- product B -- both individually valid, same-workspace FKs, but mutually
-- inconsistent with each other. This composite FK proves the referenced
-- target's OWN monitored_product_id column equals this row's
-- monitored_product_id -- the two ID columns can no longer disagree.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_tracking_target_fk
  FOREIGN KEY (workspace_id, tracking_target_id, monitored_product_id)
  REFERENCES public.pincode_tracking_targets (workspace_id, id, monitored_product_id)
  ON DELETE RESTRICT;

-- Both the direct monitored_product_id FK above and this composite one are
-- kept, not redundant: the direct FK is the database's only guarantee that
-- monitored_product_id itself is valid when tracking_target_id is NULL
-- (legacy rows, where the composite FK's multi-column NULL-skip means it
-- never fires); the composite FK is what proves the two ID columns AGREE
-- with each other on new rows. Each closes a gap the other doesn't cover.

-- Correction 2: claim_token uniqueness -- the finalize RPC's idempotency
-- key. Partial (non-null only) because legacy/bulk-checker rows never set
-- it.
CREATE UNIQUE INDEX pincode_availability_results_check_attempt_uidx
  ON public.pincode_availability_results (check_attempt_id)
  WHERE check_attempt_id IS NOT NULL;

-- Per-target history (the unified tracker table's expanded-row query) --
-- new, addresses the gap the first draft's monitored_product_id-only index
-- couldn't serve as precisely (a product can have many targets/pincodes;
-- this indexes the one-target case directly).
CREATE INDEX pincode_availability_results_tracking_target_idx
  ON public.pincode_availability_results (tracking_target_id, checked_at DESC)
  WHERE tracking_target_id IS NOT NULL;

-- Retained from the first draft, unchanged -- per-product history across
-- all of a product's pincodes.
CREATE INDEX pincode_availability_results_monitored_product_idx
  ON public.pincode_availability_results (monitored_product_id, pincode, checked_at DESC)
  WHERE monitored_product_id IS NOT NULL;

-- Existing composite index, retained unchanged (016_scraping_jobs_foundation.sql:50-51):
-- pincode_availability_results_workspace_asin_pin_checked_idx
-- ON public.pincode_availability_results (workspace_id, asin, pincode, checked_at DESC)

-- Correction 11 (2026-07-18, round 3): two CHECK constraints, both safe to
-- add immediately (not gated on the check_status backfill audit, §4a) --
-- neither depends on any existing row's content, both are structurally
-- true for every legacy row today (all four new columns are NULL on every
-- existing row, so both constraints are trivially satisfied by history).

-- (A) Identity consistency: the three new ID columns travel together --
-- either a row is a legacy row (all three NULL) or a unified-scheduler row
-- (all three NOT NULL). A row with, say, tracking_target_id set but
-- check_attempt_id null would be a malformed write this constraint catches
-- immediately, not silently accepted.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_identity_consistency_chk
  CHECK (
    (monitored_product_id IS NULL AND tracking_target_id IS NULL AND check_attempt_id IS NULL)
    OR
    (monitored_product_id IS NOT NULL AND tracking_target_id IS NOT NULL AND check_attempt_id IS NOT NULL)
  );

-- (B) New-row result consistency: ONLY fires when check_attempt_id IS NOT
-- NULL (a unified-scheduler row) -- legacy rows (check_attempt_id NULL)
-- are entirely outside this constraint's scope, so it cannot be violated by
-- history no matter what legacy availability_status/error_code values
-- exist. This is finalize_pincode_check's own write-integrity boundary
-- (IMPLEMENTATION_PLAN.md §2.7 Correction 11) enforced a second time at
-- the database layer, in case any other future write path is ever added.
--
-- Correction 1 (2026-07-18, round 4): rewritten for NULL-safety. Postgres
-- CHECK constraints use three-valued logic -- a CHECK PASSES when its
-- expression evaluates to TRUE **or NULL**, only a FALSE result rejects
-- the row. `x NOT IN (...)` and `x IN (...)` both evaluate to NULL when x
-- IS NULL, not FALSE -- so the round-3 version of this constraint would
-- have silently ACCEPTED a row with check_status = NULL, or
-- availability_status = NULL on a 'success' row, exactly the malformed
-- writes it was meant to reject. Every branch below now uses an explicit
-- IS NOT NULL/IS NULL test before any IN (...) comparison, so a NULL
-- input can never make the overall expression evaluate to NULL -- it
-- always resolves to a definite TRUE or FALSE.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_new_row_consistency_chk
  CHECK (
    check_attempt_id IS NULL
    OR (
      check_status IS NOT NULL
      AND (
        (
          check_status = 'success'
          AND availability_status IS NOT NULL
          AND availability_status IN ('available', 'unavailable', 'unknown')
        )
        OR
        (
          check_status IN ('failed', 'blocked')
          AND availability_status IS NULL
        )
      )
    )
  );
```

**Correction 1's note on the deferred, general `check_status` backfill constraint (§4a):** when that
separate, audit-gated constraint is eventually added, it must remain explicitly legacy-compatible and
equally NULL-safe: `CHECK (check_status IS NULL OR check_status IN ('success', 'failed', 'blocked'))` — this
document does **not** make `check_status` globally `NOT NULL` in P0-A, because the existing legacy
bulk-checker writer may continue creating legacy rows without this new field indefinitely; a blanket
`NOT NULL` would break that writer the moment it's applied.

Allowed vs. rejected combinations for every **new** unified-scheduler write (constraint B above, mirrored by
`finalize_pincode_check`'s own input validation, `IMPLEMENTATION_PLAN.md` §2.7):

| Combination | Allowed? |
|---|---|
| `success` + `available` | Yes |
| `success` + `unavailable` | Yes |
| `success` + `unknown` | Yes |
| `failed` + `NULL` | Yes |
| `blocked` + `NULL` | Yes |
| any `check_status` not in `('success','failed','blocked')` | **Rejected** |
| `check_status = NULL` (actual SQL `NULL`, not the string `'NULL'`) | **Rejected** — round-3's constraint form would have wrongly *accepted* this; round 4's explicit `IS NOT NULL` fixes it |
| `success` + `NULL` | **Rejected** (a successful check must report a definite availability reading) |
| `failed`/`blocked` + any non-null `availability_status` | **Rejected** (a check that didn't succeed cannot also claim to have observed availability) |
| any arbitrary/unrecognized `availability_status` string | **Rejected** |

**Required test additions (round 4, Correction 1):** the constraint/RPC test suite
(`IMPLEMENTATION_PLAN.md` §5, and `finalize_pincode_check`'s own tests, §2.7) must include cases using an
actual SQL `NULL` for `check_status` and for `availability_status` on a `'success'` row — not only a
TypeScript/JS `undefined` value at the calling-code layer, which a client library might coerce differently
than a raw `NULL` reaching the database. The point of this correction is specifically that three-valued SQL
logic behaves differently from application-language null-handling; a test that only exercises the
application layer would not have caught the round-3 bug.

**Required on every new unified-scheduler result:** `monitored_product_id`, `tracking_target_id`, and
`check_attempt_id` must all be populated — `finalize_pincode_check` (`IMPLEMENTATION_PLAN.md` §2.7) inserts
all three in the same statement it already has all three values available for (the claimed target row IS
the source of `tracking_target_id` and `monitored_product_id`; `check_attempt_id` is the target's own
`claim_token`). **Legacy bulk-checker rows may keep all four new columns `NULL`** — no backfill, no
retroactive assignment; this is consistent with decision #11 (both legacy tables preserved, no
consolidation).

`job_id` stays nullable and optional — a scheduler-originated check populates `monitored_product_id`/
`tracking_target_id`/`check_attempt_id` and leaves `job_id` null (this isn't a `scraping_jobs`-queue check
anymore, it's a new scheduler, see `IMPLEMENTATION_PLAN.md`); a legacy bulk-checker-originated check keeps
working exactly as today, `job_id` populated, all four new columns null. **No backfill of historical rows'
new-column values is required or recommended** — decision #11 preserves both legacy tables untouched; old
rows simply predate the new columns and stay queryable by their existing keys (the separate, required
`check_status` backfill in §4a is a different, narrower operation — it populates `check_status` on existing
rows so legacy history stays readable under the corrected state model, it does not touch the four columns
above).

**`pincode_checks` is not deleted, not migrated, not touched.** It remains the ASIN-detail widget's data
source exactly as today (out of scope, §`PRODUCT_SPEC.md` §4) and continues serving its 5 existing
consumers unmodified.

---

### 4a. Result-state model — Correction 8 (2026-07-18)

The first draft left `availability_status` as unconstrained `text` (confirmed: `016_scraping_jobs_foundation
.sql:32`, no CHECK, no enum) and stored `error_code`/`error_message` as separate free columns — this cannot
actually enforce the four/five-state vocabulary the product spec claims (`PRODUCT_SPEC.md` §8), because
nothing stops `availability_status` from holding an arbitrary string, and nothing distinguishes "the check
ran and confirmed unknown availability" from "the check itself failed/was blocked" — those are conflated
into whatever ad hoc value was written at each call site historically.

**Corrected model — two orthogonal columns, not one overloaded field.** `check_status` is added in §4's
column list above (part of the same additive migration as `monitored_product_id`/`tracking_target_id`/
`check_attempt_id`, not a separate ALTER):

- `check_status`: **did the check itself complete cleanly?** `'success'` | `'failed'` | `'blocked'`.
- `availability_status` (existing column, unchanged type): **what did a successful check observe?**
  `'available'` | `'unavailable'` | `'unknown'` — meaningful only when `check_status = 'success'`.

Mapping to the product-facing five-state vocabulary (`PRODUCT_SPEC.md` §8):

| `check_status` | `availability_status` | Rendered state |
|---|---|---|
| `success` | `available` | **Available** |
| `success` | `unavailable` | **Unavailable** |
| `success` | `unknown` | **Not confirmed** |
| `failed` | *(any/null)* | **Check failed** |
| `blocked` | *(any/null)* | **Blocked** |
| *(no row)* | — | **Not confirmed** (never checked) |

**Correction 9 (2026-07-18) — the read-only production audit is done; recorded here with real numbers, not
a method description.** Query run: `SELECT availability_status, (error_code IS NOT NULL) AS has_error,
count(*) FROM pincode_availability_results GROUP BY 1, 2`. Actual result, confirmed independently:

| `availability_status` | `error_code` present | Row count |
|---|---|---|
| `available` | no | **18** |
| `unknown` | yes | **7** |

**No other `(availability_status, error_code presence)` combination currently exists in production** —
specifically, **no rows exist today with `unavailable`, `blocked`, or `unknown`-without-error.** This spec
does not fabricate those combinations to demonstrate the five-state model; they simply have zero current
production examples, and the corrected model still supports them correctly for future rows (the mapping
table above is unconditional, not audit-conditional).

**Backfill rule, updated to these confirmed facts (mechanical, not guessed):**

- `availability_status = 'available' AND error_code IS NULL` (18 rows) → `check_status = 'success'`,
  `availability_status` **unchanged** (`'available'`).
- `availability_status = 'unknown' AND error_code IS NOT NULL` (7 rows) → `check_status = 'failed'`,
  **preserve** the original `availability_status`/`error_code`/`error_message` values as-is for legacy
  readability — do not null or rewrite them, only add the new `check_status` value alongside.
- No third bucket is needed for the migration that actually runs against current production data — the
  general "any row that doesn't cleanly match" fallback below is retained for defensiveness (a future row
  written between this audit and the migration running could theoretically land outside these two buckets),
  not because today's data requires it.

**Before adding any CHECK constraint to this existing, already-populated table (sequencing unchanged from
the first round, now backed by the actual numbers above rather than a hypothetical):**

1. ~~Audit first, read-only~~ — **done**, see the table above.
2. **Backfill `check_status` for existing rows using the two confirmed buckets above** — not a guessed rule
   anymore, the exact production value set. Any row that doesn't cleanly match one of these two buckets
   after re-running the audit at migration time (e.g. new rows written since 2026-07-18) must be reported,
   not silently forced into a bucket — **do not write a CHECK constraint that existing rows would violate**,
   and do not rewrite ambiguous legacy history to make a constraint pass. Given only two clean buckets exist
   today, this is a low-risk step, but the re-check-before-migrating discipline stays as written.
3. **Preserve legacy rows exactly.** No historical row's `availability_status`/`error_code`/`error_message`
   values are deleted or overwritten beyond the mechanical `check_status` backfill above — old rows remain
   readable under their original meaning. New unified-scheduler writes follow the corrected
   `check_status`/`availability_status` model from day one (§4's required-columns note); legacy rows are
   never retroactively forced to look like new ones.
4. Only after the backfill above is applied does a `CHECK (check_status IN ('success','failed','blocked'))`
   constraint get added — as its own, separate, reviewed migration, not bundled with the additive-column
   migration. With only two clean production buckets confirmed, this constraint is low-risk to add once the
   backfill runs, but remains a separate migration per the original sequencing discipline.

This audit-before-constrain sequencing is itself a P0 requirement of this spec (it blocks writing the
CHECK, not the additive column) — see `IMPLEMENTATION_PLAN.md` §3 P0 list and §5 test #16/#17.

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
2. On detecting an archived source: `UPDATE pincode_monitored_products SET status = 'archived' WHERE id =
   :id AND status NOT IN ('archived', 'removed')` (the `NOT IN ('archived', 'removed')` guard is Correction 9,
   round 4 — see below; a product the seller already removed is never overwritten back to `'archived'`) and
   cascades to child targets — **Correction 5 (2026-07-18, round 3): not a blind "set every child to
   `paused`."** A
   blind cascade would try to `UPDATE` a target currently `status = 'checking'` into `'paused'`, which
   directly violates `pincode_tracking_targets_claim_consistency_chk` (§3 — a `'checking'` row must retain
   its claim fields, a non-`'checking'` row must not) while the worker still holds that claim, and would race
   the worker's own eventual `finalize_pincode_check` UPDATE on the same row. Corrected: `UPDATE
   pincode_tracking_targets SET status = 'paused', next_check_at = NULL WHERE monitored_product_id = :id AND
   status IN ('active', 'paused', 'failed')` — **`status = 'checking'` targets are explicitly excluded from
   this UPDATE** and are left running. They resolve one of two ways, both safe:
   - **The in-flight attempt finalizes normally** — `finalize_pincode_check` (`IMPLEMENTATION_PLAN.md` §2.7)
     re-reads the (locked) parent product's current status as part of finalizing: if the parent is still
     `active`, finalize proceeds normally (compute next status/schedule as usual); if the parent has since
     gone `archived`/`removed`, finalize **still records the check result** (the result is valid — a real
     check ran and completed) but finalizes the target directly to `paused` with `next_check_at = NULL`,
     rather than scheduling a next check for a product that's no longer active. Either way, the result is
     never discarded and the target never ends up simultaneously `'checking'` and orphaned.
   - **The attempt is later reclaimed** by stale-claim reclaim (§`IMPLEMENTATION_PLAN.md` §2.4) if it never
     finalizes — reclaim resets it to `'active'`, at which point the **next** reconciliation cycle's normal
     `WHERE status IN ('active', 'paused', 'failed')` cascade catches it and pauses it correctly.
   - **No new claim may select a target whose parent product is not `active`** — the claim RPC's due-query
     (`IMPLEMENTATION_PLAN.md` §2.8) filters on `pincode_monitored_products.status = 'active'` (round-3
     Correction 4/8), so once a target is paused by this cascade it cannot be re-claimed until the product is
     un-paused/re-added.
   This is a plain `UPDATE ... WHERE ...`, not a database trigger, so it's inspectable/testable the same way
   the review-requests reclaim logic is. **Required test (new, round 3):** archive a source row while one of
   its targets is `status = 'checking'`; assert the checking target is left alone by the cascade UPDATE;
   assert `finalize_pincode_check` on that target still records a real result but finalizes to `paused`, not
   a new `next_check_at`.
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

**Correction 1 (2026-07-18) — two more cases the same reconciliation pass must cover:**

1. **Owned row, FK gone null.** `UPDATE pincode_monitored_products SET status = 'archived' WHERE
   product_source = 'owned' AND status NOT IN ('archived', 'removed') AND amazon_listing_item_id IS NULL` —
   this is the row shape produced when the source `amazon_listing_items` row is hard-deleted and `ON DELETE
   SET NULL (amazon_listing_item_id)` fires (§2). Same corrected, in-flight-safe cascade to child targets as
   the soft-archive case above (Correction 5 — `status IN ('active','paused','failed')` only, `checking`
   targets left alone); same history-preservation guarantee.
   **Correction 9 (2026-07-18, round 4) — `removed` must take precedence over `archived`, and the WHERE
   clause above is corrected accordingly (this applies equally to the parent-status UPDATE described in step
   2 of the main cascade above, wherever it is implemented — any reconciliation write to
   `pincode_monitored_products.status` must use this same guard).** Round 3's condition was `status <>
   'archived'`, which is true for a `status = 'removed'` row too — meaning
   the reconciliation pass could have overwritten a user-removed product's `status` to `'archived'` while
   `removed_at`/`removal_reason` stayed populated underneath it, directly contradicting
   `pincode_monitored_products_removed_consistency_chk` (§2, which requires `removed_at IS NULL` whenever
   `status <> 'removed'`) and — even setting the CHECK violation aside — silently discarding the seller's own
   stated reason for removing the product the moment its source later happened to disappear too. **User
   removal takes precedence over later source disappearance**: once a product is `'removed'`, the
   reconciliation pass must never touch its `status` again — `status NOT IN ('archived', 'removed')` in both
   WHERE clauses ensures this. The **only** path that clears `removed_at`/`removal_reason` and moves a
   `'removed'` product out of that state is an explicit re-add through `enroll_pincode_monitored_products`
   (§2a's atomic restore path) — never the reconciliation pass, never any other automated process.
   **Required test (round 4):** remove a product (user action) → then archive/delete its source listing →
   run reconciliation → assert the product remains `status = 'removed'` with its original `removed_at`/
   `removal_reason` untouched, never flipped to `'archived'`.
2. **Other→Owned promotion.** As part of the same cycle (cheap — one query, same cadence as the archive
   check): `SELECT id, workspace_id, marketplace_id, asin FROM pincode_monitored_products WHERE
   product_source = 'other'`, LEFT JOIN against `amazon_listing_items` on `(workspace_id, marketplace_id,
   asin)`. For every match found, `UPDATE pincode_monitored_products SET product_source = 'owned',
   amazon_listing_item_id = <matched id> WHERE id = <row id>` — `id`, `created_at`, and all
   `pincode_availability_results` history stay untouched (`PRODUCT_SPEC.md` §5.2 Correction 1). This is also
   performed opportunistically inside the enrollment RPC itself (§2a) when an enrollment attempt collides
   with an existing `'other'` row via the `ON CONFLICT` path — the reconciliation pass is the backstop for
   promotions that happen via catalog sync alone, without a fresh enrollment attempt triggering it.

---

## 6. RLS

**Correction 3 (2026-07-18) — the first draft's blanket member CRUD is revised.** Giving ordinary browser
sessions unrestricted `UPDATE` on `pincode_tracking_targets` (as the original member-CRUD-everywhere policy
did) would let any workspace member directly set `status='checking'`, `claimed_at`, `claimed_by`,
`next_check_at`, `consecutive_failures`, or `last_error_code` from the client — fabricating scheduler state
that the UI, the claim RPC, and every "is this actually running" signal in `IMPLEMENTATION_PLAN.md` §2.13
depend on being truthful. RLS alone (a row filter) cannot express "this column is member-writable but that
column isn't" — Postgres RLS is row-scoped, not column-scoped. Revised model:

- **`pincode_tracking_targets`: members get `SELECT` only.** No member-facing `INSERT`/`UPDATE`/`DELETE`
  policy exists on this table at all. Every mutation — enrollment (insert), pause/resume (status update),
  pincode add/remove, and Manual Check Now's request fields — goes through an authenticated Next.js API
  route that verifies the session, verifies workspace membership + role (below), and then writes using the
  **service-role client** (`createAdminClient()`), which bypasses RLS entirely — same pattern every other
  background worker and the `review_solicitation_orders` workstream already use in this codebase. The
  scheduler-owned fields (`status='checking'`, `claimed_*`, `next_check_at`, `consecutive_failures`,
  `last_error_code`) are therefore writable **only** from server code running with the service-role key —
  never directly from a browser session under any role.
- **`pincode_monitored_products`: members get `SELECT` only**, same reasoning — `status` on this table is
  shared between user actions (pause/resume/remove) and the archival reconciliation pass (§5), so it carries
  the same "don't let a client fabricate it" risk. Enrollment, pause/resume, and edits all go through the
  server routes in `PRODUCT_SPEC.md` §11, using the service-role client after a membership/role check.
- **Correction 5 (2026-07-18) — `workspace_default_pincodes` is corrected to `SELECT`-only too, reversing the
  prior round's "members keep direct CRUD" call.** The prior round's reasoning ("no automation-owned fields,
  so direct member CRUD is safe") missed a real gap: `user_workspace_ids()` returns every workspace a user
  belongs to **regardless of role**, including `viewer`. A blanket member-CRUD RLS policy on this table would
  let a `viewer` — who this spec elsewhere promises is read-only — bypass the server route's role check
  entirely by calling the Supabase client directly with `INSERT`/`UPDATE`/`DELETE` on
  `workspace_default_pincodes`, since RLS has no role-column awareness, only workspace membership. **Simpler,
  safe rule adopted instead: all three new configuration tables are `SELECT`-only for members, with zero
  exceptions** — there is exactly one mutation path (authenticated server route → role check → service-role
  write), never two competing paths where one (RLS-direct) accidentally has weaker enforcement than the
  other (the route's own role check).

```sql
ALTER TABLE public.workspace_default_pincodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_monitored_products  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_tracking_targets    ENABLE ROW LEVEL SECURITY;

-- All three tables: SELECT only for members. No member-facing
-- INSERT/UPDATE/DELETE policy exists on ANY of them (Correction 5) -- every
-- mutation, including workspace_default_pincodes changes, goes through an
-- authenticated server route that checks role before writing via the
-- service-role client. This is deliberately the ONLY mutation path -- see
-- the role table below.
CREATE POLICY "workspace_default_pincodes: member select" ON public.workspace_default_pincodes FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
CREATE POLICY "pincode_monitored_products: member select" ON public.pincode_monitored_products FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
CREATE POLICY "pincode_tracking_targets: member select" ON public.pincode_tracking_targets FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
```

`pincode_tracking_targets` carries its own `workspace_id` column directly (see §3 schema) so the `SELECT`
policy above and the due-work indexes (§3) can both avoid a join, matching the same
denormalization-for-RLS-and-index-simplicity pattern already used by `keyword_rank_snapshots.workspace_id`
(present despite also having `tracked_keyword_id`) and `review_solicitation_orders.workspace_id`.

**Role expectations (Correction 3).** This codebase's actual role enum, confirmed from
`001_initial_schema.sql:16`, is `public.member_role AS ENUM ('owner', 'admin', 'member', 'viewer')` — four
roles, **not** the "Owner/Admin/Analyst/Viewer" naming used in the correction request; there is no distinct
"Analyst" role in this app today. No existing `requireRole()`-style helper was found anywhere in
`esolz-app/src` (checked directly, not assumed) — the new server routes are the first place this feature
needs a role check, so it must be written new, not reused from a precedent that doesn't exist:

| Role | Pincode Checker access via the new server routes |
|---|---|
| `owner`, `admin`, `member` | Full: enroll/pause/resume/remove products, manage `workspace_default_pincodes`, request Manual Check Now — Pincode tracking is a working-day tool, not an admin-only one; no existing precedent in this codebase restricts `member` from equivalent actions on `tracked_asins` today, so this preserves consistency rather than inventing a new restriction. |
| `viewer` | `SELECT` only — enforced **twice, redundantly by design** (Correction 5): (1) RLS itself grants no role, `viewer` included, any direct write path on any of the three tables (no member-CRUD RLS policy exists to bypass), and (2) every mutating server route additionally rejects a `viewer`-role caller with `403` before it would ever reach the service-role write. Because RLS alone already blocks it, the server-side role check is defense-in-depth, not the only line of defense — this is the material difference from the prior round, where `workspace_default_pincodes`'s RLS was the *only* thing separating a `viewer`'s direct Supabase call from a successful write, and RLS doesn't check role at all (it only checks workspace membership) — so a `viewer` could have bypassed the route's role check entirely. |

Every mutating server route validates, in this order: (1) authenticated session exists, (2) the caller is a
member of the target `workspace_id` (via `user_workspace_ids()` server-side, the same check RLS itself
uses), (3) the caller's role is `owner`/`admin`/`member` (not `viewer`). A `workspace_id` is never accepted
from the request body/query string as the sole authority — it is always cross-checked against the session's
actual membership, so a crafted request cannot target a workspace the caller doesn't belong to (this applies
to `workspace_default_pincodes`'s routes too, per the correction's explicit callout that "workspace
default-pincode management ... cannot accept a `workspace_id` supplied without membership validation"). **No
table has a second, RLS-direct mutation path that could disagree with this server-side role check** —
Correction 5's explicit "do not create two competing mutation paths" requirement.

The scheduler's own reads/writes go through the service-role client (`createAdminClient()`, same as every
other worker in this codebase), which bypasses RLS entirely — consistent with every existing background
worker.

---

## 7. Migration count (revised 2026-07-18, round 4)

**3 new tables + 2 additive columns on `pincode_monitored_products` (`.removed_at`, `.removal_reason`) + 4
additive columns on `pincode_availability_results` + 3 new indexes on that table + 1 partial unique index on
`pincode_tracking_targets.claim_token` + 1 composite identity unique constraint on `pincode_tracking_targets`
+ 2 precondition constraints on existing tables + 3 CHECK constraints (`removed`-consistency,
identity-consistency, new-row-result-consistency, the last now NULL-safe per round-4 Correction 1) + **6**
RPC functions, across an estimated 4 migrations** (RPC count revised again this round — Correction 8 adds
`remove_pincode_monitored_products`, the sixth; `pincode_monitored_products_status_chk` narrowed from four
values to three per Correction 13 (no parent-level `'paused'`); `pincode_availability_results`' two FKs
switched from `ON DELETE SET NULL` to `ON DELETE RESTRICT`, and the `tracking_target_id` FK widened to a
three-column composite per Correction 11/12; not committed to exact numbering, next available migration
number to be confirmed at implementation time):

1. One migration: `ALTER TABLE amazon_listing_items ADD CONSTRAINT ... UNIQUE (workspace_id, id)` and the
   same for `tracked_asins` (§2, Correction 2 precondition) — trivial, additive, zero data risk (both
   columns are already unique via each table's own primary key), but touches two existing, in-use tables, so
   it is kept as its own reviewable step rather than folded silently into migration #2.
2. One migration: `workspace_default_pincodes`, `pincode_monitored_products` (including `.removed_at`/
   `.removal_reason`, the `removed`-consistency CHECK, and the **three-value** `status` CHECK per round-4
   Correction 13), `pincode_tracking_targets` (including the composite `pincode_tracking_targets_identity_
   uidx` per round-4 Correction 12) — all three together, since `pincode_tracking_targets` FKs to
   `pincode_monitored_products` and both are new, they belong in one migration (matches this codebase's
   existing convention of grouping tightly coupled new tables). Includes the RLS policies (§6 —
   `SELECT`-only for members on all three tables), the `updated_at` triggers, the two due-work indexes (§3),
   and the `claim_token` partial unique index (§3).
3. One migration: `pincode_availability_results.monitored_product_id` + `.tracking_target_id` +
   `.check_attempt_id` + `.check_status` additive columns (§4) + their FKs — **`ON DELETE RESTRICT`, not
   `SET NULL`, per round-4 Correction 11; the `tracking_target_id` FK is now the three-column composite
   `(workspace_id, tracking_target_id, monitored_product_id)` per round-4 Correction 12** — the
   `check_attempt_id` partial unique index, the three history indexes (§4/§4a), and the two
   immediately-addable CHECK constraints (identity-consistency, new-row-result-consistency — the latter
   rewritten NULL-safe per round-4 Correction 1; both safe against existing data, unlike the
   `check_status`-format constraint below) — kept separate from #2 so the new tables can be reviewed/applied
   independently of touching an existing, already-in-use table. **Still does not** include the
   `check_status`/result-state-format CHECK constraint — that alone remains deferred until the read-only
   production audit (§4a, recorded with real numbers — 18 available/no-error, 7 unknown/error) has its
   backfill applied.
4. One migration: the **six** RPC functions this spec's corrections require —
   `claim_due_pincode_targets(...)` (`IMPLEMENTATION_PLAN.md` §2.8, now also taking `p_allowed_workspace_ids`
   per round-4 Correction 4), `finalize_pincode_check(...)` (`IMPLEMENTATION_PLAN.md` §2.7, NULL-safe input
   validation per round-4 Correction 1), `enroll_pincode_monitored_products(...)` (§2a, atomic re-add restore
   per round-4 Correction 10), `queue_pincode_manual_check(...)` (`IMPLEMENTATION_PLAN.md` §2.10),
   `set_pincode_tracking_state(...)` (§3a), and **`remove_pincode_monitored_products(...)` (§3b, round-4
   Correction 8 — new this round)** — all six `SECURITY DEFINER`, `search_path` set explicitly, `REVOKE
   EXECUTE ... FROM PUBLIC` + `GRANT EXECUTE ... TO service_role` only (never broadly granted to
   `authenticated`), all following the one global lock order (`IMPLEMENTATION_PLAN.md` §2.0, round-4
   Correction 2) and validating their own parameters before any lock or query (round-4 Correction 14).

A fifth, follow-up migration (not counted above, deliberately deferred) adds the `check_status`-format CHECK
constraint once the backfill from the confirmed audit (§4a) is applied — this is the *only* CHECK constraint
still deferred; the others are not (see migration #3 above).

**No migration is proposed or applied in this round** — this section exists to size the work, not to
schedule it. Per round-2 Correction 10, migration #1/#2/#3 belong to implementation phase **P0-A**, migration
#4 also belongs to **P0-A** (`IMPLEMENTATION_PLAN.md` §9) — none of the 4 migrations are applied until P0-A
is its own separately reviewed and approved implementation PR.

**Addendum (PR #55 review round, P0-B):** a fifth migration, `064_pincode_p0b_config_lifecycle_and_rpcs.sql`,
adds the target-configuration-lifecycle columns and CHECK (§3c), amends `claim_due_pincode_targets`/`queue_
pincode_manual_check`/`set_pincode_tracking_state`/`finalize_pincode_check` in place (§3c), and adds two new
RPCs (`replace_pincode_product_targets`, §3c; `replace_workspace_default_pincodes`, §1) plus one new bounded
read RPC (`get_pincode_target_results`, §3d) — **9** trusted RPCs total. This migration belongs to **P0-B**
(`IMPLEMENTATION_PLAN.md` §9), found necessary only after P0-B's own implementation review surfaced the
missing Edit Pincodes contract — not part of the original P0-A migration count above, and (like migrations
060-063) not applied anywhere until its own PR is approved.
