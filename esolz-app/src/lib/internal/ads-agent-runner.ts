import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateAdsTarget, type AdsAgentRecommendation, type AdsAgentSettings, type AdsTargetEvidence } from './ads-agent-shadow'
import { acceptedAgentWindow, loadDecisionSignals, readAgentRows, type CoverageRun } from './ads-agent-inputs'

type SettingsRow = {
  workspace_id: string
  profile_id: string
  updated_at: string
  mode: AdsAgentSettings['mode']
  emergency_stop: boolean
  target_acos_percent: number | string
  max_bid_change_percent: number | string
  minimum_clicks: number
  minimum_spend: number | string
  lookback_days: number
  cooldown_hours: number
  max_data_age_days: number
}

type TargetingRow = {
  report_date: string
  campaign_id: string | null
  ad_group_id: string | null
  keyword: string | null
  keyword_id: string | null
  keyword_bid: number | string | null
  impressions: number | null
  clicks: number | null
  spend: number | string | null
  purchases: number | null
  sales: number | string | null
}

type Aggregate = AdsTargetEvidence & { keyword: string }

function asNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function settingsFrom(row: SettingsRow): AdsAgentSettings {
  return {
    mode: row.mode,
    emergencyStop: row.emergency_stop,
    targetAcosPercent: asNumber(row.target_acos_percent),
    maxBidChangePercent: asNumber(row.max_bid_change_percent),
    minimumClicks: row.minimum_clicks,
    minimumSpend: asNumber(row.minimum_spend),
    lookbackDays: row.lookback_days,
    cooldownHours: row.cooldown_hours,
    maxDataAgeDays: row.max_data_age_days,
  }
}

