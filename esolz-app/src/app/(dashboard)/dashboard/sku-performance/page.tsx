'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, ChevronDown, ChevronRight, Loader2, Lock, PackageSearch, Search, ServerCrash,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SkuPerformanceDailyResult, SkuPerformanceRow, SkuPerformanceSummaryResult } from '@/lib/sku-performance/types'
import {
  buildDailyQueryString, buildSummaryQueryString, clampRangeToMaxDays, defaultDateRange,
  deriveChartViewState, derivePageViewState, filterRowsByTitle,
} from './query'
import {
  dataStatus, formatCount, formatMoney, formatRatio, salesTrendLabel, spendTrendLabel, toneBadgeClassName,
} from './format'
import { FreshnessStrip } from './freshness-strip'
import { DailyChart } from './daily-chart'
import { IdentityConflictNotice } from './identity-conflict-notice'

interface ApiErrorBody {
  error?: string
  reason?: string
}

interface FetchState<T> {
  loading: boolean
  status: number | null
  error: string | null
  result: T | null
}

const INITIAL_SUMMARY_STATE: FetchState<SkuPerformanceSummaryResult> = { loading: true, status: null, error: null, result: null }
const INITIAL_DAILY_STATE: FetchState<SkuPerformanceDailyResult> = { loading: false, status: null, error: null, result: null }

