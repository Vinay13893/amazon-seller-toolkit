-- Additive safety migration: dedupe Seller Flex location mappings.
-- internal_fulfillment_locations.workspace_id is NOT NULL, so duplicates for
-- XHZU/XHZV/XHZR/TPKR are real per-workspace duplicate rows, not NULL-bypass
-- rows. This migration removes the extra rows, normalizes the kept row, adds
-- a defensive unique index re-asserting (workspace_id, location_code)
-- uniqueness, and adds a partial unique index on location_code where
-- workspace_id is null (currently a no-op under the NOT NULL constraint, kept
-- as a forward-compatible safeguard). No raw report rows, order identifiers,
-- or customer data are touched.

DELETE FROM public.internal_fulfillment_locations a
USING public.internal_fulfillment_locations b
WHERE a.location_code IN ('XHZU', 'XHZV', 'XHZR', 'TPKR')
  AND a.location_code = b.location_code
  AND a.workspace_id = b.workspace_id
  AND a.ctid > b.ctid;

UPDATE public.internal_fulfillment_locations
SET
  location_type = 'seller_flex',
  is_active = true,
  source = 'business_config',
  updated_at = now()
WHERE location_code IN ('XHZU', 'XHZV', 'XHZR', 'TPKR');

CREATE UNIQUE INDEX IF NOT EXISTS internal_fulfillment_locations_workspace_code_uidx
  ON public.internal_fulfillment_locations (workspace_id, location_code);

CREATE UNIQUE INDEX IF NOT EXISTS internal_fulfillment_locations_global_code_uidx
  ON public.internal_fulfillment_locations (location_code)
  WHERE workspace_id IS NULL;

INSERT INTO public.internal_fulfillment_locations (workspace_id, location_code, location_type, source)
SELECT w.id, flex.location_code, 'seller_flex', 'business_config'
FROM public.workspaces AS w
CROSS JOIN (VALUES ('XHZU'), ('XHZV'), ('XHZR'), ('TPKR')) AS flex(location_code)
ON CONFLICT (workspace_id, location_code)
DO UPDATE SET
  location_type = EXCLUDED.location_type,
  is_active = true,
  source = EXCLUDED.source,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
