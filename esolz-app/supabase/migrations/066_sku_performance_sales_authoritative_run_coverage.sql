-- SKU Performance -- Sales coverage-trust fix (branch
-- fix/business-report-daily-sku-grain, follow-up to the sales-grain
-- ingestion fix). UNAPPLIED as of this commit -- a repo file only, never
-- run against any database from this change. Never touches migration 065
-- in place; this is a new, forward-only migration that redefines exactly
-- the three functions below via CREATE OR REPLACE.
--
-- Amended (same commit round, still unapplied anywhere -- edited in place
-- rather than superseded, exactly per migration 065's own precedent for a
-- migration with no production history to preserve): a second pre-merge
-- review found `get_sku_performance_daily`'s `daily_states` CTE checked
-- `raw_sales_value IS NOT NULL` -> 'REPORTED_VALUE' BEFORE checking the new
-- authoritative-run predicate at all -- so a physically-present row
-- (including an old corrupted row, or the correct+stale mix a crash
-- between upsert and stale-delete can leave behind) still surfaced as
-- REPORTED_VALUE regardless of whether the exact-day authority actually
-- confirmed that date. That made this migration's "a failed/partial
-- reprocessing attempt is invisible as trustworthy data" claim false for
-- the per-day drill-down specifically (it was already true for the
-- window-level summary). `daily_states`' CASE ordering is corrected below:
-- before_history, then authority (source_not_complete/unknown when not
-- authoritative), THEN raw-row-presence (reported_value/confirmed_zero)
-- only once authoritative. See that CTE for the full explanation.
--
-- ============================================================
-- The confirmed defect this migration closes
-- ============================================================
-- Migration 065's Sales coverage logic (`_sku_perf_window_coverage`'s
-- `is_confirmed_zero`, and `get_sku_performance_daily`'s inline
-- `sales_confirmed_zero_evidence`) both used a bare EXISTS test with NO
-- "latest run" concept and NO "exact single-day scope" concept:
--
--   EXISTS (SELECT 1 FROM runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d
--                                   AND r.status = 'success' AND r.rows_rejected = 0)
--
-- ANY historical run whose date_from..date_to range merely OVERLAPS a date
-- satisfies this -- including the 35+ pre-fix multi-day rolling-window runs
-- already in production, each of which reported 'success'/rows_rejected=0
-- while writing the OLD, range-total-as-single-day-corrupted SKU rows this
-- whole effort exists to correct. Confirmed live: 2026-07-20 alone already
-- has 11 separate pre-fix multi-day 'success' runs satisfying this
-- predicate today, independent of anything a NEW single-day-grain
-- ingestion attempt does, is doing, or fails at. This defeats the
-- coverage gate's entire purpose: a crashed/partial reprocessing attempt
-- for an already-covered historical date leaves the date's window-level
-- `salesCoverageState` reading 'complete' (via the OLD record) regardless
-- of the CURRENT attempt's real outcome, which this PR's own
-- `formatWindowSales`/`formatWindowUnits` gate (and the pre-existing
-- per-day drill-down chart) then renders as trustworthy.
--
-- ============================================================
-- The locked invariant this migration implements (Sales domain only)
-- ============================================================
-- A date is COMPLETE only when BOTH:
--   1. There exists an ingestion attempt whose EXACT requested scope is
--      date_from = target_date AND date_to = target_date (an exact
--      single-day run). A multi-day run is NEVER eligible to certify a
--      SKU-day, full stop -- regardless of its own status.
--   2. Among all exact-single-day attempts for that same
--      workspace_id/marketplace_id/source/target_date, the LATEST
--      authoritative attempt (ordered by started_at DESC, run id DESC as
--      a deterministic tie-breaker -- see `_sku_perf_sales_day_confirmed`
--      below) has status='success' AND rows_rejected=0.
-- A previous exact-day success is superseded the moment a newer exact-day
-- attempt exists, even if that newer attempt is still 'running', 'failed',
-- or 'partial_success' -- there is no fallback to an older success once a
-- newer attempt has begun. No exact-day attempt at all for a date never
-- yields COMPLETE.
--
-- ============================================================
-- Scope: Sales (business_report_sp_api) ONLY -- Ads is untouched
-- ============================================================
-- Ads (`ads_advertised_product`) never had the range-total-as-single-day
-- bug -- its per-day rows are already genuinely per-day, and its normal
-- sync mode legitimately uses multi-day windows to confirm coverage. Both
-- functions below are careful to branch on `p_source`
-- (`_sku_perf_window_coverage`) / to touch ONLY the `sales_*` variables,
-- never the `ads_*` variables (`get_sku_performance_daily`), so Ads
-- coverage behavior is completely unchanged by this migration.
--
-- `has_any_run` (the boolean distinguishing 'unknown' from
-- 'source_not_complete' when a date is not confirmed) is DELIBERATELY LEFT
-- UNCHANGED for both sources -- an old multi-day pre-fix run still counts
-- as "some covering attempt happened" (that is a true fact), it just no
-- longer counts as CONFIRMING the date. This means a historical date
-- covered only by old multi-day runs simulates to 'source_not_complete'
-- (not 'unknown') under the new predicate -- see Phase 6 below and the
-- final report for the live simulation confirming this exact outcome.
--
-- ============================================================
-- Functions touched, and why each is the minimum necessary
-- ============================================================
-- 1. NEW: `_sku_perf_sales_day_confirmed(workspace, marketplace, date)`
--    -- the single shared implementation of the new invariant, so the
--    window-level and per-day-drill-down call sites can never drift apart
--    on what "confirmed" means. Plain (not SECURITY DEFINER), matching
--    every other small helper in migration 065 -- it inherits the caller's
--    already-elevated SECURITY DEFINER context exactly like
--    `_sku_perf_window_coverage`/`_sku_perf_rollup_state` already do.
-- 2. REDEFINED: `_sku_perf_window_coverage` -- ONLY the `is_confirmed_zero`
--    expression changes, and only for `p_source = 'business_report_sp_api'`
--    (the `p_source = 'ads_advertised_product'` branch is byte-identical
--    to migration 065). `has_any_run`, `is_before_history`, and every
--    other line are unchanged. `get_sku_performance_summary` itself is NOT
--    redefined -- it already delegates entirely to this function via
--    `CROSS JOIN LATERAL public._sku_perf_window_coverage(...)`, so fixing
--    this one function is sufficient to fix the summary RPC's
--    `salesCoverageState` too, with zero touch to that much larger
--    function's own body.
-- 3. REDEFINED: `get_sku_performance_daily` -- ONLY the
--    `sales_confirmed_zero_evidence` expression inside the `daily_base`
--    CTE changes. Every other line -- including the upfront identity-
--    conflict short-circuit and its `reasons`/`catalogAsin`/
--    `advertisedAsins`/raw-SKU-array evidence fields, `sales_any_covering_run`,
--    both `ads_*` predicates, and the whole `days` array's spend/
--    attributedSales/acos/tacos construction -- is reproduced byte-for-byte
--    from migration 065. This is a deliberate, narrow application of the
--    SAME fix to the SAME class of defect in a second, independent
--    call site (this function does not call `_sku_perf_window_coverage`
--    at all -- it has its own inline EXISTS copy) -- not a bundled,
--    unrelated identity-RPC change. The already-known live-deployed-vs-repo
--    version mismatch for this function's identity fields (missing
--    catalogAsin/advertisedAsins/reasons in the currently-deployed version)
--    remains a separate, untouched follow-up, exactly as before.
--
-- ============================================================
-- What this migration deliberately does NOT touch
-- ============================================================
-- - `get_sku_performance_summary`'s own function body (not redefined at
--   all -- see point 2 above).
-- - `_sku_perf_rollup_state` (still a pure function of day-counts; its
--   inputs are now more truthful, its own logic needs no change).
-- - Any Ads-domain predicate, anywhere.
-- - `v_sales_latest_accepted_complete_date` in `get_sku_performance_summary`
--   (`MAX(date_to)` over ALL successful runs, feeding the Sales source
--   HEALTH/FRESHNESS badge via source-health.ts) -- this has the same
--   category of defect (an old multi-day success can also inflate this
--   date) but feeds a DIFFERENT signal (a staleness badge, not the
--   per-value trust gate `salesCoverageState`) and would require touching
--   `get_sku_performance_summary`'s own body. Flagged as a related,
--   separate follow-up -- not fixed here, to keep this migration to the
--   minimum needed for the coverage-trust defect actually reported.
-- - The pre-existing manual/scratch-DB SQL fixture suite at
--   supabase/tests/sku-performance-p1b/sequential.sql: several of its
--   Sales-domain fixtures (e.g. its M1 "broad healthy account coverage"
--   setup, explicitly commented as relying on one multi-day range run
--   confirming every day within it) encode the OLD, now-corrected
--   assumption and will read differently under this fix. That suite is
--   not wired into `npm test` or any CI workflow (grep-confirmed) and was
--   not run in this session (no live Postgres available) -- it needs
--   dedicated updating and live re-verification by whoever next has DB
--   access, flagged here rather than edited blind.
-- - Migration 065 itself, in place -- untouched, exactly as instructed.

