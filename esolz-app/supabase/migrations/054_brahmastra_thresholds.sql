-- Phase R10.1: Brahmastra configurable action engine thresholds.
-- Per-workspace, per-portfolio threshold table. The special portfolio
-- '__global__' holds workspace-wide defaults applied when no category-specific
-- row exists. Column defaults = current R10 hardcoded values so behavior is
-- identical to the deployed version until the user edits values.
--
-- Column naming uses business-readable names (not internal engine names)
-- so the Thresholds & Assumptions UI is self-explanatory.

create table if not exists public.internal_brahmastra_thresholds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  portfolio text not null default '__global__',
  -- Spend thresholds
  waste_spend_threshold numeric not null default 300,
  minimum_roas numeric not null default 1.5,
  min_clicks_for_waste integer not null default 5,
  high_spend_threshold numeric not null default 500,
  min_ad_spend_for_action numeric not null default 100,
  -- ACOS / ROAS thresholds
  max_acos_pct numeric not null default 40,
  protect_roas numeric not null default 4,
  protect_acos_pct numeric not null default 25,
  good_roas numeric not null default 2.5,
  -- TACOS / category thresholds
  warning_tacos_pct numeric not null default 15,
  critical_tacos_pct numeric not null default 25,
  min_ordered_sales_for_category_action numeric not null default 5000,
  -- Refund thresholds
  refund_warning_pct numeric not null default 20,
  high_refund_amount numeric not null default 1000,
  -- Row management
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, portfolio)
);

create index if not exists internal_brahmastra_thresholds_workspace_idx
  on public.internal_brahmastra_thresholds (workspace_id);

alter table public.internal_brahmastra_thresholds enable row level security;

drop policy if exists "brahmastra_thresholds: internal select"
  on public.internal_brahmastra_thresholds;
create policy "brahmastra_thresholds: internal select"
  on public.internal_brahmastra_thresholds
  for select to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_brahmastra_thresholds.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

drop policy if exists "brahmastra_thresholds: internal write"
  on public.internal_brahmastra_thresholds;
create policy "brahmastra_thresholds: internal write"
  on public.internal_brahmastra_thresholds
  for all to authenticated
  using (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_brahmastra_thresholds.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  )
  with check (
    workspace_id in (select public.user_workspace_ids())
    and (
      lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
      or exists (
        select 1
        from public.workspace_subscriptions as ws
        join public.subscription_plans as plan on plan.id = ws.plan_id
        where ws.workspace_id = internal_brahmastra_thresholds.workspace_id
          and ws.status in ('active', 'trial')
          and plan.name = 'Internal Tester'
      )
    )
  );

drop trigger if exists trg_internal_brahmastra_thresholds_updated_at
  on public.internal_brahmastra_thresholds;
create trigger trg_internal_brahmastra_thresholds_updated_at
  before update on public.internal_brahmastra_thresholds
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
