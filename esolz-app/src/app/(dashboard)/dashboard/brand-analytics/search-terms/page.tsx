'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, ChevronLeft, ChevronRight, Loader2, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SearchTermRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
  clicked_asin: string | null
  clicked_item_name: string | null
  click_share_rank: number | null
  click_share: number | null
  conversion_share: number | null
  report_id: string | null
  report_document_id: string | null
  marketplace_id: string | null
  data_start_time: string | null
  data_end_time: string | null
}

type ApiMeta = {
  latestReportId: string | null
  latestReportDocumentId: string | null
  reportType: string | null
  processingStatus: string | null
  latestStatus: string | null
  dataStartTime: string | null
  dataEndTime: string | null
  reportPeriod: { start: string | null; end: string | null } | null
  completedAt: string | null
  storedRowCount: number | null
  parsedRowCount: number | null
  countSource: 'sync_summary' | 'exact' | 'unavailable'
}

type ApiResponse = {
  page: number
  pageSize: number
  hasMore: boolean
  rowsReturned: number
  rows: SearchTermRow[]
  meta: ApiMeta
}

type Filters = {
  searchTerm: string
  clickedAsin: string
  departmentName: string
  minRank: string
  maxRank: string
}

const DEFAULT_FILTERS: Filters = {
  searchTerm: '',
  clickedAsin: '',
  departmentName: '',
  minRank: '',
  maxRank: '',
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available'
  return new Intl.NumberFormat('en-IN').format(value)
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available'
  const normalized = Math.abs(value) <= 1 ? value * 100 : value
  return `${normalized.toFixed(2)}%`
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date)
}

function compactId(value: string | null | undefined): string {
  if (!value) return 'Not available'
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

export default function BrandAnalyticsSearchTermsPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<SearchTermRow[]>([])
  const [meta, setMeta] = useState<ApiMeta | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [pageSize, setPageSize] = useState(50)
  const [rowsReturned, setRowsReturned] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', '50')
    for (const [key, value] of Object.entries(appliedFilters)) {
      const trimmed = value.trim()
      if (trimmed) params.set(key, trimmed)
    }
    return params.toString()
  }, [appliedFilters, page])

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/brand-analytics/search-terms?${queryString}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })

      if (!res.ok) {
        setRows([])
        setRowsReturned(0)
        setError('Unable to load Brand Analytics rows right now.')
        return
      }

      const body = await res.json() as ApiResponse
      setRows(Array.isArray(body.rows) ? body.rows : [])
      setMeta(body.meta ?? null)
      setHasMore(Boolean(body.hasMore))
      setPageSize(typeof body.pageSize === 'number' ? body.pageSize : 50)
      setRowsReturned(typeof body.rowsReturned === 'number' ? body.rowsReturned : Array.isArray(body.rows) ? body.rows.length : 0)
    } catch {
      setRows([])
      setRowsReturned(0)
      setError('Network error while loading Brand Analytics rows.')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  function applyFilters() {
    setPage(1)
    setAppliedFilters(filters)
  }

  function clearFilters() {
    setFilters(DEFAULT_FILTERS)
    setAppliedFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  const dataPeriod = meta?.dataStartTime || meta?.dataEndTime
    ? `${formatDate(meta?.dataStartTime)} to ${formatDate(meta?.dataEndTime)}`
    : 'Not available'
  const connectionStatus = loading ? 'Loading' : error ? 'Error' : 'Connected'
  const latestStatus = meta?.latestStatus ?? meta?.processingStatus ?? 'Not available'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Brand Analytics — Search Terms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Data connection status: {connectionStatus}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadRows()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-lg">
          <CardContent>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stored Rows</p>
            <p className="mt-2 text-2xl font-black text-foreground">{formatNumber(meta?.storedRowCount)}</p>
            {meta?.countSource && (
              <p className="mt-1 text-[11px] text-muted-foreground">Source: {meta.countSource.replace('_', ' ')}</p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest Status</p>
            <p className="mt-2 text-sm font-semibold text-foreground">{latestStatus}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{compactId(meta?.latestReportDocumentId)}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Data Period</p>
            <p className="mt-2 text-sm font-semibold text-foreground">{dataPeriod}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Page Size</p>
            <p className="mt-2 text-2xl font-black text-foreground">{pageSize}</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="rounded-lg">
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="searchTerm">Search term</Label>
              <Input
                id="searchTerm"
                value={filters.searchTerm}
                onChange={event => setFilters(current => ({ ...current, searchTerm: event.target.value }))}
                placeholder="Contains"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clickedAsin">Clicked ASIN</Label>
              <Input
                id="clickedAsin"
                value={filters.clickedAsin}
                onChange={event => setFilters(current => ({ ...current, clickedAsin: event.target.value }))}
                placeholder="ASIN"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="departmentName">Department</Label>
              <Input
                id="departmentName"
                value={filters.departmentName}
                onChange={event => setFilters(current => ({ ...current, departmentName: event.target.value }))}
                placeholder="Department"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="minRank">Min rank</Label>
                <Input
                  id="minRank"
                  type="number"
                  min="1"
                  value={filters.minRank}
                  onChange={event => setFilters(current => ({ ...current, minRank: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="maxRank">Max rank</Label>
                <Input
                  id="maxRank"
                  type="number"
                  min="1"
                  value={filters.maxRank}
                  onChange={event => setFilters(current => ({ ...current, maxRank: event.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <Button type="button" onClick={applyFilters} disabled={loading}>
                <Search className="size-4" />
                Apply
              </Button>
              <Button type="button" variant="outline" onClick={clearFilters} disabled={loading}>
                Clear
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-lg">
        <CardContent className="px-0">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 pb-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Search Terms</h2>
            </div>
            <p className="text-xs text-muted-foreground">Page {page} - {rowsReturned} rows returned</p>
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-16">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading Search Terms...</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <p className="text-sm font-medium text-foreground">Could not load Search Terms</p>
              <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
              <Button type="button" variant="outline" onClick={() => void loadRows()}>
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <BarChart3 className="size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No rows match these filters</p>
              <p className="max-w-sm text-xs text-muted-foreground">Adjust the filters or clear them to browse the latest synced report.</p>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] text-left">
                <thead>
                  <tr className="border-b border-border bg-border/20">
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Search Term</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Search Frequency Rank</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Department</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Clicked ASIN</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Clicked Item Name</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Click Share Rank</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Click Share</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Conversion Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={`${row.report_document_id ?? 'doc'}-${row.search_frequency_rank ?? index}-${row.click_share_rank ?? index}-${index}`}
                      className="border-b border-border last:border-0 hover:bg-border/10"
                    >
                      <td className="max-w-[260px] px-4 py-3 text-xs font-medium text-foreground">
                        <span className="line-clamp-2">{row.search_term || '-'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{formatNumber(row.search_frequency_rank)}</td>
                      <td className="max-w-[180px] px-4 py-3 text-xs text-muted-foreground">
                        <span className="line-clamp-2">{row.department_name || '-'}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">{row.clicked_asin || '-'}</td>
                      <td className="max-w-[260px] px-4 py-3 text-xs text-muted-foreground">
                        <span className="line-clamp-2">{row.clicked_item_name || '-'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{formatNumber(row.click_share_rank)}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{formatPercent(row.click_share)}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{formatPercent(row.conversion_share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setPage(current => Math.max(1, current - 1))}
              disabled={loading || page === 1}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {rowsReturned > 0 ? `${rowsReturned} rows shown` : 'No rows shown'}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPage(current => current + 1)}
              disabled={loading || !hasMore}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
