-- SKU Performance P1-B -- committed, repeatable sequential test suite.
--
-- Run ONLY against a scratch/local database bootstrapped from the real
-- repository migrations (001-065) -- see run-tests.sh, which refuses a
-- production connection before this file is ever invoked.
--
-- Every assertion RAISEs a plain, greppable EXCEPTION on failure. A clean
-- run (no ERROR output, ends with the final summary SELECT) means every
-- test below passed. Run via:
--   psql -v ON_ERROR_STOP=1 -f sequential.sql
-- Self-contained: creates its own fixtures and does not depend on any
-- other test file's state.

\set ON_ERROR_STOP on

BEGIN;

-- ================================================================
-- Fixtures
-- ================================================================
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'owner@test.com');
INSERT INTO public.profiles (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'owner@test.com');

-- Two workspaces: WS_A is the primary fixture workspace, WS_B exists only
-- to prove cross-workspace isolation.
INSERT INTO public.workspaces (id, owner_id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Workspace A'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Workspace B');

INSERT INTO public.amazon_connections (id, workspace_id, status, marketplace_id) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'active', 'M1'),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'active', 'M1');

INSERT INTO public.amazon_ads_connections (id, workspace_id, status) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'active');

-- Ads profiles: P1 = WS_A/M1 (the main test scope), P2 = WS_A/M2 (marketplace
-- isolation), P3/P4 = WS_A/CURRENCYMKT with two DIFFERENT currencies (used
-- only by the currency_mismatch test, kept off M1 so it never contaminates
-- the M1 fixtures).
INSERT INTO public.amazon_ads_profiles (id, workspace_id, amazon_ads_connection_id, profile_id, marketplace_id, currency_code) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P1', 'M1', 'INR'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P2', 'M2', 'INR'),
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P3', 'CURRENCYMKT', 'INR'),
  ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P4', 'CURRENCYMKT', 'USD');

INSERT INTO public.internal_ads_deep_report_upload_batches (id, workspace_id, report_kind, original_filename) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'advertised_product', 'fixture.csv');

-- ---------------- Catalog (amazon_listing_items) ----------------
INSERT INTO public.amazon_listing_items (workspace_id, connection_id, sku, asin, marketplace_id, item_name, brand, image_url, last_synced_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-CATALOG-ONLY', 'ASINCAT001', 'M1', 'Catalog Only Item', 'BrandX', 'http://img/1.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-MAPPED', 'ASINMAP001', 'M1', 'Mapped Item', 'BrandX', 'http://img/2.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-CONFLICT-ASIN', 'ASINCONF-CATALOG', 'M1', 'Conflict Item', 'BrandX', 'http://img/3.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-GROWING', 'ASINGRW001', 'M1', 'Growing Item', 'BrandY', 'http://img/4.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-DECLINING', 'ASINDEC001', 'M1', 'Declining Item', 'BrandY', 'http://img/5.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SPEND-SPIKE', 'ASINSPK001', 'M1', 'Spend Spike Item', 'BrandY', 'http://img/6.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-NO-ATTR-SALES', 'ASINNOA001', 'M1', 'No Attr Sales Item', 'BrandY', 'http://img/7.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-TACOS-DETERIORATE', 'ASINTAC001', 'M1', 'Tacos Deteriorate Item', 'BrandY', 'http://img/8.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 'M1', 'Multi Campaign Item', 'BrandY', 'http://img/9.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-A', 'ASINSORTA', 'M1', 'Sort A', 'BrandZ', 'http://img/10.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-B', 'ASINSORTB', 'M1', 'Sort B', 'BrandZ', 'http://img/11.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-C', 'ASINSORTC', 'M1', 'Sort C', 'BrandZ', 'http://img/12.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-M2-ONLY', 'ASINM2001', 'M2', 'M2 Only Item', 'BrandX', 'http://img/13.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'SKU-WSB-ONLY', 'ASINWSB001', 'M1', 'WS-B Only Item', 'BrandX', 'http://img/14.png', '2026-07-15T00:00:00Z');

-- ---------------- Cost master ----------------
INSERT INTO public.internal_sku_cost_master (workspace_id, sku, sku_norm, category) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'SKU-MAPPED', 'SKU-MAPPED', 'Widgets');

