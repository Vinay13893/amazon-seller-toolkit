'use client'

import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, Loader2, TrendingDown, Megaphone } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { Badge } from '@/components/ui/badge'
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
import type { ActionQueueSummary, ActionStatus } from '@/lib/internal/easyhome-action-queue'
import type { ActionItemWithChanges, ChangeHistorySummary, ChangeEventInput } from '@/lib/internal/easyhome-change-history-diagnostic'
import type { DayBreakdown, ArchiveCoverage, ChunkCoverage, CorrelationSummary } from '@/lib/internal/easyhome-change-history-archive'
import type { ManualReviewCandidate } from '@/lib/internal/easyhome-manual-review-candidates'
import type { CaseReviewStatus, ManualReviewCase } from '@/lib/internal/easyhome-manual-review-cases'
import type { FindingRow, GoodWorkingRow } from '@/lib/internal/easyhome-findings-table'
import type { BlendedPeriodMetrics } from '@/lib/internal/easyhome-blended-metrics'
import { DEFAULT_RANGE_B, autoBaselineFor, usesJune15, type DateRange } from '@/lib/internal/date-range'
import { entityDisplayLabel, portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import { ActionQueue } from './action-queue'
import { ChangeHistorySection } from './change-history'
import { ChangeHistoryArchiveSection } from './change-history-archive'
import { ManualReviewCandidates } from './manual-review-candidates'
import { ManualReviewCases } from './manual-review-cases'
import { ManualReviewExecutionSheet, type ExecutionSheetUpdate } from './manual-review-execution-sheet'
import { BrahmastraControlPanel, type ControlPanelQuery } from './brahmastra-control-panel'
import { FindingsActionsTable, GoodWorkingTable, toFindingsCsv, toGoodWorkingCsv } from './findings-actions-table'
import { usePaginatedRows, TablePaginationControls } from './table-pagination'

type LatestCampaignUploadBatch = {
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

type DeepReportBatch = {
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

type DeepDiagnostic = {
  advertisedProduct: ReturnType<typeof buildAdvertisedProductDiagnostic> | null
  targeting: ReturnType<typeof buildTargetingDiagnostic> | null
  searchTerm: ReturnType<typeof buildSearchTermDiagnostic> | null
}

type ChangeHistoryBatchRow = {
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

type ChangeHistoryImportStatus = ChangeHistoryBatchRow | null

type PaymentImportStatus = {
  lastFileName: string
  acceptedCount: number
  rejectedCount: number
  insertedCount: number
  updatedCount: number
  uploadedAt: string
} | null

type ControlPanelMeta = {
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

type ApiResponse = {
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
  sourceAccuracyAudit: {
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

function formatInr(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}
function pctStr(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}
function roasStr(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}x`
}

/**
 * Generic CSV download for the smaller dashboard tables (Mapping health, Top
 * spenders, Top ad sales generators) that don't already have their own
 * export helper. `rangeSuffix` must be the loaded/applied range (never the
 * draft Control Panel inputs), so a stale-but-not-yet-run date edit can
 * never be implied by the exported filename.
 */
function downloadCsv(filenamePrefix: string, headers: string[], rows: Array<Array<string | number | null>>, rangeSuffix: string) {
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

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string }) {
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

// Default: Single Range Analysis on the June 15+ window, auto-baselined
// against the immediately preceding equal-length period. The old 14d-vs-9d
// pairing is only reachable via the explicit "Legacy June 15 Diagnostic" preset.
const DEFAULT_QUERY: ControlPanelQuery = {
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
function queriesEqual(a: ControlPanelQuery, b: ControlPanelQuery): boolean {
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

function rangeLabel(query: ControlPanelQuery): string {
  return query.mode === 'single'
    ? `${query.rangeA.startDate} → ${query.rangeA.endDate}`
    : `Range A ${query.rangeA.startDate} → ${query.rangeA.endDate}, Range B ${query.rangeB.startDate} → ${query.rangeB.endDate}`
}

function buildQueryString(query: ControlPanelQuery): string {
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

export function EasyhomeDiagnosticDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState<ControlPanelQuery>(DEFAULT_QUERY)
  // Draft = whatever the Control Panel inputs currently show, even before
  // "Run Analysis" is clicked. Loaded = the query that produced the `data`
  // currently on screen. Tables only ever render `data`, so any gap between
  // draft and loaded means the visible tables are stale relative to the inputs.
  const [draftQuery, setDraftQuery] = useState<ControlPanelQuery>(DEFAULT_QUERY)
  const [loadedQuery, setLoadedQuery] = useState<ControlPanelQuery>(DEFAULT_QUERY)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  // Declared unconditionally (rules of hooks) even though only used once data has loaded.
  const campaignTablePaging = usePaginatedRows(data?.campaignDiagnostic.campaignTable ?? [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/internal/easyhome-drop-diagnostic?${buildQueryString(query)}`)
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to load diagnostic')
        return res.json() as Promise<ApiResponse>
      })
      .then(json => { if (!cancelled) { setData(json); setLoadedQuery(query); setLoadedAt(new Date()) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load diagnostic') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query])

  const pendingChanges = !queriesEqual(draftQuery, query)

  // The Control Panel must always be visible — even on the very first load,
  // a failed fetch, or an invalid range — so the user can always adjust the
  // range and re-run instead of staring at a blank/error-only page.
  if (!data) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div>
          <h1 className="text-2xl font-black text-foreground">EasyHOME — Brahmastra Ads Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-1">Read-only Amazon Ads investigation tool.</p>
        </div>
        <BrahmastraControlPanel
          portfolios={[]}
          campaigns={[]}
          onRun={q => setQuery(q)}
          onDraftChange={setDraftQuery}
          isDirty={pendingChanges}
          onExportAll={() => {}}
          loading={loading}
        />
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading EasyHOME diagnostic…
          </div>
        )}
        {error && !loading && (
          <p className="text-sm text-red-400">{error}</p>
        )}
      </div>
    )
  }

  const {
    controlPanel, findingsTable, goodWorkingRows, topSpenders, topAdSalesGenerators, blendedMetrics,
    sourceAccuracyAudit, diagnostic, campaignDiagnostic, paymentImportStatus, deepDiagnostic, latestDeepReportBatches, actionQueue, actionQueueSummary,
    changeHistoryImportStatus, changeHistoryBatches, changeHistorySummary, changeHistoryEvents,
    changeHistoryDayByDay, changeHistoryArchiveCoverage, changeHistoryChunkCoverage, changeHistoryCorrelationSummary,
    manualReviewCandidates, manualReviewCases,
    meta,
  } = data

  const portfolioOptions = [...new Set(campaignDiagnostic.campaignTable.map(c => c.portfolio))].sort()
  const campaignOptions = [...new Set(campaignDiagnostic.campaignTable.map(c => c.campaignName))].sort()
  const showJune15Label = usesJune15(controlPanel.rangeA, controlPanel.rangeB)
  // Always the loaded/applied range — exports must never imply draft (not-yet-run) dates.
  const loadedRangeSuffix = `${controlPanel.rangeA.startDate}_to_${controlPanel.rangeB.endDate}`

  function handleExportAll() {
    const csv = [
      'FINDINGS_AND_ACTIONS',
      toFindingsCsv(findingsTable),
      '',
      'GOOD_WORKING_CAMPAIGNS_KEYWORDS_TARGETS',
      toGoodWorkingCsv(goodWorkingRows),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `brahmastra_findings_actions_${controlPanel.rangeA.startDate}_to_${controlPanel.rangeB.endDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleActionStatusChange(actionKey: string, status: ActionStatus, notes: string | null) {
    setData(prev => prev ? {
      ...prev,
      actionQueue: prev.actionQueue.map(item => item.actionKey === actionKey ? { ...item, status, notes } : item),
    } : prev)
    await fetch('/api/internal/ads-brahmastra-actions/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionKey, status, notes }),
    }).catch(() => {})
  }

  async function handleCaseUpdate(caseKey: string, fields: { status: CaseReviewStatus; owner: string | null; decision: string | null; reason: string | null; nextCheckDate: string | null; notes: string | null }) {
    setData(prev => prev ? {
      ...prev,
      manualReviewCases: prev.manualReviewCases.map(c => c.caseKey === caseKey ? { ...c, ...fields } : c),
    } : prev)
    await fetch('/api/internal/ads-review-cases/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseKey, ...fields }),
    }).catch(() => {})
  }

  async function handleExecutionSheetUpdate(caseKey: string, fields: ExecutionSheetUpdate) {
    setData(prev => prev ? {
      ...prev,
      manualReviewCases: prev.manualReviewCases.map(c => c.caseKey === caseKey ? { ...c, ...fields } : c),
    } : prev)
    await fetch('/api/internal/ads-review-cases/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseKey, ...fields }),
    }).catch(() => {})
  }
  const { before, after } = diagnostic.accountSummary

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-black text-foreground">
          EasyHOME — Brahmastra Ads Intelligence{showJune15Label ? ' (June 15 drop)' : ''}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {controlPanel.mode === 'single'
            ? <>Selected Range: {diagnostic.windows.afterStart} → {diagnostic.windows.afterEnd}. No baseline comparison — switch to Compare mode for movement vs another period.</>
            : <>Range A {diagnostic.windows.beforeStart} → {diagnostic.windows.beforeEnd} vs Range B {diagnostic.windows.afterStart} → {diagnostic.windows.afterEnd}.</>}
          {' '}Read-only. Data through {diagnostic.windows.afterEnd} ({meta.transactionRowsFetched.toLocaleString('en-IN')} transaction rows).
        </p>
        {error && <p className="text-sm text-red-400 mt-1">{error}</p>}
      </div>

      {/* Data Quality indicator — Phase R1: at-a-glance trust signal before relying on Brahmastra numbers. */}
      <div className="bg-card border border-border rounded-xl p-4">
        {(() => {
          const hasIssue = Boolean(controlPanel.dataFreshness?.adsDataIncomplete || controlPanel.dataFreshness?.salesDataIncomplete || controlPanel.dataFreshness?.changeHistoryIncomplete)
          const status: 'Healthy' | 'Warning' | 'Blocked' = !controlPanel.selectedProfileId ? 'Blocked' : hasIssue ? 'Warning' : 'Healthy'
          const colorClass = status === 'Healthy'
            ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300'
            : status === 'Warning'
              ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300'
          return (
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${colorClass}`}>
                Data Quality: {status}
              </span>
              <span className="text-xs text-muted-foreground">
                Profile: {controlPanel.selectedProfileName ?? controlPanel.selectedProfileId} ({controlPanel.selectedProfileId}) ·
                {' '}Ads through {controlPanel.dataFreshness?.latestAdsDate ?? 'unknown'} ·
                {' '}Sales through {controlPanel.dataFreshness?.latestSalesDate ?? 'unknown'} ·
                {' '}Change History through {controlPanel.dataFreshness?.latestChangeHistoryDate ?? 'unknown'} ·
                {' '}Profile isolation: scoped (Ads tables filtered by profile_id)
              </span>
            </div>
          )
        })()}
      </div>

      {/* Data freshness — always visible so "zero" never gets confused with "not imported yet".
          Warnings are metric-specific: a lag in one source must not make the whole page look invalid. */}
      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-sm font-semibold text-foreground mb-1">Data available</p>
        <p className="text-xs text-muted-foreground">
          Ads reports are complete through {controlPanel.dataFreshness?.latestAdsDate ?? 'unknown'}. Sales/payment transactions are complete through {controlPanel.dataFreshness?.latestSalesDate ?? 'unknown'}. Change History is complete through {controlPanel.dataFreshness?.latestChangeHistoryDate ?? 'unknown'}.
        </p>
        {controlPanel.dataFreshness?.adsDataIncomplete && (
          <p className="text-sm text-amber-400 mt-2">
            Selected range extends beyond available Ads data — Ads spend/sales/clicks/ACOS/ROAS findings and Good Working rows may be incomplete for this range.
          </p>
        )}
        {controlPanel.dataFreshness?.salesDataIncomplete && (
          <p className="text-sm text-amber-400 mt-2">
            Total-sales/blended metrics may be incomplete until payment transactions are refreshed. Ads-only findings above are not affected.
          </p>
        )}
        {controlPanel.dataFreshness?.changeHistoryIncomplete && (
          <p className="text-xs text-muted-foreground mt-2">
            Change History is behind the selected range — change-history correlation context may be incomplete; this does not affect Ads or sales metrics.
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-2 italic">
          Order-level and geo demand metrics will use Amazon payment transaction reports as the source of truth for SKU/date/order/geo/fulfillment/returns where available. This is not yet auto-refreshed.
        </p>
        {paymentImportStatus && (
          <div className="mt-3 border-t border-border/60 pt-3">
            <p className="text-xs font-semibold text-foreground mb-1">Payment Transaction Import</p>
            <p className="text-xs text-muted-foreground">
              Last file: {paymentImportStatus.lastFileName} · {paymentImportStatus.acceptedCount} accepted / {paymentImportStatus.rejectedCount} rejected ·{' '}
              {paymentImportStatus.insertedCount} inserted / {paymentImportStatus.updatedCount} updated · uploaded {new Date(paymentImportStatus.uploadedAt).toLocaleString('en-IN')}
            </p>
            <p className="text-xs text-muted-foreground italic">
              No buyer name, email, phone, address, or order ID is shown here — counts and dates only.
            </p>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Data source accuracy audit</p>
            <p className="text-xs text-muted-foreground">
              Settlement net sales/refunds/orders: Payment Transactions. Amazon Ads spend/ad-attributed sales/ACOS/ROAS: Amazon Ads Reports. Business Report sessions/page-views: not connected.
            </p>
          </div>
          <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {controlPanel.mode === 'single' ? 'Selected range' : 'Range A vs Range B'}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <KpiCard label="Mode" value={sourceAccuracyAudit.ranges.mode} sub="Requested by Control Panel" />
          <KpiCard
            label="Requested Range A"
            value={`${sourceAccuracyAudit.ranges.requestedRangeA.startDate} → ${sourceAccuracyAudit.ranges.requestedRangeA.endDate}`}
            sub="From query params"
          />
          <KpiCard
            label="Effective Range A"
            value={`${sourceAccuracyAudit.ranges.effectiveRangeA.startDate} → ${sourceAccuracyAudit.ranges.effectiveRangeA.endDate}`}
            sub="Actually used by API"
          />
          <KpiCard
            label="Effective Range B"
            value={`${sourceAccuracyAudit.ranges.effectiveRangeB.startDate} → ${sourceAccuracyAudit.ranges.effectiveRangeB.endDate}`}
            sub="Actually used by API"
          />
          <KpiCard label="Latest Ads Date" value={sourceAccuracyAudit.latestAdsDate ?? '—'} sub="Amazon Ads Reports" />
          <KpiCard label="Latest Payment Transaction Date" value={sourceAccuracyAudit.latestSalesDate ?? '—'} sub="Payment Transactions (settlement)" />
          <KpiCard label="Blended metrics complete" value={sourceAccuracyAudit.blendedMetricsComplete ? 'Yes' : 'No'} sub="Both sources must be complete" />
          <KpiCard label="Business Report" value="Not connected" sub="No sessions/page-views in this diagnostic" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Settlement Net Sales (B)" value={formatInr(sourceAccuracyAudit.rangeB.settlementNetSales)} sub="Payment Transactions" />
          <KpiCard label="Amazon Ads Spend (B)" value={formatInr(sourceAccuracyAudit.rangeB.amazonAdsSpend)} sub="Campaign daily rows" />
          <KpiCard label="Settlement Ad Charges (B)" value={formatInr(sourceAccuracyAudit.rangeB.settlementAdCharges)} sub="Settlement Ad Charges — not used as campaign spend" />
          <KpiCard label="Campaign vs Deep Report Spend Variance (B)" value={formatInr(sourceAccuracyAudit.rangeB.amazonAdsSpend - sourceAccuracyAudit.rangeB.advertisedProductSpend)} sub="Campaign-level minus advertised-product-level" />
          {controlPanel.mode === 'compare' && (
            <>
              <KpiCard label="Settlement Net Sales (A)" value={formatInr(sourceAccuracyAudit.rangeA.settlementNetSales)} sub="Payment Transactions" />
              <KpiCard label="Amazon Ads Spend (A)" value={formatInr(sourceAccuracyAudit.rangeA.amazonAdsSpend)} sub="Campaign daily rows" />
              <KpiCard label="Settlement Ad Charges (A)" value={formatInr(sourceAccuracyAudit.rangeA.settlementAdCharges)} sub="Settlement Ad Charges — not used as campaign spend" />
              <KpiCard label="Campaign vs Deep Report Spend Variance (A)" value={formatInr(sourceAccuracyAudit.rangeA.amazonAdsSpend - sourceAccuracyAudit.rangeA.advertisedProductSpend)} sub="Campaign-level minus advertised-product-level" />
            </>
          )}
        </div>
        {sourceAccuracyAudit.warnings.map((w, i) => (
          <p key={i} className="text-xs text-amber-600 dark:text-amber-300 mt-3">{w}</p>
        ))}
      </div>

      <BrahmastraControlPanel
        portfolios={portfolioOptions}
        campaigns={campaignOptions}
        onRun={q => setQuery(q)}
        onDraftChange={setDraftQuery}
        isDirty={pendingChanges}
        onExportAll={handleExportAll}
        loading={loading}
        dataFreshness={controlPanel.dataFreshness}
      />

      {/* Currently loaded analysis — always visible so the user never has to guess
          which range the tables/charts below actually belong to. */}
      <div className="bg-card border border-border rounded-xl p-3 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
          Currently loaded analysis
        </span>
        <span className="text-xs text-foreground">
          {controlPanel.mode === 'single' ? 'Single Range' : 'Compare'} · {rangeLabel(loadedQuery)}
        </span>
        {loadedAt && (
          <span className="text-xs text-muted-foreground">Loaded at {loadedAt.toLocaleTimeString()}</span>
        )}
      </div>

      {pendingChanges && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-xl p-4">
          <p className="text-sm font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Date or filter changes are not applied yet. Click Run Analysis to refresh all tables and charts.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Results below are still for the previously loaded analysis: {rangeLabel(loadedQuery)}.
          </p>
        </div>
      )}

      {/* Findings & Actions Table — the main, easier-to-scan view above the raw sections */}
      <GoodWorkingTable rows={goodWorkingRows} mode={controlPanel.mode} loadedRangeSuffix={loadedRangeSuffix} />
      <FindingsActionsTable rows={findingsTable} mode={controlPanel.mode} loadedRangeSuffix={loadedRangeSuffix} />

      {controlPanel.mode === 'single' && (topSpenders.length > 0 || topAdSalesGenerators.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-foreground">Top spenders (selected period)</h2>
              <button
                type="button"
                onClick={() => downloadCsv(
                  'brahmastra_top_spenders',
                  ['date_range_start', 'date_range_end', 'mode', 'portfolio', 'campaign', 'spend', 'ad_attributed_sales', 'clicks', 'acos', 'roas', 'source'],
                  topSpenders.map(row => [
                    diagnostic.windows.afterStart, diagnostic.windows.afterEnd, controlPanel.mode, portfolioDisplayLabel(row.portfolio), row.campaignName,
                    row.afterSpend, row.afterSales, row.afterClicks, row.afterAcos, row.afterRoas, 'Amazon Ads Reports',
                  ]),
                  loadedRangeSuffix,
                )}
                className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
              >
                Export CSV
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Source: Amazon Ads Reports</p>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Ad Spend', 'Ad-attributed Sales', 'ACOS']}
              rows={topSpenders.map(row => [
                row.campaignName, portfolioDisplayLabel(row.portfolio), formatInr(row.afterSpend), formatInr(row.afterSales),
                row.afterAcos !== null ? `${row.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-foreground">Top ad sales generators (selected period)</h2>
              <button
                type="button"
                onClick={() => downloadCsv(
                  'brahmastra_top_ad_sales_generators',
                  ['date_range_start', 'date_range_end', 'mode', 'portfolio', 'campaign', 'ad_attributed_sales', 'spend', 'clicks', 'acos', 'roas', 'source'],
                  topAdSalesGenerators.map(row => [
                    diagnostic.windows.afterStart, diagnostic.windows.afterEnd, controlPanel.mode, portfolioDisplayLabel(row.portfolio), row.campaignName,
                    row.afterSales, row.afterSpend, row.afterClicks, row.afterAcos, row.afterRoas, 'Amazon Ads Reports',
                  ]),
                  loadedRangeSuffix,
                )}
                className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
              >
                Export CSV
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Source: Amazon Ads Reports</p>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Ad-attributed Sales', 'Ad Spend', 'ROAS']}
              rows={topAdSalesGenerators.map(row => [
                row.campaignName, portfolioDisplayLabel(row.portfolio), formatInr(row.afterSales), formatInr(row.afterSpend),
                row.afterRoas !== null ? `${row.afterRoas.toFixed(2)}x` : '—',
              ])}
            />
          </div>
        </div>
      )}

      {/* Account summary — labels state their data source explicitly so "sales" is never
          ambiguous between total (payment transactions) and ad-attributed (Ads reports). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {controlPanel.mode === 'single' ? (
          <>
            <KpiCard label="Settlement Net Sales / Day" value={formatInr(after.netSales / Math.max(after.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Amazon Ads Spend / Day" value={formatInr(blendedMetrics.after.adSpend / Math.max(after.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Settlement Ad Charges" value={formatInr(after.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Orders" value={after.orderCount.toLocaleString('en-IN')} sub={`${after.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds" value={formatInr(after.refundAmount)} sub={`${after.refundCount} orders · Source: Payment Transactions`} />
          </>
        ) : (
          <>
            <KpiCard label="Settlement Net Sales / Day (Range A)" value={formatInr(before.netSales / Math.max(before.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Net Sales / Day (Range B)" value={formatInr(after.netSales / Math.max(after.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Amazon Ads Spend / Day (Range A)" value={formatInr((blendedMetrics.before?.adSpend ?? 0) / Math.max(before.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Spend / Day (Range B)" value={formatInr(blendedMetrics.after.adSpend / Math.max(after.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Settlement Ad Charges (Range A)" value={formatInr(before.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Settlement Ad Charges (Range B)" value={formatInr(after.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Orders (Range A)" value={before.orderCount.toLocaleString('en-IN')} sub={`${before.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Orders (Range B)" value={after.orderCount.toLocaleString('en-IN')} sub={`${after.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds (Range A)" value={formatInr(before.refundAmount)} sub={`${before.refundCount} orders · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds (Range B)" value={formatInr(after.refundAmount)} sub={`${after.refundCount} orders · Source: Payment Transactions`} />
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Ad-attributed Sales / Ad Spend figures below — including Blended ROAS/TACOS — come from Amazon Ads Reports, not payment transactions.
      </p>

      {/* Blended ROAS / TACOS — Total Sales/Refunds/Orders from Payment Transactions, Ad Spend/Ad Sales from Amazon Ads Reports. */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-bold text-foreground">Blended ROAS / TACOS</h2>
          {!blendedMetrics.complete && (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              Incomplete for selected range
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Settlement Net Sales/Refunds/Orders: Source: Payment Transactions · Amazon Ads Spend/Amazon Ads Attributed Sales: Source: Amazon Ads Reports · Blended ROAS/TACOS: Settlement Net Sales (Payment Transactions) combined with Amazon Ads Spend (Amazon Ads Reports). Seller Central Business Report Ordered Product Sales is not connected yet and may differ from Settlement Net Sales.
        </p>
        {!blendedMetrics.complete && (
          <p className="text-xs text-amber-600 dark:text-amber-300 mb-3">
            Selected range exceeds the latest available Ads and/or payment-transaction data — blended figures below may be incomplete until both sources catch up. This does not affect Ads-only Findings/Good Working.
          </p>
        )}
        {controlPanel.mode === 'single' ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Settlement Net Sales" value={formatInr(blendedMetrics.after.totalSalesNet)} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Gross Product Sales" value={formatInr(blendedMetrics.after.grossSales)} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Refunds" value={formatInr(blendedMetrics.after.refunds)} sub="Source: Payment Transactions" />
            <KpiCard label="Orders" value={blendedMetrics.after.totalOrders.toLocaleString('en-IN')} sub="Distinct orders · Payment Transactions" />
            <KpiCard label="Units" value={blendedMetrics.after.unitsSold.toLocaleString('en-IN')} sub={`${blendedMetrics.after.refundedUnits.toLocaleString('en-IN')} refunded`} />
            <KpiCard label="Amazon Ads Spend" value={formatInr(blendedMetrics.after.adSpend)} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales" value={formatInr(blendedMetrics.after.adSales)} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Ad ROAS" value={roasStr(blendedMetrics.after.adRoas)} sub="Amazon Ads Attributed Sales ÷ Amazon Ads Spend" />
            <KpiCard label="Blended ROAS" value={roasStr(blendedMetrics.after.blendedRoas)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="TACOS / Blended ACOS" value={pctStr(blendedMetrics.after.tacos)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="Organic Estimate" value={formatInr(blendedMetrics.after.organicEstimate)} sub="Settlement Net Sales − Amazon Ads Attributed Sales (estimate)" />
            <KpiCard label="Ad Sales Share" value={pctStr(blendedMetrics.after.adSalesShare)} sub="Amazon Ads Attributed Sales ÷ Settlement Net Sales" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Settlement Net Sales (A)" value={formatInr(blendedMetrics.before?.totalSalesNet ?? 0)} sub="Payment Transactions" />
            <KpiCard label="Settlement Net Sales (B)" value={formatInr(blendedMetrics.after.totalSalesNet)} sub="Payment Transactions" />
            <KpiCard label="Amazon Ads Spend (A)" value={formatInr(blendedMetrics.before?.adSpend ?? 0)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Spend (B)" value={formatInr(blendedMetrics.after.adSpend)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales (A)" value={formatInr(blendedMetrics.before?.adSales ?? 0)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales (B)" value={formatInr(blendedMetrics.after.adSales)} sub="Amazon Ads Reports" />
            <KpiCard label="Blended ROAS (A)" value={roasStr(blendedMetrics.before?.blendedRoas ?? null)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="Blended ROAS (B)" value={roasStr(blendedMetrics.after.blendedRoas)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="TACOS (A)" value={pctStr(blendedMetrics.before?.tacos ?? null)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="TACOS (B)" value={pctStr(blendedMetrics.after.tacos)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="Organic Estimate (A)" value={formatInr(blendedMetrics.before?.organicEstimate ?? 0)} sub="Estimate" />
            <KpiCard label="Organic Estimate (B)" value={formatInr(blendedMetrics.after.organicEstimate)} sub="Estimate" />
            <KpiCard label="Settlement Refunds (A)" value={formatInr(blendedMetrics.before?.refunds ?? 0)} sub="Payment Transactions" />
            <KpiCard label="Settlement Refunds (B)" value={formatInr(blendedMetrics.after.refunds)} sub="Payment Transactions" />
            <KpiCard label="Orders (A)" value={(blendedMetrics.before?.totalOrders ?? 0).toLocaleString('en-IN')} sub="Distinct orders" />
            <KpiCard label="Orders (B)" value={blendedMetrics.after.totalOrders.toLocaleString('en-IN')} sub="Distinct orders" />
            <KpiCard label="Units (A)" value={(blendedMetrics.before?.unitsSold ?? 0).toLocaleString('en-IN')} sub="Payment Transactions" />
            <KpiCard label="Units (B)" value={blendedMetrics.after.unitsSold.toLocaleString('en-IN')} sub="Payment Transactions" />
          </div>
        )}
        {blendedMetrics.insights.length > 0 && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className="text-xs font-semibold text-foreground mb-2">Blended insights (correlation only — review manually, not a causal claim)</p>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {blendedMetrics.insights.map((note, i) => (
                <li key={i} className="flex gap-2">
                  <span>•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Mapping health */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-foreground">Mapping health</h2>
          {diagnostic.mappingHealth.topUnmappedSkus.length > 0 && (
            <button
              type="button"
              onClick={() => downloadCsv(
                'brahmastra_unmapped_skus',
                ['sku', 'range_a_sales', 'range_b_sales', 'total_sales'],
                diagnostic.mappingHealth.topUnmappedSkus.map(row => [row.sku, row.beforeSales, row.afterSales, row.totalSales]),
                loadedRangeSuffix,
              )}
              className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
            >
              Export Unmapped SKUs CSV
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KpiCard label="SKUs analysed" value={diagnostic.mappingHealth.totalSkusAnalyzed.toLocaleString('en-IN')} />
          <KpiCard label="Mapped" value={diagnostic.mappingHealth.mappedSkuCount.toLocaleString('en-IN')} />
          <KpiCard label="Unmapped" value={diagnostic.mappingHealth.unmappedSkuCount.toLocaleString('en-IN')} />
          <KpiCard label="Revenue in unmapped bucket" value={formatInr(diagnostic.mappingHealth.unmappedRevenue)} />
        </div>
        {diagnostic.mappingHealth.topUnmappedSkus.length > 0 && (
          <DataTable
            columns={['SKU', 'Range A', 'Range B', 'Total']}
            rows={diagnostic.mappingHealth.topUnmappedSkus.map(row => [
              row.sku,
              formatInr(row.beforeSales),
              formatInr(row.afterSales),
              formatInr(row.totalSales),
            ])}
          />
        )}
      </div>

      {/* Brahmastra Action Queue */}
      <ActionQueue actionQueue={actionQueue} summary={actionQueueSummary} onStatusChange={handleActionStatusChange} />

      {/* Phase 1H: team-safe Review Execution Sheet (checklist + decision workflow + guardrails) */}
      <ManualReviewExecutionSheet cases={manualReviewCases} onUpdate={handleExecutionSheetUpdate} />

      {/* Phase 1G: grouped Manual Review Cases (merges duplicate Phase 1F facets) */}
      <ManualReviewCases cases={manualReviewCases} onUpdate={handleCaseUpdate} />

      {/* Phase 1F: ranked Manual Review Candidates (change history × performance) */}
      <ManualReviewCandidates candidates={manualReviewCandidates} />

      {/* Phase 1E.2: manual Change History import + linkage */}
      <ChangeHistorySection
        importStatus={changeHistoryImportStatus}
        summary={changeHistorySummary}
        actionQueue={actionQueue}
        afterStart={diagnostic.windows.afterStart}
      />

      {/* Phase 1E.4: 30-day archive, day-by-day, chunk import helper, correlation */}
      <ChangeHistoryArchiveSection
        dayByDay={changeHistoryDayByDay}
        coverage={changeHistoryArchiveCoverage}
        chunkCoverage={changeHistoryChunkCoverage}
        correlationSummary={changeHistoryCorrelationSummary}
        batches={changeHistoryBatches}
        events={changeHistoryEvents}
      />

      {/* Diagnostic notes */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" /> Diagnostic notes
        </h2>
        <ul className="space-y-2 text-sm text-foreground">
          {diagnostic.diagnosticNotes.map((note, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground">•</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Settlement daily trend */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Daily settlement net sales</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={diagnostic.dailyTrend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="netSales" name="Settlement net sales" stroke="#22c55e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Category before/after */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-red-400" /> Category (portfolio) - settlement net sales delta
        </h2>
        <div className="h-64 mb-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={diagnostic.categoryTable} margin={{ top: 5, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="portfolio" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} tickFormatter={portfolioDisplayLabel} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} labelFormatter={label => typeof label === 'string' ? portfolioDisplayLabel(label) : label} />
              <Bar dataKey="deltaSales" name="Sales delta" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <DataTable
          columns={['Portfolio', 'Range A Settlement Sales', 'Range B Settlement Sales', 'Sales Delta', 'Delta %', 'Range A Units', 'Range B Units', 'Range A Refund', 'Range B Refund']}
          rows={diagnostic.categoryTable.map(row => [
            portfolioDisplayLabel(row.portfolio),
            formatInr(row.beforeSales),
            formatInr(row.afterSales),
            formatInr(row.deltaSales),
            row.deltaSalesPct !== null ? `${row.deltaSalesPct.toFixed(1)}%` : '—',
            row.beforeUnits.toLocaleString('en-IN'),
            row.afterUnits.toLocaleString('en-IN'),
            formatInr(row.beforeRefund),
            formatInr(row.afterRefund),
          ])}
        />
      </div>

      {/* Top revenue losers */}
      <SkuLoserTable title="Top 20 settlement revenue losers (SKU)" rows={diagnostic.topRevenueLosers} metric="sales" />

      {/* Top unit losers */}
      <SkuLoserTable title="Top 20 unit/order losers (SKU)" rows={diagnostic.topUnitLosers} metric="units" />

      {/* Top refund increases */}
      <SkuLoserTable title="Top 20 SKUs with worsening refund impact" rows={diagnostic.topRefundIncreases} metric="refund" />

      {/* Outlier days */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Outlier day breakdown</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {diagnostic.outlierDays.map(day => (
            <div key={day.date} className="border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-foreground">{day.date}</span>
                {day.vsAfterPeriodAvgSalesPct !== null && (
                  <Badge variant={day.vsAfterPeriodAvgSalesPct < 0 ? 'destructive' : 'secondary'}>
                    {day.vsAfterPeriodAvgSalesPct >= 0 ? '+' : ''}{day.vsAfterPeriodAvgSalesPct.toFixed(0)}% vs after-period avg
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Settlement sales {formatInr(day.netSales)} · Settlement Ad charges {formatInr(day.adSpend)} · Refunds {formatInr(day.refundAmount)} · {day.rowCount} rows
              </p>
              {day.topPortfolioDrops.length > 0 && (
                <ul className="mt-2 text-xs text-muted-foreground space-y-1">
                  {day.topPortfolioDrops.map(p => (
                    <li key={p.portfolio}>
                      {portfolioDisplayLabel(p.portfolio)}: {p.dayShare.toFixed(1)}% of that day&apos;s sales vs {p.afterPeriodAvgShare.toFixed(1)}% of the after-period average
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Ads campaign import status */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Ads campaign CSV import
        </h2>
        {data.latestCampaignUploadBatch ? (
          <div className="text-sm text-foreground space-y-1">
            <p>
              Latest file: <span className="font-semibold">{data.latestCampaignUploadBatch.original_filename}</span>{' '}
              ({data.latestCampaignUploadBatch.report_date_start} → {data.latestCampaignUploadBatch.report_date_end})
            </p>
            <p className="text-muted-foreground text-xs">
              {data.latestCampaignUploadBatch.accepted_count} accepted / {data.latestCampaignUploadBatch.rejected_count} rejected ·{' '}
              {data.latestCampaignUploadBatch.inserted_count} inserted / {data.latestCampaignUploadBatch.updated_count} updated ·{' '}
              {data.latestCampaignUploadBatch.campaign_count} campaigns ({data.latestCampaignUploadBatch.unmapped_campaign_count} unmapped) ·{' '}
              uploaded {new Date(data.latestCampaignUploadBatch.uploaded_at).toLocaleString('en-IN')}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No campaign CSV has been imported yet. Export a <strong>daily</strong> Sponsored Products campaign report from Amazon Ads
            Console (not a period-aggregate report) and import it via POST /api/internal/ads-campaign-daily/import.
          </p>
        )}
      </div>

      {campaignDiagnostic.hasCampaignData ? (
        <>
          {campaignDiagnostic.adSpendCrossCheck.warning && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-300 flex gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{campaignDiagnostic.adSpendCrossCheck.warning}</span>
            </div>
          )}

          {/* Campaign daily trend */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Daily campaign spend vs sales</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={campaignDiagnostic.campaignDailyTrend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Line type="monotone" dataKey="spend" name="Spend" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="sales" name="Sales" stroke="#22c55e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Campaign before/after table */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign — before vs after</h2>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Range A Spend', 'Range B Spend', 'Range A Sales', 'Range B Sales', 'Range A ACOS', 'Range B ACOS']}
              rows={campaignTablePaging.pageRows.map(row => [
                row.campaignName,
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.beforeSpend),
                formatInr(row.afterSpend),
                formatInr(row.beforeSales),
                formatInr(row.afterSales),
                row.beforeAcos !== null ? `${row.beforeAcos.toFixed(1)}%` : '—',
                row.afterAcos !== null ? `${row.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
            <TablePaginationControls
              page={campaignTablePaging.page} setPage={campaignTablePaging.setPage} pageSize={campaignTablePaging.pageSize} setPageSize={campaignTablePaging.setPageSize}
              totalPages={campaignTablePaging.totalPages} totalRows={campaignTablePaging.totalRows} startIndex={campaignTablePaging.startIndex} endIndex={campaignTablePaging.endIndex}
            />
          </div>

          {/* Top campaign losers */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 campaign losers (by sales delta)</h2>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Range A Sales', 'Range B Sales', 'Δ Sales', 'Δ Spend']}
              rows={campaignDiagnostic.topCampaignLosers.map(row => [
                row.campaignName,
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.beforeSales),
                formatInr(row.afterSales),
                formatInr(row.deltaSales),
                formatInr(row.deltaSpend),
              ])}
            />
          </div>

          {/* Spend up, sales down */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaigns where spend increased but sales dropped</h2>
            {campaignDiagnostic.campaignsWithSpendUpAndSalesDown.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Campaign', 'Portfolio', 'Δ Spend', 'Δ Sales']}
                rows={campaignDiagnostic.campaignsWithSpendUpAndSalesDown.map(row => [
                  row.campaignName,
                  portfolioDisplayLabel(row.portfolio),
                  formatInr(row.deltaSpend),
                  formatInr(row.deltaSales),
                ])}
              />
            )}
          </div>

          {/* Campaign mapping health */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign mapping health</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <KpiCard label="Campaigns analysed" value={campaignDiagnostic.campaignMappingHealth.totalCampaignsAnalyzed.toLocaleString('en-IN')} />
              <KpiCard label="Mapped" value={campaignDiagnostic.campaignMappingHealth.mappedCampaignCount.toLocaleString('en-IN')} />
              <KpiCard label="Unmapped" value={campaignDiagnostic.campaignMappingHealth.unmappedCampaignCount.toLocaleString('en-IN')} />
              <KpiCard label="Spend in unmapped bucket" value={formatInr(campaignDiagnostic.campaignMappingHealth.unmappedSpend)} />
            </div>
            {campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns.length > 0 && (
              <DataTable
                columns={['Campaign', 'Total Spend', 'Total Sales']}
                rows={campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns.map(row => [row.campaignName, formatInr(row.totalSpend), formatInr(row.totalSales)])}
              />
            )}
          </div>

          {/* Campaign vs actual sales cross-check */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign sales vs actual portfolio sales (cross-check)</h2>
            <DataTable
              columns={['Portfolio', 'Campaign Range A', 'Actual Range A', 'Gap %', 'Campaign Range B', 'Actual Range B', 'Gap %']}
              rows={campaignDiagnostic.campaignPortfolioCrossCheck.map(row => [
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.campaignBeforeSales),
                formatInr(row.actualBeforeSales),
                row.beforeGapPct !== null ? `${row.beforeGapPct.toFixed(0)}%` : '—',
                formatInr(row.campaignAfterSales),
                formatInr(row.actualAfterSales),
                row.afterGapPct !== null ? `${row.afterGapPct.toFixed(0)}%` : '—',
              ])}
            />
          </div>
        </>
      ) : (
        <div className="bg-card border border-border rounded-xl p-5 text-sm text-muted-foreground">
          No campaign-level analysis available yet — import a daily Sponsored Products campaign CSV first.
        </div>
      )}

      {/* Deep SP report import status */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Deep SP report import status (SKU / targeting / search term)
        </h2>
        {latestDeepReportBatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deep report (advertised product / targeting / search term) has been imported yet.</p>
        ) : (
          <DataTable
            columns={['Report kind', 'Filename', 'Date range', 'Accepted/Rejected', 'Campaigns', 'Unmapped', 'Attribution window', 'Uploaded']}
            rows={latestDeepReportBatches.map(b => [
              b.report_kind,
              b.original_filename,
              `${b.report_date_start ?? '—'} → ${b.report_date_end ?? '—'}`,
              `${b.accepted_count}/${b.rejected_count}`,
              b.campaign_count,
              b.unmapped_count,
              b.attribution_window_used ?? '—',
              new Date(b.uploaded_at).toLocaleString('en-IN'),
            ])}
          />
        )}
      </div>

      {deepDiagnostic.advertisedProduct && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 advertised SKU ad-sales losers</h2>
            <DataTable
              columns={['SKU', 'Portfolio', 'Range A Sales', 'Range B Sales', 'Δ Sales', 'Range A ACOS', 'Range B ACOS']}
              rows={deepDiagnostic.advertisedProduct.topLosers.map((r: AdvertisedProductRow) => [
                r.advertisedSku, portfolioDisplayLabel(r.portfolio), formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
                r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Advertised SKUs: clicks continued, sales collapsed</h2>
            {deepDiagnostic.advertisedProduct.trafficContinuedSalesCollapsed.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['SKU', 'Portfolio', 'Range A Clicks', 'Range B Clicks', 'Range A Sales', 'Range B Sales']}
                rows={deepDiagnostic.advertisedProduct.trafficContinuedSalesCollapsed.map((r: AdvertisedProductRow) => [
                  r.advertisedSku, portfolioDisplayLabel(r.portfolio), r.beforeClicks, r.afterClicks, formatInr(r.beforeSales), formatInr(r.afterSales),
                ])}
              />
            )}
          </div>
        </>
      )}

      {deepDiagnostic.targeting && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 target/keyword losers</h2>
            <DataTable
              columns={['Target', 'Match type', 'Campaign', 'Range A Sales', 'Range B Sales', 'Δ Sales']}
              rows={deepDiagnostic.targeting.topLosers.map((r: TargetingRow) => [
                entityDisplayLabel(r.targetLabel), entityDisplayLabel(r.matchType ?? '—'), r.campaignName, formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Targets where ACOS worsened sharply</h2>
            {deepDiagnostic.targeting.acosWorsenedSharply.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Target', 'Match type', 'Range A ACOS', 'Range B ACOS', 'Range B Clicks']}
                rows={deepDiagnostic.targeting.acosWorsenedSharply.map((r: TargetingRow) => [
                  entityDisplayLabel(r.targetLabel), entityDisplayLabel(r.matchType ?? '—'),
                  r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                  r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
                  r.afterClicks,
                ])}
              />
            )}
          </div>
        </>
      )}

      {deepDiagnostic.searchTerm && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: high spend, zero orders after 15 June</h2>
            {deepDiagnostic.searchTerm.highSpendZeroOrdersAfter.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Range B Spend', 'Range B Clicks']}
                rows={deepDiagnostic.searchTerm.highSpendZeroOrdersAfter.map((r: SearchTermRow) => [entityDisplayLabel(r.searchTerm), r.campaignName, formatInr(r.afterSpend), r.afterClicks])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: spend up, sales down</h2>
            {deepDiagnostic.searchTerm.spendUpSalesDown.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Δ Spend', 'Δ Sales']}
                rows={deepDiagnostic.searchTerm.spendUpSalesDown.map((r: SearchTermRow) => [entityDisplayLabel(r.searchTerm), r.campaignName, formatInr(r.deltaSpend), formatInr(r.deltaSales)])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: good before, bad after</h2>
            {deepDiagnostic.searchTerm.goodBeforeBadAfter.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Range A ACOS', 'Range B ACOS', 'Range A Purchases', 'Range B Purchases']}
                rows={deepDiagnostic.searchTerm.goodBeforeBadAfter.map((r: SearchTermRow) => [
                  entityDisplayLabel(r.searchTerm), r.campaignName,
                  r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                  r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
                  r.beforePurchases, r.afterPurchases,
                ])}
              />
            )}
          </div>
        </>
      )}

      {(deepDiagnostic.advertisedProduct || deepDiagnostic.targeting || deepDiagnostic.searchTerm) && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-4">Deep report mapping health</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {deepDiagnostic.advertisedProduct && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Advertised product</p>
                <p className="text-sm text-foreground">{deepDiagnostic.advertisedProduct.mappingHealth.mappedCount}/{deepDiagnostic.advertisedProduct.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.advertisedProduct.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
            {deepDiagnostic.targeting && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Targeting</p>
                <p className="text-sm text-foreground">{deepDiagnostic.targeting.mappingHealth.mappedCount}/{deepDiagnostic.targeting.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.targeting.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
            {deepDiagnostic.searchTerm && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Search term</p>
                <p className="text-sm text-foreground">{deepDiagnostic.searchTerm.mappingHealth.mappedCount}/{deepDiagnostic.searchTerm.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.searchTerm.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {deepDiagnostic.advertisedProduct && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-4">Portfolio-level deep diagnostic summary (SKU-attributed ad spend/sales)</h2>
          <DataTable
            columns={['Portfolio', 'Range A Spend', 'Range B Spend', 'Range A Sales', 'Range B Sales', 'Range A ACOS', 'Range B ACOS']}
            rows={Object.values(
              deepDiagnostic.advertisedProduct.table.reduce((acc: Record<string, { portfolio: string; beforeSpend: number; afterSpend: number; beforeSales: number; afterSales: number }>, row: AdvertisedProductRow) => {
                if (!acc[row.portfolio]) acc[row.portfolio] = { portfolio: row.portfolio, beforeSpend: 0, afterSpend: 0, beforeSales: 0, afterSales: 0 }
                acc[row.portfolio].beforeSpend += row.beforeSpend
                acc[row.portfolio].afterSpend += row.afterSpend
                acc[row.portfolio].beforeSales += row.beforeSales
                acc[row.portfolio].afterSales += row.afterSales
                return acc
              }, {}),
            ).map(p => [
              portfolioDisplayLabel(p.portfolio), formatInr(p.beforeSpend), formatInr(p.afterSpend), formatInr(p.beforeSales), formatInr(p.afterSales),
              p.beforeSales > 0 ? `${((p.beforeSpend / p.beforeSales) * 100).toFixed(1)}%` : '—',
              p.afterSales > 0 ? `${((p.afterSpend / p.afterSales) * 100).toFixed(1)}%` : '—',
            ])}
          />
        </div>
      )}

      {/* Data gaps */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3">What&apos;s still missing for campaign-level diagnosis</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {diagnostic.dataGaps.map((gap, i) => (
            <li key={i} className="flex gap-2">
              <span>•</span>
              <span>{gap}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function SkuLoserTable({
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

function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
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