export default function SkuDailyTrendsPage() {
  const [{ dateFrom: defaultFrom, dateTo: defaultTo }] = useState(() => defaultDateRange())
  const [dateFrom, setDateFrom] = useState(defaultFrom)
  const [dateTo, setDateTo] = useState(defaultTo)
  const [search, setSearch] = useState('')
  const [summary, setSummary] = useState(INITIAL_SUMMARY_STATE)
  const [selectedSku, setSelectedSku] = useState<string | null>(null)
  const [daily, setDaily] = useState(INITIAL_DAILY_STATE)

  const summaryQueryString = useMemo(() => buildSummaryQueryString({ dateFrom, dateTo }), [dateFrom, dateTo])

  const loadSummary = useCallback(async () => {
    setSummary(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch(`/api/sku-performance/summary?${summaryQueryString}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        let message = `SKU Performance API failed (status ${res.status}).`
        try {
          const body = await res.json() as ApiErrorBody
          message = body.reason || body.error || message
        } catch {
          // Keep the generic status-based message if the body isn't JSON.
        }
        setSummary({ loading: false, status: res.status, error: message, result: null })
        return
      }
      const body = await res.json() as SkuPerformanceSummaryResult
      setSummary({ loading: false, status: res.status, error: null, result: body })
    } catch {
      setSummary({ loading: false, status: null, error: 'Network error while loading SKU Performance data.', result: null })
    }
  }, [summaryQueryString])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  const loadDaily = useCallback(async (sku: string) => {
    setDaily({ loading: true, status: null, error: null, result: null })
    try {
      const qs = buildDailyQueryString({ dateFrom, dateTo })
      const res = await fetch(`/api/sku-performance/${encodeURIComponent(sku)}/daily?${qs}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        let message = `Daily trend API failed (status ${res.status}).`
        try {
          const body = await res.json() as ApiErrorBody
          message = body.reason || body.error || message
        } catch {
          // Keep the generic status-based message if the body isn't JSON.
        }
        setDaily({ loading: false, status: res.status, error: message, result: null })
        return
      }
      const body = await res.json() as SkuPerformanceDailyResult
      setDaily({ loading: false, status: res.status, error: null, result: body })
    } catch {
      setDaily({ loading: false, status: null, error: 'Network error while loading the daily trend.', result: null })
    }
  }, [dateFrom, dateTo])

  function toggleRow(row: SkuPerformanceRow) {
    if (selectedSku === row.sku) {
      setSelectedSku(null)
      setDaily(INITIAL_DAILY_STATE)
      return
    }
    setSelectedSku(row.sku)
    // An identity-conflict row's evidence is already in hand from the
    // summary response -- no need to round-trip the daily RPC just to have
    // it echo the same identity_conflict short-circuit back.
    if (row.mappingState !== 'identity_conflict') {
      void loadDaily(row.sku)
    } else {
      setDaily(INITIAL_DAILY_STATE)
    }
  }

  function updateRange(patch: Partial<{ dateFrom: string; dateTo: string }>) {
    let nextFrom = patch.dateFrom ?? dateFrom
    const nextTo = patch.dateTo ?? dateTo
    nextFrom = clampRangeToMaxDays(nextFrom, nextTo)
    setDateFrom(nextFrom)
    setDateTo(nextTo)
    setSelectedSku(null)
    setDaily(INITIAL_DAILY_STATE)
  }

  const view = derivePageViewState(summary)
  const visibleRows = view.kind === 'ready' || view.kind === 'no_comparable_data'
    ? filterRowsByTitle(view.result.rows, search)
    : []

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">SKU Performance</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Daily SKU/ASIN-wise sales, units and advertising-spend trends</p>
      </div>

      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="dateFrom">From</Label>
              <Input id="dateFrom" type="date" value={dateFrom} max={dateTo} onChange={e => updateRange({ dateFrom: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dateTo">To</Label>
              <Input id="dateTo" type="date" value={dateTo} min={dateFrom} onChange={e => updateRange({ dateTo: e.target.value })} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="search">Search SKU / ASIN / product title</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input id="search" className="pl-7" value={search} onChange={e => setSearch(e.target.value)} placeholder="Type to filter the loaded rows" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {(view.kind === 'ready' || view.kind === 'no_comparable_data') && (
        <FreshnessStrip summary={view.result.summary} dateRange={view.result.dateRange} />
      )}

      {view.kind === 'no_comparable_data' && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          <AlertCircle className="size-4 shrink-0" />
          No comparable history overlap between Sales and Ads for this scope — combined ACOS/TACOS cannot be computed for any row below.
        </div>
      )}

      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent className="px-0">
          {view.kind === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-16">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading SKU Performance…</span>
            </div>
          )}

          {view.kind === 'unauthorized' && (
            <StateBlock icon={<Lock className="size-8 text-muted-foreground/40" />} title="Not authorized" detail="Your account does not have internal access to this page." />
          )}

          {view.kind === 'unavailable' && (
            <StateBlock
              icon={<ServerCrash className="size-8 text-muted-foreground/40" />}
              title="SKU Performance is not available right now"
              detail="The server could not complete this request — most likely the underlying database migration has not been applied to this environment yet."
              onRetry={() => void loadSummary()}
            />
          )}

          {view.kind === 'error' && (
            <StateBlock icon={<AlertCircle className="size-8 text-destructive/60" />} title="Could not load SKU Performance" detail={view.message} onRetry={() => void loadSummary()} />
          )}

          {view.kind === 'empty' && (
            <StateBlock icon={<PackageSearch className="size-8 text-muted-foreground/40" />} title="No SKUs found for this date range" detail="Try widening the date range." />
          )}

          {(view.kind === 'ready' || view.kind === 'no_comparable_data') && visibleRows.length === 0 && (
            <StateBlock icon={<PackageSearch className="size-8 text-muted-foreground/40" />} title="No SKUs match your search" detail="Clear the search box to see every SKU in this range." />
          )}

          {(view.kind === 'ready' || view.kind === 'no_comparable_data') && visibleRows.length > 0 && (
            <SkuTable
              rows={visibleRows}
              currencyCode={view.result.currencyCode}
              selectedSku={selectedSku}
              onToggleRow={toggleRow}
              daily={daily}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StateBlock({ icon, title, detail, onRetry }: { icon: React.ReactNode; title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
      {onRetry && <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

function SkuTable({ rows, currencyCode, selectedSku, onToggleRow, daily }: {
  rows: SkuPerformanceRow[]
  currencyCode: string | null
  selectedSku: string | null
  onToggleRow: (row: SkuPerformanceRow) => void
  daily: FetchState<SkuPerformanceDailyResult>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px] text-left">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="w-8 px-2 py-3" />
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Product</th>
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">SKU</th>
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">ASIN</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Sales</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Units</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Spend</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Attributed sales</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">ACOS</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">TACOS</th>
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Sales trend</th>
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Spend trend</th>
            <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Data status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <SkuRowGroup
              key={row.sku}
              row={row}
              currencyCode={currencyCode}
              expanded={selectedSku === row.sku}
              onToggle={() => onToggleRow(row)}
              daily={selectedSku === row.sku ? daily : null}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SkuRowGroup({ row, currencyCode, expanded, onToggle, daily }: {
  row: SkuPerformanceRow
  currencyCode: string | null
  expanded: boolean
  onToggle: () => void
  daily: FetchState<SkuPerformanceDailyResult> | null
}) {
  const window = row.selectedRange
  const status = dataStatus(row)

  return (
    <>
      <tr className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/20" onClick={onToggle}>
        <td className="px-2 py-3 align-top text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </td>
        <td className="max-w-[220px] px-4 py-3 align-top">
          <p className="line-clamp-2 text-sm font-medium text-foreground">{row.productTitle ?? 'Unknown'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{row.brand ?? 'Unknown brand'}</p>
        </td>
        <td className="px-4 py-3 align-top font-mono text-xs text-foreground">{row.sku}</td>
        <td className="px-4 py-3 align-top font-mono text-xs text-foreground">{row.asin ?? 'Unknown'}</td>

        {window ? (
          <>
            <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.sales, currencyCode)}</td>
            <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatCount(window.units)}</td>
            <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.spend, currencyCode)}</td>
            <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.attributedSales, currencyCode)}</td>
            <RatioCell tone={formatRatio(window.acos).tone} text={formatRatio(window.acos).text} />
            <RatioCell tone={formatRatio(window.tacos).tone} text={formatRatio(window.tacos).text} />
          </>
        ) : (
          <td colSpan={6} className="px-4 py-3 text-center align-top text-xs text-muted-foreground">No combined metrics — identity conflict</td>
        )}

        <td className="px-4 py-3 align-top text-sm text-foreground">{salesTrendLabel(row.salesTrend)}</td>
        <td className="px-4 py-3 align-top text-sm text-foreground">{spendTrendLabel(row.spendTrend)}</td>
        <td className="px-4 py-3 align-top">
          <Badge variant="outline" className={toneBadgeClassName(status.tone)}>{status.label}</Badge>
          {status.detail && <p className="mt-1 text-[11px] text-muted-foreground">{status.detail}</p>}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/10">
          <td colSpan={12} className="px-6 py-4">
            <ExpandedDaily row={row} currencyCode={currencyCode} daily={daily} />
          </td>
        </tr>
      )}
    </>
  )
}

