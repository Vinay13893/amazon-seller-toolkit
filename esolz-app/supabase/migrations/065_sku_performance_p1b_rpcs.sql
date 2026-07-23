-- SKU Performance P1-B: the two read-only, SECURITY DEFINER RPCs this
-- feature's entire data-access surface goes through, plus two small
-- internal helper functions.
--
-- Amended 2026-07-23 -- P1-B correction round ("Fix 1-6" + narrow contract
-- cleanup), closing six correctness blockers an independent code review
-- found. This migration has never been applied anywhere except a
-- disposable local scratch database, so it is edited IN PLACE rather than
-- superseded by a new migration file -- there is no production history to
-- preserve. Full list of what changed and why: BRAHMASTRA_MASTER_TRACKER.md
-- sec23 update 7.
--
-- Follows the Pincode Checker P0-A/P0-B convention: narrow, SECURITY
-- DEFINER, explicit search_path, EXECUTE revoked from PUBLIC and granted
-- only to service_role, every parameter validated before any query, no
-- generic RPC passthrough. No materialized table. No write of any kind to
-- any existing source table. All four functions below are pure reads.
--
-- ============================================================
-- Implementation decisions recorded here (never silently assumed):
-- ============================================================
-- 1. internal_ads_advertised_product_daily_rows has NO marketplace_id
--    column of its own -- Ads rows are scoped via
--    amazon_ads_profiles.profile_id -> amazon_ads_profiles.marketplace_id.
-- 2. Ads-side internal_data_refresh_runs matching filters by workspace_id +
--    profile_id (resolved via amazon_ads_profiles), and only ALSO requires
--    marketplace_id equality when that column is non-null on the run row.
--    Business Report matching filters by workspace_id + marketplace_id
--    directly.
-- 3. Product Spec's "Mapping coverage" card (SKU-count ratio) and
--    Implementation Plan's "spend-weighted mapping coverage" (spend-$
--    ratio) are two different, both-locked metrics -- returned as both
--    `mappingCoverage.bySkuCount` and `.bySpend`.
-- 4. `stale_metadata` (from the Data Audit's mapping-state vocabulary) is
--    DELIBERATELY NOT implemented anywhere in this migration -- the audit
--    itself found it "not currently provable per-row." This is an explicit
--    MVP deferral, not an oversight: `mapping_state` only ever takes the
--    values mapped/unmapped/identity_conflict/not_applicable.
-- 5. The driving SKU universe is the ALL-TIME canonical union of
--    Catalog + Business Report + Ads for the workspace+marketplace scope.
--    internal_sku_cost_master has NO marketplace_id column at all (it is
--    workspace-scoped only) and is therefore NEVER unioned into the
--    universe directly -- doing so would leak a cost-master-only SKU into
--    every marketplace the workspace has, regardless of whether that SKU
--    is actually sold/advertised there. Cost Master only ENRICHES a
--    canonical SKU already present via Catalog/Sales/Ads.
-- 6. Source-health *State classification (healthy/stale/failed/
--    not_configured/auth_required/rate_limited) is computed in TypeScript
--    (lib/sku-performance/source-health.ts), not SQL -- this RPC returns
--    only the raw facts a classifier needs. See that file's header comment
--    for why, and for the recorded scope limitation that it never returns
--    auth_required/rate_limited.
-- 7. (Fix 6) "Latest complete date" was a mislabeled fact in the previous
--    round -- it was actually just MAX(report_date), the latest date ANY
--    row exists for, regardless of whether the refresh run that produced
--    it was ever accepted as fully successful. This round separates that
--    into `salesLatestDataDate`/`adsLatestDataDate` (the old, honestly
--    relabeled fact) and `salesLatestAcceptedCompleteDate`/
--    `adsLatestAcceptedCompleteDate` (MAX(date_to) among accepted
--    successful runs only -- the fact actually needed for a trustworthy
--    staleness/health judgement).
-- 8. (Fix 1 + Fix 3) Per-(window, source) coverage is classified into
--    complete/partial/before_history/source_not_complete/unknown -- see
--    `_sku_perf_window_coverage()` and `_sku_perf_rollup_state()` below.
--    A combined ratio (TACOS specifically -- Ads spend over Sales revenue)
--    is only ever computed from sums taken over the two sources' COMMON
--    comparable sub-range within a window, and only when both sources'
--    coverage for that window is `complete` -- never from each source's
--    own, potentially-longer, individually-clamped range. A cross-source
--    metric where either source is entirely missing history is `unknown`,
--    never silently computed as if the missing source were zero.
-- 9. (Fix 4) Canonical-collision detection combines raw-SKU evidence from
--    ALL FOUR sources (Catalog, Business Report, Ads, Cost Master) into one
--    set per canonical key -- a collision anywhere in that combined set
--    (same-source or cross-source) makes the row `identity_conflict`. An
--    identity_conflict row's numeric fields (every window, every trend,
--    every flag except mappingIncomplete) are suppressed entirely (NULL)
--    rather than computed from what might be two distinct real products'
--    merged data -- it carries `identityConflictEvidence` instead.
-- 10. (Fix 5) Future-date rejection uses the requesting marketplace's own
--     Ads-profile timezone when one is configured (an exact marketplace-
--     local "today"); when no timezone is resolvable, it fails
--     conservatively -- CURRENT_DATE with no grace day, not
--     CURRENT_DATE + 1 as the previous round allowed.
-- 11. (Performance) Both entry-point RPCs set `jit = off`. Their plan-tree
--     cost estimate (from the wide per-window/per-source CASE and
--     jsonb_build_object expressions repeated per candidate row) crosses
--     Postgres's JIT cost thresholds, triggering full compilation of
--     ~200 expression functions on every call. On the representative
--     500-SKU/90-day benchmark that compilation alone cost ~11s of a
--     ~12.4s call while actual execution took ~1.1s -- JIT never pays back
--     its own compilation cost for a query this shape runs once per call.
--     Disabling it per-function (not server-wide) cut the same call to
--     ~0.95s with no plan-shape or index change.

-- ============================================================
-- 0. Supporting indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS internal_data_refresh_runs_success_coverage_idx
  ON public.internal_data_refresh_runs (workspace_id, source, date_from, date_to)
  WHERE status = 'success' AND rows_rejected = 0;

CREATE INDEX IF NOT EXISTS internal_data_refresh_runs_any_coverage_idx
  ON public.internal_data_refresh_runs (workspace_id, source, date_from, date_to);

