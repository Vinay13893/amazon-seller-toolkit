-- Phase 1H: Manual Review Execution Sheet + Guardrails.
-- Additive-only: extends the Phase 1G review-bookkeeping table with the
-- pre-change checklist (stock/buy box/coupon/price/reviews/delivery promise/
-- listing/live bid/live status/live budget), a decision date, and the
-- expected metric(s) to watch. No Amazon Ads change-history/event tables are
-- touched, and nothing here drives any write to Amazon Ads — review
-- bookkeeping only.

ALTER TABLE public.internal_ads_review_case_reviews
  ADD COLUMN IF NOT EXISTS stock_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS buy_box_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coupon_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviews_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_promise_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listing_active_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_bid_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_status_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_budget_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decision_date date,
  ADD COLUMN IF NOT EXISTS expected_metrics text[] NOT NULL DEFAULT '{}';

-- Widen the status list with the Phase 1H decision vocabulary while keeping
-- any already-saved Phase 1G values valid (no data rewrite).
ALTER TABLE public.internal_ads_review_case_reviews
  DROP CONSTRAINT IF EXISTS internal_ads_review_case_reviews_status_check;
ALTER TABLE public.internal_ads_review_case_reviews
  ADD CONSTRAINT internal_ads_review_case_reviews_status_check
  CHECK (status IN (
    'Not reviewed', 'Reviewing', 'Restore old bid? maybe', 'Keep current bid',
    'Check listing first', 'Pause/negative review', 'Done', 'Ignore',
    'Restore old bid manually', 'Partial bid correction manually'
  ));

NOTIFY pgrst, 'reload schema';
