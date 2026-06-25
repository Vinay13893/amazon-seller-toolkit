-- Phase 1D: Brahmastra Action Queue review status. Stores only the team's
-- review state (status/notes) against a deterministically-generated
-- action_key — never raw transaction/PII data. The action items themselves
-- are computed on the fly from existing diagnostic tables, not stored here.

CREATE TABLE IF NOT EXISTS public.internal_ads_brahmastra_action_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action_key text NOT NULL,
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Reviewing', 'Done', 'Ignored')),
  notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, action_key)
);

CREATE INDEX IF NOT EXISTS internal_ads_brahmastra_action_reviews_workspace_idx
  ON public.internal_ads_brahmastra_action_reviews (workspace_id, status);

ALTER TABLE public.internal_ads_brahmastra_action_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_ads_brahmastra_action_reviews: internal select"
  ON public.internal_ads_brahmastra_action_reviews
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_ads_brahmastra_action_reviews.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

-- Writes remain service-role only, consistent with other internal_* tables.

DROP TRIGGER IF EXISTS trg_internal_ads_brahmastra_action_reviews_updated_at
  ON public.internal_ads_brahmastra_action_reviews;
CREATE TRIGGER trg_internal_ads_brahmastra_action_reviews_updated_at
  BEFORE UPDATE ON public.internal_ads_brahmastra_action_reviews
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
