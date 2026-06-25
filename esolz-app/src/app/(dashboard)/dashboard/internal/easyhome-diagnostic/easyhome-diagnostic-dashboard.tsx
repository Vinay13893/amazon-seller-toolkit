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
import type { EasyhomeAdsCampaignDiagnostic } from '@/lib/internal/easyhome-ads-campaign-diagnostic'
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
import { ActionQueue } from './action-queue'
import { ChangeHistorySection } from './change-history'
import { ChangeHistoryArchiveSection } from './change-history-archive'
import { ManualReviewCandidates } from './manual-review-candidates'
import { ManualReviewCases } from './manual-review-cases'
import { ManualReviewExecutionSheet, type ExecutionSheetUpdate } from './manual-review-execution-sheet'

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

type ApiResponse = {
  diagnostic: EasyhomeDropDiagnostic
  campaignDiagnostic: EasyhomeAdsCampaignDiagnostic
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

export function EasyhomeDiagnosticDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/internal/easyhome-drop-diagnostic')
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to load diagnostic')
        return res.json() as Promise<ApiResponse>
      })
      .then(json => { if (!cancelled) setData(json) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load diagnostic') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading EasyHOME diagnostic…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-6 text-sm text-red-400">{error ?? 'No data available.'}</div>
    )
  }

  const {
    diagnostic, campaignDiagnostic, deepDiagnostic, latestDeepReportBatches, actionQueue, actionQueueSummary,
    changeHistoryImportStatus, changeHistoryBatches, changeHistorySummary, changeHistoryEvents,
    changeHistoryDayByDay, changeHistoryArchiveCoverage, changeHistoryChunkCoverage, changeHistoryCorrelationSummary,
    manualReviewCandidates, manualReviewCases,
    meta,
  } = data

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
        <h1 className="text-2xl font-black text-foreground">EasyHOME — June 15 Drop Diagnostic</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Before {diagnostic.windows.beforeStart} → {diagnostic.windows.beforeEnd} vs After {diagnostic.windows.afterStart} → {diagnostic.windows.afterEnd}.
          Read-only. Data through {diagnostic.windows.afterEnd} ({meta.transactionRowsFetched.toLocaleString('en-IN')} transaction rows).
        </p>
      </div>

      {/* Account summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Sales / day (before)" value={formatInr(before.netSales / Math.max(before.dayCount, 1))} />
        <KpiCard label="Sales / day (after)" value={formatInr(after.netSales / Math.max(after.dayCount, 1))} />
        <KpiCard label="Ad spend / day (before)" value={formatInr(before.adSpend / Math.max(before.dayCount, 1))} />
        <KpiCard label="Ad spend / day (after)" value={formatInr(after.adSpend / Math.max(after.dayCount, 1))} />
        <KpiCard label="Ad-to-sales ratio (before)" value={before.adToSalesRatioPct !== null ? `${before.adToSalesRatioPct.toFixed(1)}%` : '—'} />
        <KpiCard label="Ad-to-sales ratio (after)" value={after.adToSalesRatioPct !== null ? `${after.adToSalesRatioPct.toFixed(1)}%` : '—'} />
        <KpiCard label="Orders (before)" value={before.orderCount.toLocaleString('en-IN')} sub={`${before.unitsOrdered.toLocaleString('en-IN')} units`} />
        <KpiCard label="Orders (after)" value={after.orderCount.toLocaleString('en-IN')} sub={`${after.unitsOrdered.toLocaleString('en-IN')} units`} />
        <KpiCard label="Refunds (before)" value={formatInr(before.refundAmount)} sub={`${before.refundCount} orders`} />
        <KpiCard label="Refunds (after)" value={formatInr(after.refundAmount)} sub={`${after.refundCount} orders`} />
      </div>

      {/* Mapping health */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Mapping health</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KpiCard label="SKUs analysed" value={diagnostic.mappingHealth.totalSkusAnalyzed.toLocaleString('en-IN')} />
          <KpiCard label="Mapped" value={diagnostic.mappingHealth.mappedSkuCount.toLocaleString('en-IN')} />
          <KpiCard label="Unmapped" value={diagnostic.mappingHealth.unmappedSkuCount.toLocaleString('en-IN')} />
          <KpiCard label="Revenue in unmapped bucket" value={formatInr(diagnostic.mappingHealth.unmappedRevenue)} />
        </div>
        {diagnostic.mappingHealth.topUnmappedSkus.length > 0 && (
          <DataTable
            columns={['SKU', 'Before', 'After', 'Total']}
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

      {/* Daily trend */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Daily trend — sales vs ad spend</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={diagnostic.dailyTrend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="netSales" name="Net sales" stroke="#22c55e" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="adSpend" name="Ad spend" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Category before/after */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-red-400" /> Category (portfolio) — sales delta, most-dropped first
        </h2>
        <div className="h-64 mb-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={diagnostic.categoryTable} margin={{ top: 5, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="portfolio" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="deltaSales" name="Sales delta" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <DataTable
          columns={['Portfolio', 'Before', 'After', 'Δ Sales', 'Δ %', 'Before Units', 'After Units', 'Before Refund', 'After Refund']}
          rows={diagnostic.categoryTable.map(row => [
            row.portfolio,
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
      <SkuLoserTable title="Top 20 revenue losers (SKU)" rows={diagnostic.topRevenueLosers} metric="sales" />

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
                Sales {formatInr(day.netSales)} · Ad spend {formatInr(day.adSpend)} · Refunds {formatInr(day.refundAmount)} · {day.rowCount} rows
              </p>
              {day.topPortfolioDrops.length > 0 && (
                <ul className="mt-2 text-xs text-muted-foreground space-y-1">
                  {day.topPortfolioDrops.map(p => (
                    <li key={p.portfolio}>
                      {p.portfolio}: {p.dayShare.toFixed(1)}% of that day&apos;s sales vs {p.afterPeriodAvgShare.toFixed(1)}% of the after-period average
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
              columns={['Campaign', 'Portfolio', 'Before Spend', 'After Spend', 'Before Sales', 'After Sales', 'Before ACOS', 'After ACOS']}
              rows={campaignDiagnostic.campaignTable.map(row => [
                row.campaignName,
                row.portfolio,
                formatInr(row.beforeSpend),
                formatInr(row.afterSpend),
                formatInr(row.beforeSales),
                formatInr(row.afterSales),
                row.beforeAcos !== null ? `${row.beforeAcos.toFixed(1)}%` : '—',
                row.afterAcos !== null ? `${row.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
          </div>

          {/* Top campaign losers */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 campaign losers (by sales delta)</h2>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Before Sales', 'After Sales', 'Δ Sales', 'Δ Spend']}
              rows={campaignDiagnostic.topCampaignLosers.map(row => [
                row.campaignName,
                row.portfolio,
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
                  row.portfolio,
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
              columns={['Portfolio', 'Campaign Before', 'Actual Before', 'Gap %', 'Campaign After', 'Actual After', 'Gap %']}
              rows={campaignDiagnostic.campaignPortfolioCrossCheck.map(row => [
                row.portfolio,
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
              columns={['SKU', 'Portfolio', 'Before Sales', 'After Sales', 'Δ Sales', 'Before ACOS', 'After ACOS']}
              rows={deepDiagnostic.advertisedProduct.topLosers.map((r: AdvertisedProductRow) => [
                r.advertisedSku, r.portfolio, formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
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
                columns={['SKU', 'Portfolio', 'Before Clicks', 'After Clicks', 'Before Sales', 'After Sales']}
                rows={deepDiagnostic.advertisedProduct.trafficContinuedSalesCollapsed.map((r: AdvertisedProductRow) => [
                  r.advertisedSku, r.portfolio, r.beforeClicks, r.afterClicks, formatInr(r.beforeSales), formatInr(r.afterSales),
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
              columns={['Target', 'Match type', 'Campaign', 'Before Sales', 'After Sales', 'Δ Sales']}
              rows={deepDiagnostic.targeting.topLosers.map((r: TargetingRow) => [
                r.targetLabel, r.matchType ?? '—', r.campaignName, formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Targets where ACOS worsened sharply</h2>
            {deepDiagnostic.targeting.acosWorsenedSharply.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Target', 'Match type', 'Before ACOS', 'After ACOS', 'After Clicks']}
                rows={deepDiagnostic.targeting.acosWorsenedSharply.map((r: TargetingRow) => [
                  r.targetLabel, r.matchType ?? '—',
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
                columns={['Search term', 'Campaign', 'After Spend', 'After Clicks']}
                rows={deepDiagnostic.searchTerm.highSpendZeroOrdersAfter.map((r: SearchTermRow) => [r.searchTerm, r.campaignName, formatInr(r.afterSpend), r.afterClicks])}
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
                rows={deepDiagnostic.searchTerm.spendUpSalesDown.map((r: SearchTermRow) => [r.searchTerm, r.campaignName, formatInr(r.deltaSpend), formatInr(r.deltaSales)])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: good before, bad after</h2>
            {deepDiagnostic.searchTerm.goodBeforeBadAfter.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Before ACOS', 'After ACOS', 'Before Purchases', 'After Purchases']}
                rows={deepDiagnostic.searchTerm.goodBeforeBadAfter.map((r: SearchTermRow) => [
                  r.searchTerm, r.campaignName,
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
            columns={['Portfolio', 'Before Spend', 'After Spend', 'Before Sales', 'After Sales', 'Before ACOS', 'After ACOS']}
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
              p.portfolio, formatInr(p.beforeSpend), formatInr(p.afterSpend), formatInr(p.beforeSales), formatInr(p.afterSales),
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
        columns={['SKU', 'Portfolio', 'Before', 'After', metric === 'refund' ? 'Δ Refund' : 'Δ']}
        rows={rows.map(row => [
          row.sku,
          row.portfolio,
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
