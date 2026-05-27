-- ============================================================
-- 003_fix_asin_snapshots_rls.sql
--
-- Re-creates the asin_snapshots RLS policies to ensure they
-- are correct.  The INSERT policy (WITH CHECK) and SELECT
-- policy (USING) both rely on the helper function
-- public.user_workspace_ids() which reads workspace_members
-- using SECURITY DEFINER so it is not blocked by its own RLS.
--
-- Root cause this migration addresses:
--   The route handler was using the anon-key client for the
--   INSERT.  If auth.uid() was not resolved server-side the
--   WITH CHECK would silently reject the row.  The route has
--   been updated to use the service-role client instead, so
--   RLS is bypassed for server-side writes.  These policies
--   still apply to direct client-side queries.
--
-- Run in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- Drop any stale/duplicate policies first so this script is
-- safe to re-run.
DROP POLICY IF EXISTS "asin_snapshots: member select" ON public.asin_snapshots;
DROP POLICY IF EXISTS "asin_snapshots: member insert" ON public.asin_snapshots;

-- Ensure RLS is enabled (idempotent).
ALTER TABLE public.asin_snapshots ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members can read their own snapshots.
CREATE POLICY "asin_snapshots: member select"
  ON public.asin_snapshots
  FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- INSERT: workspace members can insert snapshots for their workspaces.
-- (Primarily used by server-side admin client, but kept for completeness.)
CREATE POLICY "asin_snapshots: member insert"
  ON public.asin_snapshots
  FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));
