-- Add historical/status fields for append-only keyword rank tracking snapshots.
ALTER TABLE public.keyword_rank_snapshots
  ADD COLUMN IF NOT EXISTS tracked_asin_id UUID REFERENCES public.tracked_asins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS keyword TEXT,
  ADD COLUMN IF NOT EXISTS page INTEGER,
  ADD COLUMN IF NOT EXISTS position_on_page INTEGER,
  ADD COLUMN IF NOT EXISTS found BOOLEAN,
  ADD COLUMN IF NOT EXISTS scrape_status TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_krs_tracked_asin_id
  ON public.keyword_rank_snapshots(tracked_asin_id);

CREATE INDEX IF NOT EXISTS idx_krs_scrape_status
  ON public.keyword_rank_snapshots(scrape_status);
