-- Additive history tables for XHZU stock CSV uploads.
-- internal_inventory_by_location remains the latest-current stock table used for calculations.
-- These tables record every upload as a batch + its rows, so a previous upload is never lost
-- and the UI can show which file/upload is currently driving suggested vendor quantities.
-- No order identifiers, shipment identifiers, or customer/buyer data are stored.

CREATE TABLE IF NOT EXISTS public.xhzu_stock_upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  uploaded_by text,
  original_filename text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS xhzu_stock_upload_batches_workspace_idx
  ON public.xhzu_stock_upload_batches (workspace_id, marketplace_id, uploaded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS xhzu_stock_upload_batches_active_uidx
  ON public.xhzu_stock_upload_batches (workspace_id, marketplace_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.xhzu_stock_upload_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.xhzu_stock_upload_batches(id) ON DELETE CASCADE,
  component_sku text NOT NULL,
  location_code text NOT NULL,
  available_quantity integer NOT NULL DEFAULT 0,
  reserved_quantity integer NOT NULL DEFAULT 0,
  inbound_quantity integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS xhzu_stock_upload_rows_batch_idx
  ON public.xhzu_stock_upload_rows (batch_id);

ALTER TABLE public.xhzu_stock_upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xhzu_stock_upload_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "xhzu_stock_upload_batches: member select"
  ON public.xhzu_stock_upload_batches
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "xhzu_stock_upload_rows: member select"
  ON public.xhzu_stock_upload_rows
  FOR SELECT
  TO authenticated
  USING (batch_id IN (
    SELECT id FROM public.xhzu_stock_upload_batches
    WHERE workspace_id IN (SELECT public.user_workspace_ids())
  ));

-- Writes remain service-role only, consistent with other internal_* import tables.

NOTIFY pgrst, 'reload schema';
