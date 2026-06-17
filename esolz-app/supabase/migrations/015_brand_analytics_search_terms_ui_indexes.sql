-- Speed up Brand Analytics Search Terms dashboard reads.

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_document_rank_idx
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    search_frequency_rank,
    click_share_rank
  )
  WHERE report_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_clicked_asin_idx
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    clicked_asin
  )
  WHERE report_document_id IS NOT NULL
    AND clicked_asin <> '';

CREATE INDEX IF NOT EXISTS ba_terms_rows_ui_department_idx
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    department_name
  )
  WHERE report_document_id IS NOT NULL
    AND department_name <> '';
