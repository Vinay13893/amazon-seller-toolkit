-- Pincode Checker P0-A, migration 2 of 4: the three new configuration/
-- tracking tables -- workspace_default_pincodes, pincode_monitored_products,
-- pincode_tracking_targets -- plus their RLS (SELECT-only for members, no
-- exceptions), updated_at triggers, and indexes.
--
-- Feature is disabled at this stage: no route, no UI, nothing user-reachable
-- yet. This migration is pure schema. See PINCODE_UNIFIED_PAGE_DATA_MODEL.md
-- sec1-sec3, sec6 and BRAHMASTRA_MASTER_TRACKER.md sec22 for the full design
-- history (5 amendment rounds) this schema implements exactly.

-- ============================================================
-- 1. workspace_default_pincodes
-- ============================================================
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
    CHECK (pincode ~ '^[1-9][0-9]{5}$')
);

CREATE INDEX workspace_default_pincodes_workspace_mp_idx
  ON public.workspace_default_pincodes (workspace_id, marketplace_id)
  WHERE is_active = true;

CREATE TRIGGER trg_workspace_default_pincodes_updated_at
  BEFORE UPDATE ON public.workspace_default_pincodes
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- ============================================================
-- 2. pincode_monitored_products
-- ============================================================
-- Parent lifecycle has exactly three states: active | archived | removed.
-- "Paused"/"Failed"/"Partially active" are DERIVED UI states computed from
-- child pincode_tracking_targets' own statuses -- never stored here.
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

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'archived' | 'removed'

  removed_at            timestamptz,
  removal_reason        text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_monitored_products_uidx
    UNIQUE (workspace_id, marketplace_id, asin),
  CONSTRAINT pincode_monitored_products_workspace_id_uidx
    UNIQUE (workspace_id, id),
  CONSTRAINT pincode_monitored_products_source_chk
    CHECK (product_source IN ('owned', 'other')),
  CONSTRAINT pincode_monitored_products_status_chk
    CHECK (status IN ('active', 'archived', 'removed')),
  CONSTRAINT pincode_monitored_products_asin_format_chk
    CHECK (asin ~ '^[A-Z0-9]{10}$'),
  -- Correction 6 (2026-07-18, PR #54 review round): strengthened. The
  -- original form only required removed_at when status='removed', leaving
  -- a row that was 'removed' with a NULL removal_reason structurally
  -- valid -- silently losing the seller's stated reason (or the RPC's own
  -- narrow value) at the database layer, even though the RPC itself only
  -- ever writes 'user_requested'. The CHECK now also requires
  -- removal_reason to be both non-null AND drawn from the same narrow
  -- allowed-value set the remove RPC enforces (DATA_MODEL.md sec3b) --
  -- defense-in-depth so a future write path can't silently create a
  -- 'removed' row with an arbitrary or missing reason.
  CONSTRAINT pincode_monitored_products_removed_consistency_chk
    CHECK (
      (status = 'removed' AND removed_at IS NOT NULL AND removal_reason IS NOT NULL
        AND removal_reason IN ('user_requested'))
      OR
      (status <> 'removed' AND removed_at IS NULL AND removal_reason IS NULL)
    ),

  -- Workspace-scoped composite FKs -- the referenced row must belong to the
  -- SAME workspace_id, enforced by Postgres, not just RLS. Column-specific
  -- ON DELETE SET NULL is PG15+ syntax; this project runs PostgreSQL 17.6
  -- (independently confirmed, DATA_MODEL.md Amendment 2).
  CONSTRAINT pincode_monitored_products_listing_fk
    FOREIGN KEY (workspace_id, amazon_listing_item_id)
    REFERENCES public.amazon_listing_items (workspace_id, id)
    ON DELETE SET NULL (amazon_listing_item_id),
  CONSTRAINT pincode_monitored_products_tracked_asin_fk
    FOREIGN KEY (workspace_id, tracked_asin_id)
    REFERENCES public.tracked_asins (workspace_id, id)
    ON DELETE SET NULL (tracked_asin_id)
  -- No "owned row must have a listing ref" CHECK here by design -- enforced
  -- once, at enrollment time, inside enroll_pincode_monitored_products.
  -- See DATA_MODEL.md sec2 Correction 1 for why a standing CHECK here would
  -- be self-defeating against the archival reconciliation pass.
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

