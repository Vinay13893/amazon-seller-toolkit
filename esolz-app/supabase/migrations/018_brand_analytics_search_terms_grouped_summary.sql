-- Precompute grouped Brand Analytics Top Search Terms rows for fast UI reads.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.brand_analytics_search_terms_grouped_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid,
  marketplace_id text,
  report_id text,
  report_document_id text NOT NULL,
  report_period text,
  data_start_time timestamptz,
  data_end_time timestamptz,
  search_term text NOT NULL,
  search_frequency_rank integer NOT NULL DEFAULT 0,
  department_name text NOT NULL DEFAULT '',
  product_1_asin text,
  product_1_title text,
  product_1_click_share numeric,
  product_1_conversion_share numeric,
  product_2_asin text,
  product_2_title text,
  product_2_click_share numeric,
  product_2_conversion_share numeric,
  product_3_asin text,
  product_3_title text,
  product_3_click_share numeric,
  product_3_conversion_share numeric,
  opportunity_tag text,
  suggested_action text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT ba_terms_grouped_rows_unique UNIQUE (
    workspace_id,
    report_document_id,
    search_term,
    search_frequency_rank,
    department_name
  )
);

CREATE INDEX IF NOT EXISTS ba_terms_grouped_document_rank_idx
  ON public.brand_analytics_search_terms_grouped_rows (
    workspace_id,
    report_document_id,
    search_frequency_rank
  );

CREATE INDEX IF NOT EXISTS ba_terms_grouped_product_1_asin_idx
  ON public.brand_analytics_search_terms_grouped_rows (
    workspace_id,
    report_document_id,
    product_1_asin
  )
  WHERE product_1_asin IS NOT NULL
    AND product_1_asin <> '';

CREATE INDEX IF NOT EXISTS ba_terms_grouped_opportunity_idx
  ON public.brand_analytics_search_terms_grouped_rows (
    workspace_id,
    report_document_id,
    opportunity_tag
  )
  WHERE opportunity_tag IS NOT NULL;

CREATE INDEX IF NOT EXISTS ba_terms_grouped_search_term_trgm_idx
  ON public.brand_analytics_search_terms_grouped_rows
  USING gin (search_term gin_trgm_ops)
  WHERE search_term IS NOT NULL
    AND search_term <> '';

ALTER TABLE public.brand_analytics_search_terms_grouped_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_analytics_search_terms_grouped_rows: member select"
  ON public.brand_analytics_search_terms_grouped_rows;
CREATE POLICY "brand_analytics_search_terms_grouped_rows: member select"
  ON public.brand_analytics_search_terms_grouped_rows FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP TRIGGER IF EXISTS trg_brand_analytics_search_terms_grouped_rows_updated_at
  ON public.brand_analytics_search_terms_grouped_rows;
CREATE TRIGGER trg_brand_analytics_search_terms_grouped_rows_updated_at
  BEFORE UPDATE ON public.brand_analytics_search_terms_grouped_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

