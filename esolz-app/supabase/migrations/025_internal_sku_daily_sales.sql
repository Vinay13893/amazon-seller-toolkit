-- Normalized, workspace-scoped daily sales inputs for the read-only
-- Internal Emount Stock Action Dashboard.
-- No order-level rows, buyer details, or raw report payloads are stored.

CREATE TABLE IF NOT EXISTS public.internal_sku_daily_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text NOT NULL,
  sku text,
  sales_date date NOT NULL,
  ordered_units integer NOT NULL DEFAULT 0 CHECK (ordered_units >= 0),
  ordered_revenue numeric(14, 2) CHECK (ordered_revenue IS NULL OR ordered_revenue >= 0),
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_sku_daily_sales_workspace_asin_date_idx
  ON public.internal_sku_daily_sales (workspace_id, asin, sales_date DESC);

CREATE INDEX IF NOT EXISTS internal_sku_daily_sales_workspace_sku_date_idx
  ON public.internal_sku_daily_sales (workspace_id, sku, sales_date DESC)
  WHERE sku IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS internal_sku_daily_sales_daily_uidx
  ON public.internal_sku_daily_sales (
    workspace_id,
    marketplace_id,
    asin,
    COALESCE(sku, ''),
    sales_date,
    source
  );

ALTER TABLE public.internal_sku_daily_sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_sku_daily_sales: member select"
  ON public.internal_sku_daily_sales
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- Writes remain service-role only. The v1 dashboard is read-only.

DROP TRIGGER IF EXISTS trg_internal_sku_daily_sales_updated_at
  ON public.internal_sku_daily_sales;
CREATE TRIGGER trg_internal_sku_daily_sales_updated_at
  BEFORE UPDATE ON public.internal_sku_daily_sales
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
