-- ─────────────────────────────────────────────────────────────────────────────
-- 008_internal_tester_plan.sql
-- Internal Tester Plan — unlimited limits for owner / QA testing
--
-- Purpose:
--   Insert a single "Internal Tester" row into subscription_plans with
--   high limits and all features enabled.  It is never shown in the public
--   Billing UI (hidden by name on the frontend).
--
-- Safety guarantees:
--   • No DROP, no DELETE, no ALTER TABLE
--   • Uses INSERT … ON CONFLICT (name) DO UPDATE, so re-running is safe
--   • Does not touch any existing plan rows
--   • No new columns added to subscription_plans
--
-- Assignment:
--   Run docs/ASSIGN_INTERNAL_TESTER_PLAN.sql in the Supabase SQL Editor
--   after creating/confirming the test user.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.subscription_plans (
  name,
  price_monthly,
  asin_limit,
  keyword_limit,
  pincode_check_limit,
  competitor_limit,
  report_limit,
  features
)
VALUES (
  'Internal Tester',
  0,
  999999,
  999999,
  999999,
  999999,
  999999,
  '{
    "bsr_tracker":     true,
    "pincode_checker": true,
    "buy_box":         true,
    "keywords":        true,
    "competitors":     true,
    "reports":         true,
    "api_access":      true,
    "white_label":     true
  }'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  price_monthly       = EXCLUDED.price_monthly,
  asin_limit          = EXCLUDED.asin_limit,
  keyword_limit       = EXCLUDED.keyword_limit,
  pincode_check_limit = EXCLUDED.pincode_check_limit,
  competitor_limit    = EXCLUDED.competitor_limit,
  report_limit        = EXCLUDED.report_limit,
  features            = EXCLUDED.features;