-- ============================================================
-- 1. New shared helper: the ONLY definition of "is this exact Sales day confirmed"
-- ============================================================
-- Returns true iff, among every internal_data_refresh_runs row for this
-- workspace/marketplace/source whose EXACT scope is date_from = date_to =
-- p_target_date, the LATEST one (started_at DESC, then id DESC as a
-- deterministic tie-breaker for the vanishingly-rare case of two rows
-- sharing the same started_at instant -- id is a random UUID, not
-- chronological, but ORDER BY on it is still fully deterministic and
-- repeatable, which is all a tie-breaker needs to be) has
-- status = 'success' AND rows_rejected = 0. A multi-day run is invisible
-- to this function by construction (the date_from = date_to filter alone
-- excludes it) -- it is never eligible to certify a day, regardless of
-- its own status. No exact-day run at all -> false (COALESCE), never
-- true, never NULL.
CREATE OR REPLACE FUNCTION public._sku_perf_sales_day_confirmed(
  p_workspace_id   uuid,
  p_marketplace_id text,
  p_target_date    date
)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT r.status = 'success' AND r.rows_rejected = 0
    FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id
      AND r.marketplace_id = p_marketplace_id
      AND r.source = 'business_report_sp_api'
      AND r.date_from = p_target_date
      AND r.date_to = p_target_date
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1
  ), false);
