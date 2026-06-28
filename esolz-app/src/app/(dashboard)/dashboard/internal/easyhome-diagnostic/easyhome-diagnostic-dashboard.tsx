'use client'

// Phase R5: this file is now a thin data/state orchestrator. All calculation
// logic, API shape, and per-section JSX live unchanged in brahmastra-shared.tsx
// and the BrahmastraXxxSection components — this file only fetches, tracks
// draft/loaded/pending range state, and routes between sections via ?view=.
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import type { ActionStatus } from '@/lib/internal/easyhome-action-queue'
import type { CaseReviewStatus } from '@/lib/internal/easyhome-manual-review-cases'
import { usesJune15 } from '@/lib/internal/date-range'
import { BrahmastraControlPanel, type ControlPanelQuery } from './brahmastra-control-panel'
import { toFindingsCsv, toGoodWorkingCsv } from './findings-actions-table'
import { type ApiResponse, DEFAULT_QUERY, buildQueryString, queriesEqual } from './brahmastra-shared'
import { BrahmastraSectionNav, isBrahmastraView, type BrahmastraView } from './brahmastra-section-nav'
import { LoadedAnalysisSummaryBar } from './loaded-analysis-summary-bar'
import { BrahmastraOverviewSection } from './brahmastra-overview-section'
import { BrahmastraActionsSection } from './brahmastra-actions-section'
import { BrahmastraGoodWorkingSection } from './brahmastra-good-working-section'
import { BrahmastraFindingsSection } from './brahmastra-findings-section'
import { BrahmastraTrendsSection } from './brahmastra-trends-section'
import { BrahmastraCategorySection } from './brahmastra-category-section'
import { BrahmastraDataHealthSection } from './brahmastra-data-health-section'
import { BrahmastraChangeHistorySection } from './brahmastra-change-history-section'
import { BrahmastraSettingsMappingSection } from './brahmastra-settings-mapping-section'
import type { ExecutionSheetUpdate } from './manual-review-execution-sheet'

function EasyhomeDiagnosticDashboardInner() {
  const searchParams = useSearchParams()
  const view: BrahmastraView = isBrahmastraView(searchParams.get('view')) ? (searchParams.get('view') as BrahmastraView) : 'overview'

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

  // Switching tabs must always land the user at the top of the new section's
  // content — without this, the browser keeps whatever scroll position the
  // previous (often much longer) tab was at, so e.g. opening Trends can land
  // mid-page instead of at the Trends heading. Query-param navigation does
  // not reset scroll on its own since the route never unmounts.
  useEffect(() => {
    // The dashboard shell scrolls inside <main>, not the window itself —
    // scroll both so this works regardless of which element actually owns
    // the scrollbar.
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [view])

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

  const { controlPanel, findingsTable, goodWorkingRows, campaignDiagnostic, diagnostic, meta } = data
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
    a.download = `brahmastra_findings_actions_${loadedRangeSuffix}.csv`
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

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
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

      <BrahmastraSectionNav active={view} />

      {view === 'overview' ? (
        <BrahmastraOverviewSection
          data={data}
          portfolioOptions={portfolioOptions}
          campaignOptions={campaignOptions}
          onRun={q => setQuery(q)}
          onDraftChange={setDraftQuery}
          isDirty={pendingChanges}
          onExportAll={handleExportAll}
          loading={loading}
          loadedQuery={loadedQuery}
          loadedAt={loadedAt}
        />
      ) : (
        <>
          <LoadedAnalysisSummaryBar controlPanel={controlPanel} loadedQuery={loadedQuery} pendingChanges={pendingChanges} />
          {view === 'actions' && (
            <BrahmastraActionsSection
              data={data}
              onActionStatusChange={handleActionStatusChange}
              onCaseUpdate={handleCaseUpdate}
              onExecutionSheetUpdate={handleExecutionSheetUpdate}
            />
          )}
          {view === 'good-working' && <BrahmastraGoodWorkingSection data={data} loadedRangeSuffix={loadedRangeSuffix} />}
          {view === 'findings' && <BrahmastraFindingsSection data={data} loadedRangeSuffix={loadedRangeSuffix} />}
          {view === 'trends' && <BrahmastraTrendsSection data={data} />}
          {view === 'category' && <BrahmastraCategorySection data={data} loadedRangeSuffix={loadedRangeSuffix} />}
          {view === 'data-health' && <BrahmastraDataHealthSection data={data} loadedRangeSuffix={loadedRangeSuffix} />}
          {view === 'change-history' && <BrahmastraChangeHistorySection data={data} />}
          {view === 'settings' && <BrahmastraSettingsMappingSection data={data} loadedRangeSuffix={loadedRangeSuffix} />}
        </>
      )}
    </div>
  )
}

export function EasyhomeDiagnosticDashboard() {
  return (
    <Suspense fallback={(
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading EasyHOME diagnostic…
      </div>
    )}
    >
      <EasyhomeDiagnosticDashboardInner />
    </Suspense>
  )
}
