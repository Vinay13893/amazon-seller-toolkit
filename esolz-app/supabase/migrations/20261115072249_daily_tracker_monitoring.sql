CREATE TABLE public.daily_tracker_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('buybox','keyword')),
  source_key text NOT NULL,
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  marketplace_id text NOT NULL DEFAULT 'A21TJRUUN4KGV',
  tracked_keyword_id uuid REFERENCES public.tracked_keywords(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  last_status text,
  last_error text,
  claim_token uuid,
  claimed_at timestamptz,
  job_id uuid REFERENCES public.scraping_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,kind,source_key),
  CHECK ((kind='keyword' AND tracked_keyword_id IS NOT NULL AND source_key=tracked_keyword_id::text)
      OR (kind='buybox' AND tracked_keyword_id IS NULL AND source_key=asin)),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);
ALTER TABLE public.daily_tracker_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_tracker_member_read ON public.daily_tracker_targets FOR SELECT TO authenticated
USING (workspace_id IN (SELECT public.user_workspace_ids()));
REVOKE ALL ON public.daily_tracker_targets FROM anon, authenticated;
GRANT SELECT ON public.daily_tracker_targets TO authenticated;
GRANT ALL ON public.daily_tracker_targets TO service_role;
CREATE INDEX daily_tracker_due_idx ON public.daily_tracker_targets(next_check_at) WHERE NOT paused;

-- Adding a tracked keyword is also an explicit request to monitor it daily.
CREATE FUNCTION public.enroll_keyword_daily_tracker() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE product_asin text;
BEGIN
  product_asin := NEW.own_asin;
  IF product_asin IS NULL THEN
    SELECT asin INTO product_asin FROM public.tracked_asins
    WHERE id=NEW.tracked_asin_id AND workspace_id=NEW.workspace_id AND status <> 'archived';
  END IF;
  IF product_asin ~ '^[A-Z0-9]{10}$' AND NEW.marketplace IN ('IN','amazon.in','A21TJRUUN4KGV') THEN
    INSERT INTO public.daily_tracker_targets(workspace_id,kind,source_key,asin,tracked_keyword_id)
    VALUES(NEW.workspace_id,'keyword',NEW.id::text,product_asin,NEW.id)
    ON CONFLICT(workspace_id,kind,source_key) DO UPDATE SET asin=excluded.asin;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enroll_keyword_daily_tracker() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER tracked_keyword_daily_enrollment AFTER INSERT OR UPDATE OF own_asin,tracked_asin_id,marketplace
ON public.tracked_keywords FOR EACH ROW EXECUTE FUNCTION public.enroll_keyword_daily_tracker();
INSERT INTO public.daily_tracker_targets(workspace_id,kind,source_key,asin,tracked_keyword_id)
SELECT k.workspace_id,'keyword',k.id::text,coalesce(k.own_asin,t.asin),k.id
FROM public.tracked_keywords k LEFT JOIN public.tracked_asins t ON t.id=k.tracked_asin_id AND t.workspace_id=k.workspace_id AND t.status <> 'archived'
WHERE coalesce(k.own_asin,t.asin) ~ '^[A-Z0-9]{10}$' AND k.marketplace IN ('IN','amazon.in','A21TJRUUN4KGV')
ON CONFLICT DO NOTHING;

CREATE FUNCTION public.claim_daily_tracker(p_workspaces uuid[]) RETURNS SETOF public.daily_tracker_targets
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH candidate AS (
    SELECT id FROM public.daily_tracker_targets WHERE workspace_id=ANY(p_workspaces) AND NOT paused
    AND next_check_at<=now() AND (claimed_at IS NULL OR claimed_at<now()-interval '10 minutes')
    ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE public.daily_tracker_targets t SET claim_token=gen_random_uuid(),claimed_at=now()
  FROM candidate c WHERE t.id=c.id RETURNING t.*;
$$;
REVOKE ALL ON FUNCTION public.claim_daily_tracker(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_tracker(uuid[]) TO service_role;

-- Explicitly watched BSR targets take priority over the general catalogue backlog.
CREATE FUNCTION public.prioritize_watched_bsr_job() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.job_type='product_page_snapshot' AND EXISTS (
    SELECT 1 FROM public.bsr_tracking_targets t WHERE t.workspace_id=NEW.workspace_id AND t.status='active'
    AND ((NEW.target_type='my_product' AND t.amazon_listing_item_id=NEW.target_id)
      OR (NEW.target_type='competitor_asin' AND t.tracked_asin_id=NEW.target_id))) THEN
    NEW.priority := greatest(NEW.priority,200);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.prioritize_watched_bsr_job() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER background_job_bsr_priority BEFORE INSERT ON public.background_jobs
FOR EACH ROW EXECUTE FUNCTION public.prioritize_watched_bsr_job();

CREATE FUNCTION public.queue_watched_bsr_target() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE product_asin text; market text; target_kind text; source_id uuid;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF NEW.amazon_listing_item_id IS NOT NULL THEN
    target_kind := 'my_product'; source_id := NEW.amazon_listing_item_id;
    SELECT asin,marketplace_id INTO product_asin,market FROM public.amazon_listing_items WHERE id=source_id AND workspace_id=NEW.workspace_id;
  ELSE
    target_kind := 'competitor_asin'; source_id := NEW.tracked_asin_id;
    SELECT asin,CASE WHEN marketplace IN ('IN','amazon.in') THEN 'A21TJRUUN4KGV' ELSE marketplace END
      INTO product_asin,market FROM public.tracked_asins WHERE id=source_id AND workspace_id=NEW.workspace_id AND status <> 'archived';
  END IF;
  IF product_asin IS NULL THEN RETURN NEW; END IF;
  UPDATE public.background_jobs SET priority=greatest(priority,200),run_after=least(run_after,now())
    WHERE workspace_id=NEW.workspace_id AND job_type='product_page_snapshot' AND target_type=target_kind AND target_id=source_id AND status='queued';
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.background_jobs WHERE workspace_id=NEW.workspace_id
    AND job_type='product_page_snapshot' AND target_type=target_kind AND target_id=source_id AND status='running') THEN
    INSERT INTO public.background_jobs(workspace_id,job_type,target_type,target_id,marketplace_id,priority,payload_json)
    VALUES(NEW.workspace_id,'product_page_snapshot',target_kind,source_id,market,200,jsonb_build_object('asin',product_asin))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.queue_watched_bsr_target() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER bsr_watch_enqueues_check AFTER INSERT OR UPDATE OF status ON public.bsr_tracking_targets
FOR EACH ROW EXECUTE FUNCTION public.queue_watched_bsr_target();
NOTIFY pgrst,'reload schema';
