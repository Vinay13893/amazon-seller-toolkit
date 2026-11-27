export type AdsDrilldownLevel = 'campaign' | 'target' | 'term'
export type AdsDrilldownRow = {
  campaign_id: string | null; campaign_name: string | null
  ad_group_id?: string | null; ad_group_name?: string | null
  keyword_id?: string | null; keyword?: string | null; targeting?: string | null
  search_term?: string | null
  impressions: number | null; clicks: number | null
  spend: number | string | null; purchases: number | null; sales: number | string | null
}
export type AdsDrilldownItem = {
  key: string; campaignId: string; campaignName: string
  adGroupId: string | null; adGroupName: string | null
  targetId: string | null; target: string | null; searchTerm: string | null
  impressions: number; clicks: number; spend: number; purchases: number; sales: number; acosPercent: number | null
}

export function aggregateAdsDrilldown(rows: AdsDrilldownRow[], level: AdsDrilldownLevel): AdsDrilldownItem[] {
  const items = new Map<string, AdsDrilldownItem>()
  for (const row of rows) {
    if (!row.campaign_id) continue
    const adGroupId = level === 'campaign' ? null : row.ad_group_id ?? null
    const targetId = level === 'target' ? row.keyword_id ?? row.targeting ?? row.keyword ?? null : null
    const searchTerm = level === 'term' ? row.search_term ?? null : null
    if (level === 'target' && !targetId || level === 'term' && !searchTerm) continue
    const key = [row.campaign_id, adGroupId, targetId, searchTerm].join('|')
    const item = items.get(key) ?? {
      key, campaignId: row.campaign_id, campaignName: row.campaign_name ?? row.campaign_id,
      adGroupId, adGroupName: adGroupId ? row.ad_group_name ?? adGroupId : null,
      targetId, target: level === 'target' ? row.keyword ?? row.targeting ?? targetId : null,
      searchTerm, impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0, acosPercent: null,
    }
    item.impressions += Number(row.impressions ?? 0)
    item.clicks += Number(row.clicks ?? 0)
    item.spend += Number(row.spend ?? 0)
    item.purchases += Number(row.purchases ?? 0)
    item.sales += Number(row.sales ?? 0)
    items.set(key, item)
  }
  return [...items.values()].map(item => ({ ...item,
    acosPercent: item.sales > 0 ? Math.round(item.spend / item.sales * 10000) / 100 : null,
  })).sort((a, b) => b.spend - a.spend)
}