-- ---------------- Business Report sales (sales_earliest for WS_A/M1 = 2026-06-10) ----------------
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  -- history anchor: earliest sales row in WS_A/M1 scope
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-06-10', 'SKU-MAPPED', 'SKU-MAPPED', 'ASINMAP001', 100, 2),
  -- SKU-SALES-ONLY: present in sales, absent everywhere else (no catalog row inserted for it on purpose)
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-10', 'SKU-SALES-ONLY', 'SKU-SALES-ONLY', NULL, 250, 3),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-13', 'SKU-SALES-ONLY', 'SKU-SALES-ONLY', NULL, 300, 4),
  -- SKU-MAPPED: sales in prior-7 and trailing-7 windows relative to as_of=2026-07-20
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-07', 'SKU-MAPPED', 'SKU-MAPPED', 'ASINMAP001', 500, 5),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-18', 'SKU-MAPPED', 'SKU-MAPPED', 'ASINMAP001', 500, 5),
  -- SKU-GROWING: prior7 = 0 (no rows in 2026-07-07..2026-07-13), t7 (2026-07-14..2026-07-20) > FLOOR_SALES(1000) => new_activity
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-GROWING', 'SKU-GROWING', 'ASINGRW001', 1500, 10),
  -- SKU-DECLINING: prior7 = 2000, t7 = 200 (< 0.7x) => declining
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-08', 'SKU-DECLINING', 'SKU-DECLINING', 'ASINDEC001', 2000, 20),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-DECLINING', 'SKU-DECLINING', 'ASINDEC001', 200, 2),
  -- SKU-SPEND-SPIKE: some sales so ACOS/TACOS are defined, not used for sales trend assertions
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SPEND-SPIKE', 'SKU-SPEND-SPIKE', 'ASINSPK001', 5000, 10),
  -- SKU-TACOS-DETERIORATE: prior7 sales = 2000 (tacos = 200/2000 = 10%), t7 sales = 2000 (tacos = 600/2000 = 30% > 10%*1.3)
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-08', 'SKU-TACOS-DETERIORATE', 'SKU-TACOS-DETERIORATE', 'ASINTAC001', 2000, 20),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-TACOS-DETERIORATE', 'SKU-TACOS-DETERIORATE', 'ASINTAC001', 2000, 20),
  -- Sort fixtures: distinct, ordered range_sales for 2026-07-01..2026-07-20 (the selected range used by sort tests)
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-A', 'SKU-SORT-A', 'ASINSORTA', 300, 1),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-B', 'SKU-SORT-B', 'ASINSORTB', 200, 1),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-C', 'SKU-SORT-C', 'ASINSORTC', 100, 1),
  -- M2 isolation fixture
  ('a0000000-0000-0000-0000-000000000001', 'M2', '2026-07-16', 'SKU-M2-ONLY', 'SKU-M2-ONLY', 'ASINM2001', 999, 9),
  -- WS_B isolation fixture
  ('a0000000-0000-0000-0000-000000000002', 'M1', '2026-07-16', 'SKU-WSB-ONLY', 'SKU-WSB-ONLY', 'ASINWSB001', 999, 9);

