-- Minimal background job queue foundation. Only the product_page_snapshot
-- job type is active for now (see Task C/D/E in the ASIN checker rollout).

CREATE TABLE IF NOT EXISTS public.background_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  marketplace_id text,
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'queued',
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error_safe text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Prevent duplicate pending jobs for the same target while one is already
-- queued or running.
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_active_target_uidx
  ON public.background_jobs (workspace_id, job_type, target_type, target_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS background_jobs_claim_idx
  ON public.background_jobs (job_type, status, run_after);

CREATE INDEX IF NOT EXISTS background_jobs_workspace_idx
  ON public.background_jobs (workspace_id, job_type, status);

ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "background_jobs: member select" ON public.background_jobs;
CREATE POLICY "background_jobs: member select"
  ON public.background_jobs FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP POLICY IF EXISTS "background_jobs: member insert" ON public.background_jobs;
CREATE POLICY "background_jobs: member insert"
  ON public.background_jobs FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

DROP TRIGGER IF EXISTS trg_background_jobs_updated_at ON public.background_jobs;
CREATE TRIGGER trg_background_jobs_updated_at
  BEFORE UPDATE ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- Snapshots are currently keyed only to tracked_asins (manual/competitor
-- tracking). Add a nullable, additive link so the same table can also store
-- snapshots for connected-account listings ("My Products"). tracked_asin_id
-- is relaxed to nullable (loosening, not narrowing) since a "my_product"
-- snapshot will have amazon_listing_item_id set instead.
ALTER TABLE public.asin_snapshots
  ALTER COLUMN tracked_asin_id DROP NOT NULL;

ALTER TABLE public.asin_snapshots
  ADD COLUMN IF NOT EXISTS amazon_listing_item_id uuid REFERENCES public.amazon_listing_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS asin_snapshots_listing_item_checked_idx
  ON public.asin_snapshots (amazon_listing_item_id, checked_at DESC);
