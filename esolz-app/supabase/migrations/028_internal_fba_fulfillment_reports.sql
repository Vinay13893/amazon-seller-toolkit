-- Internal-only structured FBA fulfillment report foundation.
-- No raw report rows, order identifiers, or customer data are stored.

CREATE TABLE IF NOT EXISTS public.internal_fba_report_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  report_type text NOT NULL,
  report_id text,
  report_document_id text,
  marketplace_id text NOT NULL,
  data_start_time timestamptz,
  data_end_time timestamptz,
  processing_status text NOT NULL DEFAULT 'IN_QUEUE',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  stored_row_count integer NOT NULL DEFAULT 0,
  fc_field_available boolean,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, report_id)
);

CREATE INDEX IF NOT EXISTS internal_fba_report_jobs_workspace_requested_idx
  ON public.internal_fba_report_jobs (workspace_id, requested_at DESC);

ALTER TABLE public.internal_fba_report_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_fba_report_jobs: internal select"
  ON public.internal_fba_report_jobs
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fba_report_jobs.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE TABLE IF NOT EXISTS public.internal_fba_report_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_job_id uuid NOT NULL REFERENCES public.internal_fba_report_jobs(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text,
  sku text,
  fnsku text,
  fulfillment_center_id text,
  disposition text,
  event_type text,
  quantity integer,
  running_balance integer,
  report_date date,
  report_type text NOT NULL,
  report_document_id text NOT NULL,
  source text NOT NULL DEFAULT 'fulfillment_report',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_asin_idx
  ON public.internal_fba_report_rows (workspace_id, marketplace_id, asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_sku_idx
  ON public.internal_fba_report_rows (workspace_id, marketplace_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_fc_idx
  ON public.internal_fba_report_rows (workspace_id, fulfillment_center_id)
  WHERE fulfillment_center_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS internal_fba_report_rows_document_row_uidx
  ON public.internal_fba_report_rows (
    workspace_id,
    report_document_id,
    COALESCE(asin, ''),
    COALESCE(sku, ''),
    COALESCE(fnsku, ''),
    COALESCE(fulfillment_center_id, ''),
    COALESCE(disposition, ''),
    COALESCE(event_type, ''),
    COALESCE(report_date, DATE '1970-01-01'),
    COALESCE(quantity, 0),
    COALESCE(running_balance, 0)
  );

ALTER TABLE public.internal_fba_report_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_fba_report_rows: internal select"
  ON public.internal_fba_report_rows
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fba_report_rows.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_internal_fba_report_jobs_updated_at
  ON public.internal_fba_report_jobs;
CREATE TRIGGER trg_internal_fba_report_jobs_updated_at
  BEFORE UPDATE ON public.internal_fba_report_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_internal_fba_report_rows_updated_at
  ON public.internal_fba_report_rows;
CREATE TRIGGER trg_internal_fba_report_rows_updated_at
  BEFORE UPDATE ON public.internal_fba_report_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