-- ---------------- Ads rows (advertised_product) ----------------
-- ads_earliest for WS_A/M1 (via profile P1) = 2026-06-01
INSERT INTO public.internal_ads_advertised_product_daily_rows
  (workspace_id, upload_batch_id, profile_id, report_date, campaign_name, campaign_id, ad_group_name, advertised_sku, advertised_asin, spend, sales, source, dedupe_key, raw_row) VALUES
  -- history anchor
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-06-01', 'Campaign Anchor', 'CMP-ANCHOR', 'AG1', 'SKU-MAPPED', 'ASINMAP001', 10, 20, 'ads_api_auto', 'DK-ANCHOR', '{}'),
  -- SKU-ADS-ONLY: ads spend, no catalog row -> unmapped
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign AdsOnly', 'CMP-AO', 'AG1', 'SKU-ADS-ONLY', 'ASINADSONLY', 300, 100, 'ads_api_auto', 'DK-AO', '{}'),
  -- SKU-MAPPED: matching ASIN -> mapped
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Mapped', 'CMP-MAP', 'AG1', 'SKU-MAPPED', 'ASINMAP001', 50, 60, 'ads_api_auto', 'DK-MAP', '{}'),
  -- SKU-CONFLICT-ASIN: ads row advertises a DIFFERENT asin than the catalog row -> identity_conflict
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Conflict', 'CMP-CONF', 'AG1', 'SKU-CONFLICT-ASIN', 'ASINCONF-ADS', 40, 20, 'ads_api_auto', 'DK-CONF', '{}'),
  -- SKU-SPEND-SPIKE: prior7 spend = 100 (2026-07-08), t7 spend = 300 (2026-07-16) -> 300 > 100*1.5 => growing/spike
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-08', 'Campaign Spike Prior', 'CMP-SPK-P', 'AG1', 'SKU-SPEND-SPIKE', 'ASINSPK001', 100, 50, 'ads_api_auto', 'DK-SPK-P', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Spike Current', 'CMP-SPK-C', 'AG1', 'SKU-SPEND-SPIKE', 'ASINSPK001', 300, 30, 'ads_api_auto', 'DK-SPK-C', '{}'),
  -- SKU-NO-ATTR-SALES: t7 spend >= min_ad_spend_for_action(100 default), 0 attributed sales
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign NoAttr', 'CMP-NOA', 'AG1', 'SKU-NO-ATTR-SALES', 'ASINNOA001', 150, 0, 'ads_api_auto', 'DK-NOA', '{}'),
  -- SKU-TACOS-DETERIORATE: prior7 spend=200 tacos=10%, t7 spend=600 tacos=30%
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-08', 'Campaign Tacos Prior', 'CMP-TAC-P', 'AG1', 'SKU-TACOS-DETERIORATE', 'ASINTAC001', 200, 100, 'ads_api_auto', 'DK-TAC-P', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Tacos Current', 'CMP-TAC-C', 'AG1', 'SKU-TACOS-DETERIORATE', 'ASINTAC001', 600, 300, 'ads_api_auto', 'DK-TAC-C', '{}'),
  -- SKU-CAMPAIGN-MULTI: THREE separate campaign rows, SAME SKU, SAME day -- proves aggregation happens
  -- before any join with the (single) sales row for that day, never multiplying the sales side.
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 1', 'CMP-M1', 'AG1', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 10, 5, 'ads_api_auto', 'DK-M1', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 2', 'CMP-M2', 'AG2', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 20, 5, 'ads_api_auto', 'DK-M2', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 3', 'CMP-M3', 'AG3', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 30, 5, 'ads_api_auto', 'DK-M3', '{}'),
  -- M2 isolation fixture
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P2', '2026-07-16', 'Campaign M2', 'CMP-M2ONLY', 'AG1', 'SKU-M2-ONLY', 'ASINM2001', 40, 20, 'ads_api_auto', 'DK-M2ONLY', '{}');

INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-CAMPAIGN-MULTI', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 1000, 8);

-- ---------------- Coverage-state model fixtures ----------------
-- SKU-COVERAGE-TEST: no catalog/ads presence, sales rows/refresh-runs
-- crafted to exercise every branch of the five-state model in one
-- get_sku_performance_daily call over 2026-06-05..2026-07-10.
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  -- Date E = 2026-07-10: REPORTED_VALUE (a real row, even with zero refresh-run evidence covering it)
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-10', 'SKU-COVERAGE-TEST', 'SKU-COVERAGE-TEST', NULL, 777, 7);

