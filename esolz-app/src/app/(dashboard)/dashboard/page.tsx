'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Loader2, Lock, PackageSearch, ServerCrash,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { SkuPerformanceSummaryResult } from '@/lib/sku-performance/types'
import { FreshnessStrip } from './sku-performance/freshness-strip'
import { formatMoney, formatCount, formatDate, formatRatio } from './sku-performance/format'
import {
  buildSingleDayQueryString, buildTodaySummaryQueryString, prior7DayRange,
  previousCompleteDate, calendarYesterday, deriveTodayViewState, buildTodayCards, buildAttentionSections,
  hasAnyAttentionItems, buildSkuPerformanceDeepLink,
  type TodayCards, type TodayAttentionSections, type AttentionRow,
} from './today-query'

export const dynamic = 'force-dynamic'

interface ApiErrorBody { error?: string; reason?: string }

interface FetchState<T> { loading: boolean; status: number | null; error: string | null; result: T | null }
const INITIAL: FetchState<SkuPerformanceSummaryResult> = { loading: true, status: null, error: null, result: null }

type SuccessResult = Extract<SkuPerformanceSummaryResult, { result: 'success' }>

async function fetchSummary(qs: string): Promise<FetchState<SkuPerformanceSummaryResult>> {
  try {
    const res = await fetch(`/api/sku-performance/summary?${qs}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let message = `SKU Performance API failed (status ${res.status}).`
      try {
        const body = await res.json() as ApiErrorBody
        message = body.reason || body.error || message
      } catch { /* keep generic message */ }
      return { loading: false, status: res.status, error: message, result: null }
    }
    const body = await res.json() as SkuPerformanceSummaryResult
    return { loading: false, status: res.status, error: null, result: body }
  } catch {
    return { loading: false, status: null, error: 'Network error while loading today’s performance data.', result: null }
  }
}

export default function DashboardTodayPage() {
  const router = useRouter()
  const [latestDay, setLatestDay] = useState(INITIAL)
  const [previousDay, setPreviousDay] = useState(INITIAL)
  const [prior7, setPrior7] = useState(INITIAL)

  const load = useCallback(async () => {
    setLatestDay(s => ({ ...s, loading: true, error: null }))

    const candidateDate = calendarYesterday()
    const probeResult = await fetchSummary(buildSingleDayQueryString(candidateDate))

    const probeView = deriveTodayViewState({ ...probeResult, now: new Date() })
    if (probeView.kind !== 'ready') {
      // Reflect the same terminal state on latestDay so the page's single
      // view derivation (below) has one source of truth to read.
      setLatestDay(probeResult)
      setPreviousDay({ loading: false, status: null, error: null, result: null })
      setPrior7({ loading: false, status: null, error: null, result: null })
      return
    }

    const { latestCompleteDate } = probeView
    const latestDayResult = latestCompleteDate === candidateDate
      ? probeResult
      : await fetchSummary(buildSingleDayQueryString(latestCompleteDate))
    setLatestDay(latestDayResult)

    const { dateFrom: p7From, dateTo: p7To } = prior7DayRange(latestCompleteDate)
    const [previousDayResult, prior7Result] = await Promise.all([
      fetchSummary(buildSingleDayQueryString(previousCompleteDate(latestCompleteDate))),
      fetchSummary(buildTodaySummaryQueryString({ dateFrom: p7From, dateTo: p7To })),
    ])
    setPreviousDay(previousDayResult)
    setPrior7(prior7Result)
  }, [])

  useEffect(() => { void load() }, [load])

  const view = useMemo(() => deriveTodayViewState({ ...latestDay, now: new Date() }), [latestDay])

  const latestDaySuccess = latestDay.result?.result === 'success' ? latestDay.result as SuccessResult : null
  const previousDaySuccess = previousDay.result?.result === 'success' ? previousDay.result as SuccessResult : null
  const prior7Success = prior7.result?.result === 'success' ? prior7.result as SuccessResult : null

  const cards: TodayCards | null = useMemo(() => {
    if (view.kind !== 'ready' || !latestDaySuccess || !previousDaySuccess || !prior7Success) return null
    return buildTodayCards(latestDaySuccess.summary, previousDaySuccess.summary, prior7Success.summary)
  }, [view.kind, latestDaySuccess, previousDaySuccess, prior7Success])

  const attention: TodayAttentionSections | null = useMemo(() => {
    if (view.kind !== 'ready' || !latestDaySuccess) return null
    return buildAttentionSections(latestDaySuccess.rows)
  }, [view.kind, latestDaySuccess])

  function goToSku(sku: string) {
    if (view.kind !== 'ready') return
    router.push(buildSkuPerformanceDeepLink({ sku, latestCompleteDate: view.latestCompleteDate }))
  }

  const showComparisonUnavailable = view.kind === 'ready' && (!previousDaySuccess || !prior7Success) && !(previousDay.loading || prior7.loading)

  return (
    <div className="flex flex-col gap-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Today</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Your latest complete Amazon sales and advertising performance</p>
        {view.kind === 'ready' && (
          <p className="mt-2 text-sm">
            Latest complete day: <span className="font-medium text-foreground">{formatDate(view.latestCompleteDate)}</span>
          </p>
        )}
      </div>

      {latestDaySuccess && (
        <FreshnessStrip summary={latestDaySuccess.summary} dateRange={latestDaySuccess.dateRange} />
      )}

      {view.kind === 'ready' && view.stale && (
        <StatusBanner tone="warning" text={`Data is more than 2 days behind — the latest complete day (${formatDate(view.latestCompleteDate)}) is older than expected. Check source health above.`} />
      )}

      {showComparisonUnavailable && (
        <StatusBanner tone="warning" text="Could not load the previous-day or prior-7-day comparison — cards below show the latest complete day only." />
      )}

      {view.kind === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-16">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading today&apos;s performance…</span>
        </div>
      )}

      {view.kind === 'unauthorized' && (
        <StateBlock icon={<Lock className="size-8 text-muted-foreground/40" />} title="Not authorized" detail="Your account does not have internal access to this page." />
      )}

      {view.kind === 'unavailable' && (
        <StateBlock
          icon={<ServerCrash className="size-8 text-muted-foreground/40" />}
          title="Today is not available right now"
          detail="The server could not complete this request. Try again shortly."
          onRetry={() => void load()}
        />
      )}

      {view.kind === 'error' && (
        <StateBlock icon={<AlertCircle className="size-8 text-destructive/60" />} title="Could not load today's performance" detail={view.message} onRetry={() => void load()} />
      )}

      {view.kind === 'incomplete_common_range' && (
        <StateBlock
          icon={<AlertCircle className="size-8 text-amber-500" />}
          title="No comparable complete day yet"
          detail="Sales and Ads don't both have an accepted-complete date yet, so a combined view can't be shown honestly."
        />
      )}

      {view.kind === 'empty' && (
        <StateBlock icon={<PackageSearch className="size-8 text-muted-foreground/40" />} title="No SKUs found" detail="No sales or ads data exists for this workspace yet." />
      )}

      {view.kind === 'ready' && cards && (
        <SummaryCards cards={cards} currencyCode={latestDaySuccess!.currencyCode} />
      )}

      {view.kind === 'ready' && attention && (
        <AttentionSectionsBlock sections={attention} currencyCode={latestDaySuccess!.currencyCode} onRowClick={goToSku} />
      )}
    </div>
  )
}

function StatusBanner({ tone, text }: { tone: 'warning' | 'info'; text: string }) {
  const cls = tone === 'warning'
    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400'
    : 'border-border bg-muted/30 text-muted-foreground'
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${cls}`}>
      <AlertCircle className="size-4 shrink-0" />
      {text}
    </div>
  )
}

