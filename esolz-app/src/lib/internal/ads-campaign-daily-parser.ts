// Phase 0D: manual Amazon Ads daily Sponsored Products campaign CSV parser.
// Read-only analytics input only — never used to change bids/budgets.

import { parseFlexibleDate, splitCsvLine, toNumber, toNumberOrNull, toTextOrNull } from './csv-report-parsing'
import { resolveEasyhomePortfolio } from './portfolio-labels'

export type AdsCampaignDailyRecord = {
  sourceRowNumber: number
  reportDate: string // YYYY-MM-DD
  campaignName: string
  campaignId: string | null
  campaignStatus: string | null
  campaignType: string | null
  targetingType: string | null
  portfolioName: string | null
  adGroupName: string | null
  targeting: string | null
  matchType: string | null
  advertisedSku: string | null
  advertisedAsin: string | null
  searchTerm: string | null
  impressions: number
  clicks: number
  ctr: number | null
  spend: number
  cpc: number | null
  purchases: number
  sales: number
  acos: number | null
  roas: number | null
  easyhomePortfolio: string
  dedupeKey: string
  rawRow: Record<string, string>
}

export type AdsCampaignDailyRejection = {
  sourceRowNumber: number
  reason: 'missing_date' | 'missing_campaign_name'
}

export type AdsCampaignDailyStats = {
  totalRowCount: number
  acceptedCount: number
  rejectedCount: number
  dateRangeStart: string | null
  dateRangeEnd: string | null
  totalSpend: number
  totalSales: number
  campaignCount: number
  unmappedCampaignCount: number
}

export type AdsCampaignDailyParseResult =
  | { ok: true; accepted: AdsCampaignDailyRecord[]; rejected: AdsCampaignDailyRejection[]; stats: AdsCampaignDailyStats }
  | { ok: false; error: string }

const DATE_HEADER_ALIASES = ['date', 'report date', 'day']
// "campaignname"/"campaignid"/"campaignstatus" (no space) are the Amazon Ads
// API v3 Reporting native JSON field names (lowercased, space-stripped by the
// header normalization below) — Console CSV exports use spaced names instead.
const CAMPAIGN_NAME_ALIASES = ['campaign name', 'campaign', 'campaignname']
const CAMPAIGN_ID_ALIASES = ['campaign id', 'campaign_id', 'campaignid']
const STATUS_ALIASES = ['status', 'campaignstatus']
const TYPE_ALIASES = ['type', 'campaign type']
const TARGETING_TYPE_ALIASES = ['targeting'] // campaign-level: AUTOMATIC / MANUAL
const PORTFOLIO_ALIASES = ['portfolio', 'portfolio name']
const IMPRESSIONS_ALIASES = ['impressions']
const CLICKS_ALIASES = ['clicks']
const CTR_ALIASES = ['ctr']
const SPEND_ALIASES = ['total cost', 'spend', 'cost', 'total cost (converted)']
const CPC_ALIASES = ['cpc', 'cpc (converted)']
// purchasesNd are the Ads API v3 native field names (N-day attribution window).
const PURCHASES_ALIASES = ['purchases', 'orders', '7 day total orders (#)', '14 day total orders (#)', 'total orders (#)', 'purchases1d', 'purchases7d', 'purchases14d']
// salesNd are the Ads API v3 native field names (N-day attribution window).
const SALES_ALIASES = ['sales', '14 day total sales', 'total sales', 'sales (converted)', '7 day total sales', 'sales1d', 'sales7d', 'sales14d']
const ACOS_ALIASES = ['acos']
const ROAS_ALIASES = ['roas']
const AD_GROUP_ALIASES = ['ad group', 'ad group name']
// Keyword/product-target text — kept distinct from "targeting" (campaign-level
// AUTOMATIC/MANUAL) because ad-group/keyword-level exports reuse different
// column names for the actual target expression.
const TARGETING_TEXT_ALIASES = ['keyword', 'keyword text', 'targeting expression', 'target']
const MATCH_TYPE_ALIASES = ['match type']
const ADVERTISED_SKU_ALIASES = ['advertised sku', 'sku']
const ADVERTISED_ASIN_ALIASES = ['advertised asin', 'asin']
const SEARCH_TERM_ALIASES = ['customer search term', 'search term']

function findHeaderRowIndex(lines: string[]): number {
  const searchLimit = Math.min(lines.length, 60)
  for (let i = 0; i < searchLimit; i += 1) {
    const lowered = lines[i].toLowerCase()
    if (lowered.includes('campaign') && (lowered.includes('impressions') || lowered.includes('clicks'))) {
      return i
    }
  }
  return 0
}

function findColumnIndex(header: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = header.indexOf(alias)
    if (idx >= 0) return idx
  }
  return -1
}

