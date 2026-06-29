-- Phase R8: automated Seller Central Business Report sync via SP-API
-- Reports API (GET_SALES_AND_TRAFFIC_REPORT). Additive only — no Amazon Ads
-- sync table touched, no payment-transaction table touched.
--
-- Reuses internal_data_refresh_runs (already generic: workspace/source/
-- status/date_from/date_to/rows_*/report_request_key/amazon_report_id/
-- amazon_report_status/amazon_report_created_at/amazon_report_completed_at,
-- from migrations 046/049/050) for run tracking, with source =
-- 'business_report_sp_api'. Only adds the few SP-API-specific columns the
-- existing Ads-sync columns don't cover.

alter table public.internal_data_refresh_runs
  add column if not exists marketplace_id text,
  add column if not exists report_type text,
  add column if not exists report_options jsonb,
  add column if not exists report_document_id text;

-- SKU/ASIN-level Business Report ("Sales and Traffic by ASIN", asinGranularity
-- SKU). Separate table from internal_business_report_sales_traffic_daily
-- (by-date) — the two report sections come from the same SP-API report
-- document but are stored independently per the existing
-- "never merge sources silently" rule. No buyer PII: ASIN/SKU/title and
-- aggregate sales/traffic counts only.
create table if not exists public.internal_business_report_sku_sales_traffic (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  marketplace_id text not null default 'unknown',
  report_date date not null,
  parent_asin text,
  child_asin text,
  sku text,
  sku_norm text,
  portfolio text,
  ordered_product_sales numeric not null default 0,
  ordered_product_sales_b2b numeric,
  units_ordered integer not null default 0,
  units_ordered_b2b integer,
  total_order_items integer not null default 0,
  total_order_items_b2b integer,
  sessions integer,
  page_views integer,
  buy_box_percentage numeric,
  unit_session_percentage numeric,
  source_report_id text,
  upload_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per workspace/marketplace/date/SKU(or ASIN if SKU absent) — upsert
-- target for re-syncs of the same date range.
create unique index if not exists internal_business_report_sku_sales_traffic_key_uidx
  on public.internal_business_report_sku_sales_traffic (
    workspace_id, marketplace_id, report_date,
    coalesce(sku_norm, ''), coalesce(child_asin, ''), coalesce(parent_asin, '')
  );

create index if not exists internal_business_report_sku_sales_traffic_date_idx
  on public.internal_business_report_sku_sales_traffic (workspace_id, report_date desc);

alter table public.internal_business_report_sku_sales_traffic enable row level security;

drop policy if exists "internal_business_report_sku_sales_traffic: internal select"
  on public.internal_business_report_sku_sales_traffic;
create policy "internal_business_report_sku_sales_traffic: internal select"
  on public.internal_business_report_sku_sales_traffic
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_business_report_sku_sales_traffic.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

drop trigger if exists trg_internal_business_report_sku_sales_traffic_updated_at
  on public.internal_business_report_sku_sales_traffic;
create trigger trg_internal_business_report_sku_sales_traffic_updated_at
  before update on public.internal_business_report_sku_sales_traffic
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