INSERT INTO public.internal_data_refresh_runs
  (workspace_id, marketplace_id, source, status, date_from, date_to, rows_rejected, started_at) VALUES
  -- covers Date B (2026-06-15) and Date F (2026-06-16): accepted successful run
  ('a0000000-0000-0000-0000-000000000001', 'M1', 'business_report_sp_api', 'success', '2026-06-11', '2026-06-20', 0, '2026-06-21T00:00:00Z'),
  -- a LATER failed retry over the SAME range as the successful run above -- must NOT erase Date F's CONFIRMED_ZERO
  ('a0000000-0000-0000-0000-000000000001', 'M1', 'business_report_sp_api', 'failed', '2026-06-11', '2026-06-20', 0, '2026-06-25T00:00:00Z'),
  -- covers Date C (2026-06-25): failed-only, no successful run covers this date -> SOURCE_NOT_COMPLETE
  ('a0000000-0000-0000-0000-000000000001', 'M1', 'business_report_sp_api', 'failed', '2026-06-21', '2026-06-30', 0, '2026-07-01T00:00:00Z');
  -- Date D (2026-07-05) intentionally has NO covering run at all -> UNKNOWN
  -- Date A (2026-06-05) predates 2026-06-10, the earliest sales row in scope -> BEFORE_HISTORY

-- Ads-side coverage fixtures, same shape, different SKU, mirrors the manual-CSV
-- scenario: a date with a real row and NO refresh run at all covering the
-- whole manual-backfill-like window (structurally identical to how the real
-- manual-CSV import route never writes internal_data_refresh_runs).
INSERT INTO public.internal_ads_advertised_product_daily_rows
  (workspace_id, upload_batch_id, profile_id, report_date, campaign_name, campaign_id, ad_group_name, advertised_sku, advertised_asin, spend, sales, source, dedupe_key, raw_row) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-06-05', 'Campaign Manual', 'CMP-MANUAL', 'AG1', 'SKU-ADS-COVERAGE-TEST', 'ASINCOV001', 15, 5, 'manual_csv_upload', 'DK-MANUAL', '{}');
  -- 2026-06-06 (same manual-backfill window): NO row, NO refresh run at all
  -- covering it -> UNKNOWN (never CONFIRMED_ZERO), exactly the manual-CSV rule.

COMMIT;

-- ================================================================
-- TEST 1: canonical union -- sales-only SKU stays visible, "Unknown product"
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 1 SEED FAILED: %', v_result; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-SALES-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU did not appear in the union'; END IF;
  IF v_row->>'productTitle' IS NOT NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU unexpectedly has a catalog title: %', v_row; END IF;
  IF (v_row->'selectedRange'->>'sales')::numeric <> 550 THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU range sales wrong, got %', v_row; END IF;
  IF v_row->>'mappingState' <> 'not_applicable' THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU (no ad spend ever) should be not_applicable, got %', v_row->>'mappingState'; END IF;
END $$;

-- ================================================================
-- TEST 2: canonical union -- Ads-only SKU stays visible, unmapped
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-ADS-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU did not appear in the union'; END IF;
  IF v_row->>'mappingState' <> 'unmapped' THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU should be unmapped, got %', v_row->>'mappingState'; END IF;
  IF (v_row->'selectedRange'->>'spend')::numeric <> 300 THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU spend wrong, got %', v_row; END IF;
END $$;

-- ================================================================
-- TEST 3: canonical union -- catalog-only SKU stays visible (zero activity)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CATALOG-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU did not appear in the union'; END IF;
  IF v_row->>'productTitle' <> 'Catalog Only Item' THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog metadata missing for catalog-only SKU: %', v_row; END IF;
  IF (v_row->'selectedRange'->>'sales')::numeric <> 0 THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU should have zero sales, got %', v_row; END IF;
  IF v_row->>'salesTrend' <> 'no_activity' THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU should be no_activity, got %', v_row->>'salesTrend'; END IF;
END $$;

-- ================================================================
-- TEST 4: mapped vs identity_conflict (ASIN mismatch)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  IF v_row->>'mappingState' <> 'mapped' THEN RAISE EXCEPTION 'TEST 4a FAILED: SKU-MAPPED should be mapped, got %', v_row->>'mappingState'; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CONFLICT-ASIN';
  IF v_row->>'mappingState' <> 'identity_conflict' THEN RAISE EXCEPTION 'TEST 4b FAILED: SKU-CONFLICT-ASIN should be identity_conflict, got %', v_row->>'mappingState'; END IF;