// "Papfoil"/baking-paper/parchment-paper/butter-paper is a real EasyHOME-adjacent
// product line that isn't one of the 7 core portfolios — kept as its own bucket
// so it doesn't pollute "Unmapped / Needs Review" (Phase 1D category cleanup).
export const PAPFOIL_PORTFOLIO = 'Coze'

// Rule order matters: mapCampaignNameToPortfolio() returns the FIRST match.
// "Liltoes" is a brand name used across both BPM (baby play mats) and EVA
// Kids (interlocking play mats) product lines, so it must never be checked
// ahead of the more specific EVA Kids signal — a generic brand term should
// not out-rank a specific category term (Phase 1D.1 mapping QA fix).
const PORTFOLIO_RULES: Array<{ pattern: RegExp; portfolio: string }> = [
  { pattern: /papfoil|baking paper|parchment paper|butter paper|facial\s*box|facialbox|face\s*tissue|tissue\s*box/i, portfolio: PAPFOIL_PORTFOLIO },
  { pattern: /\b(sra|sra_)/i, portfolio: 'Sage Royal Ayurveda' },
  { pattern: /sage\s*royal\s*ayurveda/i, portfolio: 'Sage Royal Ayurveda' },
  { pattern: /\b(eh_?boc|boc)\b|curtain/i, portfolio: 'Curtains' },
  { pattern: /baby play mat|\bbpm\b/i, portfolio: 'BPM' },
  { pattern: /eva.*kids|kids.*mat|interlocking.*kids|kids.*interlocking/i, portfolio: 'EVA Kids' },
  { pattern: /anti.?slip|\basm\b|shelf liner/i, portfolio: 'ASM' },
  { pattern: /eva.*gym|gym.*mat/i, portfolio: 'EVA Gym' },
  // Bare "Liltoes" with no EVA Kids signal present falls back to BPM (most of
  // this account's Liltoes-branded campaigns are baby play mats).
  { pattern: /liltoes/i, portfolio: 'BPM' },
  { pattern: /water tank|tank cover|insulation cover/i, portfolio: 'Water Tank Cover' },
  { pattern: /storage bag|wardrobe|under ?bed/i, portfolio: 'Storage Bags' },
  { pattern: /planter|garden/i, portfolio: 'Planter and Garden' },
]

export function mapCampaignNameToPortfolio(campaignName: string): string {
  const resolved = resolveEasyhomePortfolio(null, campaignName)
  if (resolved !== 'Unmapped / Needs Review') return resolved
  for (const rule of PORTFOLIO_RULES) {
    if (rule.pattern.test(campaignName)) return rule.portfolio
  }
  return 'Unmapped / Needs Review'
}

function buildDedupeKey(parts: {
  reportDate: string
  campaignId: string | null
  campaignName: string
  adGroupName: string | null
  targeting: string | null
  matchType: string | null
  advertisedSku: string | null
  advertisedAsin: string | null
  searchTerm: string | null
}): string {
  const norm = (value: string | null) => (value ?? '').trim().toUpperCase()
  return [
    parts.reportDate,
    parts.campaignId ? norm(parts.campaignId) : norm(parts.campaignName),
    norm(parts.adGroupName),
    norm(parts.targeting),
    norm(parts.matchType),
    norm(parts.advertisedSku),
    norm(parts.advertisedAsin),
    norm(parts.searchTerm),
  ].join('|')
}

