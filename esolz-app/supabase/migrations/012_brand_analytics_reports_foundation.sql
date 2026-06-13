-- ─────────────────────────────────────────────────────────────────────────────
-- 012_brand_analytics_reports_foundation.sql
-- Brand Analytics Reports ingestion foundation.
--
-- Adds:
--   1) amazon_report_jobs
--   2) amazon_report_documents
--   3) brand_analytics_search_query_rows
--   4) brand_analytics_search_terms_rows
--   5) brand_analytics_search_catalog_rows
--
-- RLS pattern:
--   SELECT  -> workspace members only
--   WRITE   -> service-role only (no authenticated write policies)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. amazon_report_jobs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.amazon_report_jobs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  report_type          text        NOT NULL CHECK (
                         report_type IN (
                           'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
                           'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
                           'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT'
                         )
                       ),
  report_id            text,
  report_document_id   text,
  marketplace_id       text        NOT NULL,
  report_period        text,
  data_start_time      timestamptz,
  data_end_time        timestamptz,
  processing_status    text        NOT NULL DEFAULT 'IN_QUEUE',
  requested_at         timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  error_code           text,
  error_message        text,
  raw_summary          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, report_id)
);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_workspace_idx
  ON public.amazon_report_jobs (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_connection_idx
  ON public.amazon_report_jobs (amazon_connection_id);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_report_type_idx
  ON public.amazon_report_jobs (report_type);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_report_id_idx
  ON public.amazon_report_jobs (report_id)
  WHERE report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_report_jobs_marketplace_idx
  ON public.amazon_report_jobs (marketplace_id);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_period_idx
  ON public.amazon_report_jobs (report_period);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_status_idx
  ON public.amazon_report_jobs (processing_status);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_data_window_idx
  ON public.amazon_report_jobs (data_start_time, data_end_time);

CREATE INDEX IF NOT EXISTS amazon_report_jobs_requested_idx
  ON public.amazon_report_jobs (requested_at DESC);

ALTER TABLE public.amazon_report_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_report_jobs_workspace_read"
  ON public.amazon_report_jobs
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));


-- ── 2. amazon_report_documents ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.amazon_report_documents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  amazon_report_job_id uuid        NOT NULL REFERENCES public.amazon_report_jobs(id) ON DELETE CASCADE,
  report_type          text        NOT NULL,
  report_id            text,
  report_document_id   text        NOT NULL,
  marketplace_id       text        NOT NULL,
  report_period        text,
  data_start_time      timestamptz,
  data_end_time        timestamptz,
  processing_status    text        NOT NULL DEFAULT 'IN_QUEUE',
  requested_at         timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  error_code           text,
  error_message        text,
  raw_summary          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, report_document_id)
);

CREATE INDEX IF NOT EXISTS amazon_report_documents_workspace_idx
  ON public.amazon_report_documents (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_report_documents_connection_idx
  ON public.amazon_report_documents (amazon_connection_id);

CREATE INDEX IF NOT EXISTS amazon_report_documents_job_idx
  ON public.amazon_report_documents (amazon_report_job_id);

CREATE INDEX IF NOT EXISTS amazon_report_documents_report_type_idx
  ON public.amazon_report_documents (report_type);

CREATE INDEX IF NOT EXISTS amazon_report_documents_report_id_idx
  ON public.amazon_report_documents (report_id)
  WHERE report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_report_documents_report_document_id_idx
  ON public.amazon_report_documents (report_document_id);

CREATE INDEX IF NOT EXISTS amazon_report_documents_marketplace_idx
  ON public.amazon_report_documents (marketplace_id);

CREATE INDEX IF NOT EXISTS amazon_report_documents_period_idx
  ON public.amazon_report_documents (report_period);

CREATE INDEX IF NOT EXISTS amazon_report_documents_status_idx
  ON public.amazon_report_documents (processing_status);

CREATE INDEX IF NOT EXISTS amazon_report_documents_data_window_idx
  ON public.amazon_report_documents (data_start_time, data_end_time);

ALTER TABLE public.amazon_report_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_report_documents_workspace_read"
  ON public.amazon_report_documents
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));


-- ── 3. brand_analytics_search_query_rows ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_analytics_search_query_rows (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  marketplace_id       text        NOT NULL,
  report_id            text        NOT NULL,
  report_document_id   text,
  report_period        text,
  data_start_time      timestamptz,
  data_end_time        timestamptz,
  asin                 text        NOT NULL DEFAULT '',
  search_query         text        NOT NULL DEFAULT '',
  impressions          bigint,
  clicks               bigint,
  cart_adds            bigint,
  purchases            bigint,
  click_share          numeric(12, 6),
  purchase_share       numeric(12, 6),
  top_clicked_asin_1   text,
  top_clicked_asin_2   text,
  top_clicked_asin_3   text,
  raw_row              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, report_id, search_query, asin)
);