END $$;

-- ================================================================
-- TEST 5: aggregation-before-join -- 3 campaign rows for one SKU/day never
-- multiply against the single sales row for that day.
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CAMPAIGN-MULTI';
  IF (v_row->'selectedRange'->>'spend')::numeric <> 60 THEN RAISE EXCEPTION 'TEST 5 FAILED: expected spend 10+20+30=60, got %', v_row; END IF;
  IF (v_row->'selectedRange'->>'attributedSales')::numeric <> 15 THEN RAISE EXCEPTION 'TEST 5 FAILED: expected attributed sales 5+5+5=15, got %', v_row; END IF;
  IF (v_row->'selectedRange'->>'sales')::numeric <> 1000 THEN RAISE EXCEPTION 'TEST 5 FAILED: sales must stay the single reported 1000, not multiplied by 3 campaign rows, got %', v_row; END IF;
END $$;

-- ================================================================
-- TEST 6: displayed raw-SKU precedence (catalog > sales > ads > cost master)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  -- SKU-MAPPED exists in catalog, sales, AND ads with an identical raw string
  -- in this fixture set (no case/whitespace divergence), so this asserts the
  -- catalog value wins as displayed_sku, matching precedence position 1.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 6 FAILED: SKU-MAPPED missing entirely'; END IF;
END $$;

-- ================================================================
-- TEST 7: base sales/spend trend states (new_activity, declining, spike, tacos deterioration, no-attributed-sales)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-GROWING';
  IF v_row->>'salesTrend' <> 'new_activity' THEN RAISE EXCEPTION 'TEST 7a FAILED: expected new_activity, got %', v_row->>'salesTrend'; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-DECLINING';
  IF v_row->>'salesTrend' <> 'declining' THEN RAISE EXCEPTION 'TEST 7b FAILED: expected declining, got %', v_row->>'salesTrend'; END IF;
  IF (v_row->'flags'->>'salesDrop')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 7b FAILED: salesDrop flag not set: %', v_row; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-SPEND-SPIKE';
  IF v_row->>'spendTrend' <> 'growing' THEN RAISE EXCEPTION 'TEST 7c FAILED: expected growing spend trend, got %', v_row->>'spendTrend'; END IF;
  IF (v_row->'flags'->>'spendSpike')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 7c FAILED: spendSpike flag not set: %', v_row; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-NO-ATTR-SALES';
  IF (v_row->'flags'->>'noAttributedSales')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 7d FAILED: noAttributedSales flag not set: %', v_row; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-TACOS-DETERIORATE';
  IF (v_row->'flags'->>'tacosDeterioration')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 7e FAILED: tacosDeterioration flag not set: %', v_row; END IF;
END $$;

-- ================================================================
-- TEST 8: ACOS/TACOS zero-denominator truth table
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );

  -- SKU-CATALOG-ONLY: spend=0, attributedSales=0 -> not_applicable ACOS/TACOS
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CATALOG-ONLY';
  IF v_row->'selectedRange'->'acos'->>'state' <> 'not_applicable' THEN RAISE EXCEPTION 'TEST 8a FAILED: expected not_applicable ACOS, got %', v_row->'selectedRange'->'acos'; END IF;
  IF v_row->'selectedRange'->'tacos'->>'state' <> 'not_applicable' THEN RAISE EXCEPTION 'TEST 8a FAILED: expected not_applicable TACOS, got %', v_row->'selectedRange'->'tacos'; END IF;

  -- SKU-NO-ATTR-SALES: spend>0, attributedSales=0 -> undefined ACOS
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-NO-ATTR-SALES';
  IF v_row->'selectedRange'->'acos'->>'state' <> 'undefined' THEN RAISE EXCEPTION 'TEST 8b FAILED: expected undefined ACOS, got %', v_row->'selectedRange'->'acos'; END IF;

  -- SKU-ADS-ONLY: spend>0, no sales row at all (ordered sales = 0) -> undefined_high_risk TACOS
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-ADS-ONLY';
  IF v_row->'selectedRange'->'tacos'->>'state' <> 'undefined_high_risk' THEN RAISE EXCEPTION 'TEST 8c FAILED: expected undefined_high_risk TACOS, got %', v_row->'selectedRange'->'tacos'; END IF;

  -- SKU-MAPPED: spend>0 and attributedSales>0 in range -> normal ratio
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  IF v_row->'selectedRange'->'acos'->>'state' <> 'normal' THEN RAISE EXCEPTION 'TEST 8d FAILED: expected normal ACOS, got %', v_row->'selectedRange'->'acos'; END IF;
END $$;

