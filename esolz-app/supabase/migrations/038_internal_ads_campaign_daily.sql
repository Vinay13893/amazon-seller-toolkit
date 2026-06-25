-- Manual Amazon Ads daily campaign-level CSV import foundation (Phase 0D).
-- Read-only analytics only: no bid/budget changes, no Ads API, no rollback.
-- Each upload is recorded as a batch; rows are deduped by a computed
-- dedupe_key so re-uploading an overlapping date range is idempotent.

CREATE TABLE IF NOT EXISTS public.internal_ads_campaign_upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  original_filename text NOT NULL,
  report_date_start date,
  report_date_end date,
  row_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  total_spend numeric(14, 2) NOT NULL DEFAULT 0,
  total_sales numeric(14, 2) NOT NULL DEFAULT 0,
  campaign_count integer NOT NULL DEFAULT 0,
  unmapped_campaign_count integer NOT NULL DEFAULT 0,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_ads_campaign_upload_batches_workspace_idx
  ON public.internal_ads_campaign_upload_batches (workspace_id, uploaded_at DESC);

ALTER TABLE public.internal_ads_campaign_upload_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_ads_campaign_upload_batches: internal select"
  ON public.internal_ads_campaign_upload_batches
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_ads_campaign_upload_batches.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE TABLE IF NOT EXISTS public.internal_ads_campaign_daily_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  upload_batch_id uuid NOT NULL REFERENCES public.internal_ads_campaign_upload_batches(id) ON DELETE CASCADE,

  report_date date NOT NULL,
  campaign_name text NOT NULL,
  campaign_id text,
  campaign_status text,
  campaign_type text,
  targeting_type text,
  portfolio_name text,

  ad_group_name text,
  targeting text,
  match_type text,
  advertised_sku text,
  advertised_asin text,
  search_term text,

  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  ctr numeric(8, 4),
  spend numeric(14, 2) NOT NULL DEFAULT 0,
  cpc numeric(10, 2),
  purchases integer NOT NULL DEFAULT 0,
  sales numeric(14, 2) NOT NULL DEFAULT 0,
  acos numeric(8, 4),
  roas numeric(10, 4),

  easyhome_portfolio text NOT NULL DEFAULT 'Unmapped / Needs Review',
  dedupe_key text NOT NULL,
  raw_row jsonb NOT NULL,
  source text NOT NULL DEFAULT 'manual_csv_upload',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_ads_campaign_daily_rows_dedupe_uidx
  ON public.internal_ads_campaign_daily_rows (workspace_id, dedupe_key);

CREATE INDEX IF NOT EXISTS internal_ads_campaign_daily_rows_workspace_date_idx
  ON public.internal_ads_campaign_daily_rows (workspace_id, report_date DESC);

CREATE INDEX IF NOT EXISTS internal_ads_campaign_daily_rows_workspace_portfolio_idx
  ON public.internal_ads_campaign_daily_rows (workspace_id, easyhome_portfolio);

CREATE INDEX IF NOT EXISTS internal_ads_campaign_daily_rows_batch_idx
  ON public.internal_ads_campaign_daily_rows (upload_batch_id);

ALTER TABLE public.internal_ads_campaign_daily_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_ads_campaign_daily_rows: internal select"
  ON public.internal_ads_campaign_daily_rows
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_ads_campaign_daily_rows.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

-- Writes remain service-role only, consistent with other internal_* import tables.

DROP TRIGGER IF EXISTS trg_internal_ads_campaign_daily_rows_updated_at
  ON public.internal_ads_campaign_daily_rows;
CREATE TRIGGER trg_internal_ads_campaign_daily_rows_updated_at
  BEFORE UPDATE ON public.internal_ads_campaign_daily_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
