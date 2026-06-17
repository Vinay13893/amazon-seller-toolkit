'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  TrendingUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

type TopClickedProduct = {
  rank: number | null
  asin: string | null
  itemName: string | null
  clickShare: number | null
  conversionShare: number | null
}

type SearchTermRow = {
  departmentName: string | null
  searchTerm: string | null
  searchFrequencyRank: number | null
  reportId: string | null
  reportDocumentId: string | null
  marketplaceId: string | null
  dataStartTime: string | null
  dataEndTime: string | null
  topClickedProducts: TopClickedProduct[]
  topClickedAsin: string | null
  topClickShare: number | null
  topConversionShare: number | null
  opportunityTag: 'Winning term' | 'Conversion gap' | 'Click share opportunity' | 'Monitor'
  suggestedAction: string
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
  countSource: 'sync_summary' | 'unavailable'
  countMode?: 'summary_or_unavailable'
  departments?: string[]
  fieldCompleteness?: {
    impressions: boolean
    clicks: boolean
    purchases: boolean
    cartAdds: boolean
  }
}

type ApiResponse = {
  page: number
  pageSize: number
  hasMore: boolean
  rowsReturned: number
  rows: SearchTermRow[]
  viewMode?: 'grouped_top_search_terms'
  meta: ApiMeta
}

type ApiErrorResponse = {
  errorCode?: string
  stage?: string
  message?: string
  dbErrorCode?: string | null
}

type Filters = {
  searchTerm: string
  clickedAsin: string
  departmentName: string
  minRank: string
  maxRank: string
  opportunity: OpportunityKey
}

type OpportunityKey =
  | 'all'
  | 'high-demand'
  | 'conversion-gap'
  | 'click-share-opportunity'
  | 'winning-term'
  | 'competitor-asin'

const DEFAULT_FILTERS: Filters = {
  searchTerm: '',
  clickedAsin: '',
  departmentName: '',
  minRank: '',
  maxRank: '',
  opportunity: 'all',
}

const OPPORTUNITIES: Array<{ key: OpportunityKey; label: string; why: string; action: string }> = [
  {
    key: 'high-demand',
    label: 'High-demand terms',
    why: 'These terms have strong search frequency and deserve listing and ad focus.',
    action: 'Prioritize bids and listing quality',
  },
  {
    key: 'conversion-gap',
    label: 'Conversion gaps',
    why: 'Shoppers click, but conversion share is weak compared with demand.',
    action: 'Improve image/title/price/reviews',
  },
  {
    key: 'click-share-opportunity',
    label: 'Click share opportunities',
    why: 'Demand exists, but the winning product is not capturing enough clicks.',
    action: 'Add exact-match campaigns',
  },
  {
    key: 'winning-term',
    label: 'Winning terms',
    why: 'Strong click and conversion share signals that this term should be protected.',
    action: 'Protect winning term',
  },
  {
    key: 'competitor-asin',
    label: 'Competitor ASIN opportunities',
    why: 'These terms reveal products winning shopper attention.',
    action: 'Track competitor ASINs',
  },
]

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available'
  return new Intl.NumberFormat('en-IN').format(value)
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  const normalized = Math.abs(value) <= 1 ? value * 100 : value
  return `${normalized.toFixed(1)}%`
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

function amazonProductUrl(asin: string | null): string | null {
  if (!asin) return null
  return `https://www.amazon.in/dp/${encodeURIComponent(asin)}`
}