-- ================================================================
-- TEST 9: pagination vs. summary-count separation
-- ================================================================
DO $$
DECLARE v_result jsonb; v_page1 jsonb; v_page2 jsonb;
BEGIN
  v_page1 := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    1, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF jsonb_array_length(v_page1->'rows') <> 1 THEN RAISE EXCEPTION 'TEST 9a FAILED: expected exactly 1 returned row, got %', v_page1->'pagination'; END IF;
  IF (v_page1->'pagination'->>'returnedSkuCount')::int <> 1 THEN RAISE EXCEPTION 'TEST 9a FAILED: returnedSkuCount wrong: %', v_page1->'pagination'; END IF;
  IF (v_page1->'pagination'->>'totalMatchingSkuCountAfterFilters')::int <= 1 THEN RAISE EXCEPTION 'TEST 9a FAILED: totalMatchingSkuCountAfterFilters should exceed the page size, got %', v_page1->'pagination'; END IF;
  IF (v_page1->'pagination'->>'hasMore')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 9a FAILED: hasMore should be true with more rows beyond the page, got %', v_page1->'pagination'; END IF;

  v_page2 := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  -- Summary totals must be IDENTICAL between a 1-row page and the full page --
  -- proving they are full-filtered-scope aggregates, never derived from the page.
  IF (v_page1->'summary'->>'totalOrderedSales') IS DISTINCT FROM (v_page2->'summary'->>'totalOrderedSales') THEN
    RAISE EXCEPTION 'TEST 9b FAILED: summary totals differ by page size -- page1=%, page2=%', v_page1->'summary', v_page2->'summary';
  END IF;
  IF (v_page1->'summary'->>'skusGrowing') IS DISTINCT FROM (v_page2->'summary'->>'skusGrowing') THEN
    RAISE EXCEPTION 'TEST 9c FAILED: skusGrowing differs by page size -- page1=%, page2=%', v_page1->'summary', v_page2->'summary';
  END IF;
  IF (v_page1->'pagination'->>'totalSkuCountBeforeFilters') IS DISTINCT FROM (v_page2->'pagination'->>'totalSkuCountBeforeFilters') THEN
    RAISE EXCEPTION 'TEST 9d FAILED: totalSkuCountBeforeFilters differs by page size';
  END IF;
END $$;

-- ================================================================
-- TEST 10: filters applied before pagination (growing-only narrows the set)
-- ================================================================
DO $$
DECLARE v_all jsonb; v_growing jsonb;
BEGIN
  v_all := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  v_growing := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, true, false, false, false, false, false, false, 'sku_asc'
  );
  IF (v_growing->'pagination'->>'totalMatchingSkuCountAfterFilters')::int >= (v_all->'pagination'->>'totalMatchingSkuCountAfterFilters')::int THEN
    RAISE EXCEPTION 'TEST 10 FAILED: growing-only filter did not narrow the set -- all=%, growing=%', v_all->'pagination', v_growing->'pagination';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_growing->'rows') r WHERE r->>'salesTrend' NOT IN ('growing', 'new_activity')) THEN
    RAISE EXCEPTION 'TEST 10 FAILED: growing-only filter returned a non-growing row';
  END IF;
END $$;

