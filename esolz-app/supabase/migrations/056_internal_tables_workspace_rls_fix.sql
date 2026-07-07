-- P0 fix: every internal_* table's RLS policy additionally required
-- `auth.jwt() ->> 'email' = 'test2026@sociomonkey.com' OR workspace plan =
-- 'Internal Tester'` on top of workspace membership. All 3 real workspace
-- subscriptions are 'Free', so any workspace member who is not that one
-- hardcoded test account got zero rows from every internal_* table —
-- confirmed via direct query against okxfwcfxxrtmijmvztdq on 2026-07-07.
--
-- Fix: drop the hardcoded email/plan gate and rely on the same
-- workspace-membership check (`workspace_id IN user_workspace_ids()`) that
-- already scopes every other row in these tables. This is the same
-- least-privilege boundary already used everywhere else in the schema —
-- it does not widen access beyond a user's own workspace(s), it only
-- removes the single-email dead-bolt that made the boundary unusable for
-- anyone else.
--
-- Rollback: re-AND each USING/WITH CHECK clause below with
--   (lower(coalesce(auth.jwt() ->> 'email', '')) = 'test2026@sociomonkey.com'
--     or exists (
--       select 1 from public.workspace_subscriptions ws
--       join public.subscription_plans plan on plan.id = ws.plan_id
--       where ws.workspace_id = <table>.workspace_id
--         and ws.status in ('active','trial') and plan.name = 'Internal Tester'
--     ))

do $$
declare
  t text;
  internal_tables text[] := array[
    'internal_ads_advertised_product_daily_rows',
    'internal_ads_brahmastra_action_reviews',
    'internal_ads_campaign_daily_rows',
    'internal_ads_campaign_upload_batches',
    'internal_ads_change_history_events',
    'internal_ads_change_history_import_batches',
    'internal_ads_deep_report_upload_batches',
    'internal_ads_review_case_reviews',
    'internal_ads_search_term_daily_rows',
    'internal_ads_targeting_daily_rows',
    'internal_business_report_sales_traffic_daily',
    'internal_business_report_sku_sales_traffic',
    'internal_business_report_upload_batches',
    'internal_data_refresh_runs',
    'internal_fba_report_jobs',
    'internal_fba_report_rows',
    'internal_fulfillment_locations',
    'internal_fulfillment_sales_daily',
    'internal_inventory_by_location',
    'internal_payment_sales_daily_summary',
    'internal_payment_transaction_upload_batches',
    'internal_payment_transactions',
    'internal_sku_component_mappings',
    'internal_sku_cost_master',
    'internal_sku_daily_sales',
    'internal_state_zone_map'
  ];
begin
  foreach t in array internal_tables loop
    execute format('drop policy if exists %I on public.%I', t || ': internal select', t);
    execute format(
      $f$create policy %I on public.%I for select to authenticated
        using (workspace_id in (select public.user_workspace_ids()))$f$,
      t || ': internal select', t
    );
  end loop;
end $$;

-- internal_brahmastra_thresholds has both a select and a write (ALL) policy.
drop policy if exists "brahmastra_thresholds: internal select" on public.internal_brahmastra_thresholds;
create policy "brahmastra_thresholds: internal select"
  on public.internal_brahmastra_thresholds
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));

drop policy if exists "brahmastra_thresholds: internal write" on public.internal_brahmastra_thresholds;
create policy "brahmastra_thresholds: internal write"
  on public.internal_brahmastra_thresholds
  for all to authenticated
  using (workspace_id in (select public.user_workspace_ids()))
  with check (workspace_id in (select public.user_workspace_ids()));

notify pgrst, 'reload schema';
