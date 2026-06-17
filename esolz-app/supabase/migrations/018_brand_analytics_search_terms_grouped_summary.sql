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

NOTIFY pgrst, 'reload schema';
