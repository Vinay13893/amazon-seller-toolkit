-- Allow PostgREST bulk upserts for aggregated CSV sales rows.
-- CSV uploads normalize a missing SKU to an empty string.

CREATE UNIQUE INDEX IF NOT EXISTS internal_sku_daily_sales_csv_uidx
  ON public.internal_sku_daily_sales (
    workspace_id,
    marketplace_id,
    asin,
    sku,
    sales_date,
    source
  );

DROP POLICY IF EXISTS "internal_sku_daily_sales: member select"
  ON public.internal_sku_daily_sales;
DROP POLICY IF EXISTS "internal_sku_daily_sales: internal select"
  ON public.internal_sku_daily_sales;

CREATE POLICY "internal_sku_daily_sales: internal select"
  ON public.internal_sku_daily_sales
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_sku_daily_sales.workspace_id
          AND ws.status IN ('active', 'trialing')
          AND plan.name = 'Internal Tester'
      )
    )
  );

NOTIFY pgrst, 'reload schema';
