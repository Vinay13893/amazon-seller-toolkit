-- Phase R2: payment-transaction / sales refresh foundation. Additive only.
--
-- internal_payment_transactions already exists (migration 033) with a sound
-- per-row dedupe unique index, but the manual CSV importer had no upload
-- batch bookkeeping (unlike the Ads importers), so there was no record of
-- "what was imported, when, how many rows accepted/rejected." This adds:
--
--   1. internal_payment_transaction_upload_batches — bookkeeping only, no
--      buyer PII, no raw row content. Mirrors the existing
--      internal_ads_campaign_upload_batches pattern.
--   2. internal_payment_sales_daily_summary — a derived, additive daily
--      aggregate (workspace/marketplace/date/SKU/fulfillment-bucket) that
--      will later power blended ROAS/TACOS. No buyer name/email/phone/
--      address, no raw order IDs — aggregate counts and amounts only.
--
-- Neither table stores anything not already derivable from
-- internal_payment_transactions, which itself contains no buyer identity
-- fields (only order_city/order_state/order_postal geo aggregates).

create table if not exists public.internal_payment_transaction_upload_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  original_filename text not null,
  total_row_count integer not null default 0,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  duplicate_skipped_count integer not null default 0,
  date_range_start timestamptz,
  date_range_end timestamptz,
  total_amount_sum numeric,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists internal_payment_transaction_upload_batches_workspace_idx
  on public.internal_payment_transaction_upload_batches (workspace_id, uploaded_at desc);

alter table public.internal_payment_transaction_upload_batches enable row level security;

drop policy if exists "internal_payment_transaction_upload_batches: internal select"
  on public.internal_payment_transaction_upload_batches;
create policy "internal_payment_transaction_upload_batches: internal select"
  on public.internal_payment_transaction_upload_batches
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_payment_transaction_upload_batches.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

create table if not exists public.internal_payment_sales_daily_summary (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  marketplace_id text not null,
  sales_date date not null,
  amazon_sku text,
  portfolio text,
  fulfillment_bucket text not null default 'unknown'
    check (fulfillment_bucket in ('fba_fc', 'direct_flex_easyship', 'unknown')),
  units_sold integer not null default 0,
  orders_count integer not null default 0,
  gross_sales_amount numeric not null default 0,
  refunds_amount numeric not null default 0,
  net_sales_amount numeric not null default 0,
  returns_count integer not null default 0,
  refunded_units integer not null default 0,
  source text not null default 'payment_transactions_derived',
  batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists internal_payment_sales_daily_summary_key_uidx
  on public.internal_payment_sales_daily_summary (
    workspace_id, marketplace_id, sales_date,
    coalesce(amazon_sku, ''), fulfillment_bucket
  );

create index if not exists internal_payment_sales_daily_summary_date_idx
  on public.internal_payment_sales_daily_summary (workspace_id, sales_date desc);

alter table public.internal_payment_sales_daily_summary enable row level security;

drop policy if exists "internal_payment_sales_daily_summary: internal select"
  on public.internal_payment_sales_daily_summary;
create policy "internal_payment_sales_daily_summary: internal select"
  on public.internal_payment_sales_daily_summary
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_payment_sales_daily_summary.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

drop trigger if exists trg_internal_payment_sales_daily_summary_updated_at
  on public.internal_payment_sales_daily_summary;
create trigger trg_internal_payment_sales_daily_summary_updated_at
  before update on public.internal_payment_sales_daily_summary
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
