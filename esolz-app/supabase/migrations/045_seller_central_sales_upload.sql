-- Migration 045: Seller Central uploaded demand source
-- Stores manually uploaded Seller Central Manage Inventory demand data.
-- Keeps full batch history; is_active marks the latest/used batch.
-- Intentionally separate from FBA ledger demand (trusted fulfillment demand).

create table if not exists seller_central_sales_upload_batches (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  marketplace_id     text,
  uploaded_by        text,
  original_filename  text not null,
  report_start_date  date,
  report_end_date    date,
  period_label       text,
  row_count          integer not null default 0,
  accepted_count     integer not null default 0,
  rejected_count     integer not null default 0,
  uploaded_at        timestamptz not null default now(),
  is_active          boolean not null default false,
  notes              text
);

create index if not exists idx_sc_sales_batches_workspace
  on seller_central_sales_upload_batches (workspace_id, uploaded_at desc);

create index if not exists idx_sc_sales_batches_active
  on seller_central_sales_upload_batches (workspace_id, is_active)
  where is_active = true;

create table if not exists seller_central_sales_rows (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references seller_central_sales_upload_batches (id) on delete cascade,
  workspace_id   uuid not null,
  marketplace_id text,
  amazon_sku     text not null,
  amazon_sku_norm text not null,
  asin           text,
  title          text,
  units_sold     integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists idx_sc_sales_rows_batch
  on seller_central_sales_rows (batch_id);

create index if not exists idx_sc_sales_rows_workspace_sku
  on seller_central_sales_rows (workspace_id, amazon_sku_norm);

-- RLS: internal routes use service role key, so no RLS policy needed.
-- Workspace isolation is enforced in application code via workspace_id checks.
alter table seller_central_sales_upload_batches enable row level security;
alter table seller_central_sales_rows enable row level security;
