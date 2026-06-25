// Phase 1C: shared parsing engine for the three Sponsored Products "deep"
// daily reports (advertised product / targeting / search term). Read-only
// analytics input only — never used to change bids/budgets/campaigns.

import {
  attributionWindowFromAlias,
  computeAcos,
  computeCpc,
  computeCtr,
  computeRoas,
  findFirstColumnIndex,
  parseFlexibleDate,
  round2,
  splitCsvLine,
  toNumber,
  toNumberOrNull,
  toTextOrNull,
} from './csv-report-parsing'
import { mapCostMasterCategoryToPortfolio } from './easyhome-drop-diagnostic'
import { mapCampaignNameToPortfolio, PAPFOIL_PORTFOLIO } from './ads-campaign-daily-parser'

export type DeepReportKind = 'advertised_product' | 'targeting' | 'search_term'

export type DeepReportRecord = {
  sourceRowNumber: number
  reportDate: string
  campaignName: string
  campaignId: string | null
  campaignStatus: string | null
  adGroupName: string | null
  adGroupId: string | null
  // advertised_product
  advertisedAsin: string | null
  advertisedSku: string | null
  // targeting
  targeting: string | null
  keyword: string | null
  keywordType: string | null
  keywordId: string | null
  keywordBid: number | null
  matchType: string | null
  // search_term
  searchTerm: string | null

  impressions: number
  clicks: number
  ctr: number | null
  spend: number
  cpc: number | null
  purchases: number
  sales: number
  units: number | null
  acos: number | null
  roas: number | null

  easyhomePortfolio: string
  dedupeKey: string
  rawRow: Record<string, string>
}

export type DeepReportRejection = {
  sourceRowNumber: number
  reason: 'missing_date' | 'missing_campaign_name'
}

export type DeepReportStats = {
  totalRowCount: number
  acceptedCount: number
  rejectedCount: number
  dateRangeStart: string | null
  dateRangeEnd: string | null
  totalSpend: number
  totalSales: number
  totalPurchases: number
  campaignCount: number
  unmappedCount: number
  attributionWindowUsed: string
}

export type DeepReportParseResult =
  | { ok: true; accepted: DeepReportRecord[]; rejected: DeepReportRejection[]; stats: DeepReportStats }
  | { ok: false; error: string }

const DATE_ALIASES = ['date', 'report date', 'day']
const CAMPAIGN_NAME_ALIASES = ['campaign name', 'campaign', 'campaignname']
const CAMPAIGN_ID_ALIASES = ['campaign id', 'campaign_id', 'campaignid']
const CAMPAIGN_STATUS_ALIASES = ['status', 'campaignstatus']
const AD_GROUP_NAME_ALIASES = ['ad group', 'ad group name', 'adgroupname']
const AD_GROUP_ID_ALIASES = ['ad group id', 'adgroupid']
const IMPRESSIONS_ALIASES = ['impressions']
const CLICKS_ALIASES = ['clicks']
const CTR_ALIASES = ['ctr']
const SPEND_ALIASES = ['total cost', 'spend', 'cost', 'total cost (converted)']
const CPC_ALIASES = ['cpc', 'cpc (converted)']
const ACOS_ALIASES = ['acos']
const ROAS_ALIASES = ['roas']
// Priority order: shortest attribution window first, Console-export names last.
const PURCHASES_PRIORITY = ['purchases1d', 'purchases7d', 'purchases14d', 'purchases', 'orders']
const SALES_PRIORITY = ['sales1d', 'sales7d', 'sales14d', 'sales']
const UNITS_PRIORITY = ['unitssoldclicks1d', 'unitssoldclicks7d', 'unitssoldclicks14d', 'units']

const ADVERTISED_ASIN_ALIASES = ['advertised asin', 'advertisedasin', 'asin']
const ADVERTISED_SKU_ALIASES = ['advertised sku', 'advertisedsku', 'sku']
const TARGETING_ALIASES = ['targeting']
const KEYWORD_ALIASES = ['keyword']
const KEYWORD_TYPE_ALIASES = ['keyword type', 'keywordtype']
const KEYWORD_ID_ALIASES = ['keyword id', 'keywordid']
const KEYWORD_BID_ALIASES = ['keyword bid', 'keywordbid']
const MATCH_TYPE_ALIASES = ['match type', 'matchtype']
const SEARCH_TERM_ALIASES = ['customer search term', 'search term', 'searchterm']

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

