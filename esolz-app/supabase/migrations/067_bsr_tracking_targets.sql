-- 067_bsr_tracking_targets.sql
-- Page 2 / BSR Tracker target selection.
--
-- BSR tracking must not use tracked_asins as a mixed product list. This table
-- stores only the user's BSR dashboard selection and never owns source product
-- identity or BSR history. History remains in public.asin_snapshots.

-- These composite indexes look redundant beside the parent tables' primary
-- keys on id, but they are required for the composite foreign keys below.
-- The BSR target row carries workspace_id, so the database must prove the
-- referenced source row belongs to the same workspace, not merely that the
-- source id exists globally.
CREATE UNIQUE INDEX IF NOT EXISTS amazon_listing_items_workspace_id_id_uidx
  ON public.amazon_listing_items (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS tracked_asins_workspace_id_id_uidx
  ON public.tracked_asins (workspace_id, id);

CREATE TABLE IF NOT EXISTS public.bsr_tracking_targets (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_listing_item_id uuid,
  tracked_asin_id        uuid,
  status                 text        NOT NULL DEFAULT 'active',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz,

  CONSTRAINT bsr_tracking_targets_one_source_chk
    CHECK (
      num_nonnulls(amazon_listing_item_id, tracked_asin_id) = 1
    ),
  CONSTRAINT bsr_tracking_targets_status_chk
    CHECK (status IN ('active', 'removed')),
  CONSTRAINT bsr_tracking_targets_removed_consistency_chk
    CHECK (
      (status = 'removed' AND removed_at IS NOT NULL)
      OR
      (status = 'active' AND removed_at IS NULL)
    ),
  CONSTRAINT bsr_tracking_targets_listing_fk
    FOREIGN KEY (workspace_id, amazon_listing_item_id)
    REFERENCES public.amazon_listing_items (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT bsr_tracking_targets_tracked_asin_fk
    FOREIGN KEY (workspace_id, tracked_asin_id)
    REFERENCES public.tracked_asins (workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS bsr_tracking_targets_listing_uidx
  ON public.bsr_tracking_targets (workspace_id, amazon_listing_item_id)
  WHERE amazon_listing_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bsr_tracking_targets_tracked_asin_uidx
  ON public.bsr_tracking_targets (workspace_id, tracked_asin_id)
  WHERE tracked_asin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bsr_tracking_targets_workspace_status_idx
  ON public.bsr_tracking_targets (workspace_id, status);

CREATE INDEX IF NOT EXISTS bsr_tracking_targets_listing_idx
  ON public.bsr_tracking_targets (amazon_listing_item_id)
  WHERE amazon_listing_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bsr_tracking_targets_tracked_asin_idx
  ON public.bsr_tracking_targets (tracked_asin_id)
  WHERE tracked_asin_id IS NOT NULL;

CREATE TRIGGER trg_bsr_tracking_targets_updated_at
  BEFORE UPDATE ON public.bsr_tracking_targets
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

ALTER TABLE public.bsr_tracking_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bsr_tracking_targets: member select"
  ON public.bsr_tracking_targets
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "bsr_tracking_targets: member insert"
  ON public.bsr_tracking_targets
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "bsr_tracking_targets: member update"
  ON public.bsr_tracking_targets
  FOR UPDATE
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- No authenticated DELETE policy by design. "Untrack BSR" is a soft removal
-- that updates only this configuration row and leaves catalog/competitor rows
-- plus asin_snapshots history untouched.
