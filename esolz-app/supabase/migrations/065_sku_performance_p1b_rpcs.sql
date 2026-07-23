-- SKU Performance P1-B, migration 1 of 1: the two read-only, SECURITY
-- DEFINER RPCs this feature's entire data-access surface goes through.
--
-- Implements the locked contract in SKU_DAILY_SALES_SPEND_IMPLEMENTATION_PLAN.md
-- (Update 5) and SKU_DAILY_SALES_SPEND_PRODUCT_SPEC.md exactly: the canonical
-- cross-source SKU universe (Update 5 Correction 3), the coverage-state model
-- with its corrected five-state deterministic order (Update 5 Correction 1),
-- the selected-date-range + as-of contract (Update 5 Correction 2), and the
-- pagination/summary-count separation (Update 5 Correction 4). Follows the
-- Pincode Checker P0-A/P0-B convention: narrow, SECURITY DEFINER, explicit
-- search_path, EXECUTE revoked from PUBLIC and granted only to service_role,
-- every parameter validated before any query, no generic RPC passthrough.
--
-- No materialized table (Implementation Plan sec1 -- not P1-B scope). No
-- write of any kind to any existing source table. Both RPCs are pure reads.
--
-- Implementation decisions made here that the locked contract left open
-- (recorded so they are never silently assumed elsewhere):
-- 1. internal_ads_advertised_product_daily_rows has NO marketplace_id column
--    of its own (confirmed directly against migrations 039/049) -- Ads rows
--    are scoped to a marketplace only indirectly, via
--    amazon_ads_profiles.profile_id -> amazon_ads_profiles.marketplace_id.
--    Every Ads-side query below joins through an `ads_profiles` CTE for
--    this reason, never assumes an ads_rows.marketplace_id column.
-- 2. internal_data_refresh_runs.profile_id is only ever populated for Ads
--    sources (confirmed: sync-business-reports.ts never sets it) and its
--    marketplace_id (added by migration 053) is not confirmed to be set by
--    the Ads sync path -- so Ads coverage-run matching filters by
--    workspace_id + profile_id (resolved via amazon_ads_profiles for the
--    requested workspace/marketplace) and only ALSO requires marketplace_id
--    equality when that column happens to be non-null on the run row,
--    rather than assuming it is always populated. Business Report coverage-
--    run matching filters by workspace_id + marketplace_id directly (that
--    column was added specifically for this source, migration 053).
-- 2. Correction 1's five-state coverage model requires the *exact* Ads
--    refresh-run source name `ads_advertised_product` -- confirmed to be
--    one of the literal REPORT_DEFS source strings sync-ads-reports.ts
--    writes (not `ads_api_auto`, which is the unrelated row-level `source`
--    column on internal_ads_advertised_product_daily_rows itself).
-- 3. Product Spec sec3's "Mapping coverage" card (a SKU-count ratio among
--    SKUs with spend) and Implementation Plan sec2's "spend-weighted mapping
--    coverage breakdown" (a spend-$ ratio, Data Audit sec3b's methodology)
--    are two different, both-locked metrics -- this RPC returns both
--    (`mappingCoverage.bySkuCount` and `.bySpend`) rather than picking one
--    and silently dropping the other document's requirement.
-- 4. "Mapping incomplete" (Product Spec sec6.4#8) is implemented literally
--    as `mapping_state <> 'mapped'`, which does include `not_applicable`
--    rows (SKUs with no ad-spend history at all) -- exactly as the locked
--    truth table states, not narrowed to only `unmapped`/`identity_conflict`.
-- 5. The driving SKU universe (Update 5 Correction 3) is the ALL-TIME
--    canonical union across all four sources for the workspace+marketplace
--    scope, never limited to the requested date range -- a SKU with zero
--    activity in the selected range must still appear as `no_activity`/
--    `no_spend`, not disappear from the table.
-- 6. Source-health classification (`salesSourceState`/`adsSourceState`/
--    `catalogSourceState`, the six-value vocabulary from
--    brahmastra-data-health.ts's SourceHealthStatus) is deliberately NOT
--    computed inside this RPC. That module's real classifier
--    (evaluateSyncedSource) is a private, non-exported helper tightly
--    coupled to connection/OAuth-error inspection this RPC has no access
--    to, and duplicating a second copy of that logic in SQL would be the
--    exact kind of reinvention the Product Spec says to avoid. Instead this
--    RPC returns the raw facts a classifier needs (latest complete date,
--    most recent refresh-run status, most recent run timestamp) and the
--    thin TypeScript route layer (lib/sku-performance/source-health.ts)
--    derives the *State fields from those facts, reusing the SAME
--    SourceHealthStatus vocabulary type. This is recorded as a known,
--    intentional scope limitation: the TypeScript classifier does not
--    attempt to distinguish `auth_required`/`rate_limited` the way
--    brahmastra-data-health.ts's connection-aware version can -- see
--    lib/sku-performance/source-health.ts's own header comment.

-- ============================================================
-- 0. Supporting index
-- ============================================================
-- Speeds up the CONFIRMED_ZERO / SOURCE_NOT_COMPLETE range-overlap lookups
-- both RPCs perform against internal_data_refresh_runs. Partial: only the
-- rows that can ever satisfy a CONFIRMED_ZERO check are indexed.
CREATE INDEX IF NOT EXISTS internal_data_refresh_runs_success_coverage_idx
  ON public.internal_data_refresh_runs (workspace_id, source, date_from, date_to)
  WHERE status = 'success' AND rows_rejected = 0;

CREATE INDEX IF NOT EXISTS internal_data_refresh_runs_any_coverage_idx
  ON public.internal_data_refresh_runs (workspace_id, source, date_from, date_to);

-- ============================================================
-- 1. get_sku_performance_summary
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_sku_performance_summary(
  p_workspace_id             uuid,
  p_marketplace_id           text,
  p_date_from                date,
  p_date_to                  date,
  p_as_of                    date,
  p_limit                    integer,
  p_offset                   integer,
  p_sku_filter               text,
  p_asin_filter              text,
  p_category_filter          text,
  p_brand_filter             text,
  p_growing_only             boolean,
  p_declining_only           boolean,
  p_spend_spike_only         boolean,
  p_no_attributed_sales_only boolean,
  p_high_tacos_only          boolean,
  p_unmapped_only            boolean,
  p_identity_conflict_only   boolean,
  p_sort                     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  MAX_MARKETPLACE_LEN CONSTANT integer := 40;
  MAX_FILTER_LEN       CONSTANT integer := 200;
  MAX_LIMIT            CONSTANT integer := 500;
  MAX_OFFSET           CONSTANT integer := 1000000;
  FLOOR_SALES          CONSTANT numeric := 1000;
  FLOOR_SPEND          CONSTANT numeric := 200;
  SALES_GROWTH_RATIO   CONSTANT numeric := 1.2;
  SALES_DECLINE_RATIO  CONSTANT numeric := 0.7;
  SPEND_GROWTH_RATIO   CONSTANT numeric := 1.5;
  SPEND_DECLINE_RATIO  CONSTANT numeric := 0.7;
  TACOS_DETERIORATION_RATIO CONSTANT numeric := 1.3;
  VALID_SORTS CONSTANT text[] := ARRAY[
    'attention_desc', 'sales_desc', 'sales_asc', 'spend_desc', 'spend_asc',
    'tacos_desc', 'tacos_asc', 'sku_asc'
  ];

  v_growing_only             boolean := COALESCE(p_growing_only, false);
  v_declining_only           boolean := COALESCE(p_declining_only, false);
  v_spend_spike_only         boolean := COALESCE(p_spend_spike_only, false);
  v_no_attributed_sales_only boolean := COALESCE(p_no_attributed_sales_only, false);
  v_high_tacos_only          boolean := COALESCE(p_high_tacos_only, false);
  v_unmapped_only            boolean := COALESCE(p_unmapped_only, false);
  v_identity_conflict_only   boolean := COALESCE(p_identity_conflict_only, false);

  v_min_ad_spend_for_action numeric := 100;
  v_warning_tacos_pct       numeric := 15;
  v_critical_tacos_pct      numeric := 25;

  v_currency_count integer;
  v_currency_code   text;

  v_sales_history_starts_at date;
  v_ads_history_starts_at   date;
  v_effective_date_from     date;

  v_sales_latest_complete_date date;
  v_ads_latest_complete_date   date;
  v_catalog_last_synced_at     timestamptz;
  v_sales_last_run_status      text;
  v_sales_last_run_at          timestamptz;
  v_ads_last_run_status        text;
  v_ads_last_run_at            timestamptz;

  v_result jsonb;
BEGIN
  -- ---------- Parameter validation, before any query ----------
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_date_range');
  END IF;
  IF p_date_from > p_date_to THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'date_from_after_date_to');
  END IF;
  -- Coarse UTC-based future-date guard, pending the named timezone
  -- verification checkpoint (Implementation Plan sec5/sec7, Correction 8) --
  -- not a claim that this is marketplace-timezone-exact.
  IF p_date_to > CURRENT_DATE + 1 THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'date_to_in_future');
  END IF;
  IF p_as_of IS NULL OR p_as_of > CURRENT_DATE + 1 THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_as_of');
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > MAX_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_limit');
  END IF;
  IF p_offset IS NULL OR p_offset < 0 OR p_offset > MAX_OFFSET THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_offset');
  END IF;
  IF p_sku_filter IS NOT NULL AND length(p_sku_filter) > MAX_FILTER_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'sku_filter_too_long');
  END IF;
  IF p_asin_filter IS NOT NULL AND length(p_asin_filter) > MAX_FILTER_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'asin_filter_too_long');
  END IF;
  IF p_category_filter IS NOT NULL AND length(p_category_filter) > MAX_FILTER_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'category_filter_too_long');
  END IF;
  IF p_brand_filter IS NOT NULL AND length(p_brand_filter) > MAX_FILTER_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'brand_filter_too_long');
  END IF;
  IF p_sort IS NULL OR NOT (p_sort = ANY (VALID_SORTS)) THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'unsupported_sort');
  END IF;

  -- ---------- Threshold lookup (reuse internal_brahmastra_thresholds, never reinvented) ----------
  SELECT t.min_ad_spend_for_action, t.warning_tacos_pct, t.critical_tacos_pct
    INTO v_min_ad_spend_for_action, v_warning_tacos_pct, v_critical_tacos_pct
  FROM public.internal_brahmastra_thresholds t
  WHERE t.workspace_id = p_workspace_id AND t.portfolio = '__global__' AND t.is_active
  LIMIT 1;
  v_min_ad_spend_for_action := COALESCE(v_min_ad_spend_for_action, 100);
  v_warning_tacos_pct := COALESCE(v_warning_tacos_pct, 15);
  v_critical_tacos_pct := COALESCE(v_critical_tacos_pct, 25);

  -- ---------- Currency contract (Correction 8): reject a multi-currency scope outright ----------
  SELECT count(DISTINCT ap.currency_code), min(ap.currency_code)
    INTO v_currency_count, v_currency_code
  FROM public.amazon_ads_profiles ap
  WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id
    AND ap.currency_code IS NOT NULL;

  IF v_currency_count > 1 THEN
    RETURN jsonb_build_object('result', 'currency_mismatch');
  END IF;

  -- ---------- Date-range clamp evidence (Update 5 Correction 2) ----------
  SELECT min(s.report_date) INTO v_sales_history_starts_at
  FROM public.internal_business_report_sku_sales_traffic s
  WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id;

  SELECT min(a.report_date) INTO v_ads_history_starts_at
  FROM public.internal_ads_advertised_product_daily_rows a
  JOIN public.amazon_ads_profiles ap ON ap.profile_id = a.profile_id
  WHERE a.workspace_id = p_workspace_id AND ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id;

  v_effective_date_from := GREATEST(
    p_date_from,
    LEAST(COALESCE(v_sales_history_starts_at, p_date_from), COALESCE(v_ads_history_starts_at, p_date_from))
  );

  -- ---------- Source-level freshness facts (raw; *State classification happens in TypeScript) ----------
  SELECT max(s.report_date) INTO v_sales_latest_complete_date
  FROM public.internal_business_report_sku_sales_traffic s
  WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id;

  SELECT max(a.report_date) INTO v_ads_latest_complete_date
  FROM public.internal_ads_advertised_product_daily_rows a
  JOIN public.amazon_ads_profiles ap ON ap.profile_id = a.profile_id
  WHERE a.workspace_id = p_workspace_id AND ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id;

  SELECT max(li.last_synced_at) INTO v_catalog_last_synced_at
  FROM public.amazon_listing_items li
  WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id;

  SELECT r.status, r.started_at INTO v_sales_last_run_status, v_sales_last_run_at
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.marketplace_id = p_marketplace_id
    AND r.source = 'business_report_sp_api'
  ORDER BY r.started_at DESC LIMIT 1;

  SELECT r.status, r.started_at INTO v_ads_last_run_status, v_ads_last_run_at
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.source = 'ads_advertised_product'
    AND r.profile_id IN (SELECT ap.profile_id FROM public.amazon_ads_profiles ap
                          WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id)
    AND (r.marketplace_id IS NULL OR r.marketplace_id = p_marketplace_id)
  ORDER BY r.started_at DESC LIMIT 1;

  -- ---------- Main aggregation ----------
  WITH ads_profiles AS (
    SELECT ap.profile_id, ap.currency_code
    FROM public.amazon_ads_profiles ap
    WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id
  ),
  catalog_rows AS (
    SELECT upper(btrim(li.sku)) AS canonical_sku, li.sku AS raw_sku,
           li.asin, li.item_name, li.image_url, li.brand, li.last_synced_at
    FROM public.amazon_listing_items li
    WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id
      AND li.sku IS NOT NULL AND btrim(li.sku) <> ''
  ),
  sales_rows AS (
    SELECT upper(btrim(s.sku)) AS canonical_sku, s.sku AS raw_sku,
           s.report_date, s.ordered_product_sales, s.units_ordered
    FROM public.internal_business_report_sku_sales_traffic s
    WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id
      AND s.sku IS NOT NULL AND btrim(s.sku) <> ''
  ),
  ads_rows AS (
    SELECT upper(btrim(a.advertised_sku)) AS canonical_sku, a.advertised_sku AS raw_sku,
           a.advertised_asin, a.report_date, a.spend, a.sales AS attributed_sales
    FROM public.internal_ads_advertised_product_daily_rows a
    JOIN ads_profiles ap ON ap.profile_id = a.profile_id
    WHERE a.workspace_id = p_workspace_id
      AND a.advertised_sku IS NOT NULL AND btrim(a.advertised_sku) <> ''
  ),
  cost_rows AS (
    SELECT upper(btrim(c.sku)) AS canonical_sku, c.sku AS raw_sku, c.category
    FROM public.internal_sku_cost_master c
    WHERE c.workspace_id = p_workspace_id
      AND c.sku IS NOT NULL AND btrim(c.sku) <> ''
  ),
  universe AS (
    SELECT canonical_sku FROM catalog_rows
    UNION SELECT canonical_sku FROM sales_rows
    UNION SELECT canonical_sku FROM ads_rows
    UNION SELECT canonical_sku FROM cost_rows
  ),
  catalog_grouped AS (
    SELECT canonical_sku,
           array_agg(DISTINCT raw_sku) AS raw_skus,
           (array_agg(raw_sku ORDER BY raw_sku))[1] AS display_sku,
           (array_agg(asin ORDER BY raw_sku))[1] AS asin,
           (array_agg(item_name ORDER BY raw_sku))[1] AS item_name,
           (array_agg(image_url ORDER BY raw_sku))[1] AS image_url,
           (array_agg(brand ORDER BY raw_sku))[1] AS brand,
           max(last_synced_at) AS last_synced_at
    FROM catalog_rows GROUP BY canonical_sku
  ),
  sales_grouped AS (
    SELECT canonical_sku, array_agg(DISTINCT raw_sku) AS raw_skus,
           (array_agg(raw_sku ORDER BY raw_sku))[1] AS display_sku
    FROM sales_rows GROUP BY canonical_sku
  ),
  ads_grouped AS (
    SELECT canonical_sku, array_agg(DISTINCT raw_sku) AS raw_skus,
           (array_agg(raw_sku ORDER BY raw_sku))[1] AS display_sku,
           array_agg(DISTINCT advertised_asin) AS advertised_asins
    FROM ads_rows GROUP BY canonical_sku
  ),
  cost_grouped AS (
    SELECT canonical_sku, array_agg(DISTINCT raw_sku) AS raw_skus,
           (array_agg(raw_sku ORDER BY raw_sku))[1] AS display_sku,
           (array_agg(category ORDER BY raw_sku))[1] AS category
    FROM cost_rows GROUP BY canonical_sku
  ),
  sales_daily AS (
    SELECT canonical_sku, report_date,
           sum(ordered_product_sales) AS ordered_sales, sum(units_ordered) AS units_ordered
    FROM sales_rows GROUP BY canonical_sku, report_date
  ),
  ads_daily AS (
    SELECT canonical_sku, report_date, sum(spend) AS spend, sum(attributed_sales) AS attributed_sales
    FROM ads_rows GROUP BY canonical_sku, report_date
  ),
  sku_date_facts AS (
    SELECT COALESCE(sd.canonical_sku, ad.canonical_sku) AS canonical_sku,
           COALESCE(sd.report_date, ad.report_date) AS report_date,
           COALESCE(sd.ordered_sales, 0) AS ordered_sales,
           COALESCE(sd.units_ordered, 0) AS units_ordered,
           COALESCE(ad.spend, 0) AS spend,
           COALESCE(ad.attributed_sales, 0) AS attributed_sales
    FROM sales_daily sd
    FULL OUTER JOIN ads_daily ad ON ad.canonical_sku = sd.canonical_sku AND ad.report_date = sd.report_date
  ),
  sku_metrics AS (
    SELECT
      u.canonical_sku,
      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN v_effective_date_from AND p_date_to), 0) AS range_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN v_effective_date_from AND p_date_to), 0) AS range_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN v_effective_date_from AND p_date_to), 0) AS range_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN v_effective_date_from AND p_date_to), 0) AS range_attributed_sales,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_attributed_sales,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_attributed_sales,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_sales,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_attributed_sales,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_attributed_sales,

      max(f.report_date) FILTER (WHERE f.ordered_sales > 0) AS last_sales_activity_date,
      max(f.report_date) FILTER (WHERE f.spend > 0) AS last_ad_spend_activity_date,
      max(f.report_date) FILTER (WHERE f.attributed_sales > 0) AS last_attributed_sale_activity_date
    FROM universe u
    LEFT JOIN sku_date_facts f ON f.canonical_sku = u.canonical_sku
    GROUP BY u.canonical_sku
  ),
  sku_rows AS (
    SELECT
      u.canonical_sku,
      COALESCE(cg.display_sku, sg.display_sku, ag.display_sku, cmg.display_sku) AS displayed_sku,
      cg.asin AS catalog_asin, cg.item_name, cg.image_url, cg.brand, cg.last_synced_at AS catalog_last_synced_at,
      cmg.category,
      m.range_sales, m.range_units, m.range_spend, m.range_attributed_sales,
      m.yesterday_sales, m.yesterday_units, m.yesterday_spend, m.yesterday_attributed_sales,
      m.t7_sales, m.t7_units, m.t7_spend, m.t7_attributed_sales,
      m.prior7_sales, m.prior7_spend, m.prior7_attributed_sales,
      m.t30_sales, m.t30_units, m.t30_spend, m.t30_attributed_sales,
      m.last_sales_activity_date, m.last_ad_spend_activity_date, m.last_attributed_sale_activity_date,
      CASE
        WHEN ag.canonical_sku IS NULL THEN 'not_applicable'
        WHEN COALESCE(array_length(cg.raw_skus, 1), 0) > 1
          OR COALESCE(array_length(sg.raw_skus, 1), 0) > 1
          OR COALESCE(array_length(ag.raw_skus, 1), 0) > 1
          OR COALESCE(array_length(cmg.raw_skus, 1), 0) > 1
        THEN 'identity_conflict'
        WHEN cg.canonical_sku IS NULL THEN 'unmapped'
        WHEN EXISTS (SELECT 1 FROM unnest(ag.advertised_asins) x WHERE x IS NOT NULL AND x IS DISTINCT FROM cg.asin)
        THEN 'identity_conflict'
        ELSE 'mapped'
      END AS mapping_state
    FROM universe u
    LEFT JOIN catalog_grouped cg ON cg.canonical_sku = u.canonical_sku
    LEFT JOIN sales_grouped sg ON sg.canonical_sku = u.canonical_sku
    LEFT JOIN ads_grouped ag ON ag.canonical_sku = u.canonical_sku
    LEFT JOIN cost_grouped cmg ON cmg.canonical_sku = u.canonical_sku
    LEFT JOIN sku_metrics m ON m.canonical_sku = u.canonical_sku
  ),
  sku_ratios AS (
    SELECT r.*,
      CASE WHEN range_spend = 0 AND range_attributed_sales = 0 THEN 'not_applicable'
           WHEN range_spend > 0 AND range_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS range_acos_state,
      CASE WHEN range_spend > 0 AND range_attributed_sales > 0 THEN range_spend / range_attributed_sales END AS range_acos_value,
      CASE WHEN range_spend = 0 AND range_sales = 0 THEN 'not_applicable'
           WHEN range_spend > 0 AND range_sales = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS range_tacos_state,
      CASE WHEN range_sales > 0 THEN range_spend / range_sales END AS range_tacos_value,

      CASE WHEN t7_spend = 0 AND t7_attributed_sales = 0 THEN 'not_applicable'
           WHEN t7_spend > 0 AND t7_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS t7_acos_state,
      CASE WHEN t7_spend > 0 AND t7_attributed_sales > 0 THEN t7_spend / t7_attributed_sales END AS t7_acos_value,
      CASE WHEN t7_spend = 0 AND t7_sales = 0 THEN 'not_applicable'
           WHEN t7_spend > 0 AND t7_sales = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS t7_tacos_state,
      CASE WHEN t7_sales > 0 THEN t7_spend / t7_sales END AS t7_tacos_value,

      CASE WHEN prior7_spend = 0 AND prior7_attributed_sales = 0 THEN 'not_applicable'
           WHEN prior7_spend > 0 AND prior7_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS prior7_acos_state,
      CASE WHEN prior7_spend > 0 AND prior7_attributed_sales > 0 THEN prior7_spend / prior7_attributed_sales END AS prior7_acos_value,
      CASE WHEN prior7_spend = 0 AND prior7_sales = 0 THEN 'not_applicable'
           WHEN prior7_spend > 0 AND prior7_sales = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS prior7_tacos_state,
      CASE WHEN prior7_sales > 0 THEN prior7_spend / prior7_sales END AS prior7_tacos_value,

      CASE WHEN t30_spend = 0 AND t30_attributed_sales = 0 THEN 'not_applicable'
           WHEN t30_spend > 0 AND t30_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS t30_acos_state,
      CASE WHEN t30_spend > 0 AND t30_attributed_sales > 0 THEN t30_spend / t30_attributed_sales END AS t30_acos_value,
      CASE WHEN t30_spend = 0 AND t30_sales = 0 THEN 'not_applicable'
           WHEN t30_spend > 0 AND t30_sales = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS t30_tacos_state,
      CASE WHEN t30_sales > 0 THEN t30_spend / t30_sales END AS t30_tacos_value,

      CASE WHEN yesterday_spend = 0 AND yesterday_attributed_sales = 0 THEN 'not_applicable'
           WHEN yesterday_spend > 0 AND yesterday_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS yesterday_acos_state,
      CASE WHEN yesterday_spend > 0 AND yesterday_attributed_sales > 0 THEN yesterday_spend / yesterday_attributed_sales END AS yesterday_acos_value,
      CASE WHEN yesterday_spend = 0 AND yesterday_sales = 0 THEN 'not_applicable'
           WHEN yesterday_spend > 0 AND yesterday_sales = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS yesterday_tacos_state,
      CASE WHEN yesterday_sales > 0 THEN yesterday_spend / yesterday_sales END AS yesterday_tacos_value
    FROM sku_rows r
  ),
  sku_trends AS (
    SELECT rt.*,
      CASE
        WHEN rt.prior7_sales = 0 AND rt.t7_sales = 0 THEN 'no_activity'
        WHEN rt.prior7_sales = 0 AND rt.t7_sales > FLOOR_SALES THEN 'new_activity'
        WHEN rt.prior7_sales = 0 THEN 'no_activity'
        WHEN rt.t7_sales > rt.prior7_sales * SALES_GROWTH_RATIO THEN 'growing'
        WHEN rt.t7_sales < rt.prior7_sales * SALES_DECLINE_RATIO THEN 'declining'
        ELSE 'flat'
      END AS sales_trend,
      CASE
        WHEN rt.prior7_spend = 0 AND rt.t7_spend = 0 THEN 'no_spend'
        WHEN rt.prior7_spend = 0 AND rt.t7_spend >= FLOOR_SPEND THEN 'new_spend'
        WHEN rt.prior7_spend = 0 THEN 'no_spend'
        WHEN rt.t7_spend > rt.prior7_spend * SPEND_GROWTH_RATIO THEN 'growing'
        WHEN rt.t7_spend < rt.prior7_spend * SPEND_DECLINE_RATIO THEN 'declining'
        ELSE 'flat'
      END AS spend_trend
    FROM sku_ratios rt
  ),
  sku_flags AS (
    SELECT tr.*,
      (tr.sales_trend = 'declining') AS flag_sales_drop,
      (tr.spend_trend = 'growing') AS flag_spend_spike,
      (tr.t7_spend >= v_min_ad_spend_for_action AND tr.t7_attributed_sales = 0) AS flag_no_attributed_sales,
      (
        tr.prior7_tacos_state = 'normal' AND tr.t7_tacos_state = 'normal'
        AND tr.t7_sales >= FLOOR_SALES
        AND tr.t7_tacos_value > tr.prior7_tacos_value * TACOS_DETERIORATION_RATIO
      ) AS flag_tacos_deterioration,
      (tr.sales_trend = 'growing' AND tr.spend_trend = 'flat') AS flag_sales_growing_stable_spend,
      (tr.sales_trend = 'growing' AND tr.spend_trend = 'declining') AS flag_sales_growing_spend_falls,
      (tr.mapping_state <> 'mapped') AS flag_mapping_incomplete,
      CASE
        WHEN tr.range_tacos_state <> 'normal' THEN NULL
        WHEN tr.range_tacos_value >= v_critical_tacos_pct / 100.0 THEN 'critical'
        WHEN tr.range_tacos_value >= v_warning_tacos_pct / 100.0 THEN 'warning'
        ELSE 'normal'
      END AS tacos_band
    FROM sku_trends tr
  ),
  sku_final AS (
    SELECT fl.*,
      (
        (CASE WHEN flag_sales_drop THEN 1 ELSE 0 END) +
        (CASE WHEN flag_spend_spike THEN 1 ELSE 0 END) +
        (CASE WHEN flag_no_attributed_sales THEN 1 ELSE 0 END) +
        (CASE WHEN flag_tacos_deterioration THEN 1 ELSE 0 END) +
        (CASE WHEN flag_mapping_incomplete THEN 1 ELSE 0 END) +
        (CASE WHEN tacos_band IN ('warning', 'critical') THEN 1 ELSE 0 END)
      ) AS attention_severity_rank
    FROM sku_flags fl
  ),
  filtered AS (
    SELECT * FROM sku_final f
    WHERE (p_sku_filter IS NULL OR f.displayed_sku ILIKE '%' || p_sku_filter || '%')
      AND (p_asin_filter IS NULL OR f.catalog_asin ILIKE '%' || p_asin_filter || '%')
      AND (p_category_filter IS NULL OR f.category = p_category_filter)
      AND (p_brand_filter IS NULL OR f.brand = p_brand_filter)
      AND (NOT v_growing_only OR f.sales_trend IN ('growing', 'new_activity'))
      AND (NOT v_declining_only OR f.sales_trend = 'declining')
      AND (NOT v_spend_spike_only OR f.flag_spend_spike)
      AND (NOT v_no_attributed_sales_only OR f.flag_no_attributed_sales)
      AND (NOT v_high_tacos_only OR f.flag_tacos_deterioration OR f.tacos_band IN ('warning', 'critical'))
      AND (NOT v_unmapped_only OR f.mapping_state = 'unmapped')
      AND (NOT v_identity_conflict_only OR f.mapping_state = 'identity_conflict')
  ),
  paged AS (
    SELECT * FROM filtered
    ORDER BY
      CASE WHEN p_sort = 'attention_desc' THEN attention_severity_rank END DESC NULLS LAST,
      CASE WHEN p_sort = 'attention_desc' THEN range_sales END DESC NULLS LAST,
      CASE WHEN p_sort = 'sales_desc' THEN range_sales END DESC NULLS LAST,
      CASE WHEN p_sort = 'sales_asc' THEN range_sales END ASC NULLS LAST,
      CASE WHEN p_sort = 'spend_desc' THEN range_spend END DESC NULLS LAST,
      CASE WHEN p_sort = 'spend_asc' THEN range_spend END ASC NULLS LAST,
      CASE WHEN p_sort = 'tacos_desc' THEN range_tacos_value END DESC NULLS LAST,
      CASE WHEN p_sort = 'tacos_asc' THEN range_tacos_value END ASC NULLS LAST,
      CASE WHEN p_sort = 'sku_asc' THEN displayed_sku END ASC NULLS LAST,
      canonical_sku ASC
    LIMIT p_limit OFFSET p_offset
  ),
  summary_agg AS (
    SELECT
      COALESCE(sum(range_sales), 0) AS total_ordered_sales,
      COALESCE(sum(range_units), 0) AS total_units,
      COALESCE(sum(range_spend), 0) AS total_ad_spend,
      COALESCE(sum(range_attributed_sales), 0) AS total_attributed_sales,
      count(*) FILTER (WHERE sales_trend IN ('growing', 'new_activity')) AS skus_growing,
      count(*) FILTER (WHERE sales_trend = 'declining') AS skus_declining,
      count(*) FILTER (WHERE range_spend > 0 AND mapping_state = 'mapped') AS by_count_mapped,
      count(*) FILTER (WHERE range_spend > 0 AND mapping_state = 'unmapped') AS by_count_unmapped,
      count(*) FILTER (WHERE range_spend > 0 AND mapping_state = 'identity_conflict') AS by_count_conflict,
      COALESCE(sum(range_spend) FILTER (WHERE mapping_state = 'mapped'), 0) AS mapped_spend,
      COALESCE(sum(range_spend) FILTER (WHERE mapping_state = 'unmapped'), 0) AS unmapped_spend,
      COALESCE(sum(range_spend) FILTER (WHERE mapping_state = 'identity_conflict'), 0) AS conflict_spend
    FROM filtered
  ),
  counts AS (
    SELECT
      (SELECT count(*) FROM universe) AS total_before_filters,
      (SELECT count(*) FROM filtered) AS total_after_filters,
      (SELECT count(*) FROM paged) AS returned_count
  )
  SELECT jsonb_build_object(
    'result', 'success',
    'currencyCode', v_currency_code,
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'sku', p.displayed_sku,
        'asin', p.catalog_asin,
        'productTitle', p.item_name,
        'imageUrl', p.image_url,
        'brand', p.brand,
        'category', p.category,
        'mappingState', p.mapping_state,
        'salesTrend', p.sales_trend,
        'spendTrend', p.spend_trend,
        'tacosBand', p.tacos_band,
        'lastSalesActivityDate', p.last_sales_activity_date,
        'lastAdSpendActivityDate', p.last_ad_spend_activity_date,
        'lastAttributedSaleActivityDate', p.last_attributed_sale_activity_date,
        'flags', jsonb_build_object(
          'salesDrop', p.flag_sales_drop,
          'spendSpike', p.flag_spend_spike,
          'noAttributedSales', p.flag_no_attributed_sales,
          'tacosDeterioration', p.flag_tacos_deterioration,
          'salesGrowingStableSpend', p.flag_sales_growing_stable_spend,
          'salesGrowingSpendFalls', p.flag_sales_growing_spend_falls,
          'mappingIncomplete', p.flag_mapping_incomplete
        ),
        'selectedRange', jsonb_build_object(
          'sales', p.range_sales, 'units', p.range_units, 'spend', p.range_spend, 'attributedSales', p.range_attributed_sales,
          'acos', jsonb_build_object('value', p.range_acos_value, 'state', p.range_acos_state),
          'tacos', jsonb_build_object('value', p.range_tacos_value, 'state', p.range_tacos_state)
        ),
        'yesterday', jsonb_build_object(
          'sales', p.yesterday_sales, 'units', p.yesterday_units, 'spend', p.yesterday_spend, 'attributedSales', p.yesterday_attributed_sales,
          'acos', jsonb_build_object('value', p.yesterday_acos_value, 'state', p.yesterday_acos_state),
          'tacos', jsonb_build_object('value', p.yesterday_tacos_value, 'state', p.yesterday_tacos_state)
        ),
        'trailingSevenDay', jsonb_build_object(
          'sales', p.t7_sales, 'units', p.t7_units, 'spend', p.t7_spend, 'attributedSales', p.t7_attributed_sales,
          'acos', jsonb_build_object('value', p.t7_acos_value, 'state', p.t7_acos_state),
          'tacos', jsonb_build_object('value', p.t7_tacos_value, 'state', p.t7_tacos_state)
        ),
        'priorSevenDay', jsonb_build_object(
          'sales', p.prior7_sales, 'spend', p.prior7_spend, 'attributedSales', p.prior7_attributed_sales,
          'acos', jsonb_build_object('value', p.prior7_acos_value, 'state', p.prior7_acos_state),
          'tacos', jsonb_build_object('value', p.prior7_tacos_value, 'state', p.prior7_tacos_state)
        ),
        'trailingThirtyDay', jsonb_build_object(
          'sales', p.t30_sales, 'units', p.t30_units, 'spend', p.t30_spend, 'attributedSales', p.t30_attributed_sales,
          'acos', jsonb_build_object('value', p.t30_acos_value, 'state', p.t30_acos_state),
          'tacos', jsonb_build_object('value', p.t30_tacos_value, 'state', p.t30_tacos_state)
        )
      ) ORDER BY p.canonical_sku)
      FROM paged p
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'totalOrderedSales', sa.total_ordered_sales,
        'totalUnits', sa.total_units,
        'totalAdSpend', sa.total_ad_spend,
        'totalAttributedSales', sa.total_attributed_sales,
        'acos', CASE WHEN sa.total_ad_spend > 0 AND sa.total_attributed_sales > 0 THEN sa.total_ad_spend / sa.total_attributed_sales END,
        'tacos', CASE WHEN sa.total_ordered_sales > 0 THEN sa.total_ad_spend / sa.total_ordered_sales END,
        'skusGrowing', sa.skus_growing,
        'skusDeclining', sa.skus_declining,
        'mappingCoverage', jsonb_build_object(
          'bySkuCount', jsonb_build_object(
            'mapped', sa.by_count_mapped, 'unmapped', sa.by_count_unmapped, 'identityConflict', sa.by_count_conflict,
            'mappedPct', CASE WHEN (sa.by_count_mapped + sa.by_count_unmapped + sa.by_count_conflict) > 0
                          THEN sa.by_count_mapped::numeric / (sa.by_count_mapped + sa.by_count_unmapped + sa.by_count_conflict) END
          ),
          'bySpend', jsonb_build_object(
            'mappedSpend', sa.mapped_spend, 'unmappedSpend', sa.unmapped_spend, 'identityConflictSpend', sa.conflict_spend,
            'mappedSpendPct', CASE WHEN (sa.mapped_spend + sa.unmapped_spend + sa.conflict_spend) > 0
                                THEN sa.mapped_spend / (sa.mapped_spend + sa.unmapped_spend + sa.conflict_spend) END
          )
        ),
        'salesSourceLatestCompleteDate', v_sales_latest_complete_date,
        'adsSourceLatestCompleteDate', v_ads_latest_complete_date,
        'catalogLastSyncedAt', v_catalog_last_synced_at,
        'salesLastRunStatus', v_sales_last_run_status,
        'salesLastRunAt', v_sales_last_run_at,
        'adsLastRunStatus', v_ads_last_run_status,
        'adsLastRunAt', v_ads_last_run_at
      )
      FROM summary_agg sa
    ),
    'pagination', (
      SELECT jsonb_build_object(
        'totalSkuCountBeforeFilters', c.total_before_filters,
        'totalMatchingSkuCountAfterFilters', c.total_after_filters,
        'returnedSkuCount', c.returned_count,
        'limit', p_limit,
        'offset', p_offset,
        'hasMore', (p_offset + c.returned_count) < c.total_after_filters
      )
      FROM counts c
    ),
    'dateRange', jsonb_build_object(
      'requestedDateFrom', p_date_from,
      'requestedDateTo', p_date_to,
      'effectiveDateFrom', v_effective_date_from,
      'effectiveDateTo', p_date_to,
      'asOf', p_as_of,
      'salesHistoryStartsAt', v_sales_history_starts_at,
      'adsHistoryStartsAt', v_ads_history_starts_at,
      'wasRangeClamped', (v_effective_date_from <> p_date_from),
      'clampReason', CASE WHEN v_effective_date_from <> p_date_from THEN 'requested_start_before_available_history' END
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_sku_performance_summary(
  uuid, text, date, date, date, integer, integer, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sku_performance_summary(
  uuid, text, date, date, date, integer, integer, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, text
) TO service_role;

-- ============================================================
-- 2. get_sku_performance_daily
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_sku_performance_daily(
  p_workspace_id   uuid,
  p_marketplace_id text,
  p_sku            text,
  p_date_from      date,
  p_date_to        date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  MAX_MARKETPLACE_LEN CONSTANT integer := 40;
  MAX_SKU_LEN          CONSTANT integer := 200;
  MAX_RANGE_DAYS       CONSTANT integer := 400;

  v_canonical_sku text;
  v_result jsonb;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_sku IS NULL OR length(btrim(p_sku)) = 0 OR length(p_sku) > MAX_SKU_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_sku');
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_date_range');
  END IF;
  IF p_date_from > p_date_to THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'date_from_after_date_to');
  END IF;
  IF (p_date_to - p_date_from) > MAX_RANGE_DAYS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'range_too_large');
  END IF;
  IF p_date_to > CURRENT_DATE + 1 THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'date_to_in_future');
  END IF;

  v_canonical_sku := upper(btrim(p_sku));

  WITH ads_profiles AS (
    SELECT ap.profile_id FROM public.amazon_ads_profiles ap
    WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id
  ),
  catalog_match AS (
    SELECT li.sku AS raw_sku, li.asin, li.item_name
    FROM public.amazon_listing_items li
    WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id
      AND upper(btrim(li.sku)) = v_canonical_sku
    LIMIT 1
  ),
  ads_match AS (
    SELECT DISTINCT a.advertised_sku, a.advertised_asin
    FROM public.internal_ads_advertised_product_daily_rows a
    JOIN ads_profiles ap ON ap.profile_id = a.profile_id
    WHERE a.workspace_id = p_workspace_id AND upper(btrim(a.advertised_sku)) = v_canonical_sku
  ),
  sales_earliest AS (
    SELECT min(s.report_date) AS d FROM public.internal_business_report_sku_sales_traffic s
    WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id
  ),
  ads_earliest AS (
    SELECT min(a.report_date) AS d FROM public.internal_ads_advertised_product_daily_rows a
    JOIN ads_profiles ap ON ap.profile_id = a.profile_id
    WHERE a.workspace_id = p_workspace_id
  ),
  sales_runs AS (
    SELECT r.date_from, r.date_to, r.status, r.rows_rejected FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id AND r.marketplace_id = p_marketplace_id
      AND r.source = 'business_report_sp_api'
  ),
  ads_runs AS (
    SELECT r.date_from, r.date_to, r.status, r.rows_rejected FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id AND r.source = 'ads_advertised_product'
      AND r.profile_id IN (SELECT profile_id FROM ads_profiles)
      AND (r.marketplace_id IS NULL OR r.marketplace_id = p_marketplace_id)
  ),
  date_series AS (
    SELECT generate_series(p_date_from, p_date_to, interval '1 day')::date AS d
  ),
  sku_sales_daily AS (
    SELECT s.report_date, sum(s.ordered_product_sales) AS ordered_sales, sum(s.units_ordered) AS units
    FROM public.internal_business_report_sku_sales_traffic s
    WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id
      AND upper(btrim(s.sku)) = v_canonical_sku
      AND s.report_date BETWEEN p_date_from AND p_date_to
    GROUP BY s.report_date
  ),
  sku_ads_daily AS (
    SELECT a.report_date, sum(a.spend) AS spend, sum(a.sales) AS attributed_sales
    FROM public.internal_ads_advertised_product_daily_rows a
    JOIN ads_profiles ap ON ap.profile_id = a.profile_id
    WHERE a.workspace_id = p_workspace_id AND upper(btrim(a.advertised_sku)) = v_canonical_sku
      AND a.report_date BETWEEN p_date_from AND p_date_to
    GROUP BY a.report_date
  ),
  daily_base AS (
    SELECT
      ds.d,
      ssd.ordered_sales AS raw_sales_value,
      ssd.units AS raw_units_value,
      sad.spend AS raw_spend_value,
      sad.attributed_sales AS raw_attributed_sales_value,
      (se.d IS NOT NULL AND ds.d < se.d) AS sales_before_history,
      (ae.d IS NOT NULL AND ds.d < ae.d) AS ads_before_history,
      EXISTS (SELECT 1 FROM sales_runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d AND r.status = 'success' AND r.rows_rejected = 0) AS sales_confirmed_zero_evidence,
      EXISTS (SELECT 1 FROM sales_runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d) AS sales_any_covering_run,
      EXISTS (SELECT 1 FROM ads_runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d AND r.status = 'success' AND r.rows_rejected = 0) AS ads_confirmed_zero_evidence,
      EXISTS (SELECT 1 FROM ads_runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d) AS ads_any_covering_run
    FROM date_series ds
    CROSS JOIN sales_earliest se
    CROSS JOIN ads_earliest ae
    LEFT JOIN sku_sales_daily ssd ON ssd.report_date = ds.d
    LEFT JOIN sku_ads_daily sad ON sad.report_date = ds.d
  ),
  daily_states AS (
    SELECT
      db.d,
      CASE
        WHEN db.raw_sales_value IS NOT NULL THEN 'REPORTED_VALUE'
        WHEN db.sales_before_history THEN 'BEFORE_HISTORY'
        WHEN db.sales_confirmed_zero_evidence THEN 'CONFIRMED_ZERO'
        WHEN db.sales_any_covering_run THEN 'SOURCE_NOT_COMPLETE'
        ELSE 'UNKNOWN'
      END AS sales_coverage_state,
      CASE
        WHEN db.raw_sales_value IS NOT NULL THEN db.raw_sales_value
        WHEN NOT db.sales_before_history AND db.sales_confirmed_zero_evidence THEN 0
      END AS sales_value,
      CASE
        WHEN db.raw_units_value IS NOT NULL THEN db.raw_units_value
        WHEN NOT db.sales_before_history AND db.sales_confirmed_zero_evidence THEN 0
      END AS units_value,
      CASE
        WHEN db.raw_spend_value IS NOT NULL THEN 'REPORTED_VALUE'
        WHEN db.ads_before_history THEN 'BEFORE_HISTORY'
        WHEN db.ads_confirmed_zero_evidence THEN 'CONFIRMED_ZERO'
        WHEN db.ads_any_covering_run THEN 'SOURCE_NOT_COMPLETE'
        ELSE 'UNKNOWN'
      END AS ads_coverage_state,
      CASE
        WHEN db.raw_spend_value IS NOT NULL THEN db.raw_spend_value
        WHEN NOT db.ads_before_history AND db.ads_confirmed_zero_evidence THEN 0
      END AS spend_value,
      CASE
        WHEN db.raw_attributed_sales_value IS NOT NULL THEN db.raw_attributed_sales_value
        WHEN NOT db.ads_before_history AND db.ads_confirmed_zero_evidence THEN 0
      END AS attributed_sales_value
    FROM daily_base db
  )
  SELECT jsonb_build_object(
    'result', 'success',
    'sku', jsonb_build_object(
      'canonicalSku', v_canonical_sku,
      'catalogSku', (SELECT raw_sku FROM catalog_match),
      'catalogAsin', (SELECT asin FROM catalog_match),
      'productTitle', (SELECT item_name FROM catalog_match),
      'foundInCatalog', EXISTS (SELECT 1 FROM catalog_match),
      'advertisedSkuEvidence', COALESCE((SELECT jsonb_agg(jsonb_build_object('advertisedSku', advertised_sku, 'advertisedAsin', advertised_asin)) FROM ads_match), '[]'::jsonb)
    ),
    'days', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'date', ds2.d,
        'sales', jsonb_build_object('value', ds2.sales_value, 'coverageState', ds2.sales_coverage_state),
        'units', jsonb_build_object('value', ds2.units_value, 'coverageState', ds2.sales_coverage_state),
        'spend', jsonb_build_object('value', ds2.spend_value, 'coverageState', ds2.ads_coverage_state),
        'attributedSales', jsonb_build_object('value', ds2.attributed_sales_value, 'coverageState', ds2.ads_coverage_state),
        'acos', CASE
          WHEN ds2.spend_value IS NULL OR ds2.attributed_sales_value IS NULL THEN jsonb_build_object('value', NULL, 'state', 'unknown')
          WHEN ds2.spend_value = 0 AND ds2.attributed_sales_value = 0 THEN jsonb_build_object('value', NULL, 'state', 'not_applicable')
          WHEN ds2.spend_value > 0 AND ds2.attributed_sales_value = 0 THEN jsonb_build_object('value', NULL, 'state', 'undefined')
          ELSE jsonb_build_object('value', ds2.spend_value / ds2.attributed_sales_value, 'state', 'normal')
        END,
        'tacos', CASE
          WHEN ds2.spend_value IS NULL OR ds2.sales_value IS NULL THEN jsonb_build_object('value', NULL, 'state', 'unknown')
          WHEN ds2.spend_value = 0 AND ds2.sales_value = 0 THEN jsonb_build_object('value', NULL, 'state', 'not_applicable')
          WHEN ds2.spend_value > 0 AND ds2.sales_value = 0 THEN jsonb_build_object('value', NULL, 'state', 'undefined_high_risk')
          ELSE jsonb_build_object('value', ds2.spend_value / ds2.sales_value, 'state', 'normal')
        END
      ) ORDER BY ds2.d)
      FROM daily_states ds2
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_sku_performance_daily(uuid, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sku_performance_daily(uuid, text, text, date, date) TO service_role;