CREATE INDEX IF NOT EXISTS ba_query_rows_workspace_idx
  ON public.brand_analytics_search_query_rows (workspace_id);

CREATE INDEX IF NOT EXISTS ba_query_rows_marketplace_idx
  ON public.brand_analytics_search_query_rows (marketplace_id);

CREATE INDEX IF NOT EXISTS ba_query_rows_report_id_idx
  ON public.brand_analytics_search_query_rows (report_id);

CREATE INDEX IF NOT EXISTS ba_query_rows_search_query_idx
  ON public.brand_analytics_search_query_rows (search_query);

CREATE INDEX IF NOT EXISTS ba_query_rows_asin_idx
  ON public.brand_analytics_search_query_rows (asin)
  WHERE asin <> '';

CREATE INDEX IF NOT EXISTS ba_query_rows_period_idx
  ON public.brand_analytics_search_query_rows (report_period);

CREATE INDEX IF NOT EXISTS ba_query_rows_data_window_idx
  ON public.brand_analytics_search_query_rows (data_start_time, data_end_time);

ALTER TABLE public.brand_analytics_search_query_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ba_query_rows_workspace_read"
  ON public.brand_analytics_search_query_rows
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));


-- ── 4. brand_analytics_search_terms_rows ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_analytics_search_terms_rows (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  marketplace_id       text        NOT NULL,
  report_id            text        NOT NULL,
  report_document_id   text,
  report_period        text,
  data_start_time      timestamptz,
  data_end_time        timestamptz,
  asin                 text        NOT NULL DEFAULT '',
  search_term          text        NOT NULL DEFAULT '',
  impressions          bigint,
  clicks               bigint,
  cart_adds            bigint,
  purchases            bigint,
  click_share          numeric(12, 6),
  purchase_share       numeric(12, 6),
  top_clicked_asin_1   text,
  top_clicked_asin_2   text,
  top_clicked_asin_3   text,
  raw_row              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, report_id, search_term, asin)
);

CREATE INDEX IF NOT EXISTS ba_terms_rows_workspace_idx
  ON public.brand_analytics_search_terms_rows (workspace_id);

CREATE INDEX IF NOT EXISTS ba_terms_rows_marketplace_idx
  ON public.brand_analytics_search_terms_rows (marketplace_id);

CREATE INDEX IF NOT EXISTS ba_terms_rows_report_id_idx
  ON public.brand_analytics_search_terms_rows (report_id);

CREATE INDEX IF NOT EXISTS ba_terms_rows_search_term_idx
  ON public.brand_analytics_search_terms_rows (search_term);

CREATE INDEX IF NOT EXISTS ba_terms_rows_asin_idx
  ON public.brand_analytics_search_terms_rows (asin)
  WHERE asin <> '';

CREATE INDEX IF NOT EXISTS ba_terms_rows_period_idx
  ON public.brand_analytics_search_terms_rows (report_period);

CREATE INDEX IF NOT EXISTS ba_terms_rows_data_window_idx
  ON public.brand_analytics_search_terms_rows (data_start_time, data_end_time);

ALTER TABLE public.brand_analytics_search_terms_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ba_terms_rows_workspace_read"
  ON public.brand_analytics_search_terms_rows
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));


-- ── 5. brand_analytics_search_catalog_rows ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_analytics_search_catalog_rows (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  marketplace_id       text        NOT NULL,
  report_id            text        NOT NULL,
  report_document_id   text,
  report_period        text,
  data_start_time      timestamptz,
  data_end_time        timestamptz,
  asin                 text        NOT NULL DEFAULT '',
  search_query         text        NOT NULL DEFAULT '',
  impressions          bigint,
  clicks               bigint,
  cart_adds            bigint,
  purchases            bigint,
  click_share          numeric(12, 6),
  purchase_share       numeric(12, 6),
  top_clicked_asin_1   text,
  top_clicked_asin_2   text,
  top_clicked_asin_3   text,
  raw_row              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, report_id, asin, search_query)
);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_workspace_idx
  ON public.brand_analytics_search_catalog_rows (workspace_id);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_marketplace_idx
  ON public.brand_analytics_search_catalog_rows (marketplace_id);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_report_id_idx
  ON public.brand_analytics_search_catalog_rows (report_id);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_search_query_idx
  ON public.brand_analytics_search_catalog_rows (search_query);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_asin_idx
  ON public.brand_analytics_search_catalog_rows (asin)
  WHERE asin <> '';

CREATE INDEX IF NOT EXISTS ba_catalog_rows_period_idx
  ON public.brand_analytics_search_catalog_rows (report_period);

CREATE INDEX IF NOT EXISTS ba_catalog_rows_data_window_idx
  ON public.brand_analytics_search_catalog_rows (data_start_time, data_end_time);

ALTER TABLE public.brand_analytics_search_catalog_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ba_catalog_rows_workspace_read"
  ON public.brand_analytics_search_catalog_rows
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
