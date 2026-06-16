-- Add row-level Search Terms report fields without removing legacy columns.

ALTER TABLE public.brand_analytics_search_terms_rows
  ADD COLUMN IF NOT EXISTS department_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS search_frequency_rank bigint,
  ADD COLUMN IF NOT EXISTS clicked_asin text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS clicked_item_name text,
  ADD COLUMN IF NOT EXISTS click_share_rank bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversion_share numeric(12, 6);

CREATE UNIQUE INDEX IF NOT EXISTS ba_terms_rows_document_clicked_unique
  ON public.brand_analytics_search_terms_rows (
    workspace_id,
    report_document_id,
    department_name,
    search_term,
    clicked_asin,
    click_share_rank
  );

CREATE INDEX IF NOT EXISTS ba_terms_rows_clicked_asin_idx
  ON public.brand_analytics_search_terms_rows (clicked_asin)
  WHERE clicked_asin <> '';

CREATE INDEX IF NOT EXISTS ba_terms_rows_department_idx
  ON public.brand_analytics_search_terms_rows (department_name)
  WHERE department_name <> '';
