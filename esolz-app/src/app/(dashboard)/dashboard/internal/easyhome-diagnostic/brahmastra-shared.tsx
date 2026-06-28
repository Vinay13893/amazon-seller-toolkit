// Phase R5: shared types/helpers extracted from the (formerly monolithic)
// easyhome-diagnostic-dashboard.tsx so the per-section components below can
// import them without duplicating logic. No calculation/formula changes —
// this file only relocates existing pure functions and the ApiResponse shape.
import type { EasyhomeDropDiagnostic } from '@/lib/internal/easyhome-drop-diagnostic'
import type { EasyhomeAdsCampaignDiagnostic, CampaignRow } from '@/lib/internal/easyhome-ads-campaign-diagnostic'
import type {
  AdvertisedProductRow,
  SearchTermRow,
  TargetingRow,
  buildAdvertisedProductDiagnostic,
  buildSearchTermDiagnostic,
  buildTargetingDiagnostic,
} from '@/lib/internal/easyhome-ads-deep-diagnostic'
import type { ActionQueueSummary } from '@/lib/internal/easyhome-action-queue'
import type { ActionItemWithChanges, ChangeHistorySummary, ChangeEventInput } from '@/lib/internal/easyhome-change-history-diagnostic'
import type { DayBreakdown, ArchiveCoverage, ChunkCoverage, CorrelationSummary } from '@/lib/internal/easyhome-change-history-archive'
import type { ManualReviewCandidate } from '@/lib/internal/easyhome-manual-review-candidates'
import type { ManualReviewCase } from '@/lib/internal/easyhome-manual-review-cases'
import type { FindingRow, GoodWorkingRow } from '@/lib/internal/easyhome-findings-table'
import type { BlendedPeriodMetrics } from '@/lib/internal/easyhome-blended-metrics'
import { DEFAULT_RANGE_B, autoBaselineFor, type DateRange } from '@/lib/internal/date-range'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import type { ControlPanelQuery } from './brahmastra-control-panel'

export type { AdvertisedProductRow, SearchTermRow, TargetingRow }

export type LatestCampaignUploadBatch = {
  original_filename: string
  report_date_start: string | null
  report_date_end: string | null
  accepted_count: number
  rejected_count: number
  inserted_count: number
  updated_count: number
  total_spend: number
  total_sales: number
  campaign_count: number
  unmapped_campaign_count: number
  uploaded_at: string
} | null

export type DeepReportBatch = {
  report_kind: 'advertised_product' | 'targeting' | 'search_term'
  original_filename: string
  report_date_start: string | null
  report_date_end: string | null
  accepted_count: number
  rejected_count: number
  inserted_count: number
  updated_count: number
  total_spend: number
  total_sales: number
  total_purchases: number
  campaign_count: number
  unmapped_count: number
  attribution_window_used: string | null
  uploaded_at: string
}

export type DeepDiagnostic = {
  advertisedProduct: ReturnType<typeof buildAdvertisedProductDiagnostic> | null
  targeting: ReturnType<typeof buildTargetingDiagnostic> | null
  searchTerm: ReturnType<typeof buildSearchTermDiagnostic> | null
}

export type ChangeHistoryBatchRow = {
  original_filename: string
  from_date: string | null
  to_date: string | null
  total_records: number
  imported_count: number
  rejected_count: number
  page_size: number | null
  page_offset: number | null
  max_page_number: number | null
  total_records_reported: number | null
  inserted_count: number
  updated_count: number
  is_incomplete: boolean
  created_at: string
}

export type ChangeHistoryImportStatus = ChangeHistoryBatchRow | null

export type PaymentImportStatus = {
  lastFileName: string
  acceptedCount: number
  rejectedCount: number
  insertedCount: number
  updatedCount: number
  uploadedAt: string
} | null

export type ControlPanelMeta = {
  mode: 'single' | 'compare'
  requestedMode: 'single' | 'compare'
  effectiveMode: 'single' | 'compare'
  selectedProfileId: string
  selectedProfileName: string | null
  rangeA: DateRange
  rangeB: DateRange
  effectiveRangeA: DateRange
  effectiveRangeB: DateRange
  requestedRangeA: DateRange
  requestedRangeB: DateRange | null
  portfolioFilter: string | null
  campaignFilter: string | null
  allowUnequalLengths: boolean
  daysInRangeA: number
  daysInRangeB: number
  latestAdsDate: string | null
  latestPaymentDate: string | null
  loadedAt: string
  /** @deprecated use dataFreshness.adsDataIncomplete / salesDataIncomplete instead. */
  dataIncomplete: boolean
  dataFreshness?: {
    latestAdsDate: string | null
    latestSalesDate: string | null
    latestChangeHistoryDate: string | null
    selectedRangeEnd: string
    adsDataIncomplete: boolean
    salesDataIncomplete: boolean
    changeHistoryIncomplete: boolean
    tables: Array<{ table: string; latestDate: string | null }>
  }
}