-- ================================================================
-- TEST 11: deterministic sort (sales_desc, with a stable tie-break)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_skus text[];
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20',
    500, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sales_desc'
  );
  SELECT array_agg(r->>'sku' ORDER BY ord) INTO v_skus
  FROM jsonb_array_elements(v_result->'rows') WITH ORDINALITY AS t(r, ord);
  IF v_skus IS DISTINCT FROM ARRAY['SKU-SORT-A', 'SKU-SORT-B', 'SKU-SORT-C'] THEN
    RAISE EXCEPTION 'TEST 11 FAILED: expected [SKU-SORT-A, SKU-SORT-B, SKU-SORT-C] (300, 200, 100), got %', v_skus;
  END IF;
END $$;

-- ================================================================
-- TEST 12: currency_mismatch rejection
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'CURRENCYMKT', '2026-07-01', '2026-07-20', '2026-07-20',
    100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF v_result->>'result' <> 'currency_mismatch' THEN RAISE EXCEPTION 'TEST 12 FAILED: expected currency_mismatch, got %', v_result; END IF;
END $$;

-- ================================================================
-- TEST 13: cross-workspace isolation
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-WSB-ONLY') THEN
    RAISE EXCEPTION 'TEST 13 FAILED: workspace B''s SKU leaked into workspace A''s result';
  END IF;
END $$;

-- ================================================================
-- TEST 14: cross-marketplace isolation
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-M2-ONLY') THEN
    RAISE EXCEPTION 'TEST 14 FAILED: marketplace M2''s SKU leaked into the M1 result';
  END IF;
END $$;

-- ================================================================
-- TEST 15: requested/effective range and clamp response
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  -- sales_earliest = 2026-06-10, ads_earliest = 2026-06-01 for WS_A/M1 -> min = 2026-06-01
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-05-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF (v_result->'dateRange'->>'wasRangeClamped')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 15a FAILED: expected wasRangeClamped=true, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'effectiveDateFrom' <> '2026-06-01' THEN RAISE EXCEPTION 'TEST 15a FAILED: expected effectiveDateFrom=2026-06-01, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'clampReason' IS NULL THEN RAISE EXCEPTION 'TEST 15a FAILED: clampReason must be populated when clamped'; END IF;

  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF (v_result->'dateRange'->>'wasRangeClamped')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'TEST 15b FAILED: expected wasRangeClamped=false, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'clampReason' IS NOT NULL THEN RAISE EXCEPTION 'TEST 15b FAILED: clampReason must be null when not clamped, got %', v_result->'dateRange'; END IF;
END $$;