function buildDedupeKey(parts: string[]): string {
  return parts.map(p => (p ?? '').trim().toUpperCase()).join('|')
}

export function parseDeepReport(csvText: string, kind: DeepReportKind): DeepReportParseResult {
  const lines = csvText.split(/\r?\n/)
  const headerIndex = findHeaderRowIndex(lines)
  const header = splitCsvLine(lines[headerIndex]).map(col => col.trim().toLowerCase())

  const dateIdx = findColumnIndex(header, DATE_ALIASES)
  if (dateIdx < 0) {
    return {
      ok: false,
      error: 'This looks like a period aggregate report. Please export a daily report.',
    }
  }

  const campaignNameIdx = findColumnIndex(header, CAMPAIGN_NAME_ALIASES)
  const idx = {
    date: dateIdx,
    campaignName: campaignNameIdx,
    campaignId: findColumnIndex(header, CAMPAIGN_ID_ALIASES),
    campaignStatus: findColumnIndex(header, CAMPAIGN_STATUS_ALIASES),
    adGroupName: findColumnIndex(header, AD_GROUP_NAME_ALIASES),
    adGroupId: findColumnIndex(header, AD_GROUP_ID_ALIASES),
    impressions: findColumnIndex(header, IMPRESSIONS_ALIASES),
    clicks: findColumnIndex(header, CLICKS_ALIASES),
    ctr: findColumnIndex(header, CTR_ALIASES),
    spend: findColumnIndex(header, SPEND_ALIASES),
    cpc: findColumnIndex(header, CPC_ALIASES),
    acos: findColumnIndex(header, ACOS_ALIASES),
    roas: findColumnIndex(header, ROAS_ALIASES),
    advertisedAsin: findColumnIndex(header, ADVERTISED_ASIN_ALIASES),
    advertisedSku: findColumnIndex(header, ADVERTISED_SKU_ALIASES),
    targeting: findColumnIndex(header, TARGETING_ALIASES),
    keyword: findColumnIndex(header, KEYWORD_ALIASES),
    keywordType: findColumnIndex(header, KEYWORD_TYPE_ALIASES),
    keywordId: findColumnIndex(header, KEYWORD_ID_ALIASES),
    keywordBid: findColumnIndex(header, KEYWORD_BID_ALIASES),
    matchType: findColumnIndex(header, MATCH_TYPE_ALIASES),
    searchTerm: findColumnIndex(header, SEARCH_TERM_ALIASES),
  }

  const purchasesMatch = findFirstColumnIndex(header, PURCHASES_PRIORITY)
  const salesMatch = findFirstColumnIndex(header, SALES_PRIORITY)
  const unitsMatch = findFirstColumnIndex(header, UNITS_PRIORITY)
  const attributionWindowUsed = attributionWindowFromAlias(salesMatch.matchedAlias ?? purchasesMatch.matchedAlias)

  const accepted: DeepReportRecord[] = []
  const rejected: DeepReportRejection[] = []
  const campaignNames = new Set<string>()
  const unmappedKeys = new Set<string>()
  let dateRangeStart: string | null = null
  let dateRangeEnd: string | null = null
  let totalSpend = 0
  let totalSales = 0
  let totalPurchases = 0

  for (let lineNumber = headerIndex + 1; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    if (!line || !line.trim()) continue
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
    const purchases = Math.trunc(toNumber(cells[purchasesMatch.index >= 0 ? purchasesMatch.index : -1]))
    const sales = toNumber(cells[salesMatch.index >= 0 ? salesMatch.index : -1])
    const units = unitsMatch.index >= 0 ? Math.trunc(toNumber(cells[unitsMatch.index])) : null

    const ctr = toNumberOrNull(cells[idx.ctr]) ?? computeCtr(clicks, impressions)
    const cpc = toNumberOrNull(cells[idx.cpc]) ?? computeCpc(spend, clicks)
    const acos = toNumberOrNull(cells[idx.acos]) ?? computeAcos(spend, sales)
    const roas = toNumberOrNull(cells[idx.roas]) ?? computeRoas(spend, sales)

    const campaignId = toTextOrNull(cells[idx.campaignId])
    const campaignStatus = toTextOrNull(cells[idx.campaignStatus])
    const adGroupName = toTextOrNull(cells[idx.adGroupName])
    const adGroupId = toTextOrNull(cells[idx.adGroupId])
    const advertisedAsin = toTextOrNull(cells[idx.advertisedAsin])
    const advertisedSku = toTextOrNull(cells[idx.advertisedSku])
    const targeting = toTextOrNull(cells[idx.targeting])
    const keyword = toTextOrNull(cells[idx.keyword])
    const keywordType = toTextOrNull(cells[idx.keywordType])
    const keywordId = toTextOrNull(cells[idx.keywordId])
    const keywordBid = toNumberOrNull(cells[idx.keywordBid])
    const matchType = toTextOrNull(cells[idx.matchType])
    const searchTerm = toTextOrNull(cells[idx.searchTerm])

    let easyhomePortfolio: string
    let mappingKey: string
    if (kind === 'advertised_product') {
      // SKU is the more reliable signal than campaign name when available.
      easyhomePortfolio = advertisedSku ? 'PENDING_SKU_LOOKUP' : mapCampaignNameToPortfolio(campaignName)
      mappingKey = advertisedSku ?? campaignName
    } else {
      easyhomePortfolio = mapCampaignNameToPortfolio(campaignName)
      mappingKey = campaignName
    }
    campaignNames.add(campaignName)
    if (easyhomePortfolio === 'Unmapped / Needs Review') unmappedKeys.add(mappingKey)

    let dedupeKey: string
    if (kind === 'advertised_product') {
      dedupeKey = buildDedupeKey([reportDate, campaignId ?? campaignName, adGroupId ?? adGroupName ?? '', advertisedSku ?? '', advertisedAsin ?? ''])
    } else if (kind === 'targeting') {
      dedupeKey = buildDedupeKey([reportDate, campaignId ?? campaignName, adGroupId ?? adGroupName ?? '', keywordId ?? targeting ?? '', matchType ?? ''])
    } else {
      dedupeKey = buildDedupeKey([reportDate, campaignId ?? campaignName, adGroupId ?? adGroupName ?? '', searchTerm ?? '', targeting ?? ''])
    }

    const rawRow: Record<string, string> = {}
    header.forEach((col, i) => { rawRow[col] = cells[i] ?? '' })

    accepted.push({
      sourceRowNumber,
      reportDate,
      campaignName,
      campaignId,
      campaignStatus,
      adGroupName,
      adGroupId,
      advertisedAsin,
      advertisedSku,
      targeting,
      keyword,
      keywordType,
      keywordId,
      keywordBid,
      matchType,
      searchTerm,
      impressions,
      clicks,
      ctr,
      spend,
      cpc,
      purchases,
      sales,
      units,
      acos,
      roas,
      easyhomePortfolio,
      dedupeKey,
      rawRow,
    })

    if (!dateRangeStart || reportDate < dateRangeStart) dateRangeStart = reportDate
    if (!dateRangeEnd || reportDate > dateRangeEnd) dateRangeEnd = reportDate
    totalSpend += spend
    totalSales += sales
    totalPurchases += purchases
  }

  return {
    ok: true,
    accepted,
    rejected,
    stats: {
      totalRowCount: accepted.length + rejected.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      dateRangeStart,
      dateRangeEnd,
      totalSpend: round2(totalSpend),
      totalSales: round2(totalSales),
      totalPurchases,
      campaignCount: campaignNames.size,
      unmappedCount: unmappedKeys.size,
      attributionWindowUsed,
    },
  }
}

/**
 * SKU-based portfolio resolution for advertised_product rows requires the
 * cost-master lookup, which the parser itself doesn't have access to (pure
 * function, no DB). Records are returned with easyhomePortfolio set to the
 * sentinel 'PENDING_SKU_LOOKUP' when a SKU is present; callers must resolve
 * it via this function before persisting.
 */
export function resolveAdvertisedProductPortfolio(
  record: DeepReportRecord,
  costMasterCategoryBySkuNorm: Map<string, string | null>,
): string {
  if (record.easyhomePortfolio !== 'PENDING_SKU_LOOKUP') return record.easyhomePortfolio
  const skuNorm = (record.advertisedSku ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
  const category = costMasterCategoryBySkuNorm.get(skuNorm) ?? null
  const resolved = mapCostMasterCategoryToPortfolio(category)
  if (resolved !== 'Unmapped / Needs Review') return resolved
  // SKU has no cost-master entry at all — fall back to the SKU's own text for
  // the kitchen-paper line (Phase 1D category cleanup) before giving up.
  if (/papfoil|baking paper|parchment paper|butter paper/i.test(record.advertisedSku ?? '')) {
    return PAPFOIL_PORTFOLIO
  }
  return resolved
}
