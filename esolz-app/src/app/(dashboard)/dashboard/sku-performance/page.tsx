'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, PackageSearch, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SkuPerformanceRow, SkuPerformanceSummaryResult } from '@/lib/sku-performance/types'
import {
  BASIC_FILTERS, SORT_OPTIONS, buildSummaryQueryString, defaultQueryState,
  deriveViewState, paginationLabel,
} from './query'
import type { BasicFilterKey, SkuPerformanceQueryState } from './query'
import { formatMoney, formatCount, formatRatio } from './format'
import { FreshnessStrip } from './freshness-strip'
import { SkuTable } from './sku-table'
import { IdentityConflictSheet } from './identity-conflict-sheet'

interface ApiErrorBody {
  error?: string
  reason?: string
}

export default function SkuPerformancePage() {
  const [queryState, setQueryState] = useState<SkuPerformanceQueryState>(() => defaultQueryState())
  const [searchDraft, setSearchDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SkuPerformanceSummaryResult | null>(null)
  const [conflictRow, setConflictRow] = useState<SkuPerformanceRow | null>(null)

  const queryString = useMemo(() => buildSummaryQueryString(queryState), [queryState])

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sku-performance/summary?${queryString}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        let message = `SKU Performance API failed (status ${res.status}).`
        try {
          const body = await res.json() as ApiErrorBody
          message = body.reason || body.error || message
        } catch {
          // Keep the generic status-based message if the body isn't JSON.
        }
        setResult(null)
        setError(message)
        return
      }
      const body = await res.json() as SkuPerformanceSummaryResult
      setResult(body)
    } catch {
      setResult(null)
      setError('Network error while loading SKU Performance data.')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const view = deriveViewState({ loading, error, result })

  function updateRange(patch: Partial<Pick<SkuPerformanceQueryState, 'dateFrom' | 'dateTo'>>) {
    setQueryState(current => {
      const next = { ...current, ...patch, offset: 0 }
      next.asOf = next.dateTo
      return next
    })
  }

  function applySearch() {
    setQueryState(current => ({ ...current, search: searchDraft, offset: 0 }))
  }

  function toggleFilter(key: BasicFilterKey) {
    setQueryState(current => ({
      ...current,
      offset: 0,
      filters: { ...current.filters, [key]: !current.filters[key] },
    }))
  }

  function changeSort(sort: SkuPerformanceQueryState['sort']) {
    setQueryState(current => ({ ...current, sort, offset: 0 }))
  }

  function goToPage(direction: 'prev' | 'next') {
    setQueryState(current => ({
      ...current,
      offset: direction === 'prev' ? Math.max(0, current.offset - current.limit) : current.offset + current.limit,
    }))
  }

  const summary = view.kind === 'ready' ? view.result.summary : null
  const currencyCode = view.kind === 'ready' ? view.result.currencyCode : null

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">SKU Performance</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Daily Sales &amp; Ad Spend Trends</p>
      </div>

      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="dateFrom">From</Label>
              <Input
                id="dateFrom"
                type="date"
                value={queryState.dateFrom}
                max={queryState.dateTo}
                onChange={event => updateRange({ dateFrom: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dateTo">To</Label>
              <Input
                id="dateTo"
                type="date"
                value={queryState.dateTo}
                min={queryState.dateFrom}
                onChange={event => updateRange({ dateTo: event.target.value })}
              />
            </div>
            <div className="space-y-1.5 xl:col-span-2">
              <Label htmlFor="skuSearch">Search SKU / ASIN</Label>
              <div className="flex gap-2">
                <Input
                  id="skuSearch"
                  value={searchDraft}
                  onChange={event => setSearchDraft(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && applySearch()}
                  placeholder="SKU or ASIN"
                />
                <Button type="button" variant="outline" onClick={applySearch} disabled={loading}>
                  <Search className="size-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sort">Sort</Label>
              <select
                id="sort"
                className="border-input bg-background ring-offset-background flex h-8 w-full rounded-lg border px-2.5 py-1 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                value={queryState.sort}
                onChange={event => changeSort(event.target.value as SkuPerformanceQueryState['sort'])}
              >
                {SORT_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
            {BASIC_FILTERS.map(({ key, label }) => (
              <Button
                key={key}
                type="button"
                variant={queryState.filters[key] ? 'default' : 'outline'}
                size="sm"
                onClick={() => toggleFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {view.kind === 'ready' && summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard label="Ordered sales" value={formatMoney(summary.totalOrderedSales, currencyCode)} />
          <SummaryCard label="Units" value={formatCount(summary.totalUnits)} />
          <SummaryCard label="Ad spend" value={formatMoney(summary.totalAdSpend, currencyCode)} />
          <SummaryCard label="Ad-attributed sales" value={formatMoney(summary.totalAttributedSales, currencyCode)} />
          <SummaryCard label="ACOS" value={formatRatio(summary.acos).text} />
          <SummaryCard label="TACOS" value={formatRatio(summary.tacos).text} />
          <SummaryCard label="SKUs growing" value={formatCount(summary.skusGrowing)} />
          <SummaryCard label="SKUs declining" value={formatCount(summary.skusDeclining)} />
        </div>
      )}

      {view.kind === 'ready' && (
        <FreshnessStrip summary={view.result.summary} dateRange={view.result.dateRange} />
      )}

      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent className="px-0">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 pb-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">SKUs</h2>
              <p className="mt-1 text-xs text-muted-foreground">One row per canonical SKU for the selected date range.</p>
            </div>
            {view.kind === 'ready' && (
              <p className="text-xs text-muted-foreground">{paginationLabel(view.result.pagination)}</p>
            )}
          </div>

          {view.kind === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-16">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading SKU Performance...</span>
            </div>
          )}

          {view.kind === 'error' && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <AlertCircle className="size-8 text-destructive/60" />
              <p className="text-sm font-medium text-foreground">Could not load SKU Performance</p>
              <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
              <Button type="button" variant="outline" onClick={() => void loadRows()}>Retry</Button>
            </div>
          )}

          {view.kind === 'unknown' && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <AlertCircle className="size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">Data status unknown</p>
              <p className="max-w-sm text-xs text-muted-foreground">The server did not return a recognized response. Try refreshing.</p>
              <Button type="button" variant="outline" onClick={() => void loadRows()}>Retry</Button>
            </div>
          )}

          {view.kind === 'empty' && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <PackageSearch className="size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No SKUs match the current filters</p>
              <p className="max-w-sm text-xs text-muted-foreground">Adjust the date range, search, or filters to see results.</p>
            </div>
          )}

          {view.kind === 'ready' && (
            <SkuTable rows={view.result.rows} currencyCode={view.result.currencyCode} onExplainConflict={setConflictRow} />
          )}

          {view.kind === 'ready' && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-5 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => goToPage('prev')}
                disabled={loading || queryState.offset === 0}
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">{paginationLabel(view.result.pagination)}</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => goToPage('next')}
                disabled={loading || !view.result.pagination.hasMore}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <IdentityConflictSheet row={conflictRow} onClose={() => setConflictRow(null)} />
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="rounded-lg border-border/70 shadow-none">
      <CardContent>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-2 text-base font-semibold text-foreground">{value}</p>
      </CardContent>
    </Card>
  )
}
