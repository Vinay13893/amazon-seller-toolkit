-- Internal-only profitability foundation: SKU cost-price master and the
-- normalized Amazon "Date Range Transaction Report" feed.
--
-- internal_payment_transactions intentionally stores Amazon Order ID, SKU,
-- and order city/state/postal (no buyer name, address line, phone, or other
-- customer PII) — a deliberate, scoped exception to the no-order-id
-- convention used by every other internal_* table, made specifically for
-- order-level profitability/leakage analysis. Do not extend this exception
-- to any other table without an equally explicit decision.

CREATE TABLE IF NOT EXISTS public.internal_sku_cost_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sku text NOT NULL,
  sku_norm text NOT NULL,
  cost_price numeric(14, 2),
  packing_transport numeric(14, 2),
  gst_rate numeric(6, 4),
  gst_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_name text,
  category text,
  notes text,
  source text NOT NULL DEFAULT 'json_import',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sku_norm)
);

ALTER TABLE public.internal_sku_cost_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_sku_cost_master: internal select"
  ON public.internal_sku_cost_master
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_sku_cost_master.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_internal_sku_cost_master_updated_at
  ON public.internal_sku_cost_master;
CREATE TRIGGER trg_internal_sku_cost_master_updated_at
  BEFORE UPDATE ON public.internal_sku_cost_master
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TABLE IF NOT EXISTS public.internal_payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace text NOT NULL DEFAULT 'amazon.in',
  transaction_date timestamptz NOT NULL,
  settlement_id text,
  transaction_type text NOT NULL,
  category text NOT NULL,
  order_id text,
  sku text,
  sku_norm text,
  description text,
  quantity integer,
  account_type text,
  fulfillment text,
  order_city text,
  order_state text,
  order_postal text,
  product_sales numeric(14, 2) NOT NULL DEFAULT 0,
  shipping_credits numeric(14, 2) NOT NULL DEFAULT 0,
  gift_wrap_credits numeric(14, 2) NOT NULL DEFAULT 0,
  promotional_rebates numeric(14, 2) NOT NULL DEFAULT 0,
  total_sales_tax_liable numeric(14, 2) NOT NULL DEFAULT 0,
  tcs_cgst numeric(14, 2) NOT NULL DEFAULT 0,
  tcs_sgst numeric(14, 2) NOT NULL DEFAULT 0,
  tcs_igst numeric(14, 2) NOT NULL DEFAULT 0,
  tds_194o numeric(14, 2) NOT NULL DEFAULT 0,
  selling_fees numeric(14, 2) NOT NULL DEFAULT 0,
  fba_fees numeric(14, 2) NOT NULL DEFAULT 0,
  other_transaction_fees numeric(14, 2) NOT NULL DEFAULT 0,
  other_amount numeric(14, 2) NOT NULL DEFAULT 0,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0,
  transaction_status text,
  transaction_release_date timestamptz,
  source text NOT NULL DEFAULT 'transaction_report_upload',
  source_file_name text,
  source_row_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_payment_transactions_dedupe_uidx
  ON public.internal_payment_transactions (
    workspace_id,
    COALESCE(settlement_id, ''),
    COALESCE(order_id, ''),
    COALESCE(sku, ''),
    transaction_type,
    transaction_date,
    total_amount
  );

CREATE INDEX IF NOT EXISTS internal_payment_transactions_workspace_date_idx
  ON public.internal_payment_transactions (workspace_id, transaction_date);

CREATE INDEX IF NOT EXISTS internal_payment_transactions_workspace_sku_idx
  ON public.internal_payment_transactions (workspace_id, sku_norm)
  WHERE sku_norm IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_payment_transactions_workspace_category_idx
  ON public.internal_payment_transactions (workspace_id, category);

CREATE INDEX IF NOT EXISTS internal_payment_transactions_workspace_order_idx
  ON public.internal_payment_transactions (workspace_id, order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE public.internal_payment_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_payment_transactions: internal select"
  ON public.internal_payment_transactions
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_payment_transactions.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_internal_payment_transactions_updated_at
  ON public.internal_payment_transactions;
CREATE TRIGGER trg_internal_payment_transactions_updated_at
  BEFORE UPDATE ON public.internal_payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