export function parseAdsCampaignDailyReport(csvText: string): AdsCampaignDailyParseResult {
  const lines = csvText.split(/\r?\n/)
  const headerIndex = findHeaderRowIndex(lines)
  const header = splitCsvLine(lines[headerIndex]).map(col => col.trim().toLowerCase())

  const dateIdx = findColumnIndex(header, DATE_HEADER_ALIASES)
  if (dateIdx < 0) {
    return {
      ok: false,
      error: 'This looks like a period aggregate report. Please export daily campaign report.',
    }
  }

  const campaignNameIdx = findColumnIndex(header, CAMPAIGN_NAME_ALIASES)
  const idx = {
    date: dateIdx,
    campaignName: campaignNameIdx,
    campaignId: findColumnIndex(header, CAMPAIGN_ID_ALIASES),
    status: findColumnIndex(header, STATUS_ALIASES),
    type: findColumnIndex(header, TYPE_ALIASES),
    targetingType: findColumnIndex(header, TARGETING_TYPE_ALIASES),
    portfolio: findColumnIndex(header, PORTFOLIO_ALIASES),
    impressions: findColumnIndex(header, IMPRESSIONS_ALIASES),
    clicks: findColumnIndex(header, CLICKS_ALIASES),
    ctr: findColumnIndex(header, CTR_ALIASES),
    spend: findColumnIndex(header, SPEND_ALIASES),
    cpc: findColumnIndex(header, CPC_ALIASES),
    purchases: findColumnIndex(header, PURCHASES_ALIASES),
    sales: findColumnIndex(header, SALES_ALIASES),
    acos: findColumnIndex(header, ACOS_ALIASES),
    roas: findColumnIndex(header, ROAS_ALIASES),
    adGroup: findColumnIndex(header, AD_GROUP_ALIASES),
    targetingText: findColumnIndex(header, TARGETING_TEXT_ALIASES),
    matchType: findColumnIndex(header, MATCH_TYPE_ALIASES),
    advertisedSku: findColumnIndex(header, ADVERTISED_SKU_ALIASES),
    advertisedAsin: findColumnIndex(header, ADVERTISED_ASIN_ALIASES),
    searchTerm: findColumnIndex(header, SEARCH_TERM_ALIASES),
  }

  const accepted: AdsCampaignDailyRecord[] = []
  const rejected: AdsCampaignDailyRejection[] = []
  const campaignNames = new Set<string>()
  const unmappedCampaignNames = new Set<string>()
  let dateRangeStart: string | null = null
  let dateRangeEnd: string | null = null
  let totalSpend = 0
  let totalSales = 0
  let totalRowCount = 0

  for (let lineNumber = headerIndex + 1; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    if (!line || !line.trim()) continue
    totalRowCount += 1
    const cells = splitCsvLine(line)
    const sourceRowNumber = lineNumber + 1

    const reportDate = parseFlexibleDate(cells[idx.date])
    const campaignName = toTextOrNull(cells[idx.campaignName])

    if (!reportDate) {
      rejected.push({ sourceRowNumber, reason: 'missing_date' })
      continue
    }
    if (!campaignName) {
      rejected.push({ sourceRowNumber, reason: 'missing_campaign_name' })
      continue
    }

    const impressions = Math.trunc(toNumber(cells[idx.impressions]))
    const clicks = Math.trunc(toNumber(cells[idx.clicks]))
    const spend = toNumber(cells[idx.spend])
    const purchases = Math.trunc(toNumber(cells[idx.purchases]))
    const sales = toNumber(cells[idx.sales])

    const ctr = toNumberOrNull(cells[idx.ctr]) ?? (impressions > 0 ? (clicks / impressions) * 100 : null)
    const cpc = toNumberOrNull(cells[idx.cpc]) ?? (clicks > 0 ? spend / clicks : null)
    const acos = toNumberOrNull(cells[idx.acos]) ?? (sales > 0 ? (spend / sales) * 100 : null)
    const roas = toNumberOrNull(cells[idx.roas]) ?? (spend > 0 ? sales / spend : null)

    const campaignId = toTextOrNull(cells[idx.campaignId])
    const adGroupName = toTextOrNull(cells[idx.adGroup])
    const targeting = toTextOrNull(cells[idx.targetingText])
    const matchType = toTextOrNull(cells[idx.matchType])
    const advertisedSku = toTextOrNull(cells[idx.advertisedSku])
    const advertisedAsin = toTextOrNull(cells[idx.advertisedAsin])
    const searchTerm = toTextOrNull(cells[idx.searchTerm])

    const easyhomePortfolio = mapCampaignNameToPortfolio(campaignName)
    campaignNames.add(campaignName)
    if (easyhomePortfolio === 'Unmapped / Needs Review') unmappedCampaignNames.add(campaignName)

    const rawRow: Record<string, string> = {}
    header.forEach((col, i) => { rawRow[col] = cells[i] ?? '' })

    accepted.push({
      sourceRowNumber,
      reportDate,
      campaignName,
      campaignId,
      campaignStatus: toTextOrNull(cells[idx.status]),
      campaignType: toTextOrNull(cells[idx.type]),
      targetingType: toTextOrNull(cells[idx.targetingType]),
      portfolioName: toTextOrNull(cells[idx.portfolio]),
      adGroupName,
      targeting,
      matchType,
      advertisedSku,
      advertisedAsin,
      searchTerm,
      impressions,
      clicks,
      ctr,
      spend,
      cpc,
      purchases,
      sales,
      acos,
      roas,
      easyhomePortfolio,
      dedupeKey: buildDedupeKey({ reportDate, campaignId, campaignName, adGroupName, targeting, matchType, advertisedSku, advertisedAsin, searchTerm }),
      rawRow,
    })

    if (!dateRangeStart || reportDate < dateRangeStart) dateRangeStart = reportDate
    if (!dateRangeEnd || reportDate > dateRangeEnd) dateRangeEnd = reportDate
    totalSpend += spend
    totalSales += sales
  }

  return {
    ok: true,
    accepted,
    rejected,
    stats: {
      totalRowCount,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      dateRangeStart,
      dateRangeEnd,
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalSales: Math.round(totalSales * 100) / 100,
      campaignCount: campaignNames.size,
      unmappedCampaignCount: unmappedCampaignNames.size,
    },
  }
}
