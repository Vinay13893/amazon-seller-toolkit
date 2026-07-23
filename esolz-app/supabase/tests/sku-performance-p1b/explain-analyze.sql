-- SKU Performance P1-B -- EXPLAIN ANALYZE representative-volume check.
--
-- Seeds ~500 SKUs x 90 days of Ads rows (3 campaign rows/SKU/day, matching
-- real campaign/ad-group granularity -- 135,000 rows) and ~500 SKUs x 90
-- days of Business Report rows (45,000 rows) for one benchmark workspace,
-- plus a comparable-volume "noise" workspace so workspace_id filtering is
-- actually selective (mirroring pincode-p0a's due/not-due dilution
-- technique, rather than a single-workspace table where any plan looks
-- fast regardless of index quality).
--
-- Because get_sku_performance_summary is a SECURITY DEFINER plpgsql
-- function, EXPLAIN cannot drill into its internal query plan when invoked
-- as a black-box function call -- Postgres reports a single opaque
-- function-scan node in that case. So this file does two things: (1) times
-- the actual RPC call end-to-end via \timing, against the Implementation
-- Plan sec1's documented ~800ms materialized-table promotion trigger, and
-- (2) EXPLAIN ANALYZEs the underlying Ads/Sales scan shapes directly
-- (copied verbatim from migration 065's ads_rows/sales_rows CTEs), which
-- IS introspectable, asserting they hit the existing workspace-prefixed
-- indexes rather than an unbounded cross-workspace sequential scan.
--
-- Run ONLY against a scratch/local database -- see run-tests.sh.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'bench-owner@test.com');
INSERT INTO public.profiles (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'bench-owner@test.com');

