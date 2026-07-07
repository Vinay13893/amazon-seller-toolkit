-- P0 fix: amazon_connections and amazon_ads_connections grant blanket
-- table-level SELECT to `authenticated` (Supabase default), and RLS on
-- both is row-level only (workspace_id IN user_workspace_ids()) — there is
-- no column-level restriction, so any workspace member can read
-- refresh_token_encrypted / access_token_encrypted directly via PostgREST
-- (e.g. GET /rest/v1/amazon_connections?select=refresh_token_encrypted),
-- even though the app's own server routes never select those columns for
-- the browser (confirmed: connect/status and ads/status route select
-- explicit safe-column lists via the service-role admin client).
--
-- Fix: replace the blanket table SELECT grant with a column-level SELECT
-- grant that excludes both token columns. RLS row-scoping (workspace
-- membership) is untouched — this only narrows which columns of an
-- already-visible row an `authenticated` client may select. One existing
-- client-side query (dashboard/page.tsx: `.from('amazon_connections').select('status')`)
-- is unaffected since it never selects the token columns.
--
-- Rollback:
--   grant select on public.amazon_connections to authenticated;
--   grant select on public.amazon_ads_connections to authenticated;

revoke select on public.amazon_connections from authenticated;
grant select (
  id, workspace_id, selling_partner_id, marketplace_id, marketplace_name,
  access_token_expires_at, status, connected_by_user_id, connected_at,
  last_sync_at, error_message, updated_at, brand_analytics_eligible,
  brand_registry_enrolled
) on public.amazon_connections to authenticated;

revoke select on public.amazon_ads_connections from authenticated;
grant select (
  id, workspace_id, amazon_connection_id, region, marketplace_id, status,
  access_token_expires_at, connected_by_user_id, connected_at,
  last_profile_sync_at, error_code, error_message, created_at, updated_at
) on public.amazon_ads_connections to authenticated;

notify pgrst, 'reload schema';
