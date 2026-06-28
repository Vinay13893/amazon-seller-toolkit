-- Phase R6: Seller Central Business Report ("Sales and Traffic by Date")
-- manual CSV import foundation. Additive only — does not touch Amazon Ads
-- sync, payment-transaction, or replenishment tables/logic.
--
-- Business Report "Sales and Traffic by Date" rows have no buyer PII: no
-- order IDs, buyer names, emails, phones, or addresses — only daily
-- aggregate sales/traffic counts and amounts.
--
-- Source separation is intentional: Ordered Product Sales here is
-- order-date based and a DIFFERENT number from Settlement Net Sales
-- (settlement/refund-date based, from internal_payment_transactions). They
-- are stored in separate tables and must never be silently merged.

create table if not exists public.internal_business_report_upload_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  marketplace_id text,
  filename text not null,
  status text not null default 'completed' check (status in ('completed', 'failed')),
  accepted_rows integer not null default 0,
  rejected_rows integer not null default 0,
  min_report_date date,
  max_report_date date,
  error_summary text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists internal_business_report_upload_batches_workspace_idx
  on public.internal_business_report_upload_batches (workspace_id, created_at desc);

alter table public.internal_business_report_upload_batches enable row level security;

drop policy if exists "internal_business_report_upload_batches: internal select"
  on public.internal_business_report_upload_batches;
create policy "internal_business_report_upload_batches: internal select"
  on public.internal_business_report_upload_batches
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_business_report_upload_batches.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

create table if not exists public.internal_business_report_sales_traffic_daily (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  marketplace_id text not null default 'unknown',
  report_date date not null,
  ordered_product_sales numeric not null default 0,
  ordered_product_sales_b2b numeric,
  units_ordered integer not null default 0,
  units_ordered_b2b integer,
  total_order_items integer not null default 0,
  total_order_items_b2b integer,
  average_sales_per_order_item numeric,
  average_sales_per_order_item_b2b numeric,
  average_units_per_order_item numeric,
  sessions integer,
  page_views integer,
  buy_box_percentage numeric,
  unit_session_percentage numeric,
  source_filename text not null,
  upload_batch_id uuid references public.internal_business_report_upload_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Re-uploading the same date range (e.g. a corrected export) must update the
-- existing day's row rather than create a duplicate — one row per
-- workspace/marketplace/day.
create unique index if not exists internal_business_report_sales_traffic_daily_key_uidx
  on public.internal_business_report_sales_traffic_daily (workspace_id, marketplace_id, report_date);

create index if not exists internal_business_report_sales_traffic_daily_date_idx
  on public.internal_business_report_sales_traffic_daily (workspace_id, report_date desc);

alter table public.internal_business_report_sales_traffic_daily enable row level security;

drop policy if exists "internal_business_report_sales_traffic_daily: internal select"
  on public.internal_business_report_sales_traffic_daily;
create policy "internal_business_report_sales_traffic_daily: internal select"
  on public.internal_business_report_sales_traffic_daily
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_business_report_sales_traffic_daily.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

drop trigger if exists trg_internal_business_report_sales_traffic_daily_updated_at
  on public.internal_business_report_sales_traffic_daily;
create trigger trg_internal_business_report_sales_traffic_daily_updated_at
  before update on public.internal_business_report_sales_traffic_daily
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
