-- Internal-only structured FBA fulfillment report foundation.
-- No raw report rows, order identifiers, or customer data are stored.

CREATE TABLE IF NOT EXISTS public.internal_fba_report_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id uuid NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  report_type text NOT NULL,
  report_id text,
  report_document_id text,
  marketplace_id text NOT NULL,
  data_start_time timestamptz,
  data_end_time timestamptz,
  processing_status text NOT NULL DEFAULT 'IN_QUEUE',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  stored_row_count integer NOT NULL DEFAULT 0,
  fc_field_available boolean,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, report_id)
);

CREATE INDEX IF NOT EXISTS internal_fba_report_jobs_workspace_requested_idx
  ON public.internal_fba_report_jobs (workspace_id, requested_at DESC);

ALTER TABLE public.internal_fba_report_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_fba_report_jobs: internal select"
  ON public.internal_fba_report_jobs
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fba_report_jobs.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE TABLE IF NOT EXISTS public.internal_fba_report_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_job_id uuid NOT NULL REFERENCES public.internal_fba_report_jobs(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text,
  sku text,
  fnsku text,
  fulfillment_center_id text,
  disposition text,
  event_type text,
  quantity integer,
  running_balance integer,
  report_date date,
  report_type text NOT NULL,
  report_document_id text NOT NULL,
  source text NOT NULL DEFAULT 'fulfillment_report',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_asin_idx
  ON public.internal_fba_report_rows (workspace_id, marketplace_id, asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_sku_idx
  ON public.internal_fba_report_rows (workspace_id, marketplace_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_fba_report_rows_workspace_fc_idx
  ON public.internal_fba_report_rows (workspace_id, fulfillment_center_id)
  WHERE fulfillment_center_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS internal_fba_report_rows_document_row_uidx
  ON public.internal_fba_report_rows (
    workspace_id,
    report_document_id,
    COALESCE(asin, ''),
    COALESCE(sku, ''),
    COALESCE(fnsku, ''),
    COALESCE(fulfillment_center_id, ''),
    COALESCE(disposition, ''),
    COALESCE(event_type, ''),
    COALESCE(report_date, DATE '1970-01-01'),
    COALESCE(quantity, 0),
    COALESCE(running_balance, 0)
  );

ALTER TABLE public.internal_fba_report_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_fba_report_rows: internal select"
  ON public.internal_fba_report_rows
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fba_report_rows.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_internal_fba_report_jobs_updated_at
  ON public.internal_fba_report_jobs;
CREATE TRIGGER trg_internal_fba_report_jobs_updated_at
  BEFORE UPDATE ON public.internal_fba_report_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_internal_fba_report_rows_updated_at
  ON public.internal_fba_report_rows;
CREATE TRIGGER trg_internal_fba_report_rows_updated_at
  BEFORE UPDATE ON public.internal_fba_report_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TABLE IF NOT EXISTS public.internal_fulfillment_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  location_code text NOT NULL,
  location_name text,
  location_type text NOT NULL DEFAULT 'unknown' CHECK (location_type IN ('seller_flex', 'fba_fc', 'easy_ship_mfn', 'unknown')),
  is_active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'fulfillment_report',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, location_code)
);

CREATE TABLE IF NOT EXISTS public.internal_state_zone_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state_code text NOT NULL,
  state_name text,
  zone_code text NOT NULL,
  zone_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, state_code)
);

CREATE TABLE IF NOT EXISTS public.internal_fulfillment_sales_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text,
  sku text,
  sales_date date NOT NULL,
  state_code text,
  zone_code text,
  location_code text,
  source text NOT NULL DEFAULT 'unknown',
  ordered_units integer NOT NULL DEFAULT 0 CHECK (ordered_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id,
    marketplace_id,
    COALESCE(asin, ''),
    COALESCE(sku, ''),
    sales_date,
    COALESCE(state_code, ''),
    COALESCE(location_code, ''),
    source
  )
);