export type SourceAccuracyAudit = {
  ranges: { requestedRangeA: DateRange; requestedRangeB: DateRange | null; effectiveRangeA: DateRange; effectiveRangeB: DateRange; mode: 'single' | 'compare' }
  sourceOfTruth: Record<string, string>
  latestAdsDate: string | null
  latestSalesDate: string | null
  blendedMetricsComplete: boolean
  warnings: string[]
  rangeA: {
    settlementNetSales: number
    settlementRefunds: number
    settlementAdCharges: number
    amazonAdsSpend: number
    amazonAdsSales: number
    advertisedProductSpend: number
    targetingSpend: number
    searchTermSpend: number
  }
  rangeB: {
    settlementNetSales: number
    settlementRefunds: number
    settlementAdCharges: number
    amazonAdsSpend: number
    amazonAdsSales: number
    advertisedProductSpend: number
    targetingSpend: number
    searchTermSpend: number
  }
}

export type ApiResponse = {
  controlPanel: ControlPanelMeta
  findingsTable: FindingRow[]
  goodWorkingRows: GoodWorkingRow[]
  topSpenders: CampaignRow[]
  topAdSalesGenerators: CampaignRow[]
  blendedMetrics: {
    mode: 'single' | 'compare'
    complete: boolean
    after: BlendedPeriodMetrics
    before: BlendedPeriodMetrics | null
    insights: string[]
    sourceLabels: Record<string, string>
  }
  sourceAccuracyAudit: SourceAccuracyAudit
  diagnostic: EasyhomeDropDiagnostic
  campaignDiagnostic: EasyhomeAdsCampaignDiagnostic
  paymentImportStatus: PaymentImportStatus
  latestCampaignUploadBatch: LatestCampaignUploadBatch
  deepDiagnostic: DeepDiagnostic
  latestDeepReportBatches: DeepReportBatch[]
  actionQueue: ActionItemWithChanges[]
  actionQueueSummary: ActionQueueSummary
  changeHistoryImportStatus: ChangeHistoryImportStatus
  changeHistoryBatches: ChangeHistoryBatchRow[]
  changeHistoryEvents: ChangeEventInput[]
  changeHistoryDayByDay: DayBreakdown[]
  changeHistoryArchiveCoverage: ArchiveCoverage
  changeHistoryChunkCoverage: ChunkCoverage[]
  changeHistoryCorrelationSummary: CorrelationSummary[]
  manualReviewCandidates: ManualReviewCandidate[]
  manualReviewCases: ManualReviewCase[]
  changeHistorySummary: ChangeHistorySummary
  meta: { transactionRowsFetched: number; transactionRowLimitReached: boolean; costMasterRowsFetched: number; campaignRowsFetched: number; advertisedProductRowsFetched: number; targetingRowsFetched: number; searchTermRowsFetched: number; changeHistoryEventsFetched: number }
}

export function formatInr(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}
export function pctStr(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}
export function roasStr(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}x`
}

/**
 * Compact Indian-numbering currency for KPI cards (₹10.20L / ₹1.20Cr) so
 * large settlement/ad-spend figures never overflow a narrow card. Always
 * pair with `formatInr(value)` as a `valueTitle` tooltip so the exact rupee
 * amount is never lost — this is display formatting only, not a calculation
 * change.
 */
export function formatInrCompact(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`
  return formatInr(value)
}

/**
 * Short badge text for the recurring "Source: X" sub-labels so they never
 * truncate mid-word inside a narrow card. The full original string is still
 * passed as the KpiCard `title` tooltip by callers.
 */
const SHORT_SOURCE_LABELS: Record<string, string> = {
  'Source: Payment Transactions': 'Payment Txns',
  'Payment Transactions': 'Payment Txns',
  'Payment Transactions (settlement)': 'Payment Txns (settlement)',
  'Source: Amazon Ads Reports': 'Ads Reports',
  'Amazon Ads Reports': 'Ads Reports',
  'Audit only, not Ads KPI': 'Audit only',
}

export function shortSourceLabel(full: string): string {
  return SHORT_SOURCE_LABELS[full] ?? full
}

