-- SKU Performance P1-B -- committed, repeatable sequential test suite.
--
-- Amended 2026-07-23 -- P1-B correction round: extended for Fix 1-6 and the
-- narrow contract cleanup items (BRAHMASTRA_MASTER_TRACKER.md sec23 update
-- 7). Every test in this round was written to FAIL against the pre-
-- correction migration and PASS against the corrected one -- several
-- (TEST 11 in particular) replace a prior version that could not actually
-- have caught its own bug (see TEST 11's comment).
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

-- Ads profiles: P1 = WS_A/M1 (the main test scope, timezone set for Fix 5's
-- marketplace-local-today check), P2 = WS_A/M2 (marketplace isolation),
-- P3/P4 = WS_A/CURRENCYMKT with two DIFFERENT currencies (currency_mismatch
-- test only, kept off M1 so it never contaminates the M1 fixtures), P5 =
-- WS_A/M3 (isolated home for the deliberately-incomplete coverage-state-
-- model fixtures, kept off M1 so they never collide with M1's broad
-- "healthy account" coverage).
INSERT INTO public.amazon_ads_profiles (id, workspace_id, amazon_ads_connection_id, profile_id, marketplace_id, currency_code, timezone) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P1', 'M1', 'INR', 'Asia/Kolkata'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P2', 'M2', 'INR', NULL),
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P3', 'CURRENCYMKT', 'INR', NULL),
  ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P4', 'CURRENCYMKT', 'USD', NULL),
  ('e0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'P5', 'M3', 'INR', NULL);

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
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-APPLE', 'ASINSORTAP', 'M1', 'Sort Apple', 'BrandZ', 'http://img/10.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-MANGO', 'ASINSORTMG', 'M1', 'Sort Mango', 'BrandZ', 'http://img/11.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-ZEBRA', 'ASINSORTZB', 'M1', 'Sort Zebra', 'BrandZ', 'http://img/12.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-SORT-BANANA', 'ASINSORTBN', 'M1', 'Sort Banana', 'BrandZ', 'http://img/13.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'SKU-M2-ONLY', 'ASINM2001', 'M2', 'M2 Only Item', 'BrandX', 'http://img/14.png', '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'SKU-WSB-ONLY', 'ASINWSB001', 'M1', 'WS-B Only Item', 'BrandX', 'http://img/15.png', '2026-07-15T00:00:00Z'),
  -- Fix 4 same-source collision: two DISTINCT catalog raw strings ('Dup-1'
  -- and 'DUP-1') that canonicalize to the SAME key (upper('Dup-1') =
  -- upper('DUP-1') = 'DUP-1'). Both rows are individually legal (the
  -- UNIQUE(workspace_id, sku, marketplace_id) constraint does not block
  -- them since the raw sku text genuinely differs); they intentionally use
  -- DIFFERENT ASINs, as amazon_listing_items has a UNIQUE(workspace_id,
  -- asin, marketplace_id) constraint (an ASIN can only appear once per
  -- workspace+marketplace), so they cannot share one. catalog_grouped
  -- picks ONE of the two raw skus' ASIN via array_agg(... ORDER BY
  -- raw_sku)[1], and which one sorts first is locale-collation-dependent
  -- -- to keep this fixture a raw_sku_collision case ONLY (deterministic
  -- regardless of that ordering), the Ads row below uses a NULL
  -- advertised_asin, which the mismatch check always ignores (`x IS NOT
  -- NULL` in its EXISTS clause), so no advertised_asin_catalog_asin_
  -- mismatch reason can ever appear here.
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Dup-1', 'ASINDUP001', 'M1', 'Dup Item A', 'BrandX', NULL, '2026-07-15T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'DUP-1', 'ASINDUP002', 'M1', 'Dup Item B', 'BrandX', NULL, '2026-07-15T00:00:00Z');

-- ---------------- Cost master ----------------
-- Fix narrow-cleanup #1: SKU-COSTMASTER-ONLY exists ONLY here (no catalog/
-- sales/ads row anywhere in ANY marketplace) -- proves it never leaks into
-- the M1 (or any) universe on its own.
INSERT INTO public.internal_sku_cost_master (workspace_id, sku, sku_norm, category) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'SKU-MAPPED', 'SKU-MAPPED', 'Widgets'),
  ('a0000000-0000-0000-0000-000000000001', 'SKU-COSTMASTER-ONLY', 'SKU-COSTMASTER-ONLY', 'Orphaned');

