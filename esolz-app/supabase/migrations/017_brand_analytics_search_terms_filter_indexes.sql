-- Speed up filtered Brand Analytics Search Terms reads.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_search_term_trgm_idx
  ON public.brand_analytics_search_terms_rows
  USING gin (search_term gin_trgm_ops)
  WHERE report_document_id IS NOT NULL
    AND search_term IS NOT NULL
    AND search_term <> '';

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_document_term_rank_idx
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    search_term,
    search_frequency_rank,
    click_share_rank
  )
  WHERE report_document_id IS NOT NULL
    AND search_term IS NOT NULL
    AND search_term <> '';

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_document_click_share_idx
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    search_frequency_rank,
    click_share,
    conversion_share,
    click_share_rank
  )
  WHERE report_document_id IS NOT NULL;
