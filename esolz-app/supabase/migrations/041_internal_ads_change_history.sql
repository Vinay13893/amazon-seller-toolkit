-- Phase 1E.2: manually-imported Amazon Ads Console "Change History" events.
-- Source is a JSON file the user saves from DevTools (Console UI response),
-- NOT an automated scrape and NOT the public POST /history API (which
-- returned zero events for this account during verification). Read-only
-- analytics only: no bid/budget/campaign/keyword changes, no rollback.

CREATE TABLE IF NOT EXISTS public.internal_ads_change_history_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  original_filename text NOT NULL,
  from_date timestamptz,
  to_date timestamptz,
  total_records integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual_console_event_history_json',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_ads_change_history_import_batches_workspace_idx
  ON public.internal_ads_change_history_import_batches (workspace_id, created_at DESC);

ALTER TABLE public.internal_ads_change_history_import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_ads_change_history_import_batches: internal select"
  ON public.internal_ads_change_history_import_batches
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_ads_change_history_import_batches.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE TABLE IF NOT EXISTS public.internal_ads_change_history_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  import_batch_id uuid NOT NULL REFERENCES public.internal_ads_change_history_import_batches(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual_console_event_history_json',

  changed_at timestamptz NOT NULL,
  changed_at_ms bigint NOT NULL,
  change_type text NOT NULL,
  old_value text,
  new_value text,
  is_system_event boolean NOT NULL DEFAULT false,
  event_source_type text,
  event_source_id text,
  entity_name text,
  targeting_type text,
  match_type text,
  targeting_secondary text,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  ad_group_name text,
  program_type text,

  easyhome_portfolio text NOT NULL DEFAULT 'Unmapped / Needs Review',
  raw_event jsonb NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS internal_ads_change_history_events_workspace_date_idx
  ON public.internal_ads_change_history_events (workspace_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS internal_ads_change_history_events_campaign_idx
  ON public.internal_ads_change_history_events (workspace_id, campaign_id)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS internal_ads_change_history_events_source_idx
  ON public.internal_ads_change_history_events (workspace_id, event_source_id)
  WHERE event_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS internal_ads_change_history_events_batch_idx
  ON public.internal_ads_change_history_events (import_batch_id);

ALTER TABLE public.internal_ads_change_history_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_ads_change_history_events: internal select"
  ON public.internal_ads_change_history_events
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_ads_change_history_events.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

-- Writes remain service-role only, consistent with other internal_* import tables.

DROP TRIGGER IF EXISTS trg_internal_ads_change_history_events_updated_at
  ON public.internal_ads_change_history_events;
CREATE TRIGGER trg_internal_ads_change_history_events_updated_at
  BEFORE UPDATE ON public.internal_ads_change_history_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
