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

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'archived' | 'removed'

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
    CHECK (status IN ('active', 'paused', 'archived', 'removed')),
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
`EXECUTE`:

- `p_products` is a JSONB array, one element per product:
  `{ "product_source": "owned"|"other", "amazon_listing_item_id": uuid|null, "tracked_asin_id": uuid|null,
  "asin": text, "title_snapshot": text|null, "image_url_snapshot": text|null, "brand_snapshot": text|null,
  "pincodes": text[] }` — the caller (server route) has already resolved the listing/lookup for each product
  before calling this RPC (§6's approved lookup path, `enroll_pincode_monitored_products` itself does not
  call SP-API).
- **Transaction body:**
  1. `SELECT pg_advisory_xact_lock(...)` using the deterministic key above — held for the remainder of this
     transaction, released automatically on commit/rollback.
  2. For every element of `p_products`: if `product_source = 'owned'`, `SELECT id, marketplace_id FROM
     amazon_listing_items WHERE id = :amazon_listing_item_id AND workspace_id = :workspace_id FOR SHARE` —
     if not found, or its `marketplace_id` doesn't match `p_marketplace_id` (the marketplace-consistency
     check flagged below §2), **reject the entire request**, do not write anything for any product in the
     batch. This is the same "verified against an actual `amazon_listing_items` row" requirement as round 1,
     now applied per-element inside a bulk validate-everything-first pass rather than per-transaction.
  3. For every `(product, pincode)` pair in the batch: `SELECT id, status FROM pincode_monitored_products p
     JOIN pincode_tracking_targets t ON t.monitored_product_id = p.id WHERE p.workspace_id = :workspace_id
     AND p.asin = :asin AND t.pincode = :pincode` — determine which pairs are **genuinely new** (no existing
     target) versus already-active (no-op, not counted against quota) versus existing-but-paused/failed
     (a resume, not a fresh enrollment — routed to §3a instead, this RPC does not silently resume).
  4. Count only the genuinely-new pairs → `v_requested_additional`.
  5. `SELECT count(*) FROM pincode_tracking_targets t JOIN pincode_monitored_products p ON p.id =
     t.monitored_product_id WHERE p.workspace_id = :workspace_id AND p.marketplace_id = :marketplace_id AND
     t.status IN ('active', 'checking')` → `v_current_active` (see §2b for why `'archived'`/`'removed'` are
     not, and never were, valid values of `t.status` — this counts the **target** table only, whose status
     enum is `active`/`paused`/`failed`/`checking`; a target's *product* being archived/removed is a
     separate, parent-level fact, not part of this count's own WHERE clause).
  6. If `v_current_active + v_requested_additional > p_quota_limit`, **raise/return** the locked quota error
     (§2b) — no `INSERT`/`UPDATE` for *any* product or pincode in the batch, even the ones that individually
     would have fit. Never create a subset unless the caller submits a new, smaller request.
  7. Otherwise, perform the **complete** write in the same transaction: for each product, `INSERT ... ON
     CONFLICT (workspace_id, marketplace_id, asin) DO UPDATE` (unchanged Other→Owned promotion logic from
     round 1/2, and the round-3 removed-product-restore logic, §2 above) against
     `pincode_monitored_products`; for each genuinely-new `(product, pincode)` pair, `INSERT` into
     `pincode_tracking_targets` (`status = 'active'`, `next_check_at = now()`).
  8. Commit. The advisory lock releases automatically.
- **Marketplace consistency** (round 1's flagged-but-deferred item) is now enforced directly in step 2 above,
  inside the same atomic pass — no longer a separate, easy-to-forget check.

**Every quota-increasing path uses this same lock discipline** — not just fresh enrollment:

| Path | RPC | Locks |
|---|---|---|
| New enrollment (bulk or single) | `enroll_pincode_monitored_products` | Advisory lock (above) |
| Adding pincodes to an already-enrolled product | `enroll_pincode_monitored_products` (same RPC — a pincode-add is structurally identical to enrolling a product with 1 element, `p_products` already includes the product's existing `amazon_listing_item_id`/`tracked_asin_id` so no re-verification is skipped) | Advisory lock (above) |
| Resuming paused targets | `set_pincode_tracking_state` (§3a) | Same advisory lock, same key derivation |
| Reactivating failed targets | `set_pincode_tracking_state` (§3a) | Same advisory lock, same key derivation |
| Bulk enrollment | `enroll_pincode_monitored_products` | Advisory lock (above), one lock acquisition for the whole batch, not per-product |

Integration tests (required, `IMPLEMENTATION_PLAN.md` §5) must cover: enrolling an owned product with a
valid listing succeeds; enrolling an owned product with a fabricated/foreign-workspace listing ID is
rejected; enrolling the same ASIN as owned after it was already "other" performs the promotion in place and
does not duplicate history; **a 5-product×6-pincode bulk request where only some pairs fit under quota is
rejected in full, not partially applied; two concurrent enrollment requests that would jointly exceed quota
serialize correctly and exactly one succeeds (or both succeed if there was room for both, but never both
succeeding when only one should have).**

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

**Resume (`p_action = 'resume'`):**
1. Acquire the same deterministic advisory lock as §2a/§2b (`(workspace_id, marketplace_id)`).
2. Lock every target row named in `p_target_ids` (`FOR UPDATE`) plus its parent `pincode_monitored_products`
   row (`FOR UPDATE` too — needed for step 3).
3. For each target: if the parent product's `status` is `archived` or `removed`, **reject the entire
   operation** — "archived/removed product cannot resume" (a resume attempt against a product whose source
   is gone or that the seller explicitly removed makes no sense; the seller must re-add, not resume, per §2's
   removed-restore path).
4. Calculate the projected active-target count (current `active`/`checking` count, §2b, plus every target in
   this batch that is currently `paused` or `failed` and about to become `active`).
5. If the projection exceeds `p_quota_limit`, **reject the entire operation** with the locked `409
   pincode_tracking_quota_exceeded` shape (§2b) — never partially resume a bulk request.
6. Otherwise, for each target: if it was `failed`, reset `consecutive_failures = 0` (an explicit resume is
   the seller's signal that they want a clean retry, not a continuation of the failure count); set `status =
   'active'`, `next_check_at = now()` (immediately due, same "resuming re-schedules" behavior as a fresh
   enrollment).
7. Commit.

**Pause (`p_action = 'pause'`):**
1. Acquire the same advisory lock (pausing doesn't strictly need it for correctness — pausing only *frees*
   quota, it can't oversubscribe — but using the same lock uniformly avoids a second, divergent locking
   discipline to reason about).
2. Lock every target row named in `p_target_ids`.
3. For each target, branch on its **current** `status`:
   - **`active` or a queued manual request** (i.e. not yet `checking`): set `status = 'paused'`, clear
     `manual_requested_at`/`manual_requested_by`/`manual_request_token`, clear `next_check_at`.
   - **`checking`**: **reject that target** with `409 { errorCode: 'check_in_progress' }` in P0 — do not
     invalidate an in-flight claim out from under the worker currently holding it (the same in-flight-safety
     principle as §5's archival cascade, Correction 5). The seller can pause again once the check finalizes.
     If the bulk request mixes pausable and in-progress targets, P0 rejects the **whole** batch with the
     `check_in_progress` error naming which target(s) are in flight, rather than silently pausing a subset —
     consistent with this RPC's all-or-nothing discipline elsewhere; the UI can prompt the seller to retry
     without the in-flight target(s).
   - **`paused`/`failed`**: no-op (already not running), does not error.
4. Commit.

Both actions share the "the caller always gets an explicit, complete success or an explicit, complete
rejection — never a silent partial result" discipline as `enroll_pincode_monitored_products` (§2a).

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

-- Workspace-scoped composite FKs (Correction 2, same discipline as §2/§3).
-- Both confirmed safe on this project's PostgreSQL 17.6 -- see the
-- amendment note at the top of this document.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_monitored_product_fk
  FOREIGN KEY (workspace_id, monitored_product_id)
  REFERENCES public.pincode_monitored_products (workspace_id, id)
  ON DELETE SET NULL (monitored_product_id);

ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_tracking_target_fk
  FOREIGN KEY (workspace_id, tracking_target_id)
  REFERENCES public.pincode_tracking_targets (workspace_id, id)
  ON DELETE SET NULL (tracking_target_id);

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
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_new_row_consistency_chk
  CHECK (
    check_attempt_id IS NULL
    OR (
      check_status IN ('success', 'failed', 'blocked')
      AND (
        (check_status = 'success' AND availability_status IN ('available', 'unavailable', 'unknown'))
        OR
        (check_status IN ('failed', 'blocked') AND availability_status IS NULL)
      )
    )
  );
```

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
| `success` + `NULL` | **Rejected** (a successful check must report a definite availability reading) |
| `failed`/`blocked` + any non-null `availability_status` | **Rejected** (a check that didn't succeed cannot also claim to have observed availability) |
| any arbitrary/unrecognized `availability_status` string | **Rejected** |

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
2. On detecting an archived source: sets `pincode_monitored_products.status = 'archived'` and cascades to
   child targets — **Correction 5 (2026-07-18, round 3): not a blind "set every child to `paused`."** A
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
   product_source = 'owned' AND status <> 'archived' AND amazon_listing_item_id IS NULL` — this is the row
   shape produced when the source `amazon_listing_items` row is hard-deleted and `ON DELETE SET NULL (
   amazon_listing_item_id)` fires (§2). Same corrected, in-flight-safe cascade to child targets as the
   soft-archive case above (Correction 5 — `status IN ('active','paused','failed')` only, `checking` targets
   left alone); same history-preservation guarantee.
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

## 7. Migration count (revised 2026-07-18, round 3)

**3 new tables + 2 additive columns on `pincode_monitored_products` (`.removed_at`, `.removal_reason`) + 4
additive columns on `pincode_availability_results` + 3 new indexes on that table + 1 partial unique index on
`pincode_tracking_targets.claim_token` + 2 precondition constraints on existing tables + 3 new CHECK
constraints (`removed`-consistency, identity-consistency, new-row-result-consistency) + 5 RPC functions,
across an estimated 4 migrations** (RPC count revised again this round — Correction 3 adds
`set_pincode_tracking_state`, the fifth; column/constraint count revised for Correction 6's soft-removal
state and Correction 11's immediately-addable CHECK constraints; not committed to exact numbering, next
available migration number to be confirmed at implementation time):

1. One migration: `ALTER TABLE amazon_listing_items ADD CONSTRAINT ... UNIQUE (workspace_id, id)` and the
   same for `tracked_asins` (§2, Correction 2 precondition) — trivial, additive, zero data risk (both
   columns are already unique via each table's own primary key), but touches two existing, in-use tables, so
   it is kept as its own reviewable step rather than folded silently into migration #2.
2. One migration: `workspace_default_pincodes`, `pincode_monitored_products` (including `.removed_at`/
   `.removal_reason` and the `removed`-consistency CHECK, Correction 6), `pincode_tracking_targets` — all
   three together, since `pincode_tracking_targets` FKs to `pincode_monitored_products` and both are new,
   they belong in one migration (matches this codebase's existing convention of grouping tightly coupled new
   tables, e.g. migration `059` created `review_solicitation_orders` alone since nothing else depended on it
   that same migration; migration `016` created `scraping_jobs` + `pincode_availability_results` together
   since the latter FKs the former). Includes the RLS policies (§6 — `SELECT`-only for members on all three
   tables, Correction 5 round 2), the `updated_at` triggers, the two due-work indexes (§3), and the
   `claim_token` partial unique index (§3, Correction 2 round 2).
3. One migration: `pincode_availability_results.monitored_product_id` + `.tracking_target_id` +
   `.check_attempt_id` + `.check_status` additive columns (§4, Correction 1 round 2) + their composite FKs,
   the `check_attempt_id` partial unique index, the three history indexes (§4/§4a), **and the two
   immediately-addable CHECK constraints from Correction 11 round 3** (identity-consistency,
   new-row-result-consistency — both safe against existing data, unlike the `check_status`-format constraint
   below) — kept separate from #2 so the new tables can be reviewed/applied independently of touching an
   existing, already-in-use table. **Still does not** include the `check_status`/result-state-format CHECK
   constraint — that alone remains deferred until the read-only production audit (§4a, recorded with real
   numbers — 18 available/no-error, 7 unknown/error) has its backfill applied.
4. One migration: the **five** RPC functions this spec's corrections require —
   `claim_due_pincode_targets(...)` (`IMPLEMENTATION_PLAN.md` §2.8, Corrections 4/6/7/8), `finalize_pincode_
   check(...)` (`IMPLEMENTATION_PLAN.md` §2.7, Corrections 3/4/5/10/11), `enroll_pincode_monitored_products
   (...)` (§2a, Corrections 1/2), `queue_pincode_manual_check(...)` (`IMPLEMENTATION_PLAN.md` §2.10,
   Corrections 4/9), and **`set_pincode_tracking_state(...)` (§3a, Correction 3 — new this round)** — all
   five `SECURITY DEFINER`, `search_path` set explicitly, `REVOKE EXECUTE ... FROM PUBLIC` + `GRANT EXECUTE
   ... TO service_role` only (never broadly granted to `authenticated`), per Correction 4's explicit
   requirement, unchanged this round.

A fifth, follow-up migration (not counted above, deliberately deferred) adds the `check_status`-format CHECK
constraint once the backfill from the confirmed audit (§4a) is applied — this is the *only* CHECK constraint
still deferred; Correction 11's two new ones are not (see migration #3 above).

**No migration is proposed or applied in this round** — this section exists to size the work, not to
schedule it. Per round-2 Correction 10, migration #1/#2/#3 belong to implementation phase **P0-A**, migration
#4 also belongs to **P0-A** (`IMPLEMENTATION_PLAN.md` §9) — none of the 4 migrations are applied until P0-A
is its own separately reviewed and approved implementation PR.