$$;

REVOKE EXECUTE ON FUNCTION public._sku_perf_sales_day_confirmed(uuid, text, date) FROM PUBLIC;

-- ============================================================
-- 2. _sku_perf_window_coverage -- redefined, one expression changed
-- ============================================================
CREATE OR REPLACE FUNCTION public._sku_perf_window_coverage(
  p_workspace_id    uuid,
  p_marketplace_id  text,
  p_window_from     date,
  p_window_to       date,
  p_history_start   date,
  p_source          text,
  p_ads_profile_ids text[]
)
RETURNS TABLE(
  total_days          integer,
  before_history_days integer,
  not_complete_days   integer,
  unknown_days        integer,
  problem_dates       date[]
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH ds AS (
    SELECT generate_series(p_window_from, p_window_to, interval '1 day')::date AS d
  ),
  runs AS (
    SELECT r.date_from, r.date_to, r.status, r.rows_rejected
    FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id
      AND r.source = p_source
      AND (
        (p_source = 'business_report_sp_api' AND r.marketplace_id = p_marketplace_id)
        OR (
          p_source = 'ads_advertised_product'
          AND r.profile_id = ANY (COALESCE(p_ads_profile_ids, ARRAY[]::text[]))
          AND (r.marketplace_id IS NULL OR r.marketplace_id = p_marketplace_id)
        )
      )
  ),
  classified AS (
    SELECT
      ds.d,
      (p_history_start IS NOT NULL AND ds.d < p_history_start) AS is_before_history,
      -- Sales-coverage-trust fix: for business_report_sp_api ONLY, "confirmed"
      -- now means the LATEST exact-single-day attempt for this date
      -- succeeded cleanly -- never a bare EXISTS over any overlapping
      -- range. The ads_advertised_product branch is byte-identical to
      -- migration 065 -- Ads never had the range-total-as-single-day bug
      -- and its multi-day windows legitimately confirm coverage.
      CASE
        WHEN p_source = 'business_report_sp_api' THEN
          public._sku_perf_sales_day_confirmed(p_workspace_id, p_marketplace_id, ds.d)
        ELSE
          EXISTS (SELECT 1 FROM runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d AND r.status = 'success' AND r.rows_rejected = 0)
      END AS is_confirmed_zero,
      -- Deliberately UNCHANGED for both sources: an old multi-day run still
      -- counts as "some covering attempt happened" (true), it just no
      -- longer counts as confirming the date. This is what makes a
      -- historical date covered only by old multi-day runs simulate to
      -- 'source_not_complete' (not 'unknown') under the new predicate.
      EXISTS (SELECT 1 FROM runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d) AS has_any_run
    FROM ds
  )
  SELECT
    count(*)::integer AS total_days,
    count(*) FILTER (WHERE is_before_history)::integer AS before_history_days,
    count(*) FILTER (WHERE NOT is_before_history AND NOT is_confirmed_zero AND has_any_run)::integer AS not_complete_days,
    count(*) FILTER (WHERE NOT is_before_history AND NOT is_confirmed_zero AND NOT has_any_run)::integer AS unknown_days,
    COALESCE(array_agg(d) FILTER (WHERE NOT is_before_history AND NOT is_confirmed_zero), ARRAY[]::date[]) AS problem_dates
  FROM classified;
$$;

REVOKE EXECUTE ON FUNCTION public._sku_perf_window_coverage(uuid, text, date, date, date, text, text[]) FROM PUBLIC;

-- ============================================================
-- 3. get_sku_performance_daily -- redefined, one expression changed
-- ============================================================
-- Reproduced byte-for-byte from migration 065 except the single
-- `sales_confirmed_zero_evidence` line inside `daily_base` (marked below).
-- Every identity-conflict field (reasons/catalogAsin/advertisedAsins/raw-SKU
-- evidence arrays), every Ads-side predicate, and every other line is
-- preserved exactly as committed -- not redesigned, not dropped, not
-- "fixed" as a side effect.
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
-- Performance: same JIT-compilation-cost rationale as get_sku_performance_summary above.
SET jit = off
AS $$
DECLARE
  MAX_MARKETPLACE_LEN CONSTANT integer := 40;
  MAX_SKU_LEN          CONSTANT integer := 200;
  MAX_RANGE_DAYS       CONSTANT integer := 400;

  v_marketplace_timezone text;
  v_today date;
  v_canonical_sku text;
  v_ads_profile_ids text[];

  v_catalog_raw_skus text[];
  v_sales_raw_skus   text[];
  v_ads_raw_skus     text[];
  v_cost_raw_skus    text[];
  v_catalog_asin      text;
  v_advertised_asins  text[];
  v_is_ads_absent            boolean;
  v_has_raw_sku_collision    boolean;
  v_has_asin_mismatch        boolean;
  v_is_identity_conflict     boolean;
  v_conflict_reasons         text[];

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
  -- Inclusive day-count ceiling: p_date_to - p_date_from is the day
  -- DIFFERENCE, not the number of calendar dates in range (both endpoints
  -- are inclusive) -- +1 to count actual inclusive days, so MAX_RANGE_DAYS
  -- really means "at most this many calendar dates," not "this many plus
  -- one." Exactly MAX_RANGE_DAYS inclusive dates is accepted; one more is
  -- rejected.
  IF (p_date_to - p_date_from + 1) > MAX_RANGE_DAYS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'range_too_large');
  END IF;

  SELECT ap.timezone INTO v_marketplace_timezone
  FROM public.amazon_ads_profiles ap
  WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id
    AND ap.timezone IS NOT NULL
  LIMIT 1;
  v_today := CASE WHEN v_marketplace_timezone IS NOT NULL
    THEN (now() AT TIME ZONE v_marketplace_timezone)::date
    ELSE CURRENT_DATE
  END;
  IF p_date_to > v_today THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'date_to_in_future');
  END IF;

  v_canonical_sku := upper(btrim(p_sku));

  SELECT array_agg(ap.profile_id) INTO v_ads_profile_ids
  FROM public.amazon_ads_profiles ap
  WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id;
  v_ads_profile_ids := COALESCE(v_ads_profile_ids, ARRAY[]::text[]);

  -- Collision/mismatch check upfront, across all four sources, before any
  -- day-by-day work -- an identity_conflict SKU never gets a combined
  -- series. Follow-up correction: this now mirrors get_sku_performance_
  -- summary's mapping_state decision EXACTLY (same two conflict reasons,
  -- same precedence), so the two RPCs never disagree about whether a given
  -- canonical SKU is identity_conflict.
  SELECT array_agg(DISTINCT li.sku) INTO v_catalog_raw_skus
  FROM public.amazon_listing_items li
  WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id
    AND upper(btrim(li.sku)) = v_canonical_sku;

  SELECT array_agg(DISTINCT s.sku) INTO v_sales_raw_skus
  FROM public.internal_business_report_sku_sales_traffic s
  WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id
    AND upper(btrim(s.sku)) = v_canonical_sku;

  SELECT array_agg(DISTINCT a.advertised_sku) INTO v_ads_raw_skus
  FROM public.internal_ads_advertised_product_daily_rows a
  WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
    AND upper(btrim(a.advertised_sku)) = v_canonical_sku;

  SELECT array_agg(DISTINCT c.sku) INTO v_cost_raw_skus
  FROM public.internal_sku_cost_master c
  WHERE c.workspace_id = p_workspace_id AND upper(btrim(c.sku)) = v_canonical_sku;

  -- Catalog ASIN (single value -- amazon_listing_items is unique per
  -- workspace/sku/marketplace) and the distinct set of advertised ASINs,
  -- for the ASIN-mismatch reason.
  SELECT li.asin INTO v_catalog_asin
  FROM public.amazon_listing_items li
  WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id
    AND upper(btrim(li.sku)) = v_canonical_sku
  LIMIT 1;

  SELECT array_agg(DISTINCT a.advertised_asin) INTO v_advertised_asins
  FROM public.internal_ads_advertised_product_daily_rows a
  WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
    AND upper(btrim(a.advertised_sku)) = v_canonical_sku;

  v_is_ads_absent := (v_ads_raw_skus IS NULL);

  SELECT count(DISTINCT x) > 1 INTO v_has_raw_sku_collision
  FROM unnest(
    COALESCE(v_catalog_raw_skus, ARRAY[]::text[]) || COALESCE(v_sales_raw_skus, ARRAY[]::text[]) ||
    COALESCE(v_ads_raw_skus, ARRAY[]::text[]) || COALESCE(v_cost_raw_skus, ARRAY[]::text[])
  ) AS x;

  -- Guard on v_catalog_asin IS NOT NULL -- without it, a catalog-absent SKU
  -- would spuriously read as a "mismatch" the moment any advertised ASIN
  -- exists, since `x IS DISTINCT FROM NULL` is true for every non-null x.
  SELECT (v_catalog_asin IS NOT NULL) AND EXISTS (
    SELECT 1 FROM unnest(COALESCE(v_advertised_asins, ARRAY[]::text[])) x
    WHERE x IS NOT NULL AND x IS DISTINCT FROM v_catalog_asin
  ) INTO v_has_asin_mismatch;

  -- Mirrors the summary RPC's precedence exactly: an ads-absent SKU is
  -- never identity_conflict there (it is not_applicable instead, checked
  -- before the collision/mismatch branches), so an ads-absent SKU must
  -- never short-circuit here either, even if it happens to have a raw-SKU
  -- collision purely among Catalog/Sales/Cost Master.
  v_is_identity_conflict := (NOT v_is_ads_absent) AND (v_has_raw_sku_collision OR v_has_asin_mismatch);

  IF v_is_identity_conflict THEN
    v_conflict_reasons := array_remove(ARRAY[
      CASE WHEN v_has_raw_sku_collision THEN 'raw_sku_collision' END,
      CASE WHEN v_has_asin_mismatch THEN 'advertised_asin_catalog_asin_mismatch' END
    ], NULL);
    RETURN jsonb_build_object(
      'result', 'identity_conflict',
      'canonicalSku', v_canonical_sku,
      'evidence', jsonb_build_object(
        'reasons', to_jsonb(v_conflict_reasons),
        'catalogAsin', v_catalog_asin,
        'advertisedAsins', to_jsonb(COALESCE(v_advertised_asins, ARRAY[]::text[])),
        'catalogRawSkus', to_jsonb(COALESCE(v_catalog_raw_skus, ARRAY[]::text[])),
        'salesRawSkus', to_jsonb(COALESCE(v_sales_raw_skus, ARRAY[]::text[])),
        'adsRawSkus', to_jsonb(COALESCE(v_ads_raw_skus, ARRAY[]::text[])),
        'costMasterRawSkus', to_jsonb(COALESCE(v_cost_raw_skus, ARRAY[]::text[]))
      )
    );
  END IF;

  WITH catalog_match AS (
    SELECT li.sku AS raw_sku, li.asin, li.item_name
    FROM public.amazon_listing_items li
    WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id
      AND upper(btrim(li.sku)) = v_canonical_sku
    LIMIT 1
  ),
  ads_match AS (
    SELECT DISTINCT a.advertised_sku, a.advertised_asin
    FROM public.internal_ads_advertised_product_daily_rows a
    WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
      AND upper(btrim(a.advertised_sku)) = v_canonical_sku
  ),
  sales_earliest AS (
    SELECT min(s.report_date) AS d FROM public.internal_business_report_sku_sales_traffic s
    WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id
  ),
  ads_earliest AS (
    SELECT min(a.report_date) AS d FROM public.internal_ads_advertised_product_daily_rows a
    WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
  ),
  sales_runs AS (
    SELECT r.date_from, r.date_to, r.status, r.rows_rejected FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id AND r.marketplace_id = p_marketplace_id
      AND r.source = 'business_report_sp_api'
  ),
  ads_runs AS (
    SELECT r.date_from, r.date_to, r.status, r.rows_rejected FROM public.internal_data_refresh_runs r
    WHERE r.workspace_id = p_workspace_id AND r.source = 'ads_advertised_product'
      AND r.profile_id = ANY (v_ads_profile_ids)
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
    WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
      AND upper(btrim(a.advertised_sku)) = v_canonical_sku
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
      -- Sales-coverage-trust fix: the SAME class of defect as
      -- _sku_perf_window_coverage's is_confirmed_zero, in a second,
      -- independent inline copy -- an absent SKU-row's zero could be
      -- "confirmed" by an old multi-day pre-fix run that never actually
      -- validated this specific SKU's true zero-vs-nonzero status for
      -- this exact day. Now routed through the same shared
      -- _sku_perf_sales_day_confirmed() helper _sku_perf_window_coverage
      -- uses, so the window-level and per-day views can never disagree
      -- about which dates are Sales-confirmed.
      public._sku_perf_sales_day_confirmed(p_workspace_id, p_marketplace_id, ds.d) AS sales_confirmed_zero_evidence,
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
      -- Daily raw-value-leak fix (found in pre-merge review of the first
      -- version of this migration): the ORIGINAL ordering here checked
      -- `raw_sales_value IS NOT NULL` FIRST, before the new authoritative-
      -- run predicate -- so a physically-present row (including an old
      -- corrupted row, or the correct+stale mix a crash between upsert and
      -- stale-delete can leave behind) still surfaced as REPORTED_VALUE
      -- regardless of what `sales_confirmed_zero_evidence` (the exact-day
      -- authority check) said. That made the "a failed/partial reprocessing
      -- attempt is invisible as trustworthy data" guarantee false for this
      -- function specifically -- true only for the window-level summary.
      -- Authority (and before-history) is now checked FIRST: a raw row is
      -- only ever read as REPORTED_VALUE, and a missing row only ever read
      -- as CONFIRMED_ZERO, once the exact-day authoritative run for that
      -- date has actually succeeded. before_history is structurally
      -- disjoint from "a raw row exists" (a row can never predate the
      -- workspace/marketplace's own earliest row), but is still checked
      -- ahead of authority for clarity and defense in depth.
      CASE
        WHEN db.sales_before_history THEN 'BEFORE_HISTORY'
        WHEN NOT db.sales_confirmed_zero_evidence AND db.sales_any_covering_run THEN 'SOURCE_NOT_COMPLETE'
        WHEN NOT db.sales_confirmed_zero_evidence THEN 'UNKNOWN'
        WHEN db.raw_sales_value IS NOT NULL THEN 'REPORTED_VALUE'
        ELSE 'CONFIRMED_ZERO'
      END AS sales_coverage_state,
      CASE
        WHEN db.sales_before_history THEN NULL
        WHEN NOT db.sales_confirmed_zero_evidence THEN NULL
        WHEN db.raw_sales_value IS NOT NULL THEN db.raw_sales_value
        ELSE 0
      END AS sales_value,
      CASE
        WHEN db.sales_before_history THEN NULL
        WHEN NOT db.sales_confirmed_zero_evidence THEN NULL
        WHEN db.raw_units_value IS NOT NULL THEN db.raw_units_value
        ELSE 0
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

notify pgrst, 'reload schema';
