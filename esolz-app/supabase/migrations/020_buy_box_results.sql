-- Structured Buy Box monitor results for queued scraping jobs.

CREATE TABLE IF NOT EXISTS public.buy_box_results (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id uuid REFERENCES public.scraping_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text,
  asin text NOT NULL,
  buy_box_detected boolean,
  price_detected boolean,
  price_text text,
  seller_name text,
  availability_status text,
  page_status text,
  error_code text,
  error_message text,
  checked_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buy_box_results_workspace_asin_checked_idx
  ON public.buy_box_results (workspace_id, asin, checked_at DESC);

CREATE INDEX IF NOT EXISTS buy_box_results_job_id_idx
  ON public.buy_box_results (job_id);

ALTER TABLE public.buy_box_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "buy_box_results: member select" ON public.buy_box_results;
CREATE POLICY "buy_box_results: member select"
  ON public.buy_box_results FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

NOTIFY pgrst, 'reload schema';
