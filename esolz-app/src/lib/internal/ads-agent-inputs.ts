import type { SupabaseClient } from '@supabase/supabase-js'
import { buildDecisionSignals, type RankObservation, type AvailabilityObservation } from './ads-agent-signals'

// Every paginated read has a unique ordering and an explicit tenant predicate.
export async function readAgentRows<T>(
  admin: SupabaseClient, table: string, columns: string, workspaceId: string,
  filters: Record<string, string> = {}, from?: { column: string; value: string }, orderBy?: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += 1000) {
    let query = admin.from(table).select(columns).eq('workspace_id', workspaceId)
    if (orderBy && orderBy !== 'id') query = query.order(orderBy)
    query = query.order('id')
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
    if (from) query = query.gte(from.column, from.value)
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw new Error(`agent_input_read_failed:${table}`)
    rows.push(...(data ?? []) as T[])
    if (!data || data.length < 1000) return rows
  }
}

export type CoverageRun = {
  id: string; source: string; status: string; rows_rejected: number | null
  date_from: string; date_to: string; started_at: string
}

export function acceptedAgentWindow(runs: CoverageRun[], lookbackDays: number, maxAge: number, now = new Date()) {
  const sources = ['ads_targeting', 'ads_advertised_product']
  const latest = sources.map(source => runs.filter(r => r.source === source)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))[0])
  if (latest.some(r => !r || r.status !== 'success' || r.rows_rejected !== 0)) return null
  const through = latest.map(r => r.date_to).sort()[0]
  const day = Date.parse(`${through}T00:00:00Z`)
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(day) || day >= today || (today - day) / 86400000 > maxAge) return null
  const from = new Date(day - (lookbackDays - 1) * 86400000).toISOString().slice(0, 10)
  if (latest.some(r => r.date_from > from || r.date_to < through)) return null
  return { from, through, signature: latest.map(r => r.id).join('|') }
}

type Product = { campaign_id: string; ad_group_id: string; advertised_asin: string; report_date: string }
type Keyword = { id: string; own_asin: string | null; keyword: string }
type Rank = RankObservation & { tracked_keyword_id: string }
type Monitored = { id: string; asin: string }
type Target = { id: string; monitored_product_id: string; status: string; is_configured: boolean }

export async function loadDecisionSignals(admin: SupabaseClient, workspaceId: string, profileId: string,
  marketplaceId: string, from: string, through: string, now = new Date()) {
  // Only own-product keywords are joined; competitor/research keywords cannot leak into a bid decision.
  const products = await readAgentRows<Product>(admin, 'internal_ads_advertised_product_daily_rows',
    'campaign_id,ad_group_id,advertised_asin,report_date', workspaceId, { profile_id: profileId },
    { column: 'report_date', value: from }, 'report_date')
  const keywords = await readAgentRows<Keyword>(admin, 'tracked_keywords', 'id,own_asin,keyword', workspaceId,
    { marketplace: marketplaceId === 'A21TJRUUN4KGV' ? 'IN' : marketplaceId })
  const ranks = await readAgentRows<Rank>(admin, 'keyword_rank_snapshots',
    'tracked_keyword_id,checked_at,scrape_status,organic_rank,sponsored_rank', workspaceId, {},
    { column: 'checked_at', value: new Date(now.getTime() - 7 * 86400000).toISOString() })
  const monitored = await readAgentRows<Monitored>(admin, 'pincode_monitored_products', 'id,asin', workspaceId,
    { marketplace_id: marketplaceId, status: 'active' })
  const targets = await readAgentRows<Target>(admin, 'pincode_tracking_targets',
    'id,monitored_product_id,status,is_configured', workspaceId)
  const availability = await readAgentRows<AvailabilityObservation>(admin, 'pincode_availability_results',
    'tracking_target_id,checked_at,check_status,availability_status,error_code', workspaceId,
    { marketplace_id: marketplaceId }, { column: 'checked_at', value: new Date(now.getTime() - 48 * 3600000).toISOString() })
  return (campaignId: string, adGroupId: string, keyword: string) => {
    const asins = new Set(products.filter(p => p.campaign_id === campaignId && p.ad_group_id === adGroupId
      && p.report_date <= through && p.advertised_asin).map(p => p.advertised_asin.trim().toUpperCase()))
    if (asins.size !== 1) return buildDecisionSignals(false, [], [], [], now)
    const asin = [...asins][0]
    const matchedKeywords = keywords.filter(k => k.own_asin?.toUpperCase() === asin
      && k.keyword.trim().toLowerCase() === keyword.trim().toLowerCase())
    const productIds = new Set(monitored.filter(p => p.asin.toUpperCase() === asin).map(p => p.id))
    const targetIds = targets.filter(t => productIds.has(t.monitored_product_id) && t.status === 'active' && t.is_configured).map(t => t.id)
    return buildDecisionSignals(true, matchedKeywords.length === 1
      ? ranks.filter(r => r.tracked_keyword_id === matchedKeywords[0].id) : [], targetIds, availability, now)
  }
}