CREATE TABLE IF NOT EXISTS public.internal_inventory_by_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL,
  asin text,
  sku text,
  location_code text,
  source text NOT NULL DEFAULT 'inventory_api',
  available_quantity integer NOT NULL DEFAULT 0,
  inbound_quantity integer NOT NULL DEFAULT 0,
  reserved_quantity integer NOT NULL DEFAULT 0,
  unsellable_quantity integer NOT NULL DEFAULT 0,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id,
    marketplace_id,
    COALESCE(asin, ''),
    COALESCE(sku, ''),
    COALESCE(location_code, ''),
    snapshot_at
  )
);

CREATE INDEX IF NOT EXISTS internal_fulfillment_locations_workspace_idx
  ON public.internal_fulfillment_locations (workspace_id, location_type);

CREATE INDEX IF NOT EXISTS internal_state_zone_map_workspace_idx
  ON public.internal_state_zone_map (workspace_id, zone_code);

CREATE INDEX IF NOT EXISTS internal_fulfillment_sales_daily_workspace_idx
  ON public.internal_fulfillment_sales_daily (workspace_id, sales_date DESC);

CREATE INDEX IF NOT EXISTS internal_inventory_by_location_workspace_idx
  ON public.internal_inventory_by_location (workspace_id, snapshot_at DESC);

ALTER TABLE public.internal_fulfillment_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_state_zone_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_fulfillment_sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_inventory_by_location ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_fulfillment_locations: internal select"
  ON public.internal_fulfillment_locations
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fulfillment_locations.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE POLICY "internal_state_zone_map: internal select"
  ON public.internal_state_zone_map
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_state_zone_map.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE POLICY "internal_fulfillment_sales_daily: internal select"
  ON public.internal_fulfillment_sales_daily
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_fulfillment_sales_daily.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

CREATE POLICY "internal_inventory_by_location: internal select"
  ON public.internal_inventory_by_location
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.user_workspace_ids())
    AND (
      lower(COALESCE(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      OR EXISTS (
        SELECT 1
        FROM public.workspace_subscriptions AS ws
        JOIN public.subscription_plans AS plan ON plan.id = ws.plan_id
        WHERE ws.workspace_id = internal_inventory_by_location.workspace_id
          AND ws.status IN ('active', 'trial')
          AND plan.name = 'Internal Tester'
      )
    )
  );

DROP TRIGGER IF EXISTS trg_internal_fulfillment_locations_updated_at
  ON public.internal_fulfillment_locations;
CREATE TRIGGER trg_internal_fulfillment_locations_updated_at
  BEFORE UPDATE ON public.internal_fulfillment_locations
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_internal_state_zone_map_updated_at
  ON public.internal_state_zone_map;
CREATE TRIGGER trg_internal_state_zone_map_updated_at
  BEFORE UPDATE ON public.internal_state_zone_map
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_internal_fulfillment_sales_daily_updated_at
  ON public.internal_fulfillment_sales_daily;
CREATE TRIGGER trg_internal_fulfillment_sales_daily_updated_at
  BEFORE UPDATE ON public.internal_fulfillment_sales_daily
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_internal_inventory_by_location_updated_at
  ON public.internal_inventory_by_location;
CREATE TRIGGER trg_internal_inventory_by_location_updated_at
  BEFORE UPDATE ON public.internal_inventory_by_location
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

INSERT INTO public.internal_fulfillment_locations (workspace_id, location_code, location_type, source)
SELECT w.id, flex.location_code, 'seller_flex', 'seed'
FROM public.workspaces AS w
CROSS JOIN (VALUES ('XHZU'), ('XHZV'), ('XHZR'), ('TPKR')) AS flex(location_code)
ON CONFLICT (workspace_id, location_code)
DO UPDATE SET
  location_type = EXCLUDED.location_type,
  is_active = true,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