-- ================================================================
-- TEST 16: hard parameter ceilings on get_sku_performance_summary
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 501, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_limit' THEN RAISE EXCEPTION 'TEST 16a FAILED: p_limit=501 not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, -1, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_offset' THEN RAISE EXCEPTION 'TEST 16b FAILED: p_offset=-1 not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-20', '2026-07-01', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'date_from_after_date_to' THEN RAISE EXCEPTION 'TEST 16c FAILED: date_from>date_to not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2099-01-01', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'date_to_in_future' THEN RAISE EXCEPTION 'TEST 16d FAILED: far-future date_to not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'not_a_real_sort');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'unsupported_sort' THEN RAISE EXCEPTION 'TEST 16e FAILED: unsupported sort not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, repeat('x', 201), NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'sku_filter_too_long' THEN RAISE EXCEPTION 'TEST 16f FAILED: oversized sku filter not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary(NULL, 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'missing_workspace_id' THEN RAISE EXCEPTION 'TEST 16g FAILED: NULL workspace_id not rejected, got %', v_result; END IF;
END $$;

-- ================================================================
-- TEST 17: get_sku_performance_daily -- coverage-state model, all five states
-- ================================================================
DO $$
DECLARE v_result jsonb;
  v_a jsonb; v_b jsonb; v_c jsonb; v_d jsonb; v_e jsonb; v_f jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-COVERAGE-TEST', '2026-06-05', '2026-07-10');
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 17 SEED FAILED: %', v_result; END IF;

  SELECT d INTO v_a FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-05';
  IF v_a->'sales'->>'coverageState' <> 'BEFORE_HISTORY' THEN RAISE EXCEPTION 'TEST 17a FAILED: expected BEFORE_HISTORY, got %', v_a; END IF;
  IF v_a->'sales'->>'value' IS NOT NULL THEN RAISE EXCEPTION 'TEST 17a FAILED: BEFORE_HISTORY must not have a value, got %', v_a; END IF;

  SELECT d INTO v_b FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-15';
  IF v_b->'sales'->>'coverageState' <> 'CONFIRMED_ZERO' THEN RAISE EXCEPTION 'TEST 17b FAILED: expected CONFIRMED_ZERO, got %', v_b; END IF;
  IF (v_b->'sales'->>'value')::numeric <> 0 THEN RAISE EXCEPTION 'TEST 17b FAILED: CONFIRMED_ZERO must render as 0, got %', v_b; END IF;

  SELECT d INTO v_c FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-25';
  IF v_c->'sales'->>'coverageState' <> 'SOURCE_NOT_COMPLETE' THEN RAISE EXCEPTION 'TEST 17c FAILED: expected SOURCE_NOT_COMPLETE, got %', v_c; END IF;

  SELECT d INTO v_d FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-07-05';
  IF v_d->'sales'->>'coverageState' <> 'UNKNOWN' THEN RAISE EXCEPTION 'TEST 17d FAILED: expected UNKNOWN, got %', v_d; END IF;

  SELECT d INTO v_e FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-07-10';
  IF v_e->'sales'->>'coverageState' <> 'REPORTED_VALUE' THEN RAISE EXCEPTION 'TEST 17e FAILED: expected REPORTED_VALUE, got %', v_e; END IF;
  IF (v_e->'sales'->>'value')::numeric <> 777 THEN RAISE EXCEPTION 'TEST 17e FAILED: expected value 777, got %', v_e; END IF;

  -- Date F: a successful run followed by a LATER failed retry over the same
  -- range must still resolve to CONFIRMED_ZERO -- a later failure never
  -- erases earlier successful coverage.
  SELECT d INTO v_f FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-16';
  IF v_f->'sales'->>'coverageState' <> 'CONFIRMED_ZERO' THEN RAISE EXCEPTION 'TEST 17f FAILED: a later failed retry erased earlier successful coverage, got %', v_f; END IF;
END $$;

-- ================================================================
-- TEST 18: manual-CSV-shaped gap -- a real row on one date and an absent
-- row on an adjacent date with NO refresh-run row at all covering either ->
-- REPORTED_VALUE / UNKNOWN, never CONFIRMED_ZERO (mirrors the real manual
-- CSV import route, which never writes internal_data_refresh_runs).
-- ================================================================
DO $$
DECLARE v_result jsonb; v_present jsonb; v_absent jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-ADS-COVERAGE-TEST', '2026-06-05', '2026-06-06');
  SELECT d INTO v_present FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-05';
  IF v_present->'spend'->>'coverageState' <> 'REPORTED_VALUE' THEN RAISE EXCEPTION 'TEST 18a FAILED: expected REPORTED_VALUE for the manual-CSV row, got %', v_present; END IF;

  SELECT d INTO v_absent FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-06';
  IF v_absent->'spend'->>'coverageState' <> 'UNKNOWN' THEN RAISE EXCEPTION 'TEST 18b FAILED: manual-CSV gap day should be UNKNOWN (no refresh-run row exists), got %', v_absent; END IF;
END $$;

-- ================================================================
-- TEST 19: get_sku_performance_daily hard range ceiling and parameter validation
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-MAPPED', '2026-01-01', '2027-06-01');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'range_too_large' THEN RAISE EXCEPTION 'TEST 19a FAILED: >400-day range not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', '', '2026-07-01', '2026-07-10');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_sku' THEN RAISE EXCEPTION 'TEST 19b FAILED: empty sku not rejected, got %', v_result; END IF;
END $$;

-- ================================================================
-- Summary
-- ================================================================
SELECT 'SKU Performance P1-B sequential suite: all tests passed' AS result;
