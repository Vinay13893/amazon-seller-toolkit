-- Internal-only SKU component mapping persistence (Amazon SKU -> WMS parent -> component SKU).
-- Structural mapping data only. No raw report rows, order identifiers, or customer data are stored.
-- Not yet used by recommendations; importer/insert logic lands separately.

CREATE TABLE IF NOT EXISTS public.internal_sku_component_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  amazon_sku text NOT NULL,
  amazon_sku_norm text NOT NULL,
  asin text,
  asin_norm text,
  wms_parent_sku text NOT NULL,
  wms_parent_sku_norm text NOT NULL,
  component_sku text NOT NULL,
  component_sku_norm text NOT NULL,
  component_quantity integer NOT NULL CHECK (component_quantity > 0),
  mapping_type text NOT NULL CHECK (mapping_type IN ('single', 'combo')),
  source text NOT NULL DEFAULT 'excel_upload',
  source_file_name text,
  source_row_number integer,
  source_component_column text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_sku_component_mappings_active_uidx
  ON public.internal_sku_component_mappings (workspace_id, marketplace_id, amazon_sku_norm, component_sku_norm)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS internal_sku_component_mappings_amazon_sku_idx
  ON public.internal_sku_component_mappings (workspace_id, marketplace_id, amazon_sku_norm);

CREATE INDEX IF NOT EXISTS internal_sku_component_mappings_component_sku_idx
  ON public.internal_sku_component_mappings (workspace_id, marketplace_id, component_sku_norm);

CREATE INDEX IF NOT EXISTS internal_sku_component_mappings_wms_parent_sku_idx
  ON public.internal_sku_component_mappings (workspace_id, marketplace_id, wms_parent_sku_norm);

CREATE INDEX IF NOT EXISTS internal_sku_component_mappings_workspace_active_idx
  ON public.internal_sku_component_mappings (workspace_id, is_active);

ALTER TABLE public.internal_sku_component_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_sku_component_mappings: member select"
  ON public.internal_sku_component_mappings
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- Writes remain service-role only, consistent with other internal_* import tables.

DROP TRIGGER IF EXISTS trg_internal_sku_component_mappings_updated_at
  ON public.internal_sku_component_mappings;
CREATE TRIGGER trg_internal_sku_component_mappings_updated_at
  BEFORE UPDATE ON public.internal_sku_component_mappings
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