function RatioCell({ text, tone }: { text: string; tone: 'neutral' | 'positive' | 'warning' | 'danger' | 'muted' }) {
  const toneClass = tone === 'danger' ? 'text-red-700 dark:text-red-400' : tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'
  return <td className="px-4 py-3 text-right align-top text-sm"><span className={toneClass}>{text}</span></td>
}

function ExpandedDaily({ row, currencyCode, daily }: {
  row: SkuPerformanceRow
  currencyCode: string | null
  daily: FetchState<SkuPerformanceDailyResult> | null
}) {
  if (row.mappingState === 'identity_conflict') {
    return row.identityConflictEvidence
      ? <IdentityConflictNotice evidence={row.identityConflictEvidence} />
      : <p className="text-xs text-muted-foreground">Identity conflict — evidence unavailable.</p>
  }

  const state = deriveChartViewState({
    loading: daily?.loading ?? true,
    status: daily?.status ?? null,
    error: daily?.error ?? null,
    result: daily?.result ?? null,
  })

  if (state.kind === 'loading') {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading daily trend…</div>
  }
  if (state.kind === 'unauthorized') {
    return <p className="text-sm text-muted-foreground">Not authorized to load this SKU&apos;s daily trend.</p>
  }
  if (state.kind === 'unavailable') {
    return <p className="text-sm text-muted-foreground">Daily trend is not available right now.</p>
  }
  if (state.kind === 'error') {
    return <p className="text-sm text-destructive">{state.message}</p>
  }
  if (state.kind === 'identity_conflict') {
    return <IdentityConflictNotice evidence={state.result.evidence} />
  }
  if (state.kind === 'no_comparable_data') {
    return <p className="text-sm text-muted-foreground">No comparable sales or spend data for this SKU in this date range.</p>
  }
  return <DailyChart days={state.days} currencyCode={currencyCode} />
}
