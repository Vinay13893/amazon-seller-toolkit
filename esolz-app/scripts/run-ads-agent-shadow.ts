// Hourly-safe Amazon Ads shadow evaluator.
// Reads completed daily reporting data and writes recommendations to Supabase.
// It never imports an Amazon Ads write client and cannot change bids, targets,
// budgets, campaigns, or keywords.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  evaluateAdsTarget,
  type AdsAgentRecommendation,
  type AdsAgentSettings,
  type AdsTargetEvidence,
} from '../src/lib/internal/ads-agent-shadow'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
} catch {
  // Render supplies environment variables directly.
}

type SettingsRow = {
  workspace_id: string
  profile_id: string
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
  keyword_id: string | null
  keyword_bid: number | string | null
  impressions: number | null
  clicks: number | null
  spend: number | string | null
  purchases: number | null
  sales: number | string | null
}

type Aggregate = AdsTargetEvidence

function asNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function addDays(iso: string, delta: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
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
      .select('report_date,campaign_id,ad_group_id,keyword_id,keyword_bid,impressions,clicks,spend,purchases,sales')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', from)
      .lte('report_date', through)
      .order('report_date', { ascending: true })
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
  dataThrough: string,
): Aggregate[] {
  const aggregates = new Map<string, Aggregate>()
  for (const row of rows) {
    if (!row.campaign_id || !row.ad_group_id || !row.keyword_id || asNumber(row.keyword_bid) <= 0) continue
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
      dataThrough,
      eligibleForAds: null,
    }
    current.currentBid = asNumber(row.keyword_bid) || current.currentBid
    current.impressions += asNumber(row.impressions)
    current.clicks += asNumber(row.clicks)
    current.spend += asNumber(row.spend)
    current.purchases += asNumber(row.purchases)
    current.sales += asNumber(row.sales)
    aggregates.set(key, current)
  }
  return [...aggregates.values()]
}

async function runForSettings(admin: SupabaseClient, row: SettingsRow): Promise<void> {
  const settings = settingsFrom(row)
  const { data: run, error: runError } = await admin
    .from('ads_agent_runs')
    .insert({ workspace_id: row.workspace_id, profile_id: row.profile_id, mode: row.mode, status: 'running' })
    .select('id')
    .single()
  if (runError || !run?.id) throw new Error('run_create_failed')

  try {
    if (settings.emergencyStop) {
      await admin.from('ads_agent_runs').update({ status: 'skipped', finished_at: new Date().toISOString() }).eq('id', run.id)
      return
    }

    const { data: latest, error: latestError } = await admin
      .from('internal_ads_targeting_daily_rows')
      .select('report_date')
      .eq('workspace_id', row.workspace_id)
      .eq('profile_id', row.profile_id)
      .order('report_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestError) throw new Error('latest_date_read_failed')
    if (!latest?.report_date) {
      await admin.from('ads_agent_runs').update({ status: 'skipped', error_code: 'no_targeting_data', finished_at: new Date().toISOString() }).eq('id', run.id)
      return
    }

    const dataThrough = String(latest.report_date)
    const from = addDays(dataThrough, -(settings.lookbackDays - 1))
    const targets = aggregateTargets(
      await readTargetRows(admin, row.workspace_id, row.profile_id, from, dataThrough),
      row.workspace_id,
      row.profile_id,
      dataThrough,
    )

    const cooldownFrom = new Date(Date.now() - settings.cooldownHours * 3_600_000).toISOString()
    const { data: recent, error: cooldownError } = await admin
      .from('ads_agent_actions')
      .select('entity_id')
      .eq('workspace_id', row.workspace_id)
      .eq('profile_id', row.profile_id)
      .gte('created_at', cooldownFrom)
    if (cooldownError) throw new Error('cooldown_read_failed')
    const coolingDown = new Set((recent ?? []).map(item => String(item.entity_id)))

    const recommendations = targets
      .filter(target => !coolingDown.has(target.entityId))
      .map(target => evaluateAdsTarget(target, settings))
      .filter((value): value is AdsAgentRecommendation => value !== null)

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

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('Missing Supabase server credentials')
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data, error } = await admin
    .from('ads_agent_settings')
    .select('workspace_id,profile_id,mode,emergency_stop,target_acos_percent,max_bid_change_percent,minimum_clicks,minimum_spend,lookback_days,cooldown_hours,max_data_age_days')
    .eq('enabled', true)
  if (error) throw new Error('settings_read_failed')
  const settingsRows = (data ?? []) as SettingsRow[]
  for (const settings of settingsRows) await runForSettings(admin, settings)
  console.log(JSON.stringify({ status: 'complete', settingsEvaluated: settingsRows.length }))
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', errorCode: error instanceof Error ? error.message : 'unknown_error' }))
  process.exitCode = 1
})
