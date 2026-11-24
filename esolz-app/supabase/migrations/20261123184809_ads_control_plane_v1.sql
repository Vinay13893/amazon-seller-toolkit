-- Brahmastra Amazon Ads control plane v1.
--
-- This is deliberately storage-only. It records placement performance,
-- immutable Amazon entity snapshots, adaptive baselines, experiments and
-- reversible proposals. It does not grant any Amazon Ads write capability.

create table if not exists public.internal_ads_placement_daily_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  report_date date not null,
  campaign_id text not null,
  campaign_name text,
  campaign_status text,
  placement_classification text not null,
  campaign_budget_amount numeric(14, 2),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  spend numeric(14, 2) not null default 0 check (spend >= 0),
  purchases bigint not null default 0 check (purchases >= 0),
  sales numeric(14, 2) not null default 0 check (sales >= 0),
  units bigint not null default 0 check (units >= 0),
  top_of_search_impression_share numeric(9, 4),
  dedupe_key text not null,
  source text not null default 'ads_api_auto',
  raw_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id, dedupe_key)
);

create index if not exists internal_ads_placement_workspace_date_idx
  on public.internal_ads_placement_daily_rows (workspace_id, profile_id, report_date desc);
create index if not exists internal_ads_placement_campaign_date_idx
  on public.internal_ads_placement_daily_rows (workspace_id, profile_id, campaign_id, report_date desc);

-- Immutable snapshots preserve exactly what Brahmastra observed before a
-- recommendation or future approved write. A later observation creates a new
-- version; old versions are never updated or deleted by application code.
create table if not exists public.ads_agent_entity_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  entity_type text not null check (entity_type in ('campaign', 'ad_group', 'keyword', 'product_target', 'product_ad', 'placement')),
  entity_id text not null,
  parent_campaign_id text,
  parent_ad_group_id text,
  asin text,
  sku text,
  state text,
  bid numeric(12, 2),
  daily_budget numeric(14, 2),
  bidding_strategy text,
  placement_modifiers jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, profile_id, entity_type, entity_id, content_hash)
);

create index if not exists ads_agent_snapshots_latest_idx
  on public.ads_agent_entity_snapshots (workspace_id, profile_id, entity_type, entity_id, observed_at desc);

create table if not exists public.ads_agent_baselines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  scope_type text not null check (scope_type in ('account', 'portfolio', 'category', 'campaign', 'ad_group', 'keyword', 'product_target', 'asin', 'placement')),
  scope_id text not null,
  placement_classification text not null default '',
  window_start date not null,
  window_end date not null,
  lookback_days integer not null check (lookback_days between 1 and 365),
  sample_days integer not null default 0 check (sample_days >= 0),
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14, 2) not null default 0,
  purchases bigint not null default 0,
  sales numeric(14, 2) not null default 0,
  sessions bigint,
  organic_sales numeric(14, 2),
  refunds numeric(14, 2),
  contribution_profit numeric(14, 2),
  metrics jsonb not null default '{}'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  unique (workspace_id, profile_id, scope_type, scope_id, placement_classification, window_end, lookback_days)
);

create index if not exists ads_agent_baselines_lookup_idx
  on public.ads_agent_baselines (workspace_id, profile_id, scope_type, scope_id, window_end desc);

create table if not exists public.ads_agent_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  entity_type text not null check (entity_type in ('campaign', 'ad_group', 'keyword', 'product_target', 'placement')),
  entity_id text not null,
  hypothesis text not null,
  primary_metric text not null,
  status text not null default 'planned' check (status in ('planned', 'running', 'won', 'lost', 'inconclusive', 'rolled_back', 'cancelled')),
  baseline_snapshot_id uuid references public.ads_agent_entity_snapshots(id) on delete restrict,
  baseline_id uuid references public.ads_agent_baselines(id) on delete restrict,
  proposed_change jsonb not null default '{}'::jsonb,
  rollback_payload jsonb not null default '{}'::jsonb,
  guardrails jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  evaluate_after timestamptz,
  finished_at timestamptz,
  outcome jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ads_agent_experiments_active_idx
  on public.ads_agent_experiments (workspace_id, profile_id, status, evaluate_after);