/**
 * Generic CSV download for dashboard tables that don't already have their
 * own export helper. `rangeSuffix` must be the loaded/applied range (never
 * the draft Control Panel inputs), so a stale-but-not-yet-run date edit can
 * never be implied by the exported filename.
 */
export function downloadCsv(filenamePrefix: string, headers: string[], rows: Array<Array<string | number | null>>, rangeSuffix: string) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(','), ...rows.map(row => row.map(esc).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filenamePrefix}_${rangeSuffix}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map(entry => (
        <p key={entry.name} className="font-semibold text-foreground" style={{ color: entry.color }}>
          {entry.name}: {formatInr(entry.value)}
        </p>
      ))}
    </div>
  )
}

export function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {columns.map(col => (
              <th key={col} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
              {row.map((cell, j) => (
                <td key={j} className="py-1.5 px-2 whitespace-nowrap text-foreground">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SkuLoserTable({
  title,
  rows,
  metric,
}: {
  title: string
  rows: EasyhomeDropDiagnostic['topRevenueLosers']
  metric: 'sales' | 'units' | 'refund'
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <h2 className="text-sm font-bold text-foreground mb-4">{title}</h2>
      <DataTable
        columns={['SKU', 'Portfolio', 'Range A', 'Range B', metric === 'refund' ? 'Δ Refund' : 'Δ']}
        rows={rows.map(row => [
          row.sku,
          portfolioDisplayLabel(row.portfolio),
          metric === 'units' ? row.beforeUnits.toLocaleString('en-IN') : formatInr(metric === 'refund' ? row.beforeRefund : row.beforeSales),
          metric === 'units' ? row.afterUnits.toLocaleString('en-IN') : formatInr(metric === 'refund' ? row.afterRefund : row.afterSales),
          metric === 'units'
            ? row.deltaUnits.toLocaleString('en-IN')
            : formatInr(metric === 'refund' ? row.deltaRefund : row.deltaSales),
        ])}
      />
    </div>
  )
}

// Default: Single Range Analysis on the June 15+ window, auto-baselined
// against the immediately preceding equal-length period. The old 14d-vs-9d
// pairing is only reachable via the explicit "Legacy June 15 Diagnostic" preset.
export const DEFAULT_QUERY: ControlPanelQuery = {
  mode: 'single',
  rangeA: DEFAULT_RANGE_B,
  rangeB: autoBaselineFor(DEFAULT_RANGE_B),
  portfolio: null,
  campaign: null,
  allowUnequalLengths: false,
}

/**
 * Truth-lock check: the Control Panel's date/mode/filter inputs are local
 * draft state that only reaches the API after "Run Analysis" is clicked.
 * Comparing draft vs the currently-requested query is how the UI knows
 * whether what's on screen still belongs to an older, already-applied
 * selection — without this, a user can retype dates and stare at tables that
 * still reflect the previous range with no indication anything is stale.
 */
export function queriesEqual(a: ControlPanelQuery, b: ControlPanelQuery): boolean {
  if (a.mode !== b.mode) return false
  if (a.rangeA.startDate !== b.rangeA.startDate || a.rangeA.endDate !== b.rangeA.endDate) return false
  if (a.mode === 'compare') {
    if (a.rangeB.startDate !== b.rangeB.startDate || a.rangeB.endDate !== b.rangeB.endDate) return false
    if (Boolean(a.allowUnequalLengths) !== Boolean(b.allowUnequalLengths)) return false
  }
  if ((a.portfolio ?? null) !== (b.portfolio ?? null)) return false
  if ((a.campaign ?? null) !== (b.campaign ?? null)) return false
  return true
}

export function rangeLabel(query: ControlPanelQuery): string {
  return query.mode === 'single'
    ? `${query.rangeA.startDate} → ${query.rangeA.endDate}`
    : `Range A ${query.rangeA.startDate} → ${query.rangeA.endDate}, Range B ${query.rangeB.startDate} → ${query.rangeB.endDate}`
}

export function buildQueryString(query: ControlPanelQuery): string {
  const params = new URLSearchParams()
  params.set('mode', query.mode)
  params.set('aStart', query.rangeA.startDate)
  params.set('aEnd', query.rangeA.endDate)
  if (query.mode === 'compare') {
    params.set('bStart', query.rangeB.startDate)
    params.set('bEnd', query.rangeB.endDate)
    if (query.allowUnequalLengths) params.set('allowUnequalLengths', '1')
  }
  if (query.portfolio) params.set('portfolio', query.portfolio)
  if (query.campaign) params.set('campaign', query.campaign)
  return params.toString()
}
