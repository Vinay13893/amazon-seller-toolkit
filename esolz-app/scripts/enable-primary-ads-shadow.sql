-- Applied 2026-11-24 after the read-only readiness audit.
-- Seeds ONLY the verified primary profile. Does not overwrite existing settings.
-- No Amazon write capability; emergency stop remains engaged.
insert into public.ads_agent_settings
(workspace_id,profile_id,enabled,mode,emergency_stop,target_acos_percent,
 max_bid_change_percent,minimum_clicks,minimum_spend,lookback_days,cooldown_hours,max_data_age_days)
select workspace_id,profile_id,true,'shadow',true,30,5,15,500,14,24,2
from public.amazon_ads_profiles
where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846'
  and profile_id='1119208106810251' and is_primary
  and brahmastra_sync_enabled and status='active'
on conflict (workspace_id,profile_id) do nothing;