-- ============================================================
-- 1. Internal helper: per-(window, source) coverage rollup
-- ============================================================
-- Classifies ONE date range for ONE source (never per-SKU -- coverage is a
-- source-level fact) into day counts plus the list of "problem dates"
-- (days that are neither before_history nor confirmed_zero -- i.e. days
-- whose truth this source cannot yet prove one way or the other without a
-- per-SKU real row). Called once per (window, source) pair by both RPCs
-- below (10 calls per get_sku_performance_summary invocation, 2 per
-- get_sku_performance_daily invocation) -- NOT once per SKU, which is what
-- keeps this affordable at volume.
--
-- p_source is the literal internal_data_refresh_runs.source value
-- ('business_report_sp_api' or 'ads_advertised_product'); p_ads_profile_ids
-- is only consulted when p_source = 'ads_advertised_product'.
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
      EXISTS (SELECT 1 FROM runs r WHERE r.date_from <= ds.d AND r.date_to >= ds.d AND r.status = 'success' AND r.rows_rejected = 0) AS is_confirmed_zero,
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
-- 2. Internal helper: coverage-state rollup (source-level or per-SKU)
-- ============================================================
-- Given a window's day-count breakdown (from _sku_perf_window_coverage)
-- and how many of that window's "problem dates" a specific SKU (or, for a
-- workspace-wide aggregate, the whole scope) individually has a real
-- reported row for, returns exactly one of:
--   'before_history'    -- the entire window predates this source's history
--   'complete'           -- every problem date is individually resolved
--   'source_not_complete' -- every unresolved problem date had a covering
--                            attempt, none of which fully succeeded
--   'unknown'            -- every unresolved problem date has no covering
--                            evidence at all
--   'partial'             -- a mix: some problem dates resolved, some not,
--                            or the unresolved ones are a mix of the two
--                            causes above
CREATE OR REPLACE FUNCTION public._sku_perf_rollup_state(
  p_total_days          integer,
  p_before_history_days integer,
  p_not_complete_days   integer,
  p_unknown_days        integer,
  p_missing_count       bigint,
  p_problem_count       bigint
)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_before_history_days = p_total_days THEN 'before_history'
    WHEN p_missing_count = 0 THEN 'complete'
    WHEN p_missing_count = p_problem_count THEN
      CASE
        WHEN p_unknown_days > 0 AND p_not_complete_days = 0 THEN 'unknown'
        WHEN p_not_complete_days > 0 AND p_unknown_days = 0 THEN 'source_not_complete'
        ELSE 'partial'
      END
    ELSE 'partial'
  END;
$$;

