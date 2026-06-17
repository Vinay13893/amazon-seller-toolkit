-- Queue foundation for safe, workspace-scoped scraping jobs.

CREATE TABLE IF NOT EXISTS public.scraping_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  progress_current integer DEFAULT 0,
  progress_total integer DEFAULT 0,
  attempts integer DEFAULT 0,
  max_attempts integer DEFAULT 2,
  result_summary jsonb,
  error_code text,
  error_message text,
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pincode_availability_results (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id uuid REFERENCES public.scraping_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text,
  asin text NOT NULL,
  pincode text NOT NULL,
  availability_status text,
  delivery_message_category text,
  delivery_message text,
  price_detected boolean,
  buy_box_detected boolean,
  seller_name text,
  checked_at timestamptz DEFAULT now(),
  error_code text,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scraping_jobs_workspace_status_created_idx
  ON public.scraping_jobs (workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS scraping_jobs_status_created_idx
  ON public.scraping_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS pincode_availability_results_workspace_asin_pin_checked_idx
  ON public.pincode_availability_results (workspace_id, asin, pincode, checked_at DESC);

CREATE INDEX IF NOT EXISTS pincode_availability_results_job_id_idx
  ON public.pincode_availability_results (job_id);

ALTER TABLE public.scraping_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_availability_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scraping_jobs: member select" ON public.scraping_jobs;
CREATE POLICY "scraping_jobs: member select"
  ON public.scraping_jobs FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP POLICY IF EXISTS "scraping_jobs: member insert" ON public.scraping_jobs;
CREATE POLICY "scraping_jobs: member insert"
  ON public.scraping_jobs FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

DROP POLICY IF EXISTS "pincode_availability_results: member select" ON public.pincode_availability_results;
CREATE POLICY "pincode_availability_results: member select"
  ON public.pincode_availability_results FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

DROP TRIGGER IF EXISTS trg_scraping_jobs_updated_at ON public.scraping_jobs;
CREATE TRIGGER trg_scraping_jobs_updated_at
  BEFORE UPDATE ON public.scraping_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
