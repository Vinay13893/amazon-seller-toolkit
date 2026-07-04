-- 055_asin_snapshot_bsr_deal_signals.sql
-- R11.2: BSR + deal-tag source strategy (additive only).
--
-- Adds official-source BSR context and discount-signal fields to
-- asin_snapshots. No rows are modified; all columns are nullable.
--
--   bsr_category     — human-readable category of the main rank
--   bsr_source       — 'spapi_catalog' | 'spapi_pricing_summary'
--   bsr_ranks        — all category/rank pairs from the source response
--   list_price       — Summary.ListPrice (MRP) from SP-API Product Pricing
--   discount_percent — computed when live price < list_price
--
-- Note: Amazon deal/coupon badges are NOT exposed by any SP-API endpoint the
-- app uses; discount_percent is a "price discount signal", not a deal tag.

ALTER TABLE public.asin_snapshots
  ADD COLUMN IF NOT EXISTS bsr_category text,
  ADD COLUMN IF NOT EXISTS bsr_source text,
  ADD COLUMN IF NOT EXISTS bsr_ranks jsonb,
  ADD COLUMN IF NOT EXISTS list_price numeric,
  ADD COLUMN IF NOT EXISTS discount_percent numeric;

COMMENT ON COLUMN public.asin_snapshots.bsr_source IS
  'Official source of bsr: spapi_catalog (Catalog Items salesRanks) or spapi_pricing_summary (Product Pricing Summary.SalesRankings)';
COMMENT ON COLUMN public.asin_snapshots.discount_percent IS
  'Price discount signal: percent below Summary.ListPrice. Not an Amazon deal/coupon badge (not exposed by SP-API).';