-- ---------------- Business Report sales (sales_earliest for WS_A/M1 = 2026-06-10) ----------------
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  -- history anchor: earliest sales row in WS_A/M1 scope
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-06-10', 'SKU-MAPPED', 'SKU-MAPPED', 'ASINMAP001', 100, 2),
  -- SKU-SALES-ONLY: present in sales, absent everywhere else
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
  -- Sort fixtures for 2026-07-16 (inside the well-covered July window):
  --   sales:  APPLE=300, ZEBRA=200, MANGO=100  -> sales_desc  = APPLE, ZEBRA, MANGO
  --   spend:  MANGO=300, ZEBRA=200, APPLE=100  -> spend_desc  = MANGO, ZEBRA, APPLE
  -- Alphabetical order (APPLE, BANANA, MANGO, ZEBRA) matches NEITHER --
  -- a regression to canonical_sku-only ordering would produce a visibly
  -- different, wrong sequence for both sort keys.
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-APPLE', 'SKU-SORT-APPLE', 'ASINSORTAP', 300, 1),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-ZEBRA', 'SKU-SORT-ZEBRA', 'ASINSORTZB', 200, 1),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-MANGO', 'SKU-SORT-MANGO', 'ASINSORTMG', 100, 1),
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-SORT-BANANA', 'SKU-SORT-BANANA', 'ASINSORTBN', 50, 1),
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
  -- SKU-CAMPAIGN-MULTI: THREE separate campaign rows, SAME SKU, SAME day
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 1', 'CMP-M1', 'AG1', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 10, 5, 'ads_api_auto', 'DK-M1', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 2', 'CMP-M2', 'AG2', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 20, 5, 'ads_api_auto', 'DK-M2', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Multi 3', 'CMP-M3', 'AG3', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 30, 5, 'ads_api_auto', 'DK-M3', '{}'),
  -- Sort fixtures (spend side): MANGO=300, ZEBRA=200, APPLE=100
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Sort Mango', 'CMP-SM', 'AG1', 'SKU-SORT-MANGO', 'ASINSORTMG', 300, 50, 'ads_api_auto', 'DK-SM', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Sort Zebra', 'CMP-SZ', 'AG1', 'SKU-SORT-ZEBRA', 'ASINSORTZB', 200, 50, 'ads_api_auto', 'DK-SZ', '{}'),
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Sort Apple', 'CMP-SA', 'AG1', 'SKU-SORT-APPLE', 'ASINSORTAP', 100, 50, 'ads_api_auto', 'DK-SA', '{}'),
  -- SKU-SORT-BANANA: unmapped-flag SKU (advertised, no catalog match --
  -- wait, it DOES have a catalog row above; use it purely for a
  -- mapping-incomplete-driven attention_desc test instead by attaching a
  -- conflicting ASIN so it becomes identity_conflict and carries the
  -- highest attention severity despite the lowest sales.
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Sort Banana', 'CMP-SB', 'AG1', 'SKU-SORT-BANANA', 'ASINSORTBN-DIFFERENT', 20, 10, 'ads_api_auto', 'DK-SB', '{}'),
  -- M2 isolation fixture
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P2', '2026-07-16', 'Campaign M2', 'CMP-M2ONLY', 'AG1', 'SKU-M2-ONLY', 'ASINM2001', 40, 20, 'ads_api_auto', 'DK-M2ONLY', '{}'),
  -- Fix 4 cross-source collision: catalog canonical is DUP-1 (from 'Dup-1'/'DUP-1'
  -- above); this Ads row uses a THIRD raw string 'dup-1' (also canonicalizes
  -- to DUP-1), proving the check spans sources, not just within one.
  -- advertised_asin is deliberately NULL (see the catalog fixture's comment
  -- above) so this stays a raw_sku_collision-only case regardless of which
  -- catalog row's ASIN collation happens to pick as "the" catalog ASIN.
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P1', '2026-07-16', 'Campaign Dup', 'CMP-DUP', 'AG1', 'dup-1', NULL, 15, 5, 'ads_api_auto', 'DK-DUP', '{}');

INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', 'SKU-CAMPAIGN-MULTI', 'SKU-CAMPAIGN-MULTI', 'ASINMULTI01', 1000, 8);

-- ---------------- Broad "healthy account" refresh-run coverage for M1 ----------------
-- Everything on M1 dated 2026-05-01..2026-07-20 relies on this: an accepted
-- successful run for BOTH sources covering the entire window (extended back
-- to 2026-05-01, not just July, so TEST 15's mixed-period-TACOS regression
-- -- which deliberately requests a range starting before either source's
-- history -- sees complete coverage across its whole requested range, not
-- just the before-history days that are exempt regardless). A SKU with no
-- row on some day within it is therefore a real, confirmed zero (not
-- unknown/source_not_complete) -- exactly what a routinely-syncing account
-- looks like. The deliberately-incomplete coverage-state-model fixtures
-- live on marketplace M3 instead (see below) so they never collide with
-- this broad M1 coverage.
INSERT INTO public.internal_data_refresh_runs
  (workspace_id, marketplace_id, profile_id, source, status, date_from, date_to, rows_rejected, started_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'M1', NULL, 'business_report_sp_api', 'success', '2026-05-01', '2026-07-20', 0, '2026-07-21T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'M1', 'P1', 'ads_advertised_product', 'success', '2026-05-01', '2026-07-20', 0, '2026-07-21T00:00:00Z');

-- ---------------- Coverage-state model fixtures (marketplace M3, fully isolated) ----------------
-- SKU-COVERAGE-TEST: no catalog/ads presence, sales rows/refresh-runs
-- crafted to exercise every branch of the five-state model in one
-- get_sku_performance_daily call over 2026-06-05..2026-07-10. Lives on its
-- own marketplace (M3, with its own ads profile P5) precisely so these
-- deliberate coverage GAPS never collide with M1's broad "healthy account"
-- coverage above -- the two fixture sets test opposite scenarios in the
-- same June/July calendar window and cannot share a marketplace scope.
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  -- History anchor for the M3 SCOPE (sales_earliest is computed per
  -- marketplace, not per SKU) -- establishes M3's sales history_start at
  -- 2026-06-10, matching the anchor M1 used to have via SKU-MAPPED before
  -- this fixture set moved marketplaces, so Date A below is still BEFORE
  -- this history and Dates B/C/D still fall on/after it.
  ('a0000000-0000-0000-0000-000000000001', 'M3', '2026-06-10', 'SKU-M3-HISTORY-ANCHOR', 'SKU-M3-HISTORY-ANCHOR', NULL, 1, 1),
  -- Date E = 2026-07-10: REPORTED_VALUE (a real row, even with zero refresh-run evidence covering it)
  ('a0000000-0000-0000-0000-000000000001', 'M3', '2026-07-10', 'SKU-COVERAGE-TEST', 'SKU-COVERAGE-TEST', NULL, 777, 7);

INSERT INTO public.internal_data_refresh_runs
  (workspace_id, marketplace_id, source, status, date_from, date_to, rows_rejected, started_at) VALUES
  -- covers Date B (2026-06-15) and Date F (2026-06-16): accepted successful run
  ('a0000000-0000-0000-0000-000000000001', 'M3', 'business_report_sp_api', 'success', '2026-06-11', '2026-06-20', 0, '2026-06-21T00:00:00Z'),
  -- a LATER failed retry over the SAME range as the successful run above -- must NOT erase Date F's CONFIRMED_ZERO
  ('a0000000-0000-0000-0000-000000000001', 'M3', 'business_report_sp_api', 'failed', '2026-06-11', '2026-06-20', 0, '2026-06-25T00:00:00Z'),
  -- covers Date C (2026-06-25): failed-only, no successful run covers this date -> SOURCE_NOT_COMPLETE
  ('a0000000-0000-0000-0000-000000000001', 'M3', 'business_report_sp_api', 'failed', '2026-06-21', '2026-06-30', 0, '2026-07-01T00:00:00Z');
  -- Date D (2026-07-05) intentionally has NO covering run at all -> UNKNOWN
  -- Date A (2026-06-05) predates 2026-06-10, the earliest sales row in scope -> BEFORE_HISTORY

-- Ads-side coverage fixtures, same shape, different SKU, mirrors the manual-CSV
-- scenario: a date with a real row and NO refresh run at all covering the
-- whole manual-backfill-like window. Uses ads profile P5 (workspace WS_A,
-- marketplace M3) so it resolves under p_marketplace_id='M3'.
INSERT INTO public.internal_ads_advertised_product_daily_rows
  (workspace_id, upload_batch_id, profile_id, report_date, campaign_name, campaign_id, ad_group_name, advertised_sku, advertised_asin, spend, sales, source, dedupe_key, raw_row) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'P5', '2026-06-05', 'Campaign Manual', 'CMP-MANUAL', 'AG1', 'SKU-ADS-COVERAGE-TEST', 'ASINCOV001', 15, 5, 'manual_csv_upload', 'DK-MANUAL', '{}');
  -- 2026-06-06 (same manual-backfill window): NO row, NO refresh run at all
  -- covering it -> UNKNOWN (never CONFIRMED_ZERO), exactly the manual-CSV rule.

-- ---------------- Fix 3: partial_success / current-complete-prior-unknown fixtures ----------------
-- SKU-TREND-GAP-TEST: lives on its own marketplace M4, entirely in January
-- 2026 -- deliberately far in the past (not anchored near "today", unlike
-- the rest of this suite's July 2026 dates) so this scenario never runs
-- into the marketplace-local future-date check (Fix 5) regardless of what
-- real calendar date this suite executes on. Its own earliest row
-- (2025-01-01) anchors M4's sales history well before the window under
-- test, so BEFORE_HISTORY never masks the states being exercised here.
-- t7 window (2026-01-09..2026-01-15) has ONLY a partial_success run
-- covering it (no accepted success) -> source_not_complete. prior7 window
-- (2026-01-02..2026-01-08) has NO covering run at all -> unknown. The SKU
-- itself has no real rows in either window, so neither source-level
-- problem date gets individually rescued.
INSERT INTO public.internal_business_report_sku_sales_traffic
  (workspace_id, marketplace_id, report_date, sku, sku_norm, child_asin, ordered_product_sales, units_ordered) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'M4', '2025-01-01', 'SKU-TREND-GAP-TEST', 'SKU-TREND-GAP-TEST', NULL, 1, 1);

INSERT INTO public.internal_data_refresh_runs
  (workspace_id, marketplace_id, source, status, date_from, date_to, rows_rejected, started_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'M4', 'business_report_sp_api', 'partial_success', '2026-01-09', '2026-01-15', 3, '2026-01-16T00:00:00Z');

COMMIT;

-- ================================================================
-- TEST 1: canonical union -- sales-only SKU stays visible, "Unknown product"
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 1 SEED FAILED: %', v_result; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-SALES-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU did not appear in the union'; END IF;
  IF v_row->>'productTitle' IS NOT NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU unexpectedly has a catalog title: %', v_row; END IF;
  IF (v_row->'selectedRange'->>'sales')::numeric <> 550 THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU range sales wrong, got %', v_row; END IF;
  IF v_row->>'mappingState' <> 'not_applicable' THEN RAISE EXCEPTION 'TEST 1 FAILED: sales-only SKU (no ad spend ever) should be not_applicable, got %', v_row->>'mappingState'; END IF;
  IF (v_row->'flags'->>'mappingIncomplete')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST 1 FAILED (narrow cleanup #2): not_applicable must NOT set mappingIncomplete, got %', v_row->'flags';
  END IF;
END $$;

-- ================================================================
-- TEST 2: canonical union -- Ads-only SKU stays visible, unmapped
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-ADS-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU did not appear in the union'; END IF;
  IF v_row->>'mappingState' <> 'unmapped' THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU should be unmapped, got %', v_row->>'mappingState'; END IF;
  IF (v_row->'selectedRange'->>'spend')::numeric <> 300 THEN RAISE EXCEPTION 'TEST 2 FAILED: ads-only SKU spend wrong, got %', v_row; END IF;
  IF (v_row->'flags'->>'mappingIncomplete')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST 2 FAILED (narrow cleanup #2): unmapped MUST set mappingIncomplete, got %', v_row->'flags';
  END IF;
END $$;

-- ================================================================
-- TEST 3: canonical union -- catalog-only SKU stays visible (zero activity,
-- with broad July coverage giving a real, confirmed no_activity/no_spend)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CATALOG-ONLY';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU did not appear in the union'; END IF;
  IF v_row->>'productTitle' <> 'Catalog Only Item' THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog metadata missing for catalog-only SKU: %', v_row; END IF;
  IF (v_row->'selectedRange'->>'sales')::numeric <> 0 THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU should have zero sales, got %', v_row; END IF;
  IF v_row->>'salesTrend' <> 'no_activity' THEN RAISE EXCEPTION 'TEST 3 FAILED: catalog-only SKU should be no_activity (broad July coverage confirms the zero), got %', v_row->>'salesTrend'; END IF;
  IF v_row->'selectedRange'->>'salesCoverageState' <> 'complete' THEN RAISE EXCEPTION 'TEST 3 FAILED: expected complete sales coverage, got %', v_row->'selectedRange'; END IF;
END $$;

-- ================================================================
-- TEST 4: mapped vs identity_conflict (ASIN mismatch) -- and Fix 4's
-- suppressed-metrics contract for identity_conflict rows.
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  IF v_row->>'mappingState' <> 'mapped' THEN RAISE EXCEPTION 'TEST 4a FAILED: SKU-MAPPED should be mapped, got %', v_row->>'mappingState'; END IF;

  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-CONFLICT-ASIN';
  IF v_row->>'mappingState' <> 'identity_conflict' THEN RAISE EXCEPTION 'TEST 4b FAILED: SKU-CONFLICT-ASIN should be identity_conflict, got %', v_row->>'mappingState'; END IF;
  IF v_row->>'selectedRange' IS NOT NULL THEN RAISE EXCEPTION 'TEST 4b FAILED (Fix 4): identity_conflict row must suppress selectedRange, got %', v_row->'selectedRange'; END IF;
  IF v_row->>'salesTrend' IS NOT NULL THEN RAISE EXCEPTION 'TEST 4b FAILED (Fix 4): identity_conflict row must suppress salesTrend, got %', v_row->>'salesTrend'; END IF;
  IF (v_row->'flags'->>'spendSpike')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'TEST 4b FAILED (Fix 4): identity_conflict row must not raise non-mapping flags, got %', v_row->'flags'; END IF;
  IF (v_row->'flags'->>'mappingIncomplete')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 4b FAILED: identity_conflict must still set mappingIncomplete, got %', v_row->'flags'; END IF;
  IF v_row->'identityConflictEvidence' IS NULL THEN RAISE EXCEPTION 'TEST 4b FAILED (Fix 4): identity_conflict row must carry identityConflictEvidence'; END IF;
  -- Follow-up correction: SKU-CONFLICT-ASIN is an ASIN-mismatch case, not a
  -- raw-SKU collision -- reasons must contain exactly
  -- advertised_asin_catalog_asin_mismatch, and the evidence must name the
  -- actual conflicting ASINs, not just leave them implicit.
  IF v_row->'identityConflictEvidence'->'reasons' <> '["advertised_asin_catalog_asin_mismatch"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4b FAILED (follow-up): expected reasons=[advertised_asin_catalog_asin_mismatch] only, got %', v_row->'identityConflictEvidence'->'reasons';
  END IF;
  IF v_row->'identityConflictEvidence'->>'catalogAsin' <> 'ASINCONF-CATALOG' THEN
    RAISE EXCEPTION 'TEST 4b FAILED (follow-up): expected catalogAsin=ASINCONF-CATALOG, got %', v_row->'identityConflictEvidence';
  END IF;
  IF v_row->'identityConflictEvidence'->'advertisedAsins' <> '["ASINCONF-ADS"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4b FAILED (follow-up): expected advertisedAsins=[ASINCONF-ADS], got %', v_row->'identityConflictEvidence';
  END IF;
END $$;

-- ================================================================
-- TEST 4c: Fix 4 -- same-source collision (two catalog raw SKUs, one
-- canonical key) and cross-source collision (a third raw SKU from Ads)
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' IN ('Dup-1', 'DUP-1', 'dup-1');
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 4c FAILED: DUP-1 canonical row not found'; END IF;
  IF v_row->>'mappingState' <> 'identity_conflict' THEN RAISE EXCEPTION 'TEST 4c FAILED: DUP-1 should be identity_conflict (same-source + cross-source collision), got %', v_row->>'mappingState'; END IF;
  IF jsonb_array_length(v_row->'identityConflictEvidence'->'catalogRawSkus') <> 2 THEN
    RAISE EXCEPTION 'TEST 4c FAILED: expected 2 distinct catalog raw SKUs (Dup-1, DUP-1) in evidence, got %', v_row->'identityConflictEvidence';
  END IF;
  IF jsonb_array_length(v_row->'identityConflictEvidence'->'adsRawSkus') <> 1 THEN
    RAISE EXCEPTION 'TEST 4c FAILED: expected 1 ads raw SKU (dup-1) in evidence, got %', v_row->'identityConflictEvidence';
  END IF;
  -- Follow-up correction: DUP-1 is a raw-SKU-collision case ONLY (both
  -- catalog rows share the same ASIN as the Ads row, by fixture design --
  -- see the fixture comment above) -- reasons must contain exactly
  -- raw_sku_collision, never advertised_asin_catalog_asin_mismatch.
  IF v_row->'identityConflictEvidence'->'reasons' <> '["raw_sku_collision"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4c FAILED (follow-up): expected reasons=[raw_sku_collision] only, got %', v_row->'identityConflictEvidence'->'reasons';
  END IF;
END $$;

-- ================================================================
-- TEST 4d: Fix 4 -- daily RPC identity_conflict short-circuit for a
-- raw-SKU collision, no combined series
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'DUP-1', '2026-07-01', '2026-07-20');
  IF v_result->>'result' <> 'identity_conflict' THEN RAISE EXCEPTION 'TEST 4d FAILED: expected identity_conflict result, got %', v_result; END IF;
  IF v_result ? 'days' THEN RAISE EXCEPTION 'TEST 4d FAILED (Fix 4): identity_conflict daily response must not include a combined days series, got %', v_result; END IF;
  IF v_result->'evidence' IS NULL THEN RAISE EXCEPTION 'TEST 4d FAILED: identity_conflict daily response must include evidence'; END IF;
  IF v_result->'evidence'->'reasons' <> '["raw_sku_collision"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4d FAILED (follow-up): expected evidence.reasons=[raw_sku_collision], got %', v_result->'evidence'->'reasons';
  END IF;
END $$;

-- ================================================================
-- TEST 4e: follow-up correction -- daily RPC identity_conflict
-- short-circuit for an ASIN mismatch (previously the daily RPC only
-- short-circuited for a raw-SKU collision; SKU-CONFLICT-ASIN would have
-- silently returned a per-day 'success' series despite the ASIN mismatch).
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-CONFLICT-ASIN', '2026-07-01', '2026-07-20');
  IF v_result->>'result' <> 'identity_conflict' THEN
    RAISE EXCEPTION 'TEST 4e FAILED (follow-up): expected identity_conflict for an ASIN-mismatch SKU, got %', v_result;
  END IF;
  IF v_result ? 'days' THEN RAISE EXCEPTION 'TEST 4e FAILED (follow-up): identity_conflict daily response must not include a combined days series, got %', v_result; END IF;
  IF v_result->'evidence'->'reasons' <> '["advertised_asin_catalog_asin_mismatch"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4e FAILED (follow-up): expected evidence.reasons=[advertised_asin_catalog_asin_mismatch], got %', v_result->'evidence'->'reasons';
  END IF;
  IF v_result->'evidence'->>'catalogAsin' <> 'ASINCONF-CATALOG' THEN
    RAISE EXCEPTION 'TEST 4e FAILED (follow-up): expected evidence.catalogAsin=ASINCONF-CATALOG, got %', v_result->'evidence';
  END IF;
  IF v_result->'evidence'->'advertisedAsins' <> '["ASINCONF-ADS"]'::jsonb THEN
    RAISE EXCEPTION 'TEST 4e FAILED (follow-up): expected evidence.advertisedAsins=[ASINCONF-ADS], got %', v_result->'evidence';
  END IF;
END $$;

-- ================================================================
-- TEST 4f: follow-up correction -- summary and daily must return a
-- CONSISTENT conflict status for the same canonical SKU, in both
-- directions (conflict SKUs agree, and a normal SKU is never flagged by
-- one RPC but not the other).
-- ================================================================
DO $$
DECLARE v_summary jsonb; v_daily jsonb; v_row jsonb;
BEGIN
  v_summary := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );

  -- DUP-1: both RPCs must agree it is identity_conflict.
  SELECT r INTO v_row FROM jsonb_array_elements(v_summary->'rows') r WHERE r->>'sku' IN ('Dup-1', 'DUP-1', 'dup-1');
  v_daily := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'DUP-1', '2026-07-01', '2026-07-20');
  IF NOT (v_row->>'mappingState' = 'identity_conflict' AND v_daily->>'result' = 'identity_conflict') THEN
    RAISE EXCEPTION 'TEST 4f FAILED: DUP-1 summary/daily disagree -- summary=%, daily=%', v_row->>'mappingState', v_daily->>'result';
  END IF;

  -- SKU-CONFLICT-ASIN: both RPCs must agree it is identity_conflict.
  SELECT r INTO v_row FROM jsonb_array_elements(v_summary->'rows') r WHERE r->>'sku' = 'SKU-CONFLICT-ASIN';
  v_daily := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-CONFLICT-ASIN', '2026-07-01', '2026-07-20');
  IF NOT (v_row->>'mappingState' = 'identity_conflict' AND v_daily->>'result' = 'identity_conflict') THEN
    RAISE EXCEPTION 'TEST 4f FAILED: SKU-CONFLICT-ASIN summary/daily disagree -- summary=%, daily=%', v_row->>'mappingState', v_daily->>'result';
  END IF;

  -- SKU-MAPPED: a normal, non-conflicted SKU must agree on BOTH sides too
  -- (never identity_conflict in either RPC).
  SELECT r INTO v_row FROM jsonb_array_elements(v_summary->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  v_daily := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-MAPPED', '2026-07-01', '2026-07-20');
  IF NOT (v_row->>'mappingState' = 'mapped' AND v_daily->>'result' = 'success' AND (v_daily ? 'days')) THEN
    RAISE EXCEPTION 'TEST 4f FAILED: SKU-MAPPED unexpectedly flagged as a conflict somewhere -- summary=%, daily=%', v_row->>'mappingState', v_daily->>'result';
  END IF;
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
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
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
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
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
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
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
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
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
-- TEST 11: Fix 2 -- requested sort order survives into the jsonb response,
-- for sort keys whose order DIFFERS from alphabetical SKU order (the
-- previous version of this test used SKU-SORT-A/B/C, whose alphabetical
-- order happened to coincide with sales_desc order by construction -- it
-- could never have caught the original bug where jsonb_agg silently
-- re-sorted by canonical_sku regardless of p_sort. APPLE/MANGO/ZEBRA/BANANA
-- deliberately do not coincide with either sort key's numeric order).
-- ================================================================
DO $$
DECLARE v_result jsonb; v_skus text[]; v_sku1 text;
BEGIN
  -- sales_desc: APPLE(300) > ZEBRA(200) > MANGO(100); alphabetical would be APPLE, MANGO, ZEBRA -- different.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20',
    500, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sales_desc'
  );
  SELECT array_agg(r->>'sku' ORDER BY ord) INTO v_skus
  FROM jsonb_array_elements(v_result->'rows') WITH ORDINALITY AS t(r, ord);
  IF v_skus IS DISTINCT FROM ARRAY['SKU-SORT-APPLE', 'SKU-SORT-ZEBRA', 'SKU-SORT-MANGO', 'SKU-SORT-BANANA'] THEN
    RAISE EXCEPTION 'TEST 11a FAILED (Fix 2, sales_desc): expected [APPLE, ZEBRA, MANGO, BANANA] by sales (300,200,100,0), got %', v_skus;
  END IF;

  -- spend_desc: MANGO(300) > ZEBRA(200) > APPLE(100) > BANANA(20) -- a DIFFERENT permutation from sales_desc.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20',
    500, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'spend_desc'
  );
  SELECT array_agg(r->>'sku' ORDER BY ord) INTO v_skus
  FROM jsonb_array_elements(v_result->'rows') WITH ORDINALITY AS t(r, ord);
  IF v_skus IS DISTINCT FROM ARRAY['SKU-SORT-MANGO', 'SKU-SORT-ZEBRA', 'SKU-SORT-APPLE', 'SKU-SORT-BANANA'] THEN
    RAISE EXCEPTION 'TEST 11b FAILED (Fix 2, spend_desc): expected [MANGO, ZEBRA, APPLE, BANANA] by spend (300,200,100,20), got %', v_skus;
  END IF;

  -- attention_desc: SKU-SORT-BANANA is identity_conflict (highest severity) despite the LOWEST sales -- must sort first.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20',
    500, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'attention_desc'
  );
  SELECT (r->>'sku') INTO v_sku1 FROM jsonb_array_elements(v_result->'rows') WITH ORDINALITY AS t(r, ord) WHERE ord = 1;
  IF v_sku1 <> 'SKU-SORT-BANANA' THEN
    RAISE EXCEPTION 'TEST 11c FAILED (Fix 2, attention_desc): expected SKU-SORT-BANANA (identity_conflict) first regardless of its low sales, got %', v_sku1;
  END IF;

  -- Page 1 vs page 2 determinism: no overlap, no gap, same overall order as
  -- a single unpaginated call.
  DECLARE
    v_full jsonb; v_p1 jsonb; v_p2 jsonb;
    v_full_skus text[]; v_paged_skus text[];
  BEGIN
    v_full := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20', 500, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sales_desc');
    v_p1 := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20', 2, 0, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sales_desc');
    v_p2 := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-16', '2026-07-16', '2026-07-20', 2, 2, 'SKU-SORT-', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sales_desc');
    SELECT array_agg(r->>'sku' ORDER BY ord) INTO v_full_skus FROM jsonb_array_elements(v_full->'rows') WITH ORDINALITY AS t(r, ord);
    SELECT array_agg(r->>'sku' ORDER BY ord) INTO v_paged_skus FROM jsonb_array_elements(v_p1->'rows') WITH ORDINALITY AS t(r, ord);
    v_paged_skus := v_paged_skus || (SELECT array_agg(r->>'sku' ORDER BY ord) FROM jsonb_array_elements(v_p2->'rows') WITH ORDINALITY AS t(r, ord));
    IF v_full_skus IS DISTINCT FROM v_paged_skus THEN
      RAISE EXCEPTION 'TEST 11d FAILED (Fix 2, page determinism): page1+page2 (%) does not match the unpaginated order (%)', v_paged_skus, v_full_skus;
    END IF;
  END;
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
-- TEST 14: cross-marketplace isolation (including Cost Master, narrow cleanup #1)
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-M2-ONLY') THEN
    RAISE EXCEPTION 'TEST 14a FAILED: marketplace M2''s SKU leaked into the M1 result';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-COSTMASTER-ONLY') THEN
    RAISE EXCEPTION 'TEST 14b FAILED (narrow cleanup #1): a Cost-Master-only SKU (no marketplace_id, no catalog/sales/ads presence) leaked into the M1 universe';
  END IF;
END $$;

-- ================================================================
-- TEST 15: Fix 1 -- common comparable date range, per-source effective
-- range, clampReasons array, and the mixed-period-TACOS regression.
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb; v_reasons text[];
BEGIN
  -- sales_earliest = 2026-06-10, ads_earliest = 2026-06-01 for WS_A/M1.
  -- Requested range starts 2026-05-01, before BOTH.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-05-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF (v_result->'dateRange'->>'wasRangeClamped')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST 15a FAILED: expected wasRangeClamped=true, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'salesEffectiveDateFrom' <> '2026-06-10' THEN RAISE EXCEPTION 'TEST 15a FAILED: expected salesEffectiveDateFrom=2026-06-10, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'adsEffectiveDateFrom' <> '2026-06-01' THEN RAISE EXCEPTION 'TEST 15a FAILED: expected adsEffectiveDateFrom=2026-06-01, got %', v_result->'dateRange'; END IF;
  IF v_result->'dateRange'->>'commonEffectiveDateFrom' <> '2026-06-10' THEN RAISE EXCEPTION 'TEST 15a FAILED: expected commonEffectiveDateFrom=GREATEST(05-01,06-10,06-01)=2026-06-10, got %', v_result->'dateRange'; END IF;

  SELECT array_agg(x::text) INTO v_reasons FROM jsonb_array_elements_text(v_result->'dateRange'->'clampReasons') x;
  IF NOT ('requested_start_before_sales_history' = ANY(v_reasons)) OR NOT ('requested_start_before_ads_history' = ANY(v_reasons)) THEN
    RAISE EXCEPTION 'TEST 15b FAILED: clampReasons must be an array containing both source reasons, got %', v_result->'dateRange'->'clampReasons';
  END IF;

  -- Not clamped case
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF (v_result->'dateRange'->>'wasRangeClamped')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'TEST 15c FAILED: expected wasRangeClamped=false, got %', v_result->'dateRange'; END IF;
  IF jsonb_array_length(v_result->'dateRange'->'clampReasons') <> 0 THEN RAISE EXCEPTION 'TEST 15c FAILED: clampReasons must be empty when not clamped, got %', v_result->'dateRange'; END IF;

  -- Mixed-period TACOS regression: SKU-MAPPED has spend=10 on 2026-06-01
  -- (BEFORE sales history, 2026-06-10) plus spend=50 on 2026-07-16. Sales
  -- are 100 on 2026-06-10 (the sales-history anchor row -- exactly ON the
  -- common range's start, so it IS included) plus 500+500 on 07-07/07-18,
  -- total 1100, all within the common range [2026-06-10, 2026-07-20]. The
  -- requested range 2026-05-01..2026-07-20 must NOT let the pre-sales-
  -- history 06-01 spend dilute TACOS -- only the 07-16 spend (50) may enter
  -- the ratio: TACOS = 50/1100 = 0.045454..., never (10+50)/1100 = 0.054545...
  -- (the old LEAST()-based combined-start bug would have let the 06-01
  -- spend into the numerator).
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  -- (re-fetch using the wide range to exercise the actual clamp)
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-05-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-MAPPED';
  IF (v_row->'selectedRange'->>'spend')::numeric <> 60 THEN
    RAISE EXCEPTION 'TEST 15d FAILED SEED: the selectedRange spend CARD should still show the full 10+50=60 (own-range, unclamped by the common range), got %', v_row->'selectedRange';
  END IF;
  IF v_row->'selectedRange'->'tacos'->>'state' <> 'normal' THEN
    RAISE EXCEPTION 'TEST 15d FAILED SEED: expected a normal TACOS state, got %', v_row->'selectedRange'->'tacos';
  END IF;
  IF abs((v_row->'selectedRange'->'tacos'->>'value')::numeric - (50.0/1100.0)) > 0.0001 THEN
    RAISE EXCEPTION 'TEST 15d FAILED (Fix 1, mixed-period TACOS): expected TACOS = 50/1100 = 0.045454... (pre-sales-history spend excluded from the ratio), got %', v_row->'selectedRange'->'tacos';
  END IF;
END $$;

-- ================================================================
-- TEST 16: Fix 5 -- strict/conservative parameter validation
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

  -- Fix 5: no more CURRENT_DATE+1 grace day -- CURRENT_DATE+1 itself must now be rejected.
  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', (CURRENT_DATE + 1)::text::date, (CURRENT_DATE + 1)::text::date, 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'date_to_in_future' THEN RAISE EXCEPTION 'TEST 16d FAILED (Fix 5): CURRENT_DATE+1 must now be rejected (no grace day), got %', v_result; END IF;

  -- Short range (well under the 400-day ceiling) but still far in the future,
  -- so this isolates the future-date check from the range-ceiling check
  -- (a wide 2026..2099 range would trip range_too_large first instead).
  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2098-12-01', '2099-01-01', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'date_to_in_future' THEN RAISE EXCEPTION 'TEST 16e FAILED: far-future date_to not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'not_a_real_sort');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'unsupported_sort' THEN RAISE EXCEPTION 'TEST 16f FAILED: unsupported sort not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, repeat('x', 201), NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'sku_filter_too_long' THEN RAISE EXCEPTION 'TEST 16g FAILED: oversized sku filter not rejected, got %', v_result; END IF;

  v_result := public.get_sku_performance_summary(NULL, 'M1', '2026-07-01', '2026-07-20', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'missing_workspace_id' THEN RAISE EXCEPTION 'TEST 16h FAILED: NULL workspace_id not rejected, got %', v_result; END IF;

  -- Fix 5: hard range ceiling on the summary RPC (previously only the daily RPC had one).
  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', '2025-01-01', '2026-07-20', '2026-07-20', 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'range_too_large' THEN RAISE EXCEPTION 'TEST 16i FAILED (Fix 5): >400-day selected range not rejected, got %', v_result; END IF;
END $$;

-- ================================================================
-- TEST 16j: follow-up correction -- EXACT 400 inclusive days accepted,
-- 401 inclusive days rejected (dateTo - dateFrom is a day DIFFERENCE, not
-- an inclusive calendar-date count -- both endpoints are inclusive, so the
-- correct ceiling check is dateTo - dateFrom + 1 > 400, not dateTo -
-- dateFrom > 400, which would have let 401 inclusive dates through).
-- ================================================================
DO $$
DECLARE v_result jsonb; v_date_to date := '2026-07-20'; v_date_from_400 date; v_date_from_401 date;
BEGIN
  v_date_from_400 := v_date_to - 399; -- v_date_to - v_date_from_400 + 1 = 400 inclusive days
  v_date_from_401 := v_date_to - 400; -- v_date_to - v_date_from_401 + 1 = 401 inclusive days

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', v_date_from_400, v_date_to, v_date_to, 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' = 'invalid_parameters' AND v_result->>'reason' = 'range_too_large' THEN
    RAISE EXCEPTION 'TEST 16j FAILED (follow-up): exactly 400 inclusive days must be ACCEPTED, got %', v_result;
  END IF;

  v_result := public.get_sku_performance_summary('a0000000-0000-0000-0000-000000000001', 'M1', v_date_from_401, v_date_to, v_date_to, 100, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'range_too_large' THEN
    RAISE EXCEPTION 'TEST 16j FAILED (follow-up): 401 inclusive days must be REJECTED as range_too_large, got %', v_result;
  END IF;
END $$;

-- ================================================================
-- TEST 17: get_sku_performance_daily -- coverage-state model, all five states
-- ================================================================
DO $$
DECLARE v_result jsonb;
  v_a jsonb; v_b jsonb; v_c jsonb; v_d jsonb; v_e jsonb; v_f jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M3', 'SKU-COVERAGE-TEST', '2026-06-05', '2026-07-10');
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

  SELECT d INTO v_f FROM jsonb_array_elements(v_result->'days') d WHERE d->>'date' = '2026-06-16';
  IF v_f->'sales'->>'coverageState' <> 'CONFIRMED_ZERO' THEN RAISE EXCEPTION 'TEST 17f FAILED: a later failed retry erased earlier successful coverage, got %', v_f; END IF;
END $$;

-- ================================================================
-- TEST 18: manual-CSV-shaped gap
-- ================================================================
DO $$
DECLARE v_result jsonb; v_present jsonb; v_absent jsonb;
BEGIN
  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M3', 'SKU-ADS-COVERAGE-TEST', '2026-06-05', '2026-06-06');
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
-- TEST 19c: follow-up correction -- EXACT 400 inclusive days accepted,
-- 401 inclusive days rejected, same inclusive-day-count fix as TEST 16j,
-- applied to the daily RPC.
-- ================================================================
DO $$
DECLARE v_result jsonb; v_date_to date := '2026-07-20'; v_date_from_400 date; v_date_from_401 date;
BEGIN
  v_date_from_400 := v_date_to - 399; -- v_date_to - v_date_from_400 + 1 = 400 inclusive days
  v_date_from_401 := v_date_to - 400; -- v_date_to - v_date_from_401 + 1 = 401 inclusive days

  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-MAPPED', v_date_from_400, v_date_to);
  IF v_result->>'result' = 'invalid_parameters' AND v_result->>'reason' = 'range_too_large' THEN
    RAISE EXCEPTION 'TEST 19c FAILED (follow-up): exactly 400 inclusive days must be ACCEPTED, got %', v_result;
  END IF;

  v_result := public.get_sku_performance_daily('a0000000-0000-0000-0000-000000000001', 'M1', 'SKU-MAPPED', v_date_from_401, v_date_to);
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'range_too_large' THEN
    RAISE EXCEPTION 'TEST 19c FAILED (follow-up): 401 inclusive days must be REJECTED as range_too_large, got %', v_result;
  END IF;
END $$;

-- ================================================================
-- TEST 20: Fix 3 -- summary coverage truth: partial_success -> source_not_complete,
-- and a trend that cannot safely be computed -> no_comparable_baseline, with
-- no flags raised from it.
-- ================================================================
DO $$
DECLARE v_result jsonb; v_row jsonb;
BEGIN
  -- as_of = 2026-01-15 (marketplace M4, deliberately in the past -- see the
  -- fixture comment above): t7 = 2026-01-09..01-15 (covered ONLY by the
  -- partial_success run, no accepted success) -> source_not_complete;
  -- prior7 = 2026-01-02..01-08 (no coverage at all) -> unknown.
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M4', '2026-01-15', '2026-01-15', '2026-01-15',
    500, 0, 'SKU-TREND-GAP-TEST', NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 20 SEED FAILED: %', v_result; END IF;
  SELECT r INTO v_row FROM jsonb_array_elements(v_result->'rows') r WHERE r->>'sku' = 'SKU-TREND-GAP-TEST';
  IF v_row IS NULL THEN RAISE EXCEPTION 'TEST 20 SEED FAILED: SKU-TREND-GAP-TEST not found in result: %', v_result; END IF;
  IF v_row->'trailingSevenDay'->>'salesCoverageState' <> 'source_not_complete' THEN
    RAISE EXCEPTION 'TEST 20a FAILED (Fix 3): expected source_not_complete for a partial_success-only window, got %', v_row->'trailingSevenDay';
  END IF;
  IF v_row->>'salesTrend' <> 'no_comparable_baseline' THEN
    RAISE EXCEPTION 'TEST 20b FAILED (Fix 3): expected no_comparable_baseline trend when t7/prior7 coverage is not complete, got %', v_row->>'salesTrend';
  END IF;
  IF (v_row->'flags'->>'salesDrop')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST 20c FAILED (Fix 3): no flag may be derived from an incomplete/unknown trend, got %', v_row->'flags';
  END IF;
END $$;

-- ================================================================
-- TEST 21: Fix 6 -- truthful source health facts (latest data date vs.
-- latest ACCEPTED complete date; rows-rejected surfaced).
-- ================================================================
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.get_sku_performance_summary(
    'a0000000-0000-0000-0000-000000000001', 'M1', '2026-07-01', '2026-07-20', '2026-07-20',
    500, 0, NULL, NULL, NULL, NULL, false, false, false, false, false, false, false, 'sku_asc'
  );
  IF v_result->'summary'->>'salesLatestDataDate' <> '2026-07-18' THEN
    RAISE EXCEPTION 'TEST 21a FAILED: expected salesLatestDataDate=2026-07-18 (latest real row), got %', v_result->'summary';
  END IF;
  IF v_result->'summary'->>'salesLatestAcceptedCompleteDate' <> '2026-07-20' THEN
    RAISE EXCEPTION 'TEST 21b FAILED (Fix 6): expected salesLatestAcceptedCompleteDate=2026-07-20 (the accepted successful run''s date_to), got %', v_result->'summary';
  END IF;
  IF (v_result->'summary'->>'salesLastRunRowsRejected')::int <> 0 THEN
    RAISE EXCEPTION 'TEST 21c FAILED (Fix 6): salesLastRunRowsRejected must be surfaced, got %', v_result->'summary';
  END IF;

  -- Summary-level ACOS/TACOS are now {value, state} objects, not bare numbers.
  IF NOT (v_result->'summary'->'acos' ? 'value') OR NOT (v_result->'summary'->'acos' ? 'state') THEN
    RAISE EXCEPTION 'TEST 21d FAILED (narrow cleanup #4): summary.acos must be a {value, state} object, got %', v_result->'summary'->'acos';
  END IF;
  IF NOT (v_result->'summary'->'tacos' ? 'value') OR NOT (v_result->'summary'->'tacos' ? 'state') THEN
    RAISE EXCEPTION 'TEST 21e FAILED (narrow cleanup #4): summary.tacos must be a {value, state} object, got %', v_result->'summary'->'tacos';
  END IF;
END $$;

-- ================================================================
-- Summary
-- ================================================================
SELECT 'SKU Performance P1-B sequential suite: all tests passed' AS result;
