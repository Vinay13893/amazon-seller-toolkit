-- ============================================================
-- 002_fix_missing_index.sql
-- Adds missing workspace_id index on keyword_rank_snapshots
-- (was omitted from 001_initial_schema.sql)
-- Run in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_krs_workspace
  ON public.keyword_rank_snapshots(workspace_id);