-- ============================================================
-- 3. get_sku_performance_summary
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
-- Performance (P1-B correction round): this function's plan-tree cost
-- estimate (driven by the wide per-window/per-source CASE and
-- jsonb_build_object expressions repeated over every candidate row) easily
-- crosses jit_above_cost/jit_optimize_above_cost, triggering full JIT
-- compilation of ~200 expression functions on every call. Measured on the
-- representative 500-SKU/90-day benchmark, that JIT compilation alone
-- accounted for ~11s of a ~12.4s call (Optimization + Emission phases),
-- while actual plan execution finished in ~1.1s -- the query never runs
-- long enough per call for JIT's compiled code to pay back its own
-- compilation cost. Disabling JIT for this function specifically (not
-- globally) turned ~12.4s into ~0.95s with no plan-shape or index change.
SET jit = off
AS $$
DECLARE
  MAX_MARKETPLACE_LEN CONSTANT integer := 40;
  MAX_FILTER_LEN       CONSTANT integer := 200;
  MAX_LIMIT            CONSTANT integer := 500;
  MAX_OFFSET           CONSTANT integer := 1000000;
  MAX_RANGE_DAYS       CONSTANT integer := 400;
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

  v_marketplace_timezone text;
  v_today                date;

  v_currency_count integer;
  v_currency_code   text;
  v_ads_profile_ids text[];

  v_sales_history_starts_at date;
  v_ads_history_starts_at   date;
  v_sales_effective_date_from date;
  v_ads_effective_date_from   date;
  v_common_effective_date_from date;
  v_common_effective_date_to   date;
  v_clamp_reasons text[];

  v_sales_latest_data_date            date;
  v_ads_latest_data_date              date;
  v_sales_latest_accepted_complete_date date;
  v_ads_latest_accepted_complete_date   date;
  v_catalog_last_synced_at     timestamptz;
  v_sales_last_run_status      text;
  v_sales_last_run_at          timestamptz;
  v_sales_last_run_rows_rejected integer;
  v_ads_last_run_status        text;
  v_ads_last_run_at            timestamptz;
  v_ads_last_run_rows_rejected integer;

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
  IF (p_date_to - p_date_from) > MAX_RANGE_DAYS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'range_too_large');
  END IF;
  IF p_as_of IS NULL THEN
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

  -- ---------- Fix 5: marketplace-local "today", fail conservative ----------
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
  IF p_as_of > v_today THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_as_of');
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

  -- ---------- Currency contract: reject a multi-currency scope outright ----------
  SELECT count(DISTINCT ap.currency_code), min(ap.currency_code), array_agg(ap.profile_id)
    INTO v_currency_count, v_currency_code, v_ads_profile_ids
  FROM public.amazon_ads_profiles ap
  WHERE ap.workspace_id = p_workspace_id AND ap.marketplace_id = p_marketplace_id;

  IF v_currency_count > 1 THEN
    RETURN jsonb_build_object('result', 'currency_mismatch');
  END IF;
  v_ads_profile_ids := COALESCE(v_ads_profile_ids, ARRAY[]::text[]);

  -- ---------- Fix 1: per-source history + effective/common range ----------
  SELECT min(s.report_date) INTO v_sales_history_starts_at
  FROM public.internal_business_report_sku_sales_traffic s
  WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id;

  SELECT min(a.report_date) INTO v_ads_history_starts_at
  FROM public.internal_ads_advertised_product_daily_rows a
  WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids);

  v_sales_effective_date_from := GREATEST(p_date_from, COALESCE(v_sales_history_starts_at, p_date_from));
  v_ads_effective_date_from := GREATEST(p_date_from, COALESCE(v_ads_history_starts_at, p_date_from));

  -- Fix 1: never coalesce an entirely-missing source into the common range
  -- as though it existed -- commonEffectiveDateFrom/To are NULL when either
  -- source has no history at all.
  IF v_sales_history_starts_at IS NULL OR v_ads_history_starts_at IS NULL THEN
    v_common_effective_date_from := NULL;
    v_common_effective_date_to := NULL;
  ELSE
    v_common_effective_date_from := GREATEST(p_date_from, v_sales_history_starts_at, v_ads_history_starts_at);
    v_common_effective_date_to := p_date_to;
  END IF;

  v_clamp_reasons := array_remove(ARRAY[
    CASE WHEN v_sales_effective_date_from <> p_date_from THEN 'requested_start_before_sales_history' END,
    CASE WHEN v_ads_effective_date_from <> p_date_from THEN 'requested_start_before_ads_history' END,
    CASE WHEN v_sales_history_starts_at IS NULL THEN 'sales_source_has_no_history_at_all' END,
    CASE WHEN v_ads_history_starts_at IS NULL THEN 'ads_source_has_no_history_at_all' END
  ], NULL);

  -- ---------- Fix 6: truthful source freshness facts ----------
  SELECT max(s.report_date) INTO v_sales_latest_data_date
  FROM public.internal_business_report_sku_sales_traffic s
  WHERE s.workspace_id = p_workspace_id AND s.marketplace_id = p_marketplace_id;

  SELECT max(a.report_date) INTO v_ads_latest_data_date
  FROM public.internal_ads_advertised_product_daily_rows a
  WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids);

  SELECT max(r.date_to) INTO v_sales_latest_accepted_complete_date
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.marketplace_id = p_marketplace_id
    AND r.source = 'business_report_sp_api' AND r.status = 'success' AND r.rows_rejected = 0;

  SELECT max(r.date_to) INTO v_ads_latest_accepted_complete_date
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.source = 'ads_advertised_product'
    AND r.profile_id = ANY (v_ads_profile_ids)
    AND (r.marketplace_id IS NULL OR r.marketplace_id = p_marketplace_id)
    AND r.status = 'success' AND r.rows_rejected = 0;

  SELECT max(li.last_synced_at) INTO v_catalog_last_synced_at
  FROM public.amazon_listing_items li
  WHERE li.workspace_id = p_workspace_id AND li.marketplace_id = p_marketplace_id;

  SELECT r.status, r.started_at, r.rows_rejected INTO v_sales_last_run_status, v_sales_last_run_at, v_sales_last_run_rows_rejected
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.marketplace_id = p_marketplace_id
    AND r.source = 'business_report_sp_api'
  ORDER BY r.started_at DESC LIMIT 1;

  SELECT r.status, r.started_at, r.rows_rejected INTO v_ads_last_run_status, v_ads_last_run_at, v_ads_last_run_rows_rejected
  FROM public.internal_data_refresh_runs r
  WHERE r.workspace_id = p_workspace_id AND r.source = 'ads_advertised_product'
    AND r.profile_id = ANY (v_ads_profile_ids)
    AND (r.marketplace_id IS NULL OR r.marketplace_id = p_marketplace_id)
  ORDER BY r.started_at DESC LIMIT 1;

  -- ---------- Main aggregation ----------
  WITH window_specs (window_name, window_from, window_to) AS (
    VALUES
      ('range', p_date_from, p_date_to),
      ('yesterday', p_as_of, p_as_of),
      ('t7', p_as_of - 6, p_as_of),
      ('prior7', p_as_of - 13, p_as_of - 7),
      ('t30', p_as_of - 29, p_as_of)
  ),
  source_specs (source_key, refresh_run_source, history_start) AS (
    VALUES
      ('sales', 'business_report_sp_api', v_sales_history_starts_at),
      ('ads', 'ads_advertised_product', v_ads_history_starts_at)
  ),
  window_coverage_raw AS (
    SELECT ws.window_name, ss.source_key, wc.*
    FROM window_specs ws
    CROSS JOIN source_specs ss
    CROSS JOIN LATERAL public._sku_perf_window_coverage(
      p_workspace_id, p_marketplace_id, ws.window_from, ws.window_to,
      ss.history_start, ss.refresh_run_source, v_ads_profile_ids
    ) wc
  ),
  wc AS (
    SELECT
      max(total_days) FILTER (WHERE window_name = 'range' AND source_key = 'sales') AS sel_sales_total,
      max(before_history_days) FILTER (WHERE window_name = 'range' AND source_key = 'sales') AS sel_sales_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'range' AND source_key = 'sales') AS sel_sales_nc,
      max(unknown_days) FILTER (WHERE window_name = 'range' AND source_key = 'sales') AS sel_sales_unk,
      max(problem_dates) FILTER (WHERE window_name = 'range' AND source_key = 'sales') AS sel_sales_problem,
      max(total_days) FILTER (WHERE window_name = 'range' AND source_key = 'ads') AS sel_ads_total,
      max(before_history_days) FILTER (WHERE window_name = 'range' AND source_key = 'ads') AS sel_ads_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'range' AND source_key = 'ads') AS sel_ads_nc,
      max(unknown_days) FILTER (WHERE window_name = 'range' AND source_key = 'ads') AS sel_ads_unk,
      max(problem_dates) FILTER (WHERE window_name = 'range' AND source_key = 'ads') AS sel_ads_problem,

      max(total_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'sales') AS yst_sales_total,
      max(before_history_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'sales') AS yst_sales_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'sales') AS yst_sales_nc,
      max(unknown_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'sales') AS yst_sales_unk,
      max(problem_dates) FILTER (WHERE window_name = 'yesterday' AND source_key = 'sales') AS yst_sales_problem,
      max(total_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'ads') AS yst_ads_total,
      max(before_history_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'ads') AS yst_ads_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'ads') AS yst_ads_nc,
      max(unknown_days) FILTER (WHERE window_name = 'yesterday' AND source_key = 'ads') AS yst_ads_unk,
      max(problem_dates) FILTER (WHERE window_name = 'yesterday' AND source_key = 'ads') AS yst_ads_problem,

      max(total_days) FILTER (WHERE window_name = 't7' AND source_key = 'sales') AS t7_sales_total,
      max(before_history_days) FILTER (WHERE window_name = 't7' AND source_key = 'sales') AS t7_sales_bh,
      max(not_complete_days) FILTER (WHERE window_name = 't7' AND source_key = 'sales') AS t7_sales_nc,
      max(unknown_days) FILTER (WHERE window_name = 't7' AND source_key = 'sales') AS t7_sales_unk,
      max(problem_dates) FILTER (WHERE window_name = 't7' AND source_key = 'sales') AS t7_sales_problem,
      max(total_days) FILTER (WHERE window_name = 't7' AND source_key = 'ads') AS t7_ads_total,
      max(before_history_days) FILTER (WHERE window_name = 't7' AND source_key = 'ads') AS t7_ads_bh,
      max(not_complete_days) FILTER (WHERE window_name = 't7' AND source_key = 'ads') AS t7_ads_nc,
      max(unknown_days) FILTER (WHERE window_name = 't7' AND source_key = 'ads') AS t7_ads_unk,
      max(problem_dates) FILTER (WHERE window_name = 't7' AND source_key = 'ads') AS t7_ads_problem,

      max(total_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'sales') AS p7_sales_total,
      max(before_history_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'sales') AS p7_sales_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'sales') AS p7_sales_nc,
      max(unknown_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'sales') AS p7_sales_unk,
      max(problem_dates) FILTER (WHERE window_name = 'prior7' AND source_key = 'sales') AS p7_sales_problem,
      max(total_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'ads') AS p7_ads_total,
      max(before_history_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'ads') AS p7_ads_bh,
      max(not_complete_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'ads') AS p7_ads_nc,
      max(unknown_days) FILTER (WHERE window_name = 'prior7' AND source_key = 'ads') AS p7_ads_unk,
      max(problem_dates) FILTER (WHERE window_name = 'prior7' AND source_key = 'ads') AS p7_ads_problem,

      max(total_days) FILTER (WHERE window_name = 't30' AND source_key = 'sales') AS t30_sales_total,
      max(before_history_days) FILTER (WHERE window_name = 't30' AND source_key = 'sales') AS t30_sales_bh,
      max(not_complete_days) FILTER (WHERE window_name = 't30' AND source_key = 'sales') AS t30_sales_nc,
      max(unknown_days) FILTER (WHERE window_name = 't30' AND source_key = 'sales') AS t30_sales_unk,
      max(problem_dates) FILTER (WHERE window_name = 't30' AND source_key = 'sales') AS t30_sales_problem,
      max(total_days) FILTER (WHERE window_name = 't30' AND source_key = 'ads') AS t30_ads_total,
      max(before_history_days) FILTER (WHERE window_name = 't30' AND source_key = 'ads') AS t30_ads_bh,
      max(not_complete_days) FILTER (WHERE window_name = 't30' AND source_key = 'ads') AS t30_ads_nc,
      max(unknown_days) FILTER (WHERE window_name = 't30' AND source_key = 'ads') AS t30_ads_unk,
      max(problem_dates) FILTER (WHERE window_name = 't30' AND source_key = 'ads') AS t30_ads_problem
    FROM window_coverage_raw
  ),
  ads_profiles AS (
    SELECT unnest(v_ads_profile_ids) AS profile_id
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
    WHERE a.workspace_id = p_workspace_id AND a.profile_id = ANY (v_ads_profile_ids)
      AND a.advertised_sku IS NOT NULL AND btrim(a.advertised_sku) <> ''
  ),
  -- Fix: narrow contract cleanup #1 -- Cost Master has no marketplace_id
  -- and must never independently introduce a canonical SKU into the
  -- marketplace-scoped universe. It is joined for enrichment only, below.
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
           (sd.canonical_sku IS NOT NULL) AS sales_has_row,
           COALESCE(ad.spend, 0) AS spend,
           COALESCE(ad.attributed_sales, 0) AS attributed_sales,
           (ad.canonical_sku IS NOT NULL) AS ads_has_row
    FROM sales_daily sd
    FULL OUTER JOIN ads_daily ad ON ad.canonical_sku = sd.canonical_sku AND ad.report_date = sd.report_date
  ),
  sku_metrics AS (
    SELECT
      u.canonical_sku,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN p_date_from AND p_date_to), 0) AS range_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN p_date_from AND p_date_to), 0) AS range_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN p_date_from AND p_date_to), 0) AS range_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN p_date_from AND p_date_to), 0) AS range_attributed_sales,
      -- Fix 1: common-comparable-range sums, used ONLY for the range TACOS ratio
      COALESCE(sum(f.ordered_sales) FILTER (WHERE v_common_effective_date_from IS NOT NULL AND f.report_date BETWEEN v_common_effective_date_from AND p_date_to), 0) AS range_sales_common,
      COALESCE(sum(f.spend) FILTER (WHERE v_common_effective_date_from IS NOT NULL AND f.report_date BETWEEN v_common_effective_date_from AND p_date_to), 0) AS range_spend_common,
      count(DISTINCT f.report_date) FILTER (WHERE f.sales_has_row AND f.report_date = ANY (wc.sel_sales_problem)) AS range_sales_problem_resolved,
      count(DISTINCT f.report_date) FILTER (WHERE f.ads_has_row AND f.report_date = ANY (wc.sel_ads_problem)) AS range_ads_problem_resolved,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date = p_as_of), 0) AS yesterday_attributed_sales,
      COALESCE(sum(f.ordered_sales) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date = p_as_of AND p_as_of >= GREATEST(v_sales_history_starts_at, v_ads_history_starts_at)), 0) AS yesterday_sales_common,
      COALESCE(sum(f.spend) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date = p_as_of AND p_as_of >= GREATEST(v_sales_history_starts_at, v_ads_history_starts_at)), 0) AS yesterday_spend_common,
      count(DISTINCT f.report_date) FILTER (WHERE f.sales_has_row AND f.report_date = ANY (wc.yst_sales_problem)) AS yesterday_sales_problem_resolved,
      count(DISTINCT f.report_date) FILTER (WHERE f.ads_has_row AND f.report_date = ANY (wc.yst_ads_problem)) AS yesterday_ads_problem_resolved,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 6) AND p_as_of), 0) AS t7_attributed_sales,
      COALESCE(sum(f.ordered_sales) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 6, v_sales_history_starts_at, v_ads_history_starts_at) AND p_as_of), 0) AS t7_sales_common,
      COALESCE(sum(f.spend) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 6, v_sales_history_starts_at, v_ads_history_starts_at) AND p_as_of), 0) AS t7_spend_common,
      count(DISTINCT f.report_date) FILTER (WHERE f.sales_has_row AND f.report_date = ANY (wc.t7_sales_problem)) AS t7_sales_problem_resolved,
      count(DISTINCT f.report_date) FILTER (WHERE f.ads_has_row AND f.report_date = ANY (wc.t7_ads_problem)) AS t7_ads_problem_resolved,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_sales,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 13) AND (p_as_of - 7)), 0) AS prior7_attributed_sales,
      COALESCE(sum(f.ordered_sales) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 13, v_sales_history_starts_at, v_ads_history_starts_at) AND (p_as_of - 7)), 0) AS prior7_sales_common,
      COALESCE(sum(f.spend) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 13, v_sales_history_starts_at, v_ads_history_starts_at) AND (p_as_of - 7)), 0) AS prior7_spend_common,
      count(DISTINCT f.report_date) FILTER (WHERE f.sales_has_row AND f.report_date = ANY (wc.p7_sales_problem)) AS prior7_sales_problem_resolved,
      count(DISTINCT f.report_date) FILTER (WHERE f.ads_has_row AND f.report_date = ANY (wc.p7_ads_problem)) AS prior7_ads_problem_resolved,

      COALESCE(sum(f.ordered_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_sales,
      COALESCE(sum(f.units_ordered) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_units,
      COALESCE(sum(f.spend) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_spend,
      COALESCE(sum(f.attributed_sales) FILTER (WHERE f.report_date BETWEEN (p_as_of - 29) AND p_as_of), 0) AS t30_attributed_sales,
      COALESCE(sum(f.ordered_sales) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 29, v_sales_history_starts_at, v_ads_history_starts_at) AND p_as_of), 0) AS t30_sales_common,
      COALESCE(sum(f.spend) FILTER (WHERE v_ads_history_starts_at IS NOT NULL AND v_sales_history_starts_at IS NOT NULL AND f.report_date BETWEEN GREATEST(p_as_of - 29, v_sales_history_starts_at, v_ads_history_starts_at) AND p_as_of), 0) AS t30_spend_common,
      count(DISTINCT f.report_date) FILTER (WHERE f.sales_has_row AND f.report_date = ANY (wc.t30_sales_problem)) AS t30_sales_problem_resolved,
      count(DISTINCT f.report_date) FILTER (WHERE f.ads_has_row AND f.report_date = ANY (wc.t30_ads_problem)) AS t30_ads_problem_resolved,

      max(f.report_date) FILTER (WHERE f.sales_has_row AND f.ordered_sales > 0) AS last_sales_activity_date,
      max(f.report_date) FILTER (WHERE f.ads_has_row AND f.spend > 0) AS last_ad_spend_activity_date,
      max(f.report_date) FILTER (WHERE f.ads_has_row AND f.attributed_sales > 0) AS last_attributed_sale_activity_date
    FROM universe u
    CROSS JOIN wc
    LEFT JOIN sku_date_facts f ON f.canonical_sku = u.canonical_sku
    GROUP BY u.canonical_sku
  ),
  -- wc is re-joined here (cheap: it is always exactly one row) rather than
  -- being carried through sku_metrics' GROUP BY -- selecting wc.* there
  -- would force ~50 constant columns into the grouping key for no reason,
  -- which was the single largest performance regression this correction
  -- round introduced and fixed (see BRAHMASTRA_MASTER_TRACKER.md sec23
  -- update 7's performance section).
  sku_coverage AS (
    SELECT m.*,
      public._sku_perf_rollup_state(wc.sel_sales_total, wc.sel_sales_bh, wc.sel_sales_nc, wc.sel_sales_unk,
        COALESCE(array_length(wc.sel_sales_problem, 1), 0) - m.range_sales_problem_resolved, COALESCE(array_length(wc.sel_sales_problem, 1), 0)) AS range_sales_coverage,
      public._sku_perf_rollup_state(wc.sel_ads_total, wc.sel_ads_bh, wc.sel_ads_nc, wc.sel_ads_unk,
        COALESCE(array_length(wc.sel_ads_problem, 1), 0) - m.range_ads_problem_resolved, COALESCE(array_length(wc.sel_ads_problem, 1), 0)) AS range_ads_coverage,
      public._sku_perf_rollup_state(wc.yst_sales_total, wc.yst_sales_bh, wc.yst_sales_nc, wc.yst_sales_unk,
        COALESCE(array_length(wc.yst_sales_problem, 1), 0) - m.yesterday_sales_problem_resolved, COALESCE(array_length(wc.yst_sales_problem, 1), 0)) AS yesterday_sales_coverage,
      public._sku_perf_rollup_state(wc.yst_ads_total, wc.yst_ads_bh, wc.yst_ads_nc, wc.yst_ads_unk,
        COALESCE(array_length(wc.yst_ads_problem, 1), 0) - m.yesterday_ads_problem_resolved, COALESCE(array_length(wc.yst_ads_problem, 1), 0)) AS yesterday_ads_coverage,
      public._sku_perf_rollup_state(wc.t7_sales_total, wc.t7_sales_bh, wc.t7_sales_nc, wc.t7_sales_unk,
        COALESCE(array_length(wc.t7_sales_problem, 1), 0) - m.t7_sales_problem_resolved, COALESCE(array_length(wc.t7_sales_problem, 1), 0)) AS t7_sales_coverage,
      public._sku_perf_rollup_state(wc.t7_ads_total, wc.t7_ads_bh, wc.t7_ads_nc, wc.t7_ads_unk,
        COALESCE(array_length(wc.t7_ads_problem, 1), 0) - m.t7_ads_problem_resolved, COALESCE(array_length(wc.t7_ads_problem, 1), 0)) AS t7_ads_coverage,
      public._sku_perf_rollup_state(wc.p7_sales_total, wc.p7_sales_bh, wc.p7_sales_nc, wc.p7_sales_unk,
        COALESCE(array_length(wc.p7_sales_problem, 1), 0) - m.prior7_sales_problem_resolved, COALESCE(array_length(wc.p7_sales_problem, 1), 0)) AS prior7_sales_coverage,
      public._sku_perf_rollup_state(wc.p7_ads_total, wc.p7_ads_bh, wc.p7_ads_nc, wc.p7_ads_unk,
        COALESCE(array_length(wc.p7_ads_problem, 1), 0) - m.prior7_ads_problem_resolved, COALESCE(array_length(wc.p7_ads_problem, 1), 0)) AS prior7_ads_coverage,
      public._sku_perf_rollup_state(wc.t30_sales_total, wc.t30_sales_bh, wc.t30_sales_nc, wc.t30_sales_unk,
        COALESCE(array_length(wc.t30_sales_problem, 1), 0) - m.t30_sales_problem_resolved, COALESCE(array_length(wc.t30_sales_problem, 1), 0)) AS t30_sales_coverage,
      public._sku_perf_rollup_state(wc.t30_ads_total, wc.t30_ads_bh, wc.t30_ads_nc, wc.t30_ads_unk,
        COALESCE(array_length(wc.t30_ads_problem, 1), 0) - m.t30_ads_problem_resolved, COALESCE(array_length(wc.t30_ads_problem, 1), 0)) AS t30_ads_coverage
    FROM sku_metrics m
    CROSS JOIN wc
  ),
  sku_rows AS (
    SELECT
      c.*,
      COALESCE(cg.display_sku, sg.display_sku, ag.display_sku, cmg.display_sku) AS displayed_sku,
      cg.asin AS catalog_asin, cg.item_name, cg.image_url, cg.brand, cg.last_synced_at AS catalog_last_synced_at,
      cmg.category,
      -- Fix 4: cross-source collision -- combine raw-SKU evidence from ALL
      -- FOUR sources into one set; more than one distinct raw string
      -- anywhere in that combined set is a collision, same-source or not.
      (
        SELECT count(DISTINCT x) FROM unnest(
          COALESCE(cg.raw_skus, ARRAY[]::text[]) || COALESCE(sg.raw_skus, ARRAY[]::text[]) ||
          COALESCE(ag.raw_skus, ARRAY[]::text[]) || COALESCE(cmg.raw_skus, ARRAY[]::text[])
        ) AS x
      ) > 1 AS has_cross_source_collision,
      cg.raw_skus AS catalog_raw_skus, sg.raw_skus AS sales_raw_skus,
      ag.raw_skus AS ads_raw_skus, cmg.raw_skus AS cost_master_raw_skus,
      (ag.canonical_sku IS NULL) AS is_ads_absent,
      (cg.canonical_sku IS NULL) AS is_catalog_absent,
      EXISTS (SELECT 1 FROM unnest(ag.advertised_asins) x WHERE x IS NOT NULL AND x IS DISTINCT FROM cg.asin) AS has_asin_mismatch
    FROM sku_coverage c
    LEFT JOIN catalog_grouped cg ON cg.canonical_sku = c.canonical_sku
    LEFT JOIN sales_grouped sg ON sg.canonical_sku = c.canonical_sku
    LEFT JOIN ads_grouped ag ON ag.canonical_sku = c.canonical_sku
    LEFT JOIN cost_grouped cmg ON cmg.canonical_sku = c.canonical_sku
  ),
  sku_mapping AS (
    SELECT r.*,
      CASE
        WHEN r.is_ads_absent THEN 'not_applicable'
        WHEN r.has_cross_source_collision THEN 'identity_conflict'
        WHEN r.is_catalog_absent THEN 'unmapped'
        WHEN r.has_asin_mismatch THEN 'identity_conflict'
        ELSE 'mapped'
      END AS mapping_state
    FROM sku_rows r
  ),
  sku_ratios AS (
    SELECT r.*,
      -- range: TACOS uses the common-comparable-range sums; ACOS is Ads-only, no common-range issue
      CASE WHEN range_ads_coverage <> 'complete' THEN 'unknown'
           WHEN range_spend = 0 AND range_attributed_sales = 0 THEN 'not_applicable'
           WHEN range_spend > 0 AND range_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS range_acos_state,
      CASE WHEN range_ads_coverage = 'complete' AND range_spend > 0 AND range_attributed_sales > 0 THEN range_spend / range_attributed_sales END AS range_acos_value,
      CASE WHEN range_sales_coverage <> 'complete' OR range_ads_coverage <> 'complete'
             OR v_common_effective_date_from IS NULL OR v_common_effective_date_from > p_date_to THEN 'unknown'
           WHEN range_spend_common = 0 AND range_sales_common = 0 THEN 'not_applicable'
           WHEN range_spend_common > 0 AND range_sales_common = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS range_tacos_state,
      CASE WHEN range_sales_coverage = 'complete' AND range_ads_coverage = 'complete'
             AND v_common_effective_date_from IS NOT NULL AND v_common_effective_date_from <= p_date_to
             AND range_sales_common > 0 THEN range_spend_common / range_sales_common END AS range_tacos_value,

      CASE WHEN t7_ads_coverage <> 'complete' THEN 'unknown'
           WHEN t7_spend = 0 AND t7_attributed_sales = 0 THEN 'not_applicable'
           WHEN t7_spend > 0 AND t7_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS t7_acos_state,
      CASE WHEN t7_ads_coverage = 'complete' AND t7_spend > 0 AND t7_attributed_sales > 0 THEN t7_spend / t7_attributed_sales END AS t7_acos_value,
      CASE WHEN t7_sales_coverage <> 'complete' OR t7_ads_coverage <> 'complete' OR v_ads_history_starts_at IS NULL OR v_sales_history_starts_at IS NULL THEN 'unknown'
           WHEN t7_spend_common = 0 AND t7_sales_common = 0 THEN 'not_applicable'
           WHEN t7_spend_common > 0 AND t7_sales_common = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS t7_tacos_state,
      CASE WHEN t7_sales_coverage = 'complete' AND t7_ads_coverage = 'complete' AND t7_sales_common > 0 THEN t7_spend_common / t7_sales_common END AS t7_tacos_value,

      CASE WHEN prior7_ads_coverage <> 'complete' THEN 'unknown'
           WHEN prior7_spend = 0 AND prior7_attributed_sales = 0 THEN 'not_applicable'
           WHEN prior7_spend > 0 AND prior7_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS prior7_acos_state,
      CASE WHEN prior7_ads_coverage = 'complete' AND prior7_spend > 0 AND prior7_attributed_sales > 0 THEN prior7_spend / prior7_attributed_sales END AS prior7_acos_value,
      CASE WHEN prior7_sales_coverage <> 'complete' OR prior7_ads_coverage <> 'complete' OR v_ads_history_starts_at IS NULL OR v_sales_history_starts_at IS NULL THEN 'unknown'
           WHEN prior7_spend_common = 0 AND prior7_sales_common = 0 THEN 'not_applicable'
           WHEN prior7_spend_common > 0 AND prior7_sales_common = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS prior7_tacos_state,
      CASE WHEN prior7_sales_coverage = 'complete' AND prior7_ads_coverage = 'complete' AND prior7_sales_common > 0 THEN prior7_spend_common / prior7_sales_common END AS prior7_tacos_value,

      CASE WHEN t30_ads_coverage <> 'complete' THEN 'unknown'
           WHEN t30_spend = 0 AND t30_attributed_sales = 0 THEN 'not_applicable'
           WHEN t30_spend > 0 AND t30_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS t30_acos_state,
      CASE WHEN t30_ads_coverage = 'complete' AND t30_spend > 0 AND t30_attributed_sales > 0 THEN t30_spend / t30_attributed_sales END AS t30_acos_value,
      CASE WHEN t30_sales_coverage <> 'complete' OR t30_ads_coverage <> 'complete' OR v_ads_history_starts_at IS NULL OR v_sales_history_starts_at IS NULL THEN 'unknown'
           WHEN t30_spend_common = 0 AND t30_sales_common = 0 THEN 'not_applicable'
           WHEN t30_spend_common > 0 AND t30_sales_common = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS t30_tacos_state,
      CASE WHEN t30_sales_coverage = 'complete' AND t30_ads_coverage = 'complete' AND t30_sales_common > 0 THEN t30_spend_common / t30_sales_common END AS t30_tacos_value,

      CASE WHEN yesterday_ads_coverage <> 'complete' THEN 'unknown'
           WHEN yesterday_spend = 0 AND yesterday_attributed_sales = 0 THEN 'not_applicable'
           WHEN yesterday_spend > 0 AND yesterday_attributed_sales = 0 THEN 'undefined'
           ELSE 'normal' END AS yesterday_acos_state,
      CASE WHEN yesterday_ads_coverage = 'complete' AND yesterday_spend > 0 AND yesterday_attributed_sales > 0 THEN yesterday_spend / yesterday_attributed_sales END AS yesterday_acos_value,
      CASE WHEN yesterday_sales_coverage <> 'complete' OR yesterday_ads_coverage <> 'complete' OR v_ads_history_starts_at IS NULL OR v_sales_history_starts_at IS NULL THEN 'unknown'
           WHEN yesterday_spend_common = 0 AND yesterday_sales_common = 0 THEN 'not_applicable'
           WHEN yesterday_spend_common > 0 AND yesterday_sales_common = 0 THEN 'undefined_high_risk'
           ELSE 'normal' END AS yesterday_tacos_state,
      CASE WHEN yesterday_sales_coverage = 'complete' AND yesterday_ads_coverage = 'complete' AND yesterday_sales_common > 0 THEN yesterday_spend_common / yesterday_sales_common END AS yesterday_tacos_value
    FROM sku_mapping r
  ),
  sku_trends AS (
    SELECT rt.*,
      -- Fix 3: never classify a trend when the windows it depends on aren't complete
      CASE
        WHEN rt.t7_sales_coverage <> 'complete' OR rt.prior7_sales_coverage <> 'complete' THEN 'no_comparable_baseline'
        WHEN rt.prior7_sales = 0 AND rt.t7_sales = 0 THEN 'no_activity'
        WHEN rt.prior7_sales = 0 AND rt.t7_sales > FLOOR_SALES THEN 'new_activity'
        WHEN rt.prior7_sales = 0 THEN 'no_activity'
        WHEN rt.t7_sales > rt.prior7_sales * SALES_GROWTH_RATIO THEN 'growing'
        WHEN rt.t7_sales < rt.prior7_sales * SALES_DECLINE_RATIO THEN 'declining'
        ELSE 'flat'
      END AS sales_trend,
      CASE
        WHEN rt.t7_ads_coverage <> 'complete' OR rt.prior7_ads_coverage <> 'complete' THEN 'no_comparable_baseline'
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
      (tr.t7_ads_coverage = 'complete' AND tr.t7_spend >= v_min_ad_spend_for_action AND tr.t7_attributed_sales = 0) AS flag_no_attributed_sales,
      (
        tr.prior7_tacos_state = 'normal' AND tr.t7_tacos_state = 'normal'
        AND tr.t7_sales >= FLOOR_SALES
        AND tr.t7_tacos_value > tr.prior7_tacos_value * TACOS_DETERIORATION_RATIO
      ) AS flag_tacos_deterioration,
      (tr.sales_trend = 'growing' AND tr.spend_trend = 'flat') AS flag_sales_growing_stable_spend,
      (tr.sales_trend = 'growing' AND tr.spend_trend = 'declining') AS flag_sales_growing_spend_falls,
      -- Narrow contract cleanup #2: mappingIncomplete is only a real
      -- mapping problem for unmapped/identity_conflict, never for
      -- not_applicable (a SKU with no advertising activity has nothing to
      -- "map" in the first place).
      (tr.mapping_state IN ('unmapped', 'identity_conflict')) AS flag_mapping_incomplete,
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
  -- Fix 2: assign a stable row number in the FULL requested sort order,
  -- BEFORE pagination -- this is what the final jsonb_agg orders by, so
  -- the requested sort survives into the response instead of being
  -- silently replaced by canonical_sku order.
  sorted AS (
    SELECT *, ROW_NUMBER() OVER (
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
    ) AS sort_rn
    FROM filtered
  ),
  paged AS (
    SELECT * FROM sorted WHERE sort_rn > p_offset AND sort_rn <= (p_offset + p_limit)
  ),
  summary_agg AS (
    SELECT
      COALESCE(sum(range_sales) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_ordered_sales,
      COALESCE(sum(range_units) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_units,
      COALESCE(sum(range_spend) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_ad_spend,
      COALESCE(sum(range_attributed_sales) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_attributed_sales,
      COALESCE(sum(range_sales_common) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_sales_common,
      COALESCE(sum(range_spend_common) FILTER (WHERE mapping_state <> 'identity_conflict'), 0) AS total_spend_common,
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
  -- Fix 3 (summary-level): the aggregate ACOS/TACOS coverage is the plain
  -- source-level rollup for the selected range (nc/unknown days are never
  -- individually "rescued" at the aggregate level -- see header comment).
  scope_coverage AS (
    SELECT
      public._sku_perf_rollup_state(sel_sales_total, sel_sales_bh, sel_sales_nc, sel_sales_unk, COALESCE(array_length(sel_sales_problem,1),0), COALESCE(array_length(sel_sales_problem,1),0)) AS sales_coverage,
      public._sku_perf_rollup_state(sel_ads_total, sel_ads_bh, sel_ads_nc, sel_ads_unk, COALESCE(array_length(sel_ads_problem,1),0), COALESCE(array_length(sel_ads_problem,1),0)) AS ads_coverage
    FROM wc
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
        'identityConflictEvidence', CASE WHEN p.mapping_state = 'identity_conflict' THEN jsonb_build_object(
          'catalogRawSkus', to_jsonb(COALESCE(p.catalog_raw_skus, ARRAY[]::text[])),
          'salesRawSkus', to_jsonb(COALESCE(p.sales_raw_skus, ARRAY[]::text[])),
          'adsRawSkus', to_jsonb(COALESCE(p.ads_raw_skus, ARRAY[]::text[])),
          'costMasterRawSkus', to_jsonb(COALESCE(p.cost_master_raw_skus, ARRAY[]::text[]))
        ) END,
        'salesTrend', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE p.sales_trend END,
        'spendTrend', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE p.spend_trend END,
        'tacosBand', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE p.tacos_band END,
        'lastSalesActivityDate', p.last_sales_activity_date,
        'lastAdSpendActivityDate', p.last_ad_spend_activity_date,
        'lastAttributedSaleActivityDate', p.last_attributed_sale_activity_date,
        'flags', jsonb_build_object(
          'salesDrop', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_sales_drop,
          'spendSpike', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_spend_spike,
          'noAttributedSales', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_no_attributed_sales,
          'tacosDeterioration', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_tacos_deterioration,
          'salesGrowingStableSpend', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_sales_growing_stable_spend,
          'salesGrowingSpendFalls', COALESCE(p.mapping_state <> 'identity_conflict', false) AND p.flag_sales_growing_spend_falls,
          'mappingIncomplete', p.flag_mapping_incomplete
        ),
        'selectedRange', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE jsonb_build_object(
          'sales', p.range_sales, 'units', p.range_units, 'spend', p.range_spend, 'attributedSales', p.range_attributed_sales,
          'salesCoverageState', p.range_sales_coverage, 'adsCoverageState', p.range_ads_coverage,
          'acos', jsonb_build_object('value', p.range_acos_value, 'state', p.range_acos_state),
          'tacos', jsonb_build_object('value', p.range_tacos_value, 'state', p.range_tacos_state)
        ) END,
        'yesterday', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE jsonb_build_object(
          'sales', p.yesterday_sales, 'units', p.yesterday_units, 'spend', p.yesterday_spend, 'attributedSales', p.yesterday_attributed_sales,
          'salesCoverageState', p.yesterday_sales_coverage, 'adsCoverageState', p.yesterday_ads_coverage,
          'acos', jsonb_build_object('value', p.yesterday_acos_value, 'state', p.yesterday_acos_state),
          'tacos', jsonb_build_object('value', p.yesterday_tacos_value, 'state', p.yesterday_tacos_state)
        ) END,
        'trailingSevenDay', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE jsonb_build_object(
          'sales', p.t7_sales, 'units', p.t7_units, 'spend', p.t7_spend, 'attributedSales', p.t7_attributed_sales,
          'salesCoverageState', p.t7_sales_coverage, 'adsCoverageState', p.t7_ads_coverage,
          'acos', jsonb_build_object('value', p.t7_acos_value, 'state', p.t7_acos_state),
          'tacos', jsonb_build_object('value', p.t7_tacos_value, 'state', p.t7_tacos_state)
        ) END,
        'priorSevenDay', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE jsonb_build_object(
          'sales', p.prior7_sales, 'spend', p.prior7_spend, 'attributedSales', p.prior7_attributed_sales,
          'salesCoverageState', p.prior7_sales_coverage, 'adsCoverageState', p.prior7_ads_coverage,
          'acos', jsonb_build_object('value', p.prior7_acos_value, 'state', p.prior7_acos_state),
          'tacos', jsonb_build_object('value', p.prior7_tacos_value, 'state', p.prior7_tacos_state)
        ) END,
        'trailingThirtyDay', CASE WHEN p.mapping_state = 'identity_conflict' THEN NULL ELSE jsonb_build_object(
          'sales', p.t30_sales, 'units', p.t30_units, 'spend', p.t30_spend, 'attributedSales', p.t30_attributed_sales,
          'salesCoverageState', p.t30_sales_coverage, 'adsCoverageState', p.t30_ads_coverage,
          'acos', jsonb_build_object('value', p.t30_acos_value, 'state', p.t30_acos_state),
          'tacos', jsonb_build_object('value', p.t30_tacos_value, 'state', p.t30_tacos_state)
        ) END
      ) ORDER BY p.sort_rn)
      FROM paged p
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'totalOrderedSales', sa.total_ordered_sales,
        'totalUnits', sa.total_units,
        'totalAdSpend', sa.total_ad_spend,
        'totalAttributedSales', sa.total_attributed_sales,
        'acos', CASE WHEN sc.ads_coverage <> 'complete' THEN jsonb_build_object('value', NULL, 'state', 'unknown')
                     WHEN sa.total_ad_spend = 0 AND sa.total_attributed_sales = 0 THEN jsonb_build_object('value', NULL, 'state', 'not_applicable')
                     WHEN sa.total_ad_spend > 0 AND sa.total_attributed_sales = 0 THEN jsonb_build_object('value', NULL, 'state', 'undefined')
                     ELSE jsonb_build_object('value', sa.total_ad_spend / sa.total_attributed_sales, 'state', 'normal') END,
        'tacos', CASE WHEN sc.sales_coverage <> 'complete' OR sc.ads_coverage <> 'complete' OR v_common_effective_date_from IS NULL THEN jsonb_build_object('value', NULL, 'state', 'unknown')
                      WHEN sa.total_spend_common = 0 AND sa.total_sales_common = 0 THEN jsonb_build_object('value', NULL, 'state', 'not_applicable')
                      WHEN sa.total_spend_common > 0 AND sa.total_sales_common = 0 THEN jsonb_build_object('value', NULL, 'state', 'undefined_high_risk')
                      ELSE jsonb_build_object('value', sa.total_spend_common / sa.total_sales_common, 'state', 'normal') END,
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
        'salesLatestDataDate', v_sales_latest_data_date,
        'adsLatestDataDate', v_ads_latest_data_date,
        'salesLatestAcceptedCompleteDate', v_sales_latest_accepted_complete_date,
        'adsLatestAcceptedCompleteDate', v_ads_latest_accepted_complete_date,
        'catalogLastSyncedAt', v_catalog_last_synced_at,
        'salesLastRunStatus', v_sales_last_run_status,
        'salesLastRunAt', v_sales_last_run_at,
        'salesLastRunRowsRejected', v_sales_last_run_rows_rejected,
        'adsLastRunStatus', v_ads_last_run_status,
        'adsLastRunAt', v_ads_last_run_at,
        'adsLastRunRowsRejected', v_ads_last_run_rows_rejected
      )
      FROM summary_agg sa CROSS JOIN scope_coverage sc
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
      'commonEffectiveDateFrom', v_common_effective_date_from,
      'commonEffectiveDateTo', v_common_effective_date_to,
      'salesEffectiveDateFrom', v_sales_effective_date_from,
      'adsEffectiveDateFrom', v_ads_effective_date_from,
      'asOf', p_as_of,
      'salesHistoryStartsAt', v_sales_history_starts_at,
      'adsHistoryStartsAt', v_ads_history_starts_at,
      'wasRangeClamped', (COALESCE(array_length(v_clamp_reasons, 1), 0) > 0),
      'clampReasons', to_jsonb(v_clamp_reasons)
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
-- 4. get_sku_performance_daily
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
  v_has_collision boolean;

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

  -- Fix 4: collision check upfront, across all four sources, before any
  -- day-by-day work -- an identity_conflict SKU never gets a combined series.
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

  SELECT count(DISTINCT x) > 1 INTO v_has_collision
  FROM unnest(
    COALESCE(v_catalog_raw_skus, ARRAY[]::text[]) || COALESCE(v_sales_raw_skus, ARRAY[]::text[]) ||
    COALESCE(v_ads_raw_skus, ARRAY[]::text[]) || COALESCE(v_cost_raw_skus, ARRAY[]::text[])
  ) AS x;

  IF v_has_collision THEN
    RETURN jsonb_build_object(
      'result', 'identity_conflict',
      'canonicalSku', v_canonical_sku,
      'evidence', jsonb_build_object(
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
