'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import type { ApiResponse } from './brahmastra-shared'
import { formatInr, formatInrCompact, pctStr, roasStr, rangeLabel, shortSourceLabel } from './brahmastra-shared'
import { BrahmastraControlPanel, type ControlPanelQuery } from './brahmastra-control-panel'
import { AccuracyAuditPanel, BusinessReportVsSettlementCard, PrimarySalesSourceBadge } from './brahmastra-data-health-section'

/**
 * Overview is intentionally the only tab that carries the full Control
 * Panel + pending-changes/loaded-analysis banners — every other tab uses
 * the compact LoadedAnalysisSummaryBar and links back here to change ranges.
 */
export function BrahmastraOverviewSection({
  data,
  portfolioOptions,
  campaignOptions,
  onRun,
  onDraftChange,
  isDirty,
  onExportAll,
  loading,
  loadedQuery,
  loadedAt,
}: {
  data: ApiResponse
  portfolioOptions: string[]
  campaignOptions: string[]
  onRun: (query: ControlPanelQuery) => void
  onDraftChange: (query: ControlPanelQuery) => void
  isDirty: boolean
  onExportAll: () => void
  loading: boolean
  loadedQuery: ControlPanelQuery
  loadedAt: Date | null
}) {
  const { controlPanel, sourceAccuracyAudit, blendedMetrics, businessReportBlended, actionQueue, diagnostic, findingsTable, goodWorkingRows } = data
  const { after } = diagnostic.accountSummary
  const isBusinessReportPrimary = data.primarySalesSource === 'business_report'
  const primaryInsights = isBusinessReportPrimary ? businessReportBlended.insights : blendedMetrics.insights
  const isSingle = controlPanel.mode === 'single'

  type TopActionItem = { actionKey: string; entityName: string; portfolio: string; priority: string }
  const topActions: TopActionItem[] = isSingle
    ? [...findingsTable]
        .sort((a, b) => (a.priority === 'High' ? 0 : a.priority === 'Medium' ? 1 : 2) - (b.priority === 'High' ? 0 : b.priority === 'Medium' ? 1 : 2))
        .slice(0, 5)
    : [...actionQueue]
        .sort((a, b) => (a.priority === 'High' ? 0 : a.priority === 'Medium' ? 1 : 2) - (b.priority === 'High' ? 0 : b.priority === 'Medium' ? 1 : 2))
        .slice(0, 5)

  return (
    <div className="space-y-6">
      <BrahmastraControlPanel
        portfolios={portfolioOptions}
        campaigns={campaignOptions}
        onRun={onRun}
        onDraftChange={onDraftChange}
        isDirty={isDirty}
        onExportAll={onExportAll}
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

      {isDirty && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-xl p-4">
          <p className="text-sm font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Date or filter changes are not applied yet. Click Run Analysis to refresh all tables and charts.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Results below are still for the previously loaded analysis: {rangeLabel(loadedQuery)}.
          </p>
        </div>
      )}

      <AccuracyAuditPanel controlPanel={controlPanel} sourceAccuracyAudit={sourceAccuracyAudit} />

      <div className="flex items-center gap-2">
        <PrimarySalesSourceBadge data={data} />
      </div>

      {!isBusinessReportPrimary && (
        <p className="text-sm text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
          Business Report data is missing for this range. Showing Settlement Net Sales view.
        </p>
      )}

      {/* Primary business sales — Business Report Ordered Product Sales when complete for the loaded range. */}
      {isBusinessReportPrimary && businessReportBlended.after && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <KpiCard label="Ordered Product Sales" value={formatInrCompact(businessReportBlended.after.orderedProductSales)} valueTitle={formatInr(businessReportBlended.after.orderedProductSales)} sub="Business Reports" />
          <KpiCard label="Units Ordered" value={data.businessReport.rangeB.unitsOrdered.toLocaleString('en-IN')} sub="Business Reports" />
          <KpiCard label="Total Order Items" value={data.businessReport.rangeB.totalOrderItems.toLocaleString('en-IN')} sub="Business Reports" />
          <KpiCard label="Total Amazon Ads Spend" value={formatInrCompact(businessReportBlended.after.adSpend)} valueTitle={formatInr(businessReportBlended.after.adSpend)} sub={shortSourceLabel('SP + SD + SB campaign reports')} subTitle="Source: SP + SD + SB campaign reports — matches Amazon Ads Console spend" />
          <KpiCard label="Business Report Blended ROAS" value={roasStr(businessReportBlended.after.roas)} sub="Ordered Sales ÷ Ads Spend" subWrap />
          <KpiCard label="Business Report TACOS" value={pctStr(businessReportBlended.after.tacos)} sub="Ads Spend ÷ Ordered Sales" subWrap subTitle="Total Amazon Ads Spend ÷ Business Report Ordered Product Sales" />
          <KpiCard label="API Attributed Ad Sales" value={formatInrCompact(businessReportBlended.after.adSales)} valueTitle={formatInr(businessReportBlended.after.adSales)} sub="API click-attributed" subTitle="Amazon Ads API campaign reports — may exclude SD view-through conversions" />
          <KpiCard label="Business Report Ad Sales Share" value={pctStr(businessReportBlended.after.adSalesShare)} sub="API Ad Sales ÷ Ordered Sales" subWrap />
          <KpiCard label="Business Report Organic Estimate" value={formatInrCompact(businessReportBlended.after.organicEstimate)} valueTitle={formatInr(businessReportBlended.after.organicEstimate)} sub="Estimate" subTitle="Ordered Product Sales − API Attributed Ad Sales (estimate)" />
        </div>
      )}

      {/* Secondary / reconciliation — Settlement, kept separate from the primary view above. */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{isBusinessReportPrimary ? 'Secondary — Settlement (reconciliation)' : 'Settlement'}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <KpiCard label="Settlement Net Sales" value={formatInrCompact(blendedMetrics.after.totalSalesNet)} valueTitle={formatInr(blendedMetrics.after.totalSalesNet)} sub={shortSourceLabel('Source: Payment Transactions')} subTitle="Source: Payment Transactions" />
          <KpiCard label="Settlement Gross Product Sales" value={formatInrCompact(blendedMetrics.after.grossSales)} valueTitle={formatInr(blendedMetrics.after.grossSales)} sub={shortSourceLabel('Source: Payment Transactions')} subTitle="Source: Payment Transactions" />
          <KpiCard label="Settlement Refunds" value={formatInrCompact(blendedMetrics.after.refunds)} valueTitle={formatInr(blendedMetrics.after.refunds)} sub={shortSourceLabel('Source: Payment Transactions')} subTitle="Source: Payment Transactions" />
          <KpiCard label="Settlement Orders" value={after.orderCount.toLocaleString('en-IN')} sub="Payment Txns" subTitle="Distinct orders · Payment Transactions" />
          {!isBusinessReportPrimary && (
            <KpiCard label="Total Amazon Ads Spend" value={formatInrCompact(blendedMetrics.after.adSpend)} valueTitle={formatInr(blendedMetrics.after.adSpend)} sub={shortSourceLabel('SP + SD + SB campaign reports')} subTitle="Source: SP + SD + SB campaign reports — matches Amazon Ads Console spend" />
          )}
          <KpiCard label="Settlement Blended ROAS" value={roasStr(blendedMetrics.after.blendedRoas)} sub="Net Sales ÷ Ads Spend" subTitle="Settlement Net Sales ÷ Amazon Ads Spend" />
          <KpiCard label="Settlement TACOS" value={pctStr(blendedMetrics.after.tacos)} sub="Ads Spend ÷ Net Sales" subTitle="Amazon Ads Spend ÷ Settlement Net Sales" />
        </div>
      </div>
      {!blendedMetrics.complete && (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          Settlement-based metrics above may be incomplete for the selected range until both Ads and payment-transaction data catch up. See Data Health &amp; Imports for details.
        </p>
      )}

      <BusinessReportVsSettlementCard data={data} />

      {/* Top 3 insights / single-mode daily action summary */}
      {isSingle ? (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-3">Daily Action Summary — Selected Period</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KpiCard label="High Priority" value={findingsTable.filter(f => f.priority === 'High').length.toString()} sub="Findings" />
            <KpiCard label="Waste Spend" value={findingsTable.filter(f => f.issueType === 'Waste spend' || f.issueType === 'Spend with zero ad sales').length.toString()} sub="Candidates" />
            <KpiCard label="Good Working" value={goodWorkingRows.length.toString()} sub="Efficient rows" />
            <KpiCard label="Total Findings" value={findingsTable.length.toString()} sub="All priorities" />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link href="/dashboard/internal/easyhome-diagnostic?view=findings" className="text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">See Findings →</Link>
            <Link href="/dashboard/internal/easyhome-diagnostic?view=good-working" className="text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">See Good Working →</Link>
            <Link href="/dashboard/internal/easyhome-diagnostic?view=actions" className="text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">Actions tab →</Link>
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-3">Top insights</h2>
          {primaryInsights.length === 0 ? (
            <p className="text-sm text-muted-foreground">No compare-mode insights for this selection — switch to Compare mode, or see Trends &amp; Charts / Category Performance for more detail.</p>
          ) : (
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {primaryInsights.slice(0, 3).map((note, i) => (
                <li key={i} className="flex gap-2">
                  <span>•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Top 5 actions / findings preview */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-foreground">{isSingle ? 'Top findings (selected period)' : 'Top actions'}</h2>
          <Link href={`/dashboard/internal/easyhome-diagnostic?view=${isSingle ? 'findings' : 'actions'}`} className="text-xs text-primary underline hover:no-underline">
            {isSingle ? 'See all findings →' : 'See all actions →'}
          </Link>
        </div>
        {topActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isSingle
              ? 'No findings for this selected period under current thresholds. Try a longer range or check data freshness.'
              : 'No open action queue items for this selection.'}
          </p>
        ) : (
          <ul className="space-y-2 text-sm text-foreground">
            {topActions.map(item => (
              <li key={item.actionKey} className="flex items-center justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0">
                <span className="truncate">{item.entityName} <span className="text-xs text-muted-foreground">({item.portfolio})</span></span>
                <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">{item.priority}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Links to deeper sections */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          { href: 'good-working', label: 'Good Working' },
          { href: 'findings', label: 'Findings' },
          { href: 'trends', label: 'Trends & Charts' },
          { href: 'category', label: 'Category Performance' },
          { href: 'data-health', label: 'Data Health & Imports' },
          { href: 'change-history', label: 'Change History' },
          { href: 'settings', label: 'Settings / Mapping' },
        ].map(link => (
          <Link
            key={link.href}
            href={`/dashboard/internal/easyhome-diagnostic?view=${link.href}`}
            className="text-center text-xs font-medium text-primary border border-border rounded-md px-3 py-2 hover:bg-muted"
          >
            {link.label} →
          </Link>
        ))}
      </div>
    </div>
  )
}