create index if not exists ads_agent_experiments_snapshot_idx
  on public.ads_agent_experiments (baseline_snapshot_id) where baseline_snapshot_id is not null;
create index if not exists ads_agent_experiments_baseline_idx
  on public.ads_agent_experiments (baseline_id) where baseline_id is not null;

-- Stream v2 registry and versioned current-state store. Delivery identifiers
-- and S3 object locations are intentionally not exposed to browser clients.
create table if not exists public.amazon_marketing_stream_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  advertiser_account_id text not null,
  dataset_id text not null,
  subscription_id text,
  destination_region text not null,
  bucket_arn text not null,
  queue_arn text not null,
  status text not null default 'configured' check (status in ('configured', 'active', 'suspended', 'deleted', 'error')),
  last_delivery_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id, advertiser_account_id, dataset_id)
);

create table if not exists public.amazon_marketing_stream_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  advertiser_account_id text not null,
  dataset_id text not null,
  record_key text not null,
  record_date date,
  record_hour smallint check (record_hour is null or (record_hour >= 0 and record_hour <= 23)),
  stream_batch_version bigint not null,
  dimensions jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  is_deleted boolean not null default false,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id, advertiser_account_id, dataset_id, record_key)
);

create index if not exists amazon_marketing_stream_records_time_idx
  on public.amazon_marketing_stream_records (workspace_id, profile_id, dataset_id, record_date desc, record_hour desc);

