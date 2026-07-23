/**
 * SKU Performance P1-B — TypeScript mirror of migration 065's two RPC
 * response shapes (`get_sku_performance_summary`, `get_sku_performance_daily`).
 * Field names match the RPC's `jsonb_build_object` keys exactly.
 */
import type { SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

export type MappingState = 'mapped' | 'unmapped' | 'identity_conflict' | 'not_applicable'
export type SalesTrend = 'growing' | 'declining' | 'flat' | 'new_activity' | 'no_activity'
export type SpendTrend = 'growing' | 'declining' | 'flat' | 'new_spend' | 'no_spend'
export type TacosBand = 'critical' | 'warning' | 'normal' | null
export type RatioState = 'normal' | 'not_applicable' | 'undefined' | 'undefined_high_risk' | 'unknown'
export type CoverageState = 'REPORTED_VALUE' | 'BEFORE_HISTORY' | 'CONFIRMED_ZERO' | 'SOURCE_NOT_COMPLETE' | 'UNKNOWN'

export interface Ratio {
  value: number | null
  state: RatioState
}

export interface WindowMetrics {
  sales: number
  units: number
  spend: number
  attributedSales: number
  acos: Ratio
  tacos: Ratio
}

export interface SkuPerformanceRow {
  sku: string
  asin: string | null
  productTitle: string | null
  imageUrl: string | null
  brand: string | null
  category: string | null
  mappingState: MappingState
  salesTrend: SalesTrend
  spendTrend: SpendTrend
  tacosBand: TacosBand
  lastSalesActivityDate: string | null
  lastAdSpendActivityDate: string | null
  lastAttributedSaleActivityDate: string | null
  flags: {
    salesDrop: boolean
    spendSpike: boolean
    noAttributedSales: boolean
    tacosDeterioration: boolean
    salesGrowingStableSpend: boolean
    salesGrowingSpendFalls: boolean
    mappingIncomplete: boolean
    /** Merged in by the route layer (source-scoped, identical across every row in a response), never computed per-row by the RPC. */
    dataDelayed?: boolean
  }
  selectedRange: WindowMetrics
  yesterday: WindowMetrics
  trailingSevenDay: WindowMetrics
  priorSevenDay: Omit<WindowMetrics, 'units'>
  trailingThirtyDay: WindowMetrics
}

export interface MappingCoverageBreakdown {
  bySkuCount: { mapped: number; unmapped: number; identityConflict: number; mappedPct: number | null }
  bySpend: { mappedSpend: number; unmappedSpend: number; identityConflictSpend: number; mappedSpendPct: number | null }
}

export interface SkuPerformanceSummaryTotals {
  totalOrderedSales: number
  totalUnits: number
  totalAdSpend: number
  totalAttributedSales: number
  acos: number | null
  tacos: number | null
  skusGrowing: number
  skusDeclining: number
  mappingCoverage: MappingCoverageBreakdown
  salesSourceLatestCompleteDate: string | null
  adsSourceLatestCompleteDate: string | null
  catalogLastSyncedAt: string | null
  salesLastRunStatus: string | null
  salesLastRunAt: string | null
  adsLastRunStatus: string | null
  adsLastRunAt: string | null
  /** Merged in by the route layer via lib/sku-performance/source-health.ts, never computed by the RPC. */
  salesSourceState?: SourceHealthStatus
  adsSourceState?: SourceHealthStatus
  catalogSourceState?: SourceHealthStatus
}

export interface SkuPerformancePagination {
  totalSkuCountBeforeFilters: number
  totalMatchingSkuCountAfterFilters: number
  returnedSkuCount: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface SkuPerformanceDateRange {
  requestedDateFrom: string
  requestedDateTo: string
  effectiveDateFrom: string
  effectiveDateTo: string
  asOf: string
  salesHistoryStartsAt: string | null
  adsHistoryStartsAt: string | null
  wasRangeClamped: boolean
  clampReason: string | null
}

export type SkuPerformanceSummaryResult =
  | { result: 'invalid_parameters'; reason: string }
  | { result: 'currency_mismatch' }
  | {
      result: 'success'
      currencyCode: string | null
      rows: SkuPerformanceRow[]
      summary: SkuPerformanceSummaryTotals
      pagination: SkuPerformancePagination
      dateRange: SkuPerformanceDateRange
    }

export interface SkuPerformanceDailyDay {
  date: string
  sales: { value: number | null; coverageState: CoverageState }
  units: { value: number | null; coverageState: CoverageState }
  spend: { value: number | null; coverageState: CoverageState }
  attributedSales: { value: number | null; coverageState: CoverageState }
  acos: Ratio
  tacos: Ratio
}

export type SkuPerformanceDailyResult =
  | { result: 'invalid_parameters'; reason: string }
  | {
      result: 'success'
      sku: {
        canonicalSku: string
        catalogSku: string | null
        catalogAsin: string | null
        productTitle: string | null
        foundInCatalog: boolean
        advertisedSkuEvidence: Array<{ advertisedSku: string | null; advertisedAsin: string | null }>
      }
      days: SkuPerformanceDailyDay[]
    }