async function readTargetRows(
  admin: SupabaseClient,
  workspaceId: string,
  profileId: string,
  from: string,
  through: string,
): Promise<TargetingRow[]> {
  const pageSize = 1_000
  const rows: TargetingRow[] = []
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from('internal_ads_targeting_daily_rows')
      .select('report_date,campaign_id,ad_group_id,keyword,keyword_id,keyword_bid,impressions,clicks,spend,purchases,sales')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', from)
      .lte('report_date', through)
      .order('report_date', { ascending: true }).order('id')
      .range(offset, offset + pageSize - 1)
    if (error) throw new Error('targeting_read_failed')
    const page = (data ?? []) as TargetingRow[]
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

function aggregateTargets(
  rows: TargetingRow[],
  workspaceId: string,
  profileId: string,
): Aggregate[] {
  const aggregates = new Map<string, Aggregate>()
  for (const row of rows) {
    if (!row.campaign_id || !row.ad_group_id || !row.keyword_id) continue
    const key = [row.campaign_id, row.ad_group_id, row.keyword_id].join('|')
    const current = aggregates.get(key) ?? {
      workspaceId,
      profileId,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      entityId: row.keyword_id,
      currentBid: asNumber(row.keyword_bid),
      impressions: 0,
      clicks: 0,
      spend: 0,
      purchases: 0,
      sales: 0,
      dataThrough: row.report_date,
      keyword: row.keyword ?? '',
      eligibleForAds: null,
    }
    current.dataThrough = row.report_date
    current.keyword = row.keyword ?? current.keyword
    current.currentBid = asNumber(row.keyword_bid)
    current.impressions += row.impressions === null ? NaN : Number(row.impressions)
    current.clicks += row.clicks === null ? NaN : Number(row.clicks)
    current.spend += row.spend === null ? NaN : Number(row.spend)
    current.purchases += row.purchases === null ? NaN : Number(row.purchases)
    current.sales += row.sales === null ? NaN : Number(row.sales)
    aggregates.set(key, current)
  }
  return [...aggregates.values()]
}

export async function runForSettings(admin: SupabaseClient, row: SettingsRow): Promise<void> {
  const settings = settingsFrom(row)
  const { data: run, error: runError } = await admin
    .from('ads_agent_runs')
    .insert({ workspace_id: row.workspace_id, profile_id: row.profile_id, mode: row.mode, status: 'running' })
    .select('id')
    .single()
  if (runError || !run?.id) throw new Error('run_create_failed')

  try {
    if (settings.mode !== 'shadow') throw new Error('shadow_mode_required')
    const { data: profile, error: profileError } = await admin.from('amazon_ads_profiles')
      .select('marketplace_id,status,brahmastra_sync_enabled')
      .eq('workspace_id', row.workspace_id).eq('profile_id', row.profile_id).single()
    if (profileError || profile?.status !== 'active' || !profile.brahmastra_sync_enabled
      || !profile.marketplace_id) throw new Error('profile_not_ready')
    const readCoverage = () => readAgentRows<CoverageRun>(admin, 'internal_data_refresh_runs',
      'id,source,status,rows_rejected,date_from,date_to,started_at', row.workspace_id,
      { profile_id: row.profile_id }, { column: 'started_at', value: new Date(Date.now() - 7 * 86400000).toISOString() })
    const window = acceptedAgentWindow(await readCoverage(), settings.lookbackDays, settings.maxDataAgeDays)
    if (!window) {
      const { error } = await admin.from('ads_agent_runs').update({ status: 'skipped',
        error_code: 'report_window_not_ready', finished_at: new Date().toISOString() }).eq('id', run.id)
      if (error) throw new Error('run_finish_failed')
      return
    }
    const { through: dataThrough, from } = window
    const signalsFor = await loadDecisionSignals(admin, row.workspace_id, row.profile_id,
      profile.marketplace_id, from, dataThrough)
    const targets = aggregateTargets(
      await readTargetRows(admin, row.workspace_id, row.profile_id, from, dataThrough),
      row.workspace_id,
      row.profile_id,
    )

    for (const target of targets) target.signals = signalsFor(target.campaignId, target.adGroupId, target.keyword)
    const cooldownFrom = new Date(Date.now() - settings.cooldownHours * 3_600_000).toISOString()
    const recent = await readAgentRows<{ entity_id: string }>(admin, 'ads_agent_actions', 'entity_id',
      row.workspace_id, { profile_id: row.profile_id }, { column: 'created_at', value: cooldownFrom })
    const coolingDown = new Set(recent.map(item => item.entity_id))
    const checkedWindow = acceptedAgentWindow(await readCoverage(), settings.lookbackDays, settings.maxDataAgeDays)
    if (checkedWindow?.signature !== window.signature) throw new Error('reports_changed_during_read')

    const recommendations = targets
      .filter(target => !coolingDown.has(target.entityId))
      .map(target => evaluateAdsTarget(target, settings))
      .filter((value): value is AdsAgentRecommendation => value !== null)

    // Disabling a profile during evaluation must prevent output from this invocation.
    const { data: stillEnabled, error: settingsError } = await admin.from('ads_agent_settings')
      .select('enabled,mode,updated_at').eq('workspace_id', row.workspace_id).eq('profile_id', row.profile_id).single()
    if (settingsError || !stillEnabled?.enabled || stillEnabled.mode !== 'shadow'
      || stillEnabled.updated_at !== row.updated_at) throw new Error('settings_changed_during_run')
    let proposedCount = 0
    if (recommendations.length > 0) {
      const { data: inserted, error: insertError } = await admin
        .from('ads_agent_actions')
        .upsert(recommendations.map(item => ({
          workspace_id: row.workspace_id,
          profile_id: row.profile_id,
          run_id: run.id,
          action_key: item.actionKey,
          action_type: item.actionType,
          reason_code: item.reasonCode,
          entity_type: 'keyword',
          entity_id: item.entityId,
          campaign_id: item.campaignId,
          ad_group_id: item.adGroupId,
          current_value: item.currentValue,
          proposed_value: item.proposedValue,
          change_percent: item.changePercent,
          evidence: item.evidence,
          data_through: item.dataThrough,
          status: 'proposed',
        })), { onConflict: 'workspace_id,profile_id,action_key', ignoreDuplicates: true })
        .select('id')
      if (insertError) throw new Error('action_insert_failed')
      proposedCount = inserted?.length ?? 0
    }

    const { error: finishError } = await admin.from('ads_agent_runs').update({
      status: 'success',
      data_through: dataThrough,
      evaluated_count: targets.length,
      proposed_count: proposedCount,
      finished_at: new Date().toISOString(),
    }).eq('id', run.id)
    if (finishError) throw new Error('run_finish_failed')
    console.log(JSON.stringify({ status: 'success', evaluatedCount: targets.length, proposedCount }))
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : 'shadow_run_failed'
    await admin.from('ads_agent_runs').update({
      status: 'failed',
      error_code: errorCode,
      error_message: 'Ads agent shadow evaluation failed. No Amazon changes were attempted.',
      finished_at: new Date().toISOString(),
    }).eq('id', run.id)
    throw error
  }
}

export async function runEnabledShadowAgents(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from('ads_agent_settings')
    .select('workspace_id,profile_id,updated_at,mode,emergency_stop,target_acos_percent,max_bid_change_percent,minimum_clicks,minimum_spend,lookback_days,cooldown_hours,max_data_age_days')
    .eq('enabled', true)
    .eq('mode', 'shadow')
  if (error) throw new Error('settings_read_failed')
  const settingsRows = (data ?? []) as SettingsRow[]
  for (const settings of settingsRows) await runForSettings(admin, settings)
  return settingsRows.length
}
