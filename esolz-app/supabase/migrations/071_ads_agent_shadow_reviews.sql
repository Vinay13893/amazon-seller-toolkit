-- Human feedback on shadow proposals is deliberately separate from the
-- action's execution status. No review decision authorizes an Ads API write.
create unique index if not exists ads_agent_actions_workspace_id_uidx
  on public.ads_agent_actions (workspace_id, id);
create table if not exists public.ads_agent_shadow_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action_id uuid not null unique,
  decision text not null check (decision in ('approve', 'reject')),
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  reviewed_at timestamptz not null default now(),
  constraint ads_agent_shadow_reviews_action_workspace_fk
    foreign key (workspace_id, action_id)
    references public.ads_agent_actions (workspace_id, id) on delete cascade
);

create index if not exists ads_agent_shadow_reviews_workspace_idx
  on public.ads_agent_shadow_reviews (workspace_id, reviewed_at desc);
alter table public.ads_agent_shadow_reviews enable row level security;
create policy "ads_agent_shadow_reviews: workspace select"
  on public.ads_agent_shadow_reviews for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
revoke all on public.ads_agent_shadow_reviews from anon, authenticated;
grant select on public.ads_agent_shadow_reviews to authenticated;

notify pgrst, 'reload schema';
