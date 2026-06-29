// Phase R8: automated Seller Central Business Report sync via the SP-API
// Reports API (GET_SALES_AND_TRAFFIC_REPORT). Read-only — only ever calls
// createReport/getReport/getReportDocument and downloads the result; never
// calls a write endpoint. No buyer PII anywhere in this report (no order
// IDs, names, emails, phones, addresses) — only daily/SKU aggregate sales
// and traffic counts.
//
// Reuses the generic SP-API plumbing in src/lib/amazon/reports.ts
// (createAmazonReport/getAmazonReport/getAmazonReportDocument/
// downloadAmazonReportDocument) rather than duplicating HTTP/decrypt/
// decompress logic. This file only adds: (1) a dedicated parser for this
// report's specific two-array JSON shape (the generic parseAmazonReportDocument
// single-array unwrapper would silently drop one of the two arrays), and
// (2) a polling loop with 429 backoff for this report type's processing
// states (IN_QUEUE/IN_PROGRESS/DONE/CANCELLED/FATAL — different vocabulary
// from the Ads Reporting API's PENDING/PROCESSING/COMPLETED/FAILED).

import { getAmazonReport, type AmazonReportStatusResult } from '@/lib/amazon/reports'
import { mapCostMasterCategoryToPortfolio } from '@/lib/internal/easyhome-drop-diagnostic'
import { resolveEasyhomePortfolio } from '@/lib/internal/portfolio-labels'

export const SALES_AND_TRAFFIC_REPORT_TYPE = 'GET_SALES_AND_TRAFFIC_REPORT'

/**
 * Phase R9: same two-tier resolution chain already used for payment/Ads SKU
 * mapping (exact-match cost-master category dictionary first, then the
 * shared regex resolver) — reused here rather than reimplemented, per the
 * "always import the exact function the live code path uses" rule. The
 * original Business Report sync (R8) called resolveEasyhomePortfolio()
 * directly and skipped the cost-master exact-match step entirely, which is
 * why EVA Kids/EVA Gym/ASM SKUs that already have a correct cost-master
 * category came back "Unmapped / Needs Review" — fixed here.
 */
export function resolveBusinessReportSkuPortfolio(
  costMasterCategory: string | null,
  sku: string | null,
  childAsin: string | null,
  parentAsin: string | null,
  productName: string | null = null,
): string {
  const fromCategory = mapCostMasterCategoryToPortfolio(costMasterCategory)
  if (fromCategory !== 'Unmapped / Needs Review') return fromCategory
  return resolveEasyhomePortfolio(null, sku, productName, childAsin, parentAsin)
}

export type MoneyAmount = { amount: number; currencyCode: string } | undefined

function amountOf(value: MoneyAmount): number | null {
  return typeof value?.amount === 'number' ? value.amount : null
}

export type SalesAndTrafficByDateRow = {
  date: string
  orderedProductSales: number
  orderedProductSalesB2b: number | null
  unitsOrdered: number
  unitsOrderedB2b: number | null
  totalOrderItems: number
  totalOrderItemsB2b: number | null
  averageSalesPerOrderItem: number | null
  averageSalesPerOrderItemB2b: number | null
  averageUnitsPerOrderItem: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPercentage: number | null
  unitSessionPercentage: number | null
}

export type SalesAndTrafficByAsinRow = {
  parentAsin: string | null
  childAsin: string | null
  sku: string | null
  orderedProductSales: number
  orderedProductSalesB2b: number | null
  unitsOrdered: number
  unitsOrderedB2b: number | null
  totalOrderItems: number
  totalOrderItemsB2b: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPercentage: number | null
  unitSessionPercentage: number | null
}

export type ParsedSalesAndTrafficReport = {
  byDate: SalesAndTrafficByDateRow[]
  byAsin: SalesAndTrafficByAsinRow[]
  /** Every top-level/nested field key actually seen in this document, for the
   * "document exactly what fields are returned" requirement — never guessed,
   * always derived from the live response. */
  byAsinFieldsSeen: string[]
}

/**
 * Dedicated parser for GET_SALES_AND_TRAFFIC_REPORT's JSON, which contains
 * BOTH `salesAndTrafficByDate` and `salesAndTrafficByAsin` arrays in the
 * same document. Never invents fields that aren't present — every numeric
 * field is null/0 (not fabricated) when Amazon didn't return it.
 */
