-- Amazon Ads foundation: workspace-scoped connection, profiles, and report jobs.
-- No automation or report sync is enabled by this migration.

CREATE TABLE IF NOT EXISTS public.amazon_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid REFERENCES public.amazon_connections(id) ON DELETE SET NULL,
  region text NOT NULL DEFAULT 'eu',
  marketplace_id text,
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'not_connected', 'active', 'expired', 'revoked', 'error')),
  refresh_token_encrypted text,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  connected_by_user_id uuid REFERENCES auth.users(id),
  connected_at timestamptz,
  last_profile_sync_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS amazon_ads_connections_workspace_id_idx
  ON public.amazon_ads_connections (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_ads_connections_status_idx
  ON public.amazon_ads_connections (status);

CREATE INDEX IF NOT EXISTS amazon_ads_connections_marketplace_idx
  ON public.amazon_ads_connections (marketplace_id)
  WHERE marketplace_id IS NOT NULL;

ALTER TABLE public.amazon_ads_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "amazon_ads_connections_workspace_read"
  ON public.amazon_ads_connections;
CREATE POLICY "amazon_ads_connections_workspace_read"
  ON public.amazon_ads_connections
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE TABLE IF NOT EXISTS public.amazon_ads_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_ads_connection_id uuid NOT NULL REFERENCES public.amazon_ads_connections(id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  marketplace_id text,
  country_code text,
  currency_code text,
  timezone text,
  account_name text,
  account_id text,
  profile_type text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'archived', 'unknown')),
  last_synced_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, profile_id)
);

CREATE INDEX IF NOT EXISTS amazon_ads_profiles_workspace_idx
  ON public.amazon_ads_profiles (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_ads_profiles_connection_idx
  ON public.amazon_ads_profiles (amazon_ads_connection_id);

CREATE INDEX IF NOT EXISTS amazon_ads_profiles_marketplace_idx
  ON public.amazon_ads_profiles (marketplace_id)
  WHERE marketplace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_ads_profiles_status_idx
  ON public.amazon_ads_profiles (status);

ALTER TABLE public.amazon_ads_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "amazon_ads_profiles_workspace_read"
  ON public.amazon_ads_profiles;
CREATE POLICY "amazon_ads_profiles_workspace_read"
  ON public.amazon_ads_profiles
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE TABLE IF NOT EXISTS public.amazon_ads_report_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_ads_connection_id uuid REFERENCES public.amazon_ads_connections(id) ON DELETE CASCADE,
  amazon_ads_profile_id uuid REFERENCES public.amazon_ads_profiles(id) ON DELETE SET NULL,
  profile_id text,
  marketplace_id text,
  report_type text NOT NULL,
  report_id text,
  report_document_id text,
  report_period text,
  data_start_time timestamptz,
  data_end_time timestamptz,
  processing_status text NOT NULL DEFAULT 'queued'
    CHECK (processing_status IN ('queued', 'requested', 'processing', 'done', 'failed', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, report_id)
);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_workspace_idx
  ON public.amazon_ads_report_jobs (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_connection_idx
  ON public.amazon_ads_report_jobs (amazon_ads_connection_id);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_profile_idx
  ON public.amazon_ads_report_jobs (amazon_ads_profile_id);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_report_type_idx
  ON public.amazon_ads_report_jobs (report_type);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_status_idx
  ON public.amazon_ads_report_jobs (processing_status);

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_report_id_idx
  ON public.amazon_ads_report_jobs (report_id)
  WHERE report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_report_document_idx
  ON public.amazon_ads_report_jobs (report_document_id)
  WHERE report_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_ads_report_jobs_requested_idx
  ON public.amazon_ads_report_jobs (requested_at DESC);

ALTER TABLE public.amazon_ads_report_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "amazon_ads_report_jobs_workspace_read"
  ON public.amazon_ads_report_jobs;
CREATE POLICY "amazon_ads_report_jobs_workspace_read"
  ON public.amazon_ads_report_jobs
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP TRIGGER IF EXISTS trg_amazon_ads_connections_updated_at
  ON public.amazon_ads_connections;
CREATE TRIGGER trg_amazon_ads_connections_updated_at
  BEFORE UPDATE ON public.amazon_ads_connections
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_amazon_ads_profiles_updated_at
  ON public.amazon_ads_profiles;
CREATE TRIGGER trg_amazon_ads_profiles_updated_at
  BEFORE UPDATE ON public.amazon_ads_profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_amazon_ads_report_jobs_updated_at
  ON public.amazon_ads_report_jobs;
CREATE TRIGGER trg_amazon_ads_report_jobs_updated_at
  BEFORE UPDATE ON public.amazon_ads_report_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
