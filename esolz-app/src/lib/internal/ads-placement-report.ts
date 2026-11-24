export type AdsPlacementDailyRow = {
  reportDate: string
  campaignId: string
  campaignName: string | null
  campaignStatus: string | null
  placementClassification: string
  campaignBudgetAmount: number | null
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
  units: number
  topOfSearchImpressionShare: number | null
  dedupeKey: string
  rawRow: Record<string, unknown>
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseAdsPlacementRows(rows: Array<Record<string, unknown>>): {
  accepted: AdsPlacementDailyRow[]
  rejectedCount: number
} {
  const accepted: AdsPlacementDailyRow[] = []
  let rejectedCount = 0
  for (const rawRow of rows) {
    const reportDate = text(rawRow.date)
    const campaignId = text(rawRow.campaignId)
    const placementClassification = text(rawRow.placementClassification)
    if (!reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !campaignId || !placementClassification) {
      rejectedCount += 1
      continue
    }
    accepted.push({
      reportDate,
      campaignId,
      campaignName: text(rawRow.campaignName),
      campaignStatus: text(rawRow.campaignStatus),
      placementClassification,
      campaignBudgetAmount: nullableNumber(rawRow.campaignBudgetAmount),
      impressions: Math.max(0, Math.trunc(number(rawRow.impressions))),
      clicks: Math.max(0, Math.trunc(number(rawRow.clicks))),
      spend: Math.max(0, number(rawRow.cost)),
      purchases: Math.max(0, Math.trunc(number(rawRow.purchases1d))),
      sales: Math.max(0, number(rawRow.sales1d)),
      units: Math.max(0, Math.trunc(number(rawRow.unitsSoldClicks1d))),
      topOfSearchImpressionShare: nullableNumber(rawRow.topOfSearchImpressionShare),
      dedupeKey: [reportDate, campaignId, placementClassification.toUpperCase()].join('|'),
      rawRow,
    })
  }
  return { accepted, rejectedCount }
}

export function placementDailyRowFor(row: AdsPlacementDailyRow, workspaceId: string, profileId: string) {
  return {
    workspace_id: workspaceId,
    profile_id: profileId,
    report_date: row.reportDate,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    campaign_status: row.campaignStatus,
    placement_classification: row.placementClassification,
    campaign_budget_amount: row.campaignBudgetAmount,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    purchases: row.purchases,
    sales: row.sales,
    units: row.units,
    top_of_search_impression_share: row.topOfSearchImpressionShare,
    dedupe_key: row.dedupeKey,
    raw_row: row.rawRow,
    source: 'ads_api_auto',
  }
}
