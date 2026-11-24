-- Read-only aggregate audit. No Amazon API calls, secrets, terms, or ASINs.
-- Change only scope values for another workspace/profile.
with scope as (
  select '55a321c9-7729-4662-a494-9f1f1aa86846'::uuid workspace_id,
         '1119208106810251'::text profile_id, current_date today
), ads as (
  select 'campaign' source, r.dedupe_key,r.report_date,r.created_at,r.updated_at
  from internal_ads_campaign_daily_rows r join scope s using(workspace_id,profile_id)
  where report_date >= s.today-14 and report_date < s.today
  union all
  select 'product',r.dedupe_key,r.report_date,r.created_at,r.updated_at
  from internal_ads_advertised_product_daily_rows r join scope s using(workspace_id,profile_id)
  where report_date >= s.today-14 and report_date < s.today
  union all
  select 'targeting',r.dedupe_key,r.report_date,r.created_at,r.updated_at
  from internal_ads_targeting_daily_rows r join scope s using(workspace_id,profile_id)
  where report_date >= s.today-14 and report_date < s.today
  union all
  select 'search_term',r.dedupe_key,r.report_date,r.created_at,r.updated_at
  from internal_ads_search_term_daily_rows r join scope s using(workspace_id,profile_id)
  where report_date >= s.today-14 and report_date < s.today
), totals as (
  select source,count(*) rows,count(*)-count(distinct dedupe_key) duplicates,
    count(distinct report_date) days,
    count(*) filter(where report_date <= current_date-3) eligible,
    count(*) filter(where report_date <= current_date-3 and updated_at>created_at) touched
  from ads group by source
)
select jsonb_build_object(
  'checked_at',now(),
  'ads', (select jsonb_agg(t) from totals t),
  'brand_analytics_rows',(select count(*) from brand_analytics_search_terms_rows r join scope s using(workspace_id)),
  'keyword_latest',(select max(checked_at) from keyword_rank_snapshots r join scope s using(workspace_id)),
  'pincode_due',(select count(*) from pincode_tracking_targets r join scope s using(workspace_id) where status='active' and is_configured and next_check_at<now()),
  'shadow_settings',(select jsonb_agg(jsonb_build_object('enabled',enabled,'mode',mode,'emergency_stop',emergency_stop)) from ads_agent_settings r join scope s using(workspace_id,profile_id)),
  'executed_actions',(select count(*) from ads_agent_actions r join scope s using(workspace_id,profile_id) where status='executed')
) readiness;
