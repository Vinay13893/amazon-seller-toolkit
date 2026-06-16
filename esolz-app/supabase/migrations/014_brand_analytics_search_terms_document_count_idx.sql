-- Speed up safe progress counts by report document.

CREATE INDEX IF NOT EXISTS ba_terms_rows_report_document_id_idx
  ON public.brand_analytics_search_terms_rows (report_document_id)
  WHERE report_document_id IS NOT NULL;
