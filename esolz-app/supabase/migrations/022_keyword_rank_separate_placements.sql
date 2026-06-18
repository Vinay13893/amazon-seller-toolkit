-- Separate organic and sponsored keyword placements without dropping snapshot data.
ALTER TABLE public.keyword_rank_snapshots
  ADD COLUMN IF NOT EXISTS organic_page integer,
  ADD COLUMN IF NOT EXISTS organic_slot integer,
  ADD COLUMN IF NOT EXISTS sponsored_page integer,
  ADD COLUMN IF NOT EXISTS sponsored_slot integer,
  ADD COLUMN IF NOT EXISTS organic_found boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sponsored_found boolean NOT NULL DEFAULT false;

-- Safely backfill fields whose meaning is unambiguous in legacy snapshots.
UPDATE public.keyword_rank_snapshots
SET
  organic_page = CASE WHEN organic_rank IS NOT NULL THEN page ELSE organic_page END,
  organic_slot = CASE WHEN organic_rank IS NOT NULL THEN position_on_page ELSE organic_slot END,
  sponsored_page = CASE
    WHEN sponsored_rank IS NOT NULL AND organic_rank IS NULL THEN page
    ELSE sponsored_page
  END,
  sponsored_slot = CASE
    WHEN sponsored_rank IS NOT NULL AND organic_rank IS NULL THEN position_on_page
    ELSE sponsored_slot
  END,
  organic_found = organic_rank IS NOT NULL,
  sponsored_found = sponsored_rank IS NOT NULL
WHERE
  organic_rank IS NOT NULL
  OR sponsored_rank IS NOT NULL;

-- Replace the legacy workspace-wide keyword uniqueness with ASIN-scoped uniqueness.
ALTER TABLE public.tracked_keywords
  DROP CONSTRAINT IF EXISTS tracked_keywords_workspace_id_keyword_marketplace_key;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_asin_keyword_marketplace_uidx
  ON public.tracked_keywords (workspace_id, tracked_asin_id, keyword, marketplace)
  WHERE tracked_asin_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_unassigned_keyword_marketplace_uidx
  ON public.tracked_keywords (workspace_id, keyword, marketplace)
  WHERE tracked_asin_id IS NULL;

CREATE INDEX IF NOT EXISTS keyword_rank_snapshots_organic_found_idx
  ON public.keyword_rank_snapshots (workspace_id, organic_found, checked_at DESC);

CREATE INDEX IF NOT EXISTS keyword_rank_snapshots_sponsored_found_idx
  ON public.keyword_rank_snapshots (workspace_id, sponsored_found, checked_at DESC);

NOTIFY pgrst, 'reload schema';