-- ============================================================
-- 3. pincode_tracking_targets
-- ============================================================
CREATE TABLE public.pincode_tracking_targets (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  monitored_product_id  uuid        NOT NULL,
  pincode               text        NOT NULL,

  status                text        NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'failed' | 'checking'
  cadence_hours         integer     NOT NULL DEFAULT 24,

  claimed_at            timestamptz,
  claimed_by            text,
  claim_token           uuid,

  manual_requested_at   timestamptz,
  manual_requested_by   uuid,
  manual_request_token  uuid,

  last_checked_at       timestamptz,
  next_check_at         timestamptz,
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_error_code       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pincode_tracking_targets_uidx
    UNIQUE (monitored_product_id, pincode),
  CONSTRAINT pincode_tracking_targets_workspace_id_uidx
    UNIQUE (workspace_id, id),
  CONSTRAINT pincode_tracking_targets_identity_uidx
    UNIQUE (workspace_id, id, monitored_product_id),
  CONSTRAINT pincode_tracking_targets_status_chk
    CHECK (status IN ('active', 'paused', 'failed', 'checking')),
  CONSTRAINT pincode_tracking_targets_pincode_format_chk
    CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT pincode_tracking_targets_cadence_chk
    CHECK (cadence_hours > 0 AND cadence_hours <= 168),
  CONSTRAINT pincode_tracking_targets_failures_chk
    CHECK (consecutive_failures >= 0),
  CONSTRAINT pincode_tracking_targets_claim_consistency_chk
    CHECK (
      (status = 'checking' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL AND claim_token IS NOT NULL)
      OR
      (status <> 'checking' AND claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL)
    ),
  -- Correction 5 (2026-07-18, PR #54 review round): RESTRICT, not CASCADE.
  -- Normal feature behavior is SOFT removal -- remove_pincode_monitored_
  -- products (DATA_MODEL.md sec3b) sets the parent's status='removed' and
  -- pauses child targets, it never DELETEs the parent row. A plain CASCADE
  -- here meant a direct hard DELETE of a pincode_monitored_products row
  -- (an operational mistake, a manual psql session, a future bug) would
  -- silently erase every one of its tracking targets -- and, transitively,
  -- get blocked by pincode_availability_results' own RESTRICT FK (062)
  -- only if history existed; a product with targets but zero results yet
  -- would have had its targets silently cascaded away with no error at
  -- all. Matches the same reasoning already applied to the result table's
  -- FKs (062, Correction 11 from the original spec round): this feature's
  -- own tables are never hard-deleted in normal operation, so a hard
  -- DELETE against them should be loudly rejected, not silently absorbed.
  -- Workspace-level cascade (ON DELETE CASCADE from workspaces, above,
  -- unaffected by this correction) is retained deliberately -- deleting an
  -- entire workspace is a real, intentional, whole-tenant operation this
  -- schema still needs to clean up after, tested separately from the
  -- per-row RESTRICT case this correction addresses.
  CONSTRAINT pincode_tracking_targets_monitored_product_fk
    FOREIGN KEY (workspace_id, monitored_product_id)
    REFERENCES public.pincode_monitored_products (workspace_id, id)
    ON DELETE RESTRICT
);

-- Global due-work query (claim_due_pincode_targets) selects across all
-- workspaces ordered by next_check_at, then applies per-workspace fairness
-- inside the claim RPC -- this index leads with next_check_at to match.
CREATE INDEX pincode_tracking_targets_due_idx
  ON public.pincode_tracking_targets (next_check_at, workspace_id)
  WHERE status = 'active' AND next_check_at IS NOT NULL;

-- Workspace-scoped reads (tracker table's own due count, per-workspace cap
-- check inside the claim RPC) -- kept separate from the index above.
CREATE INDEX pincode_tracking_targets_workspace_due_idx
  ON public.pincode_tracking_targets (workspace_id, next_check_at)
  WHERE status = 'active' AND next_check_at IS NOT NULL;

CREATE INDEX pincode_tracking_targets_monitored_product_idx
  ON public.pincode_tracking_targets (monitored_product_id);

CREATE UNIQUE INDEX pincode_tracking_targets_manual_request_idx
  ON public.pincode_tracking_targets (manual_request_token) WHERE manual_request_token IS NOT NULL;

-- claim_token must be database-enforced unique, not just assumed
-- collision-free -- finalize_pincode_check locates exactly one claimed
-- target by claim_token alone.
CREATE UNIQUE INDEX pincode_tracking_targets_claim_token_uidx
  ON public.pincode_tracking_targets (claim_token) WHERE claim_token IS NOT NULL;

CREATE TRIGGER trg_pincode_tracking_targets_updated_at
  BEFORE UPDATE ON public.pincode_tracking_targets
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- ============================================================
-- 4. RLS -- SELECT-only for members on all three tables, no exceptions.
-- ============================================================
-- Every mutation goes through an authenticated Next.js API route (P0-B)
-- that verifies session, workspace membership, and role, then writes using
-- the service-role client, which bypasses RLS entirely. No member-facing
-- INSERT/UPDATE/DELETE policy exists on any of these three tables -- this
-- is deliberately the ONLY mutation path. See DATA_MODEL.md sec6 Correction
-- 3/5 for why a blanket member-CRUD policy (even on the seemingly-harmless
-- workspace_default_pincodes table) would let a viewer-role member bypass
-- the server route's role check, since RLS has no role-column awareness.

ALTER TABLE public.workspace_default_pincodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_monitored_products  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_tracking_targets    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_default_pincodes: member select" ON public.workspace_default_pincodes;
CREATE POLICY "workspace_default_pincodes: member select"
  ON public.workspace_default_pincodes FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP POLICY IF EXISTS "pincode_monitored_products: member select" ON public.pincode_monitored_products;
CREATE POLICY "pincode_monitored_products: member select"
  ON public.pincode_monitored_products FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP POLICY IF EXISTS "pincode_tracking_targets: member select" ON public.pincode_tracking_targets;
CREATE POLICY "pincode_tracking_targets: member select"
  ON public.pincode_tracking_targets FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

notify pgrst, 'reload schema';
