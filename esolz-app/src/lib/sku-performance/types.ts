/**
 * SKU Performance P1-B — TypeScript mirror of migration 065's two RPC
 * response shapes (`get_sku_performance_summary`, `get_sku_performance_daily`).
 * Field names match the RPC's `jsonb_build_object` keys exactly.
 */
import type { SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

export type MappingState = 'mapped' | 'unmapped' | 'identity_conflict' | 'not_applicable'
export type SalesTrend = 'growing' | 'declining' | 'flat' | 'new_activity' | 'no_activity' | 'no_comparable_baseline'
export type SpendTrend = 'growing' | 'declining' | 'flat' | 'new_spend' | 'no_spend' | 'no_comparable_baseline'
export type TacosBand = 'critical' | 'warning' | 'normal' | null
export type RatioState = 'normal' | 'not_applicable' | 'undefined' | 'undefined_high_risk' | 'unknown'
export type CoverageState = 'REPORTED_VALUE' | 'BEFORE_HISTORY' | 'CONFIRMED_ZERO' | 'SOURCE_NOT_COMPLETE' | 'UNKNOWN'
/** Window/source-level coverage (Fix 3) — a distinct, lowercase vocabulary from the day-level CoverageState above. */
export type WindowCoverageState = 'complete' | 'partial' | 'before_history' | 'source_not_complete' | 'unknown'

export interface Ratio {
  value: number | null
  state: RatioState
}

export interface WindowMetrics {
  sales: number
  units: number
  spend: number
  attributedSales: number
  salesCoverageState: WindowCoverageState
  adsCoverageState: WindowCoverageState
  acos: Ratio
  tacos: Ratio
}

export interface IdentityConflictEvidence {
  catalogRawSkus: string[]
  salesRawSkus: string[]
  adsRawSkus: string[]
  costMasterRawSkus: string[]
}

export interface SkuPerformanceRow {
  sku: string
  asin: string | null
  productTitle: string | null
  imageUrl: string | null
  brand: string | null
  category: string | null
  mappingState: MappingState
  /** Only present (non-null) when mappingState === 'identity_conflict'. */
  identityConflictEvidence: IdentityConflictEvidence | null
  /** Null when mappingState === 'identity_conflict' — Fix 4: a conflicted identity never gets a combined trend. */
  salesTrend: SalesTrend | null
  spendTrend: SpendTrend | null
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
  /** All five window objects are null when mappingState === 'identity_conflict' — Fix 4: no combined metrics from a merged/ambiguous identity. */
  selectedRange: WindowMetrics | null
  yesterday: WindowMetrics | null
  trailingSevenDay: WindowMetrics | null
  priorSevenDay: Omit<WindowMetrics, 'units'> | null
  trailingThirtyDay: WindowMetrics | null
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
  acos: Ratio
  tacos: Ratio
  skusGrowing: number
  skusDeclining: number
  mappingCoverage: MappingCoverageBreakdown
  /** Fix 6: honest "latest row seen" date — never call this "complete." */
  salesLatestDataDate: string | null
  adsLatestDataDate: string | null
  /** Fix 6: latest date_to of an ACCEPTED (status='success', rows_rejected=0) refresh run — the only date safe to call "complete." */
  salesLatestAcceptedCompleteDate: string | null
  adsLatestAcceptedCompleteDate: string | null
  catalogLastSyncedAt: string | null
  salesLastRunStatus: string | null
  salesLastRunAt: string | null
  salesLastRunRowsRejected: number | null
  adsLastRunStatus: string | null
  adsLastRunAt: string | null
  adsLastRunRowsRejected: number | null
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
  /** Fix 1: GREATEST(requestedDateFrom, salesHistoryStartsAt, adsHistoryStartsAt) — null when either source's history start is unknown. Combined ACOS/TACOS use only this narrower range. */
  commonEffectiveDateFrom: string | null
  commonEffectiveDateTo: string | null
  /** Per-source effective start (own history only, never coalesced with the other source). */
  salesEffectiveDateFrom: string | null
  adsEffectiveDateFrom: string | null
  asOf: string
  salesHistoryStartsAt: string | null
  adsHistoryStartsAt: string | null
  wasRangeClamped: boolean
  /** Fix 1: an array, not a single lossy string — a request can be clamped by more than one reason at once. */
  clampReasons: string[]
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
      /** Fix 4: a cross-source canonical collision short-circuits before any day-by-day work — no combined series is ever returned for it. */
      result: 'identity_conflict'
      canonicalSku: string
      evidence: IdentityConflictEvidence
    }
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