WITH grouped AS (
  SELECT
    workspace_id,
    max(marketplace_id) AS marketplace_id,
    max(report_id) AS report_id,
    report_document_id,
    CASE
      WHEN min(data_start_time) IS NOT NULL OR max(data_end_time) IS NOT NULL
        THEN concat_ws(' to ', min(data_start_time)::date::text, max(data_end_time)::date::text)
      ELSE NULL
    END AS report_period,
    min(data_start_time) AS data_start_time,
    max(data_end_time) AS data_end_time,
    search_term,
    coalesce(search_frequency_rank, 0)::integer AS search_frequency_rank,
    coalesce(department_name, '') AS department_name,
    max(clicked_asin) FILTER (WHERE click_share_rank = 1) AS product_1_asin,
    max(clicked_item_name) FILTER (WHERE click_share_rank = 1) AS product_1_title,
    max(click_share) FILTER (WHERE click_share_rank = 1) AS product_1_click_share,
    max(conversion_share) FILTER (WHERE click_share_rank = 1) AS product_1_conversion_share,
    max(clicked_asin) FILTER (WHERE click_share_rank = 2) AS product_2_asin,
    max(clicked_item_name) FILTER (WHERE click_share_rank = 2) AS product_2_title,
    max(click_share) FILTER (WHERE click_share_rank = 2) AS product_2_click_share,
    max(conversion_share) FILTER (WHERE click_share_rank = 2) AS product_2_conversion_share,
    max(clicked_asin) FILTER (WHERE click_share_rank = 3) AS product_3_asin,
    max(clicked_item_name) FILTER (WHERE click_share_rank = 3) AS product_3_title,
    max(click_share) FILTER (WHERE click_share_rank = 3) AS product_3_click_share,
    max(conversion_share) FILTER (WHERE click_share_rank = 3) AS product_3_conversion_share
  FROM public.brand_analytics_search_terms_rows
  WHERE report_document_id IS NOT NULL
    AND search_term IS NOT NULL
    AND search_term <> ''
  GROUP BY
    workspace_id,
    report_document_id,
    search_term,
    coalesce(search_frequency_rank, 0),
    coalesce(department_name, '')
)
INSERT INTO public.brand_analytics_search_terms_grouped_rows (
  workspace_id,
  amazon_connection_id,
  marketplace_id,
  report_id,
  report_document_id,
  report_period,
  data_start_time,
  data_end_time,
  search_term,
  search_frequency_rank,
  department_name,
  product_1_asin,
  product_1_title,
  product_1_click_share,
  product_1_conversion_share,
  product_2_asin,
  product_2_title,
  product_2_click_share,
  product_2_conversion_share,
  product_3_asin,
  product_3_title,
  product_3_click_share,
  product_3_conversion_share,
  opportunity_tag,
  suggested_action
)
SELECT
  workspace_id,
  NULL::uuid,
  marketplace_id,
  report_id,
  report_document_id,
  report_period,
  data_start_time,
  data_end_time,
  search_term,
  search_frequency_rank,
  department_name,
  product_1_asin,
  product_1_title,
  product_1_click_share,
  product_1_conversion_share,
  product_2_asin,
  product_2_title,
  product_2_click_share,
  product_2_conversion_share,
  product_3_asin,
  product_3_title,
  product_3_click_share,
  product_3_conversion_share,
  CASE
    WHEN search_frequency_rank <= 1000 AND coalesce(product_1_conversion_share, 0) < 2
      THEN 'Conversion gap'
    WHEN search_frequency_rank <= 5000 AND coalesce(product_1_click_share, 0) < 5
      THEN 'Click share opportunity'
    WHEN coalesce(product_1_click_share, 0) >= 10 AND coalesce(product_1_conversion_share, 0) >= 8
      THEN 'Winning term'
    ELSE 'Monitor'
  END AS opportunity_tag,
  CASE
    WHEN search_frequency_rank <= 1000 AND coalesce(product_1_conversion_share, 0) < 2
      THEN 'Improve image/title/price/reviews'
    WHEN search_frequency_rank <= 5000 AND coalesce(product_1_click_share, 0) < 5
      THEN 'Add to exact-match campaign'
    WHEN coalesce(product_1_click_share, 0) >= 10 AND coalesce(product_1_conversion_share, 0) >= 8
      THEN 'Protect winning term'
    ELSE 'Monitor next report'
  END AS suggested_action
FROM grouped
ON CONFLICT (
  workspace_id,
  report_document_id,
  search_term,
  search_frequency_rank,
  department_name
) DO UPDATE SET
  marketplace_id = EXCLUDED.marketplace_id,
  report_id = EXCLUDED.report_id,
  report_period = EXCLUDED.report_period,
  data_start_time = EXCLUDED.data_start_time,
  data_end_time = EXCLUDED.data_end_time,
  product_1_asin = EXCLUDED.product_1_asin,
  product_1_title = EXCLUDED.product_1_title,
  product_1_click_share = EXCLUDED.product_1_click_share,
  product_1_conversion_share = EXCLUDED.product_1_conversion_share,
  product_2_asin = EXCLUDED.product_2_asin,
  product_2_title = EXCLUDED.product_2_title,
  product_2_click_share = EXCLUDED.product_2_click_share,
  product_2_conversion_share = EXCLUDED.product_2_conversion_share,
  product_3_asin = EXCLUDED.product_3_asin,
  product_3_title = EXCLUDED.product_3_title,
  product_3_click_share = EXCLUDED.product_3_click_share,
  product_3_conversion_share = EXCLUDED.product_3_conversion_share,
  opportunity_tag = EXCLUDED.opportunity_tag,
  suggested_action = EXCLUDED.suggested_action,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
