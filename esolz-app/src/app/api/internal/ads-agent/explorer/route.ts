import { createAdminClient } from '@/lib/supabase/admin'
import { getInternalAccessContext } from '@/lib/internal-access'
import { resolveSelectedProfileForWorkspace } from '@/lib/internal/brahmastra-selected-profile'
import { aggregateAdsDrilldown, type AdsDrilldownLevel, type AdsDrilldownRow } from '@/lib/internal/ads-drilldown'

export const runtime = 'nodejs'
export const maxDuration = 60

const TABLE: Record<AdsDrilldownLevel, string> = {
  campaign: 'internal_ads_campaign_daily_rows',
  target: 'internal_ads_targeting_daily_rows',
  term: 'internal_ads_search_term_daily_rows',
}
const COLUMNS: Record<AdsDrilldownLevel, string> = {
  campaign: 'campaign_id,campaign_name,impressions,clicks,spend,purchases,sales',
  target: 'campaign_id,campaign_name,ad_group_id,ad_group_name,keyword_id,keyword,targeting,impressions,clicks,spend,purchases,sales',
  term: 'campaign_id,campaign_name,ad_group_id,ad_group_name,search_term,impressions,clicks,spend,purchases,sales',
}

export async function GET(request: Request): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId)
    return Response.json({ error: 'unauthorized' }, { status: 403 })
  const url = new URL(request.url)
  const level = url.searchParams.get('level') ?? 'campaign'
  if (!(level in TABLE)) return Response.json({ error: 'invalid_level' }, { status: 400 })
  const typedLevel = level as AdsDrilldownLevel
  const campaignId = url.searchParams.get('campaignId')
  const adGroupId = url.searchParams.get('adGroupId')
  if (typedLevel !== 'campaign' && (!campaignId || campaignId.length > 100))
    return Response.json({ error: 'campaign_required' }, { status: 400 })
  if (typedLevel === 'term' && (!adGroupId || adGroupId.length > 100))
    return Response.json({ error: 'ad_group_required' }, { status: 400 })

  const admin = createAdminClient()
  const selection = await resolveSelectedProfileForWorkspace(admin, access.workspaceId)
  if (!selection.ok) return Response.json({ error: selection.reason }, { status: 409 })
  const through = new Date(Date.now() - 3 * 86400000)
  const from = new Date(through.getTime() - 13 * 86400000)
  const fromDate = from.toISOString().slice(0, 10)
  const throughDate = through.toISOString().slice(0, 10)
  const rows: AdsDrilldownRow[] = []
  for (let offset = 0; offset <= 20_000; offset += 1000) {
    let query = admin.from(TABLE[typedLevel]).select(COLUMNS[typedLevel])
      .eq('workspace_id', access.workspaceId).eq('profile_id', selection.profileId)
      .gte('report_date', fromDate).lte('report_date', throughDate)
      .order('id').range(offset, offset + (offset === 20_000 ? 0 : 999))
    if (campaignId) query = query.eq('campaign_id', campaignId)
    if (adGroupId) query = query.eq('ad_group_id', adGroupId)
    const { data, error } = await query
    if (error) return Response.json({ error: 'report_read_failed' }, { status: 500 })
    if (offset === 20_000 && (data?.length ?? 0) > 0)
      return Response.json({ error: 'report_too_large_for_complete_view' }, { status: 503 })
    rows.push(...(data ?? []) as unknown as AdsDrilldownRow[])
    if ((data?.length ?? 0) < 1000) break
  }
  if (rows.some(row => [row.impressions, row.clicks, row.spend, row.purchases, row.sales]
    .some(value => value === null || !Number.isFinite(Number(value)))))
    return Response.json({ error: 'incomplete_report_metrics' }, { status: 503 })
  return Response.json({ level: typedLevel, profileId: selection.profileId,
    fromDate, throughDate, sourceRows: rows.length,
    items: aggregateAdsDrilldown(rows, typedLevel) })
}
