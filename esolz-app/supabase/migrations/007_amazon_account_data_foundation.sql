-- ─────────────────────────────────────────────────────────────────────────────
-- 007_amazon_account_data_foundation.sql
-- Amazon SP-API Phase 2A: Account Data Schema + Sync Job Foundation
--
-- Tables added:
--   1. amazon_sync_jobs           — audit trail + status for every SP-API sync run
--   2. amazon_listing_items       — catalog/listing data per SKU/ASIN per workspace
--   3. amazon_inventory_summaries — FBA inventory levels per SKU per workspace
--   4. amazon_pricing_snapshots   — point-in-time price snapshots per ASIN
--
-- RLS pattern (all tables):
--   SELECT  → workspace_id IN (SELECT public.user_workspace_ids())
--   INSERT/UPDATE/DELETE → service-role only (no authenticated policy)
--
-- NOT included in this migration:
--   Orders, sales, Brand Analytics (deferred to later phases)
--   No PII columns (no customer names, addresses, or order-level buyer data)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. amazon_sync_jobs ───────────────────────────────────────────────────────
-- Records every SP-API sync attempt: type, status, timing, errors.
-- job_type examples : 'basic_sync', 'listing_items', 'inventory', 'pricing'
-- status values     : 'pending', 'running', 'completed', 'failed', 'cancelled'

