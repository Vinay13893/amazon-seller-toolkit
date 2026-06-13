-- Add scrape status to ASIN snapshots for partial/failure-safe status rendering.
ALTER TABLE public.asin_snapshots
  ADD COLUMN IF NOT EXISTS scrape_status TEXT;