-- Atomic highest-version-wins ingestion for at-least-once, unordered Stream
-- delivery. Only the server service role may call this function.
create or replace function public.upsert_amazon_marketing_stream_record(
  p_workspace_id uuid,
  p_profile_id text,
  p_advertiser_account_id text,
  p_dataset_id text,
  p_record_key text,
  p_record_date date,
  p_record_hour smallint,
  p_stream_batch_version bigint,
  p_dimensions jsonb,
  p_metrics jsonb,
  p_is_deleted boolean
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  insert into public.amazon_marketing_stream_records (
    workspace_id, profile_id, advertiser_account_id, dataset_id, record_key,
    record_date, record_hour, stream_batch_version, dimensions, metrics, is_deleted
  ) values (
    p_workspace_id, p_profile_id, p_advertiser_account_id, p_dataset_id, p_record_key,
    p_record_date, p_record_hour, p_stream_batch_version,
    coalesce(p_dimensions, '{}'::jsonb), coalesce(p_metrics, '{}'::jsonb), p_is_deleted
  )
  on conflict (workspace_id, profile_id, advertiser_account_id, dataset_id, record_key)
  do update set
    record_date = excluded.record_date,
    record_hour = excluded.record_hour,
    stream_batch_version = excluded.stream_batch_version,
    dimensions = excluded.dimensions,
    metrics = excluded.metrics,
    is_deleted = excluded.is_deleted,
    received_at = now(),
    updated_at = now()
  where excluded.stream_batch_version > amazon_marketing_stream_records.stream_batch_version;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.upsert_amazon_marketing_stream_record(uuid, text, text, text, text, date, smallint, bigint, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.upsert_amazon_marketing_stream_record(uuid, text, text, text, text, date, smallint, bigint, jsonb, jsonb, boolean) to service_role;

-- Expand the shadow foundation so the ledger can safely represent future
-- approval-mode proposals. Existing values remain valid.
alter table public.ads_agent_actions drop constraint if exists ads_agent_actions_action_type_check;
alter table public.ads_agent_actions add constraint ads_agent_actions_action_type_check
  check (action_type in ('increase_bid', 'decrease_bid', 'pause_target', 'enable_target', 'increase_budget', 'decrease_budget', 'change_placement_modifier'));

alter table public.ads_agent_actions drop constraint if exists ads_agent_actions_reason_code_check;
alter table public.ads_agent_actions add constraint ads_agent_actions_reason_code_check
  check (reason_code in ('wasted_spend', 'acos_above_guardrail', 'product_not_eligible', 'profitable_growth', 'rank_defense', 'budget_capped', 'placement_opportunity', 'placement_waste', 'low_confidence_hold', 'inventory_risk'));

alter table public.ads_agent_actions drop constraint if exists ads_agent_actions_entity_type_check;
alter table public.ads_agent_actions add constraint ads_agent_actions_entity_type_check
  check (entity_type in ('campaign', 'ad_group', 'keyword', 'product_target', 'placement'));

alter table public.ads_agent_actions
  add column if not exists baseline_id uuid references public.ads_agent_baselines(id) on delete restrict,
  add column if not exists baseline_snapshot_id uuid references public.ads_agent_entity_snapshots(id) on delete restrict,
  add column if not exists experiment_id uuid references public.ads_agent_experiments(id) on delete set null,
  add column if not exists rollback_payload jsonb not null default '{}'::jsonb,
  add column if not exists confidence numeric(5, 4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  add column if not exists expires_at timestamptz;

create index if not exists ads_agent_actions_baseline_idx
  on public.ads_agent_actions (baseline_id) where baseline_id is not null;
create index if not exists ads_agent_actions_snapshot_idx
  on public.ads_agent_actions (baseline_snapshot_id) where baseline_snapshot_id is not null;
create index if not exists ads_agent_actions_experiment_idx
  on public.ads_agent_actions (experiment_id) where experiment_id is not null;

alter table public.internal_ads_placement_daily_rows enable row level security;
alter table public.ads_agent_entity_snapshots enable row level security;
alter table public.ads_agent_baselines enable row level security;
alter table public.ads_agent_experiments enable row level security;
alter table public.amazon_marketing_stream_subscriptions enable row level security;
alter table public.amazon_marketing_stream_records enable row level security;

create policy "internal_ads_placement_daily_rows: workspace select"
  on public.internal_ads_placement_daily_rows for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy "ads_agent_entity_snapshots: workspace select"
  on public.ads_agent_entity_snapshots for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy "ads_agent_baselines: workspace select"
  on public.ads_agent_baselines for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy "ads_agent_experiments: workspace select"
  on public.ads_agent_experiments for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
-- No browser policies for raw Stream rows or destination ARNs. Aggregated UI
-- reads must go through an authorized server route with workspace checks.

revoke insert, update, delete on public.internal_ads_placement_daily_rows from anon, authenticated;
revoke insert, update, delete on public.ads_agent_entity_snapshots from anon, authenticated;
revoke insert, update, delete on public.ads_agent_baselines from anon, authenticated;
revoke insert, update, delete on public.ads_agent_experiments from anon, authenticated;
revoke insert, update, delete on public.amazon_marketing_stream_subscriptions from anon, authenticated;
revoke insert, update, delete on public.amazon_marketing_stream_records from anon, authenticated;
revoke select on public.amazon_marketing_stream_subscriptions from anon, authenticated;
revoke select on public.amazon_marketing_stream_records from anon, authenticated;
grant select on public.internal_ads_placement_daily_rows, public.ads_agent_entity_snapshots,
  public.ads_agent_baselines, public.ads_agent_experiments to authenticated;

drop trigger if exists trg_internal_ads_placement_updated_at on public.internal_ads_placement_daily_rows;
create trigger trg_internal_ads_placement_updated_at before update on public.internal_ads_placement_daily_rows
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ads_agent_experiments_updated_at on public.ads_agent_experiments;
create trigger trg_ads_agent_experiments_updated_at before update on public.ads_agent_experiments
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_amazon_marketing_stream_subscriptions_updated_at on public.amazon_marketing_stream_subscriptions;
create trigger trg_amazon_marketing_stream_subscriptions_updated_at before update on public.amazon_marketing_stream_subscriptions
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
