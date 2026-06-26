-- Derived aggregate table: SKU × date × geo × fulfilment demand.
-- Populated on-demand from internal_payment_transactions via the geo-demand
-- API route (upsert). Never stores buyer identity, full address, or raw
-- order payloads. Order ID is intentionally excluded from this derived table.
--
-- fulfillment_bucket values:
--   fba_fc              → fulfillment = 'Amazon'
--   direct_flex_easyship → fulfillment = 'Merchant' (Flex / Easy Ship / MFN)
--   unknown             → fulfillment NULL / unrecognised

CREATE TABLE IF NOT EXISTS public.amazon_sku_geo_sales_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL DEFAULT 'A21TJRUUN4KGV',
  sales_date date NOT NULL,
  amazon_sku text NOT NULL,
  amazon_sku_norm text NOT NULL,
  asin text,
  fulfillment_bucket text NOT NULL DEFAULT 'unknown'
    CHECK (fulfillment_bucket IN ('fba_fc', 'direct_flex_easyship', 'unknown')),
  state text,
  city text,
  pincode text,
  country_code text NOT NULL DEFAULT 'IN',
  units_sold integer NOT NULL DEFAULT 0,
  orders_count integer NOT NULL DEFAULT 0,
  gross_sales_amount numeric(14, 2),
  refunds_amount numeric(14, 2),
  returns_count integer NOT NULL DEFAULT 0,
  refunded_units integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'payment_transaction_report',
  batch_source_period_start date,
  batch_source_period_end date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    marketplace_id,
    sales_date,
    amazon_sku_norm,
    fulfillment_bucket,
    state,
    city,
    pincode
  )
);

CREATE INDEX IF NOT EXISTS amazon_sku_geo_sales_daily_workspace_date_idx
  ON public.amazon_sku_geo_sales_daily (workspace_id, sales_date DESC);

CREATE INDEX IF NOT EXISTS amazon_sku_geo_sales_daily_workspace_sku_idx
  ON public.amazon_sku_geo_sales_daily (workspace_id, amazon_sku_norm);

CREATE INDEX IF NOT EXISTS amazon_sku_geo_sales_daily_workspace_state_idx
  ON public.amazon_sku_geo_sales_daily (workspace_id, state)
  WHERE state IS NOT NULL;

ALTER TABLE public.amazon_sku_geo_sales_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_sku_geo_sales_daily: internal select"
  ON public.amazon_sku_geo_sales_daily
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = amazon_sku_geo_sales_daily.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_amazon_sku_geo_sales_daily_updated_at
  ON public.amazon_sku_geo_sales_daily;
CREATE TRIGGER trg_amazon_sku_geo_sales_daily_updated_at
  BEFORE UPDATE ON public.amazon_sku_geo_sales_daily
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