function StateBlock({ icon, title, detail, onRetry }: { icon: React.ReactNode; title: string; detail: string; onRetry?: () => void }) {
  return (
    <Card className="rounded-lg border-border/70 shadow-none">
      <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        {icon}
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
        {onRetry && <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------ summary cards ---

function SummaryCards({ cards, currencyCode }: { cards: TodayCards; currencyCode: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.raw.map(m => (
        <Card key={m.key} className="rounded-lg border-border/70 shadow-none">
          <CardContent className="flex flex-col gap-2 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.label}</p>
            <p className="text-xl font-semibold text-foreground">
              {m.key === 'units' ? formatCount(m.latestDay) : formatMoney(m.latestDay, currencyCode)}
            </p>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <ChangeLine label="vs previous day" value={m.previousDay} changePct={m.changeVsPreviousDayPct} isCount={m.key === 'units'} currencyCode={currencyCode} />
              <ChangeLine label="vs 7-day avg" value={m.prior7DayAvg} changePct={m.changeVsPrior7AvgPct} isCount={m.key === 'units'} currencyCode={currencyCode} />
            </div>
          </CardContent>
        </Card>
      ))}
      {cards.ratio.map(m => {
        const latest = formatRatio(m.latestDay)
        const previous = formatRatio(m.previousDay)
        const prior7Avg = formatRatio(m.prior7DayAvg)
        return (
          <Card key={m.key} className="rounded-lg border-border/70 shadow-none">
            <CardContent className="flex flex-col gap-2 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.label}</p>
              <p className="text-xl font-semibold text-foreground">{latest.text}</p>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>Previous day: <span className="font-medium text-foreground">{previous.text}</span></span>
                <span>7-day avg: <span className="font-medium text-foreground">{prior7Avg.text}</span></span>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function ChangeLine({ label, value, changePct, isCount, currencyCode }: {
  label: string
  value: number
  changePct: number | null
  isCount: boolean
  currencyCode: string | null
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}:</span>
      <span className="font-medium text-foreground">{isCount ? formatCount(Math.round(value)) : formatMoney(value, currencyCode)}</span>
      <PercentBadge pct={changePct} />
    </span>
  )
}

function PercentBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">(n/a)</span>
  const rounded = Math.round(pct)
  if (rounded === 0) return <span className="text-muted-foreground">(no change)</span>
  const positive = rounded > 0
  return (
    <span className={`inline-flex items-center gap-0.5 ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {positive ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
      {Math.abs(rounded)}%
    </span>
  )
}

// -------------------------------------------------------- attention sections ---

function AttentionSectionsBlock({ sections, currencyCode, onRowClick }: {
  sections: TodayAttentionSections
  currencyCode: string | null
  onRowClick: (sku: string) => void
}) {
  if (!hasAnyAttentionItems(sections)) {
    return (
      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <p className="text-sm font-medium text-foreground">Nothing needs attention on the latest complete day</p>
          <p className="text-xs text-muted-foreground">No sales declines, spend-without-sales, or notable growth to review.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <AttentionTable title="Biggest sales declines" rows={sections.salesDeclines} currencyCode={currencyCode} onRowClick={onRowClick} emptyText="No SKUs declined versus their 7-day average." />
      <AttentionTable title="Biggest sales growth" rows={sections.salesGrowth} currencyCode={currencyCode} onRowClick={onRowClick} emptyText="No SKUs grew versus their 7-day average." />
      <AttentionTable title="Ad spend up, sales flat or down" rows={sections.spendUpSalesFlat} currencyCode={currencyCode} onRowClick={onRowClick} emptyText="No SKUs with rising spend and flat/falling sales." />
      <AttentionTable title="High spend, zero attributed sales" rows={sections.highSpendZeroSales} currencyCode={currencyCode} onRowClick={onRowClick} emptyText="No SKUs spending with zero attributed sales." />
    </div>
  )
}

function AttentionTable({ title, rows, currencyCode, onRowClick, emptyText }: {
  title: string
  rows: AttentionRow[]
  currencyCode: string | null
  onRowClick: (sku: string) => void
  emptyText: string
}) {
  return (
    <Card className="rounded-lg border-border/70 shadow-none">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <CardContent className="px-0 py-0">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map(row => (
              <button
                key={row.sku}
                type="button"
                onClick={() => onRowClick(row.sku)}
                className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{row.productTitle ?? 'Unknown product'}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.sku}{row.asin ? ` · ${row.asin}` : ''}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium text-foreground">{formatMoney(row.orderedSales, currencyCode)}</p>
                    <p className="text-[11px] text-muted-foreground">{formatCount(row.units)} units</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>Spend {formatMoney(row.adSpend, currencyCode)}</span>
                  <span>Attributed sales {formatMoney(row.adAttributedSales, currencyCode)}</span>
                  <span>TACOS {formatRatio(row.tacos).text}</span>
                </div>
                <p className="text-xs text-muted-foreground">{row.reason}</p>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