CREATE TABLE IF NOT EXISTS public.amazon_sync_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id)        ON DELETE CASCADE,
  connection_id uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  job_type      text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  started_at    timestamptz,
  finished_at   timestamptz,
  error_message text,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS amazon_sync_jobs_workspace_idx
  ON public.amazon_sync_jobs (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_sync_jobs_workspace_created_idx
  ON public.amazon_sync_jobs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS amazon_sync_jobs_connection_idx
  ON public.amazon_sync_jobs (connection_id);

CREATE INDEX IF NOT EXISTS amazon_sync_jobs_status_idx
  ON public.amazon_sync_jobs (status);

ALTER TABLE public.amazon_sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_sync_jobs_workspace_read"
  ON public.amazon_sync_jobs
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only


-- ── 2. amazon_listing_items ───────────────────────────────────────────────────
-- Catalog and listing metadata per SKU fetched from SP-API Listings Items API.
-- Primary deduplication key : (workspace_id, sku, marketplace_id)
-- Partial unique index       : (workspace_id, asin, marketplace_id) WHERE asin IS NOT NULL
-- Upserted on each sync run; raw_data holds the full SP-API response payload.
--
-- NOT stored here: pricing, inventory (separate tables), orders (future phase)

CREATE TABLE IF NOT EXISTS public.amazon_listing_items (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES public.workspaces(id)        ON DELETE CASCADE,
  connection_id  uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  asin           text,                    -- nullable: ASIN may not yet be assigned to a SKU
  sku            text,                    -- seller SKU
  marketplace_id text,
  item_name      text,
  brand          text,
  product_type   text,
  status         text,                    -- e.g. 'ACTIVE', 'INACTIVE', 'INCOMPLETE'
  image_url      text,
  raw_data       jsonb       NOT NULL DEFAULT '{}',
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Primary uniqueness: one row per SKU per marketplace per workspace
  UNIQUE (workspace_id, sku, marketplace_id)
);

-- Partial unique index: one ASIN per marketplace per workspace (nulls excluded)
CREATE UNIQUE INDEX IF NOT EXISTS amazon_listing_items_asin_marketplace_uidx
  ON public.amazon_listing_items (workspace_id, asin, marketplace_id)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_listing_items_workspace_idx
  ON public.amazon_listing_items (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_listing_items_connection_idx
  ON public.amazon_listing_items (connection_id);

CREATE INDEX IF NOT EXISTS amazon_listing_items_asin_idx
  ON public.amazon_listing_items (workspace_id, asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_listing_items_sku_idx
  ON public.amazon_listing_items (workspace_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_listing_items_marketplace_idx
  ON public.amazon_listing_items (workspace_id, marketplace_id);

ALTER TABLE public.amazon_listing_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_listing_items_workspace_read"
  ON public.amazon_listing_items
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only


-- ── 3. amazon_inventory_summaries ─────────────────────────────────────────────
-- FBA inventory levels per SKU from SP-API FBA Inventory API.
-- Deduplicated per (workspace_id, sku, marketplace_id) — replaced on each sync.
--
-- available_quantity   = sellable stock on FBA floor
-- inbound_quantity     = en-route to FBA warehouse
-- reserved_quantity    = holds / pending shipments
-- fulfillable_quantity = total quantity Amazon can fulfil right now

CREATE TABLE IF NOT EXISTS public.amazon_inventory_summaries (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id)        ON DELETE CASCADE,
  connection_id        uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  asin                 text,              -- nullable: SKU may not always map to an ASIN
  sku                  text        NOT NULL,
  marketplace_id       text,
  available_quantity   int         NOT NULL DEFAULT 0,
  inbound_quantity     int         NOT NULL DEFAULT 0,
  reserved_quantity    int         NOT NULL DEFAULT 0,
  fulfillable_quantity int         NOT NULL DEFAULT 0,
  raw_data             jsonb       NOT NULL DEFAULT '{}',
  last_synced_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, sku, marketplace_id)
);

CREATE INDEX IF NOT EXISTS amazon_inventory_summaries_workspace_idx
  ON public.amazon_inventory_summaries (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_inventory_summaries_connection_idx
  ON public.amazon_inventory_summaries (connection_id);

CREATE INDEX IF NOT EXISTS amazon_inventory_summaries_asin_idx
  ON public.amazon_inventory_summaries (workspace_id, asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS amazon_inventory_summaries_sku_idx
  ON public.amazon_inventory_summaries (workspace_id, sku);

CREATE INDEX IF NOT EXISTS amazon_inventory_summaries_marketplace_idx
  ON public.amazon_inventory_summaries (workspace_id, marketplace_id);

ALTER TABLE public.amazon_inventory_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_inventory_summaries_workspace_read"
  ON public.amazon_inventory_summaries
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only


-- ── 4. amazon_pricing_snapshots ───────────────────────────────────────────────
-- Append-only price time-series per ASIN from SP-API Product Pricing API.
-- Each sync run inserts new rows (no unique constraint — intentional time-series).
-- Used for price history charts and buy box trend detection.
--
-- landed_price  = listing price + shipping (total buyer pays)
-- listing_price = seller's listed price before shipping
-- buy_box_price = current Buy Box winner's landed price
-- currency      = ISO 4217 code e.g. 'INR', 'USD'

CREATE TABLE IF NOT EXISTS public.amazon_pricing_snapshots (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES public.workspaces(id)        ON DELETE CASCADE,
  connection_id  uuid        NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  asin           text        NOT NULL,
  marketplace_id text,
  landed_price   numeric,
  listing_price  numeric,
  buy_box_price  numeric,
  currency       text,
  raw_data       jsonb       NOT NULL DEFAULT '{}',
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_workspace_asin_time_idx
  ON public.amazon_pricing_snapshots (workspace_id, asin, checked_at DESC);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_workspace_idx
  ON public.amazon_pricing_snapshots (workspace_id);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_connection_idx
  ON public.amazon_pricing_snapshots (connection_id);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_asin_idx
  ON public.amazon_pricing_snapshots (workspace_id, asin);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_marketplace_idx
  ON public.amazon_pricing_snapshots (workspace_id, marketplace_id);

CREATE INDEX IF NOT EXISTS amazon_pricing_snapshots_checked_at_idx
  ON public.amazon_pricing_snapshots (checked_at DESC);

ALTER TABLE public.amazon_pricing_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amazon_pricing_snapshots_workspace_read"
  ON public.amazon_pricing_snapshots
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only
