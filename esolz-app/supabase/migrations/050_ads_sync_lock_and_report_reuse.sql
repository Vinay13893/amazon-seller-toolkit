-- Phase R1 reliability hardening (continued): Render Ads report sync was
-- failing because Amazon's report generation regularly takes longer than the
-- old 180s polling timeout, and there was no protection against two sync
-- runs overlapping for the same profile or against re-creating an Amazon
-- report job that's already in flight. Additive only — no data tables are
-- touched, no rows are deleted.
--
-- internal_data_refresh_runs.status already excludes any in-progress run
-- from being mistaken for "done", but the script needs to be able to record
-- a deliberate skip (already-synced-recently, or another sync holding the
-- lock) as its own terminal state distinct from success/failure.

alter table public.internal_data_refresh_runs
  drop constraint if exists internal_data_refresh_runs_status_check;
alter table public.internal_data_refresh_runs
  add constraint internal_data_refresh_runs_status_check
  check (status in ('running', 'success', 'partial_success', 'failed', 'skipped'));

alter table public.internal_data_refresh_runs
  add column if not exists report_request_key text,
  add column if not exists amazon_report_id text,
  add column if not exists amazon_report_status text,
  add column if not exists amazon_report_created_at timestamptz,
  add column if not exists amazon_report_completed_at timestamptz;

-- Used both for the per-profile concurrency lock ("is a sync already
-- running for this workspace+profile?") and for report reuse ("is there
-- already an Amazon report in flight for this exact request key?").
create index if not exists internal_data_refresh_runs_lock_idx
  on public.internal_data_refresh_runs (workspace_id, profile_id, status, started_at desc)
  where profile_id is not null;

create index if not exists internal_data_refresh_runs_request_key_idx
  on public.internal_data_refresh_runs (report_request_key, started_at desc)
  where report_request_key is not null;

notify pgrst, 'reload schema';
