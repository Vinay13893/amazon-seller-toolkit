-- Add optional Product Pricing enrichment fields for Buy Box snapshots.
-- Non-destructive: all new columns are nullable and existing rows remain valid.

ALTER TABLE public.buybox_snapshots
  ADD COLUMN IF NOT EXISTS number_of_offers INTEGER NULL,
  ADD COLUMN IF NOT EXISTS number_of_buybox_eligible_offers INTEGER NULL,
  ADD COLUMN IF NOT EXISTS lowest_price NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS lowest_price_currency TEXT NULL,
  ADD COLUMN IF NOT EXISTS buy_box_currency TEXT NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NULL,
  ADD COLUMN IF NOT EXISTS raw_summary JSONB NULL,
  ADD COLUMN IF NOT EXISTS raw_offers JSONB NULL;
