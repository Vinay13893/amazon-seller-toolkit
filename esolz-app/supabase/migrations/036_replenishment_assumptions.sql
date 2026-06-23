-- Additive table for persisted replenishment planning assumptions (Flex/Vendor and FC scopes).
-- Today these assumptions are runtime query-string parameters with hardcoded defaults
-- (see DEFAULT_REPLENISHMENT_ASSUMPTIONS in internal-replenishment-planner.ts). This table lets
-- a saved override be looked up later without changing the existing default-driven formula.
-- No order identifiers, shipment identifiers, or customer/buyer data are stored.

CREATE TABLE IF NOT EXISTS public.replenishment_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('flex', 'fc')),
  lookback_days integer NOT NULL,
  planning_days integer NOT NULL,
  transit_buffer_days integer NOT NULL,
  sales_growth_ratio numeric NOT NULL,
  safety_stock_multiplier numeric NOT NULL DEFAULT 1,
  vendor_qty_multiplier numeric NOT NULL DEFAULT 1,
  include_inbound boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS replenishment_assumptions_scope_uidx
  ON public.replenishment_assumptions (workspace_id, marketplace_id, scope);

ALTER TABLE public.replenishment_assumptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "replenishment_assumptions: member select"
  ON public.replenishment_assumptions
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- Writes remain service-role only, consistent with other internal_* planning tables.

DROP TRIGGER IF EXISTS trg_replenishment_assumptions_updated_at
  ON public.replenishment_assumptions;
CREATE TRIGGER trg_replenishment_assumptions_updated_at
  BEFORE UPDATE ON public.replenishment_assumptions
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
