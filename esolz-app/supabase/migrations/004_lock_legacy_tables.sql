-- Migration 004: Lock legacy tables by enabling RLS with zero-access policies
-- These tables predate the migration system. None are used by current application code.
-- Enabling RLS with no policies = complete lockdown via REST API.
-- Admin/service-role client retains access. No data is deleted or modified.
--
-- Tables locked:
--   seller_credentials  (CRITICAL: may contain Amazon API keys/secrets)
--   users               (HIGH: old user PII, ~248 rows)
--   asins               (replaced by tracked_asins)
--   bsr_history         (replaced by asin_snapshots)
--   job_logs            (old scheduler logs)
--   keyword_ranks       (replaced by keyword_rank_snapshots)
--   tool_usage          (old usage analytics)

ALTER TABLE public.seller_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bsr_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_ranks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_usage         ENABLE ROW LEVEL SECURITY;