INSERT INTO public.workspaces (id, owner_id, name) VALUES
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'Bench Workspace'),
  ('b0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'Bench Noise Workspace');

INSERT INTO public.amazon_connections (id, workspace_id, status, marketplace_id) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'active', 'M1'),
  ('b1000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'active', 'M1');

INSERT INTO public.amazon_ads_connections (id, workspace_id, status) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'active'),
  ('b2000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'active');

INSERT INTO public.amazon_ads_profiles (id, workspace_id, amazon_ads_connection_id, profile_id, marketplace_id, currency_code) VALUES
  ('b3000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'BENCH-P1', 'M1', 'INR'),
  ('b3000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 'BENCH-P2', 'M1', 'INR');

INSERT INTO public.internal_ads_deep_report_upload_batches (id, workspace_id, report_kind, original_filename) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'advertised_product', 'bench.csv'),
  ('b4000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'advertised_product', 'bench-noise.csv');

-- 500 catalog SKUs for the benchmark workspace.
INSERT INTO public.amazon_listing_items (workspace_id, connection_id, sku, asin, marketplace_id, item_name)
SELECT 'b0000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
       'BENCH-SKU-' || lpad(gs::text, 4, '0'), 'BASIN' || lpad(gs::text, 5, '0'), 'M1', 'Bench Item ' || gs
FROM generate_series(1, 500) gs;

-- Business Report: 500 SKUs x 90 days = 45,000 rows, benchmark workspace.
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered)
SELECT 'b0000000-0000-0000-0000-000000000001', 'M1',
       ('2026-04-01'::date + d),
       'BENCH-SKU-' || lpad(gs::text, 4, '0'), 'BENCH-SKU-' || lpad(gs::text, 4, '0'), 'BASIN' || lpad(gs::text, 5, '0'),
       (random() * 1000)::numeric(14,2), (random() * 10)::int
FROM generate_series(1, 500) gs
CROSS JOIN generate_series(0, 89) d;

-- Ads: 500 SKUs x 90 days x 3 campaign rows = 135,000 rows, benchmark workspace.
INSERT INTO public.internal_ads_advertised_product_daily_rows
  (workspace_id, upload_batch_id, profile_id, report_date, campaign_name, campaign_id, ad_group_name, advertised_sku, advertised_asin, spend, sales, source, dedupe_key, raw_row)
SELECT 'b0000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 'BENCH-P1',
       ('2026-04-01'::date + d),
       'Bench Campaign ' || c, 'BCMP-' || gs || '-' || c, 'BAG-' || c,
       'BENCH-SKU-' || lpad(gs::text, 4, '0'), 'BASIN' || lpad(gs::text, 5, '0'),
       (random() * 50)::numeric(14,2), (random() * 60)::numeric(14,2), 'ads_api_auto',
       'BDK-' || gs || '-' || d || '-' || c, '{}'
FROM generate_series(1, 500) gs
CROSS JOIN generate_series(0, 89) d
CROSS JOIN generate_series(1, 3) c;

-- Comparable-volume noise in a SEPARATE workspace, so workspace_id
-- filtering is actually selective (~50% of the table, not 100%).
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered)
SELECT 'b0000000-0000-0000-0000-000000000002', 'M1',
       ('2026-04-01'::date + d), 'NOISE-SKU-' || lpad(gs::text, 4, '0'), 'NOISE-SKU-' || lpad(gs::text, 4, '0'), NULL,
       (random() * 1000)::numeric(14,2), (random() * 10)::int
FROM generate_series(1, 500) gs CROSS JOIN generate_series(0, 89) d;

INSERT INTO public.internal_ads_advertised_product_daily_rows
  (workspace_id, upload_batch_id, profile_id, report_date, campaign_name, campaign_id, ad_group_name, advertised_sku, advertised_asin, spend, sales, source, dedupe_key, raw_row)
SELECT 'b0000000-0000-0000-0000-000000000002', 'b4000000-0000-0000-0000-000000000002', 'BENCH-P2',
       ('2026-04-01'::date + d), 'Noise Campaign ' || c, 'NCMP-' || gs || '-' || c, 'NAG-' || c,
       'NOISE-SKU-' || lpad(gs::text, 4, '0'), 'NASIN' || lpad(gs::text, 5, '0'),
       (random() * 50)::numeric(14,2), (random() * 60)::numeric(14,2), 'ads_api_auto',
       'NDK-' || gs || '-' || d || '-' || c, '{}'
FROM generate_series(1, 500) gs CROSS JOIN generate_series(0, 89) d CROSS JOIN generate_series(1, 3) c;

COMMIT;

ANALYZE public.internal_business_report_sku_sales_traffic;
ANALYZE public.internal_ads_advertised_product_daily_rows;
ANALYZE public.amazon_listing_items;

-- ---------------- Phase A: end-to-end RPC timing ----------------
\timing on
SELECT (public.get_sku_performance_summary(
  'b0000000-0000-0000-0000-000000000001', 'M1', '2026-06-01', '2026-06-30', '2026-06-30',
  500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'attention_desc'
)->'pagination') AS pagination_result;
\timing off

-- ---------------- Phase B: underlying scan-shape index checks ----------------
DO $$
DECLARE v_plan jsonb;
BEGIN
  EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT upper(btrim(s.sku)) AS canonical_sku, s.sku AS raw_sku, s.report_date, s.ordered_product_sales, s.units_ordered
    FROM public.internal_business_report_sku_sales_traffic s
    WHERE s.workspace_id = 'b0000000-0000-0000-0000-000000000001' AND s.marketplace_id = 'M1'
      AND s.sku IS NOT NULL AND btrim(s.sku) <> ''
  $q$ INTO v_plan;

  IF jsonb_path_exists(v_plan, '$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "internal_business_report_sku_sales_traffic")') THEN
    RAISE EXCEPTION 'EXPLAIN-ANALYZE FAILED: sales_rows scan used a sequential scan instead of the workspace/date index -- plan: %', v_plan;
  END IF;
  RAISE NOTICE 'PHASE B (sales_rows): no sequential scan on internal_business_report_sku_sales_traffic. Execution time: % ms', v_plan->0->'Execution Time';
END $$;

DO $$
DECLARE v_plan jsonb;
BEGIN
  EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT upper(btrim(a.advertised_sku)) AS canonical_sku, a.advertised_sku AS raw_sku, a.report_date, a.spend, a.sales
    FROM public.internal_ads_advertised_product_daily_rows a
    JOIN public.amazon_ads_profiles ap ON ap.profile_id = a.profile_id
    WHERE a.workspace_id = 'b0000000-0000-0000-0000-000000000001'
      AND a.advertised_sku IS NOT NULL AND btrim(a.advertised_sku) <> ''
  $q$ INTO v_plan;

  IF jsonb_path_exists(v_plan, '$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "internal_ads_advertised_product_daily_rows")') THEN
    RAISE EXCEPTION 'EXPLAIN-ANALYZE FAILED: ads_rows scan used a sequential scan instead of the workspace index -- plan: %', v_plan;
  END IF;
  RAISE NOTICE 'PHASE B (ads_rows): no sequential scan on internal_ads_advertised_product_daily_rows. Execution time: % ms', v_plan->0->'Execution Time';
END $$;

SELECT 'EXPLAIN-ANALYZE CHECK COMPLETED WITHOUT ERROR' AS summary;
