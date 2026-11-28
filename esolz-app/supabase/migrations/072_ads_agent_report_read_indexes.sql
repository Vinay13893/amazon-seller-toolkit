-- Shadow runner reads one profile's recent report dates in report_date/id order.
-- Existing ID-only pagination scans the full historical warehouse and can hit
-- PostgREST's statement timeout before the first shadow evaluation.
create index if not exists internal_ads_advertised_product_agent_read_idx
  on public.internal_ads_advertised_product_daily_rows
  (workspace_id, profile_id, report_date, id);

create index if not exists internal_ads_targeting_agent_read_idx
  on public.internal_ads_targeting_daily_rows
  (workspace_id, profile_id, report_date, id);
