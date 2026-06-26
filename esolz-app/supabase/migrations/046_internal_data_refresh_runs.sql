-- Migration 046: read-only logging of automated daily data-refresh runs
-- (Amazon Ads report sync, etc). Bookkeeping only — never drives any
-- Amazon Ads write action.

create table if not exists internal_data_refresh_runs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  source          text not null, -- e.g. 'ads_campaign_daily', 'ads_advertised_product', 'ads_targeting', 'ads_search_term'
  status          text not null default 'running' check (status in ('running', 'success', 'partial_success', 'failed')),
  date_from       date,
  date_to         date,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  rows_fetched    integer not null default 0,
  rows_inserted   integer not null default 0,
  rows_updated    integer not null default 0,
  rows_rejected   integer not null default 0,
  error_message   text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_data_refresh_runs_workspace
  on internal_data_refresh_runs (workspace_id, source, started_at desc);

-- RLS: written only by the service-role sync script; read access mirrors
-- the existing internal_* tester gate.
alter table internal_data_refresh_runs enable row level security;

create policy "internal_data_refresh_runs: internal select"
  on internal_data_refresh_runs
  for select to authenticated
  using (
    workspace_id in (select user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from workspace_subscriptions as ws
        join subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_data_refresh_runs.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

notify pgrst, 'reload schema';