function opportunityTone(tag: SearchTermRow['opportunityTag']): string {
  switch (tag) {
    case 'Winning term':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'Conversion gap':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'Click share opportunity':
      return 'border-sky-200 bg-sky-50 text-sky-700'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

function opportunityIcon(tag: SearchTermRow['opportunityTag']) {
  if (tag === 'Winning term') return <ShieldCheck className="size-3.5" />
  if (tag === 'Conversion gap') return <TrendingUp className="size-3.5" />
  if (tag === 'Click share opportunity') return <Target className="size-3.5" />
  return <BarChart3 className="size-3.5" />
}

function insightSummary(rows: SearchTermRow[]) {
  return OPPORTUNITIES.map(opportunity => {
    let value = 0
    if (opportunity.key === 'high-demand') value = rows.filter(row => (row.searchFrequencyRank ?? Number.MAX_SAFE_INTEGER) <= 10000).length
    if (opportunity.key === 'conversion-gap') value = rows.filter(row => row.opportunityTag === 'Conversion gap').length
    if (opportunity.key === 'click-share-opportunity') value = rows.filter(row => row.opportunityTag === 'Click share opportunity').length
    if (opportunity.key === 'winning-term') value = rows.filter(row => row.opportunityTag === 'Winning term').length
    if (opportunity.key === 'competitor-asin') value = rows.filter(row => row.topClickedProducts.some(product => product.asin)).length
    return { ...opportunity, value }
  })
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
  const [selectedRow, setSelectedRow] = useState<SearchTermRow | null>(null)

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
        let safeDetail = `status_${res.status}`
        try {
          const body = await res.json() as ApiErrorResponse
          if (body?.stage || body?.errorCode) {
            safeDetail = [body.stage, body.errorCode, body.dbErrorCode].filter(Boolean).join(' / ')
          }
        } catch {
          safeDetail = `status_${res.status}`
        }
        setRows([])
        setRowsReturned(0)
        setError(`Brand Analytics API failed at ${safeDetail}.`)
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

  function updateManualFilter<K extends Exclude<keyof Filters, 'opportunity'>>(key: K, value: Filters[K]) {
    setFilters(current => ({ ...current, [key]: value, opportunity: 'all' }))
  }

  function clearFilters() {
    setFilters(DEFAULT_FILTERS)
    setAppliedFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  function viewOpportunity(opportunity: OpportunityKey) {
    const nextFilters = { ...DEFAULT_FILTERS, opportunity }
    if (opportunity === 'high-demand') nextFilters.maxRank = '10000'
    setFilters(nextFilters)
    setAppliedFilters(nextFilters)
    setPage(1)
  }

  function downloadCsv() {
    const params = new URLSearchParams(queryString)
    window.open(`/api/brand-analytics/search-terms/export?${params.toString()}`, '_blank', 'noopener,noreferrer')
  }

  const dataPeriod = meta?.dataStartTime || meta?.dataEndTime
    ? `${formatDate(meta?.dataStartTime)} to ${formatDate(meta?.dataEndTime)}`
    : 'Not available'
  const connectionStatus = loading ? 'Loading' : error ? 'Error' : 'Connected'
  const latestStatus = meta?.latestStatus ?? meta?.processingStatus ?? 'Not available'
  const storedRowsLabel = typeof meta?.storedRowCount === 'number'
    ? formatNumber(meta.storedRowCount)
    : 'Available after data refresh'
  const insights = insightSummary(rows)
  const viewingOpportunity = OPPORTUNITIES.find(item => item.key === appliedFilters.opportunity)
  const meaningfulDepartments = (meta?.departments ?? []).filter(department => {
    const normalized = department.trim().toLowerCase()
    return normalized && normalized !== 'amazon.in' && normalized !== 'amazon india'
  })
  const showDepartmentFilter = meaningfulDepartments.length > 1
  const activeFilterLabels = [
    appliedFilters.searchTerm ? 'Search term' : null,
    appliedFilters.clickedAsin ? 'Clicked ASIN' : null,
    appliedFilters.departmentName ? 'Category / Source' : null,
    appliedFilters.minRank ? 'Min rank' : null,
    appliedFilters.maxRank ? 'Max rank' : null,
    viewingOpportunity ? viewingOpportunity.label : null,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Top Search Terms</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Brand Analytics translated into demand, winners, gaps, and next actions.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadRows()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Refresh
        </Button>
        <Button type="button" variant="outline" onClick={downloadCsv} disabled={loading}>
          <Download className="size-4" />
          Download CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent>
            <p className="text-xs font-medium text-muted-foreground">Status</p>
            <p className="mt-2 text-base font-semibold text-foreground">{connectionStatus}</p>
            <p className="mt-1 text-xs text-muted-foreground">{latestStatus}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent>
            <p className="text-xs font-medium text-muted-foreground">Period</p>
            <p className="mt-2 text-base font-semibold text-foreground">{dataPeriod}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent>
            <p className="text-xs font-medium text-muted-foreground">Stored rows</p>
            <p className="mt-2 text-base font-semibold text-foreground">{storedRowsLabel}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent>
            <p className="text-xs font-medium text-muted-foreground">Latest document</p>
            <p className="mt-2 text-base font-semibold text-foreground">{compactId(meta?.latestReportDocumentId)}</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="rounded-lg border-border/70 shadow-none">
        <CardContent>
          <div className="mb-4 flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="searchTerm">Search term</Label>
              <Input
                id="searchTerm"
                value={filters.searchTerm}
                onChange={event => updateManualFilter('searchTerm', event.target.value)}
                placeholder="Contains"
              />
              <p className="text-[11px] text-muted-foreground">
                Search is optimized for exact or close term lookup. Broader analysis starts from the ranked view.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clickedAsin">Clicked ASIN</Label>
              <Input
                id="clickedAsin"
                value={filters.clickedAsin}
                onChange={event => updateManualFilter('clickedAsin', event.target.value)}
                placeholder="ASIN"
              />
            </div>
            {showDepartmentFilter ? (
              <div className="space-y-1.5">
                <Label htmlFor="departmentName">Category / Source</Label>
                <select
                  id="departmentName"
                  className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  value={filters.departmentName}
                  onChange={event => updateManualFilter('departmentName', event.target.value)}
                >
                  <option value="">All categories</option>
                  {meaningfulDepartments.map(department => (
                    <option key={department} value={department}>{department}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Category / Source</Label>
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm text-muted-foreground">
                  Not available in this report
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="minRank">Min rank</Label>
                <Input
                  id="minRank"
                  type="number"
                  min="1"
                  value={filters.minRank}
                  onChange={event => updateManualFilter('minRank', event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="maxRank">Max rank</Label>
                <Input
                  id="maxRank"
                  type="number"
                  min="1"
                  value={filters.maxRank}
                  onChange={event => updateManualFilter('maxRank', event.target.value)}
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
          {activeFilterLabels.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                Active filters: <span className="font-medium text-foreground">{activeFilterLabels.join(', ')}</span>
              </p>
              {viewingOpportunity && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const nextFilters = { ...appliedFilters, opportunity: 'all' as OpportunityKey }
                    setFilters(nextFilters)
                    setAppliedFilters(nextFilters)
                    setPage(1)
                  }}
                >
                  Clear view
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent className="px-0">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 pb-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Top Search Terms</h2>
                <p className="mt-1 text-xs text-muted-foreground">One row per term with the top clicked products and recommended action.</p>
              </div>
              <p className="text-xs text-muted-foreground">Page {page} - {rowsReturned} terms</p>
            </div>

            {loading && (
              <div className="flex items-center justify-center gap-2 py-16">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading Top Search Terms...</span>
              </div>
            )}

            {!loading && error && (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <p className="text-sm font-medium text-foreground">Could not load Top Search Terms</p>
                <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
                <Button type="button" variant="outline" onClick={() => void loadRows()}>
                  Retry
                </Button>
              </div>
            )}

            {!loading && !error && rows.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <BarChart3 className="size-8 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground">No matching search terms found for this filter.</p>
                <p className="max-w-sm text-xs text-muted-foreground">Adjust the filters or clear them to browse the latest synced report.</p>
              </div>
            )}

            {!loading && !error && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-left">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-5 py-3 text-xs font-medium text-muted-foreground">Search term</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Demand</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Top clicked products</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Opportunity</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Suggested action</th>
                      <th className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={`${row.reportDocumentId ?? 'doc'}-${row.searchFrequencyRank ?? index}-${row.searchTerm ?? index}`}
                        className="border-b border-border last:border-0 hover:bg-muted/20"
                      >
                        <td className="max-w-[260px] px-5 py-4 align-top">
                          <p className="line-clamp-2 text-sm font-semibold text-foreground">{row.searchTerm || 'Not available'}</p>
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{row.departmentName || 'Department not available'}</p>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <p className="text-sm font-semibold text-foreground">#{formatNumber(row.searchFrequencyRank)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">Search frequency rank</p>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="grid gap-2">
                            {row.topClickedProducts.slice(0, 3).map((product, productIndex) => (
                              <div key={`${product.asin ?? 'asin'}-${productIndex}`} className="rounded-md border border-border/70 px-3 py-2">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    {amazonProductUrl(product.asin) ? (
                                      <a
                                        href={amazonProductUrl(product.asin) ?? undefined}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block truncate font-mono text-xs font-medium text-foreground hover:underline"
                                      >
                                        #{product.rank ?? productIndex + 1} {product.asin}
                                      </a>
                                    ) : (
                                      <p className="truncate font-mono text-xs font-medium text-foreground">
                                        #{product.rank ?? productIndex + 1} ASIN unavailable
                                      </p>
                                    )}
                                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{product.itemName || 'Item name unavailable'}</p>
                                  </div>
                                  <p className="shrink-0 text-xs font-semibold text-foreground">{formatPercent(product.clickShare)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <Badge variant="outline" className={opportunityTone(row.opportunityTag)}>
                            {opportunityIcon(row.opportunityTag)}
                            {row.opportunityTag}
                          </Badge>
                        </td>
                        <td className="max-w-[190px] px-4 py-4 align-top">
                          <p className="text-sm text-foreground">{row.suggestedAction}</p>
                        </td>
                        <td className="px-5 py-4 text-right align-top">
                          <Button type="button" variant="outline" size="sm" onClick={() => setSelectedRow(row)}>
                            Explain
                            <ArrowUpRight className="size-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border px-5 pt-4">
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
                {rowsReturned > 0 ? `${rowsReturned} grouped terms shown` : 'No terms shown'}
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

        <Card className="rounded-lg border-border/70 shadow-none">
          <CardContent>
            <div className="mb-4">
              <h2 className="text-base font-semibold text-foreground">Growth Opportunities</h2>
              <p className="mt-1 text-xs text-muted-foreground">Click an opportunity to see the terms behind it.</p>
            </div>
            <div className="grid gap-3">
              {insights.map(insight => (
                <button
                  key={insight.label}
                  type="button"
                  onClick={() => viewOpportunity(insight.key)}
                  className="rounded-md border border-border/70 p-3 text-left transition hover:bg-muted/40"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">{insight.label}</p>
                    <p className="text-lg font-semibold text-foreground">{insight.value}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{insight.action}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Why? {insight.why}</p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Sheet open={Boolean(selectedRow)} onOpenChange={open => !open && setSelectedRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selectedRow?.searchTerm || 'Search term details'}</SheetTitle>
            <SheetDescription>
              Seller-friendly explanation based on the latest Brand Analytics report.
            </SheetDescription>
          </SheetHeader>

          {selectedRow && (
            <div className="grid gap-5 px-4 pb-6">
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">What this means</p>
                <p className="mt-2 text-sm text-foreground">
                  This term ranks #{formatNumber(selectedRow.searchFrequencyRank)} by search frequency. The current top clicked product gets {formatPercent(selectedRow.topClickShare)} click share, with {formatPercent(selectedRow.topConversionShare)} conversion share.
                </p>
              </div>

              <div className="rounded-lg border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">Opportunity</p>
                <div className="mt-2">
                  <Badge variant="outline" className={opportunityTone(selectedRow.opportunityTag)}>
                    {opportunityIcon(selectedRow.opportunityTag)}
                    {selectedRow.opportunityTag}
                  </Badge>
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">{selectedRow.suggestedAction}</p>
              </div>

              <div className="rounded-lg border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">Top clicked products</p>
                <div className="mt-3 grid gap-3">
                  {selectedRow.topClickedProducts.map((product, index) => (
                    <div key={`${product.asin ?? 'product'}-${index}`} className="rounded-md bg-muted/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          {amazonProductUrl(product.asin) ? (
                            <a
                              href={amazonProductUrl(product.asin) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block font-mono text-xs font-semibold text-foreground hover:underline"
                            >
                              #{product.rank ?? index + 1} {product.asin}
                            </a>
                          ) : (
                            <p className="font-mono text-xs font-semibold text-foreground">#{product.rank ?? index + 1} ASIN unavailable</p>
                          )}
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{product.itemName || 'Item name unavailable'}</p>
                        </div>
                        <div className="text-right text-xs">
                          <p className="font-semibold text-foreground">{formatPercent(product.clickShare)}</p>
                          <p className="text-muted-foreground">click share</p>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">Conversion share: {formatPercent(product.conversionShare)}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">Coming soon</p>
                <div className="mt-3 grid gap-2">
                  <Button type="button" variant="outline" disabled>Create exact-match campaign</Button>
                  <Button type="button" variant="outline" disabled>Add keyword to existing campaign</Button>
                  <Button type="button" variant="outline" disabled>Add ASIN to competitor watchlist</Button>
                  <Button type="button" variant="outline" disabled>Save action</Button>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
