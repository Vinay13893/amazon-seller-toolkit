-- API-origin net transaction ledger. Never union with CSV payment rows:
-- their identity and item grain differ. Sales/fees allocation needs separate validation.
create table public.internal_amazon_finance_transactions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  marketplace_id text not null,
  transaction_id text not null,
  posted_at timestamptz not null,
  transaction_type text not null,
  transaction_status text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric not null,
  last_seen_at timestamptz not null default now(),
  sync_run_id uuid references public.internal_data_refresh_runs(id),
  primary key (workspace_id, marketplace_id, transaction_id)
);
create index finance_workspace_posted_idx on public.internal_amazon_finance_transactions
  (workspace_id, marketplace_id, posted_at);
alter table public.internal_amazon_finance_transactions enable row level security;
revoke all on public.internal_amazon_finance_transactions from public, anon, authenticated;
grant select on public.internal_amazon_finance_transactions to authenticated;
grant all on public.internal_amazon_finance_transactions to service_role;
create policy finance_workspace_read on public.internal_amazon_finance_transactions
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create unique index finance_one_running_sync on public.internal_data_refresh_runs
  (workspace_id, marketplace_id)
  where source = 'finance_transactions_sp_api' and status = 'running';
