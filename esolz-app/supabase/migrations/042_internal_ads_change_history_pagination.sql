-- Phase 1E.4: track Amazon's pagination metadata on each Change History
-- import batch so an incomplete import (Amazon's totalRecords > events
-- captured in this page) is visible rather than silently under-counted.
-- Additive only — no new tables, no behavior change to existing rows.

ALTER TABLE public.internal_ads_change_history_import_batches
  ADD COLUMN IF NOT EXISTS page_size integer,
  ADD COLUMN IF NOT EXISTS page_offset integer,
  ADD COLUMN IF NOT EXISTS max_page_number integer,
  ADD COLUMN IF NOT EXISTS total_records_reported integer,
  ADD COLUMN IF NOT EXISTS inserted_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_incomplete boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
