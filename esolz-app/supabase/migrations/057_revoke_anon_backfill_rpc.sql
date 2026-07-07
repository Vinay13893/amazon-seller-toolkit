-- P0 fix: backfill_brand_analytics_search_terms_grouped_rows is
-- SECURITY DEFINER, takes an arbitrary report_document_id with no internal
-- workspace/authorization check, and was EXECUTE-granted to PUBLIC and anon
-- — callable by anyone (including unauthenticated requests) via PostgREST's
-- /rpc endpoint, and would upsert into brand_analytics_search_terms_grouped_rows
-- for whatever workspace owns that report_document_id. No caller of this
-- function exists anywhere in the current app codebase (grep across
-- src/ and scripts/ returns nothing) — it's only ever meant to be run
-- ad hoc by an operator with service-role access.
--
-- Fix: revoke EXECUTE from PUBLIC/anon/authenticated; leave service_role
-- (and the function owner) able to call it.
--
-- Rollback: grant execute on function
--   public.backfill_brand_analytics_search_terms_grouped_rows(text, integer, integer)
--   to anon, authenticated;

revoke execute on function
  public.backfill_brand_analytics_search_terms_grouped_rows(text, integer, integer)
  from public, anon, authenticated;
