-- Conservative Amazon Ads agent foundation. This migration stores settings,
-- aggregate run metadata, and proposed actions only. It grants no Amazon Ads
-- write capability and exposes no service-role access to browser clients.

create table if not exists public.ads_agent_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  enabled boolean not null default false,
  mode text not null default 'shadow' check (mode in ('shadow', 'approval', 'autopilot')),
  emergency_stop boolean not null default true,
  target_acos_percent numeric(7, 2) not null default 30 check (target_acos_percent > 0 and target_acos_percent <= 500),
  max_bid_change_percent numeric(5, 2) not null default 10 check (max_bid_change_percent > 0 and max_bid_change_percent <= 10),
  minimum_clicks integer not null default 8 check (minimum_clicks >= 1),
  minimum_spend numeric(12, 2) not null default 300 check (minimum_spend >= 0),
  lookback_days integer not null default 14 check (lookback_days between 7 and 30),
  cooldown_hours integer not null default 24 check (cooldown_hours between 1 and 168),
  max_data_age_days integer not null default 3 check (max_data_age_days between 1 and 7),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id)
);

create table if not exists public.ads_agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  mode text not null check (mode in ('shadow', 'approval', 'autopilot')),
  status text not null check (status in ('running', 'success', 'failed', 'skipped')),
  data_through date,
  evaluated_count integer not null default 0,
  proposed_count integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ads_agent_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id text not null,
  run_id uuid not null references public.ads_agent_runs(id) on delete cascade,
  action_key text not null,
  action_type text not null check (action_type in ('decrease_bid', 'pause_target')),
  reason_code text not null check (reason_code in ('wasted_spend', 'acos_above_guardrail', 'product_not_eligible')),
  entity_type text not null default 'keyword' check (entity_type in ('keyword', 'product_target')),
  entity_id text not null,
  campaign_id text not null,
  ad_group_id text not null,
  current_value numeric(12, 2),
  proposed_value numeric(12, 2),
  change_percent numeric(7, 2),
  evidence jsonb not null default '{}'::jsonb,
  data_through date not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id, action_key)
);

create index if not exists ads_agent_runs_workspace_started_idx
  on public.ads_agent_runs (workspace_id, profile_id, started_at desc);
create index if not exists ads_agent_actions_workspace_status_idx
  on public.ads_agent_actions (workspace_id, profile_id, status, created_at desc);
create index if not exists ads_agent_actions_entity_cooldown_idx
  on public.ads_agent_actions (workspace_id, profile_id, entity_id, created_at desc);

alter table public.ads_agent_settings enable row level security;
alter table public.ads_agent_runs enable row level security;
alter table public.ads_agent_actions enable row level security;

create policy "ads_agent_settings: workspace select"
  on public.ads_agent_settings for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy "ads_agent_runs: workspace select"
  on public.ads_agent_runs for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy "ads_agent_actions: workspace select"
  on public.ads_agent_actions for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));

-- Settings and agent output remain service-role write-only. Approval/execution
-- endpoints will be added separately with explicit server-side authorization.
revoke insert, update, delete on public.ads_agent_settings from anon, authenticated;
revoke insert, update, delete on public.ads_agent_runs from anon, authenticated;
revoke insert, update, delete on public.ads_agent_actions from anon, authenticated;
grant select on public.ads_agent_settings, public.ads_agent_runs, public.ads_agent_actions to authenticated;

drop trigger if exists trg_ads_agent_settings_updated_at on public.ads_agent_settings;
create trigger trg_ads_agent_settings_updated_at before update on public.ads_agent_settings
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ads_agent_actions_updated_at on public.ads_agent_actions;
create trigger trg_ads_agent_actions_updated_at before update on public.ads_agent_actions
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
