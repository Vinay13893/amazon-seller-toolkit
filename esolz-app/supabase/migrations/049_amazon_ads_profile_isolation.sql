-- Phase R1: profile isolation for Amazon Ads report data. A single Ads OAuth
-- connection can carry many advertiser profiles (9 are connected today, only
-- one — 1119208106810251 / EMOUNT RETAIL — is selected for Brahmastra). The
-- Ads report tables had no profile_id column, so a future sync against a
-- different profile could silently mix rows from unrelated businesses into
-- the same Brahmastra analysis. This migration is additive only: it adds a
-- nullable profile_id column, backfills all existing rows to the profile
-- they actually came from (the only profile ever successfully synced), then
-- tightens the column to NOT NULL and folds profile_id into the existing
-- per-table dedupe unique index. No rows are deleted or modified beyond
-- setting the new column.

do $$
declare
  v_workspace_id uuid;
  v_profile_id text := '1119208106810251'; -- EMOUNT RETAIL — the only profile ever synced into these tables
begin
  select distinct workspace_id into v_workspace_id from public.internal_ads_campaign_daily_rows limit 1;

  -- ── Ads report row tables ────────────────────────────────────────────────
  alter table public.internal_ads_campaign_daily_rows add column if not exists profile_id text;
  alter table public.internal_ads_advertised_product_daily_rows add column if not exists profile_id text;
  alter table public.internal_ads_targeting_daily_rows add column if not exists profile_id text;
  alter table public.internal_ads_search_term_daily_rows add column if not exists profile_id text;

  update public.internal_ads_campaign_daily_rows set profile_id = v_profile_id where profile_id is null;
  update public.internal_ads_advertised_product_daily_rows set profile_id = v_profile_id where profile_id is null;
  update public.internal_ads_targeting_daily_rows set profile_id = v_profile_id where profile_id is null;
  update public.internal_ads_search_term_daily_rows set profile_id = v_profile_id where profile_id is null;

  alter table public.internal_ads_campaign_daily_rows alter column profile_id set not null;
  alter table public.internal_ads_advertised_product_daily_rows alter column profile_id set not null;
  alter table public.internal_ads_targeting_daily_rows alter column profile_id set not null;
  alter table public.internal_ads_search_term_daily_rows alter column profile_id set not null;

  -- ── Upload batch tables (bookkeeping only) ──────────────────────────────
  alter table public.internal_ads_campaign_upload_batches add column if not exists profile_id text;
  alter table public.internal_ads_deep_report_upload_batches add column if not exists profile_id text;
  update public.internal_ads_campaign_upload_batches set profile_id = v_profile_id where profile_id is null;
  update public.internal_ads_deep_report_upload_batches set profile_id = v_profile_id where profile_id is null;

  -- ── Refresh-run log (Ads sources only; other sources stay null) ────────
  alter table public.internal_data_refresh_runs add column if not exists profile_id text;
  update public.internal_data_refresh_runs
    set profile_id = v_profile_id
    where profile_id is null and source like 'ads_%';
end $$;

-- Re-key each table's dedupe uniqueness to be profile-scoped: the same
-- dedupe_key may legitimately repeat across two different profiles (e.g. an
-- identically-named campaign in two different seller accounts), so the
-- unique index must include profile_id, not just workspace_id.
drop index if exists public.internal_ads_campaign_daily_rows_dedupe_uidx;
create unique index internal_ads_campaign_daily_rows_dedupe_uidx
  on public.internal_ads_campaign_daily_rows (workspace_id, profile_id, dedupe_key);

drop index if exists public.internal_ads_advertised_product_daily_rows_dedupe_uidx;
create unique index internal_ads_advertised_product_daily_rows_dedupe_uidx
  on public.internal_ads_advertised_product_daily_rows (workspace_id, profile_id, dedupe_key);

drop index if exists public.internal_ads_targeting_daily_rows_dedupe_uidx;
create unique index internal_ads_targeting_daily_rows_dedupe_uidx
  on public.internal_ads_targeting_daily_rows (workspace_id, profile_id, dedupe_key);

drop index if exists public.internal_ads_search_term_daily_rows_dedupe_uidx;
create unique index internal_ads_search_term_daily_rows_dedupe_uidx
  on public.internal_ads_search_term_daily_rows (workspace_id, profile_id, dedupe_key);

create index if not exists internal_ads_campaign_daily_rows_profile_idx
  on public.internal_ads_campaign_daily_rows (workspace_id, profile_id);
create index if not exists internal_ads_advertised_product_daily_rows_profile_idx
  on public.internal_ads_advertised_product_daily_rows (workspace_id, profile_id);
create index if not exists internal_ads_targeting_daily_rows_profile_idx
  on public.internal_ads_targeting_daily_rows (workspace_id, profile_id);
create index if not exists internal_ads_search_term_daily_rows_profile_idx
  on public.internal_ads_search_term_daily_rows (workspace_id, profile_id);

notify pgrst, 'reload schema';
