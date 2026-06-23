-- Placeholder table for Amazon's own restock/replenishment recommendation per SKU
-- (GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT). No fetch job writes to this table yet
-- (see Task A/B audit) -- it exists so the FC allocation UI has a safe, honest place to
-- read from and show "Amazon recommendation not synced yet" rather than faking a value.
-- benefit_type/benefit_eligible_qty/benefit_expiry are NOT verified as SP-API/report fields
-- yet; they stay nullable until confirmed against the live report schema for our marketplace.

CREATE TABLE IF NOT EXISTS public.amazon_restock_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text,
  amazon_sku text NOT NULL,
  amazon_sku_norm text NOT NULL,
  recommended_qty integer,
  recommended_ship_date date,
  days_of_supply numeric,
  inbound_quantity_considered integer,
  benefit_eligible_qty integer,
  benefit_type text,
  benefit_expiry date,
  source_status text NOT NULL DEFAULT 'pending_fetch'
    CHECK (source_status IN ('not_connected', 'not_available', 'pending_fetch', 'available')),
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS amazon_restock_recommendations_sku_uidx
  ON public.amazon_restock_recommendations (workspace_id, marketplace_id, amazon_sku_norm);

ALTER TABLE public.amazon_restock_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_restock_recommendations: member select"
  ON public.amazon_restock_recommendations
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- Writes remain service-role only, consistent with other internal_* planning tables.

DROP TRIGGER IF EXISTS trg_amazon_restock_recommendations_updated_at
  ON public.amazon_restock_recommendations;
CREATE TRIGGER trg_amazon_restock_recommendations_updated_at
  BEFORE UPDATE ON public.amazon_restock_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
