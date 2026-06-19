-- Align internal_sku_component_mappings RLS with the gated Internal Tester
-- pattern used by migration 029, replacing the plain workspace-member policy
-- added in migration 031. Writes remain service-role only.

ALTER TABLE public.internal_sku_component_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "internal_sku_component_mappings: member select"
  ON public.internal_sku_component_mappings;

DROP POLICY IF EXISTS "internal_sku_component_mappings: internal select"
  ON public.internal_sku_component_mappings;

CREATE POLICY "internal_sku_component_mappings: internal select"
  ON public.internal_sku_component_mappings
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_sku_component_mappings.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

NOTIFY pgrst, 'reload schema';