export function parseSalesAndTrafficReport(rawJson: string): ParsedSalesAndTrafficReport {
  const parsed = JSON.parse(rawJson) as {
    salesAndTrafficByDate?: Array<Record<string, unknown>>
    salesAndTrafficByAsin?: Array<Record<string, unknown>>
  }

  const byDate: SalesAndTrafficByDateRow[] = (parsed.salesAndTrafficByDate ?? []).map(row => {
    const salesByDate = (row.salesByDate ?? {}) as Record<string, unknown>
    const trafficByDate = (row.trafficByDate ?? {}) as Record<string, unknown>
    return {
      date: String(row.date ?? ''),
      orderedProductSales: amountOf(salesByDate.orderedProductSales as MoneyAmount) ?? 0,
      orderedProductSalesB2b: amountOf(salesByDate.orderedProductSalesB2B as MoneyAmount),
      unitsOrdered: typeof salesByDate.unitsOrdered === 'number' ? salesByDate.unitsOrdered : 0,
      unitsOrderedB2b: typeof salesByDate.unitsOrderedB2B === 'number' ? salesByDate.unitsOrderedB2B : null,
      totalOrderItems: typeof salesByDate.totalOrderItems === 'number' ? salesByDate.totalOrderItems : 0,
      totalOrderItemsB2b: typeof salesByDate.totalOrderItemsB2B === 'number' ? salesByDate.totalOrderItemsB2B : null,
      averageSalesPerOrderItem: amountOf(salesByDate.averageSalesPerOrderItem as MoneyAmount),
      averageSalesPerOrderItemB2b: amountOf(salesByDate.averageSalesPerOrderItemB2B as MoneyAmount),
      averageUnitsPerOrderItem: typeof salesByDate.averageUnitsPerOrderItem === 'number' ? salesByDate.averageUnitsPerOrderItem : null,
      sessions: typeof trafficByDate.sessions === 'number' ? trafficByDate.sessions : null,
      pageViews: typeof trafficByDate.pageViews === 'number' ? trafficByDate.pageViews : null,
      buyBoxPercentage: typeof trafficByDate.buyBoxPercentage === 'number' ? trafficByDate.buyBoxPercentage : null,
      unitSessionPercentage: typeof trafficByDate.unitSessionPercentage === 'number' ? trafficByDate.unitSessionPercentage : null,
    }
  }).filter(row => row.date)

  const fieldsSeen = new Set<string>()
  const byAsin: SalesAndTrafficByAsinRow[] = (parsed.salesAndTrafficByAsin ?? []).map(row => {
    for (const key of Object.keys(row)) fieldsSeen.add(key)
    const salesByAsin = (row.salesByAsin ?? {}) as Record<string, unknown>
    const trafficByAsin = (row.trafficByAsin ?? {}) as Record<string, unknown>
    for (const key of Object.keys(salesByAsin)) fieldsSeen.add(`salesByAsin.${key}`)
    for (const key of Object.keys(trafficByAsin)) fieldsSeen.add(`trafficByAsin.${key}`)
    return {
      parentAsin: typeof row.parentAsin === 'string' ? row.parentAsin : null,
      childAsin: typeof row.childAsin === 'string' ? row.childAsin : null,
      sku: typeof row.sku === 'string' ? row.sku : null,
      orderedProductSales: amountOf(salesByAsin.orderedProductSales as MoneyAmount) ?? 0,
      orderedProductSalesB2b: amountOf(salesByAsin.orderedProductSalesB2B as MoneyAmount),
      unitsOrdered: typeof salesByAsin.unitsOrdered === 'number' ? salesByAsin.unitsOrdered : 0,
      unitsOrderedB2b: typeof salesByAsin.unitsOrderedB2B === 'number' ? salesByAsin.unitsOrderedB2B : null,
      totalOrderItems: typeof salesByAsin.totalOrderItems === 'number' ? salesByAsin.totalOrderItems : 0,
      totalOrderItemsB2b: typeof salesByAsin.totalOrderItemsB2B === 'number' ? salesByAsin.totalOrderItemsB2B : null,
      sessions: typeof trafficByAsin.sessions === 'number' ? trafficByAsin.sessions : null,
      pageViews: typeof trafficByAsin.pageViews === 'number' ? trafficByAsin.pageViews : null,
      buyBoxPercentage: typeof trafficByAsin.buyBoxPercentage === 'number' ? trafficByAsin.buyBoxPercentage : null,
      unitSessionPercentage: typeof trafficByAsin.unitSessionPercentage === 'number' ? trafficByAsin.unitSessionPercentage : null,
    }
  })

  return { byDate, byAsin, byAsinFieldsSeen: [...fieldsSeen].sort() }
}

export type ReportWaitResult = { status: 'DONE'; reportDocumentId: string } | { status: 'CANCELLED' | 'FATAL' }

/**
 * Polls GET_SALES_AND_TRAFFIC_REPORT until DONE/CANCELLED/FATAL. Backs off
 * on HTTP 429 (rate limit) instead of hammering the endpoint — SP-API's
 * Reports API has a low requests-per-second quota.
 */
export async function waitForSalesAndTrafficReport(
  accessToken: string,
  reportId: string,
  { maxWaitMs = 900_000, pollIntervalMs = 20_000 }: { maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<ReportWaitResult> {
  const deadline = Date.now() + maxWaitMs
  let backoffMs = pollIntervalMs
  while (Date.now() < deadline) {
    let status: AmazonReportStatusResult
    try {
      status = await getAmazonReport(accessToken, reportId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('429')) {
        backoffMs = Math.min(backoffMs * 2, 120_000)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        continue
      }
      throw err
    }
    backoffMs = pollIntervalMs
    if (status.processingStatus === 'DONE') {
      if (!status.reportDocumentId) throw new Error('Report marked DONE but no reportDocumentId was returned.')
      return { status: 'DONE', reportDocumentId: status.reportDocumentId }
    }
    if (status.processingStatus === 'CANCELLED' || status.processingStatus === 'FATAL') {
      return { status: status.processingStatus }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Report ${reportId} did not reach a terminal state within ${maxWaitMs}ms.`)
}
