'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw, Sheet as SheetIcon, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  StockSheetsFailure,
  StockWorkbookMetadata,
  StockWorkbookMetadataResponse,
  WorksheetData,
  WorksheetDataResponse,
} from '@/lib/stock-intelligence/types'
import { RunHealthView } from './run-health-view'
import { TodayView } from './today-view'
import { WorksheetNavigation } from './worksheet-navigation'
import { WorksheetTableView } from './worksheet-table-view'

function isFailure(value: StockWorkbookMetadataResponse | WorksheetDataResponse): value is StockSheetsFailure {
  return value.status !== 'ready'
}

async function requestMetadata(refresh = false): Promise<StockWorkbookMetadataResponse> {
  const response = await fetch(`/api/internal/stock-intelligence/metadata${refresh ? '?refresh=1' : ''}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const body = await response.json() as StockWorkbookMetadataResponse
  if (!response.ok && !isFailure(body)) {
    return { status: 'unavailable', message: 'Stock workbook metadata is unavailable.' }
  }
  return body
}

export function StockIntelligenceDashboard() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requestedSheet = searchParams.get('sheet') ?? 'Today'
  const [metadata, setMetadata] = useState<StockWorkbookMetadata | null>(null)
  const [metadataFailure, setMetadataFailure] = useState<StockSheetsFailure | null>(null)
  const [data, setData] = useState<WorksheetData | null>(null)
  const [dataFailure, setDataFailure] = useState<StockSheetsFailure | null>(null)
  const [loadingMetadata, setLoadingMetadata] = useState(true)
  const [loadingData, setLoadingData] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [brand, setBrand] = useState('')
  const [category, setCategory] = useState('')
  const [sortColumn, setSortColumn] = useState<number | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc' | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const refreshRequested = useRef(false)

  const loadMetadata = useCallback(async (refresh = false) => {
    setLoadingMetadata(true)
    setMetadataFailure(null)
    try {
      const body = await requestMetadata(refresh)
      if (isFailure(body)) {
        setMetadata(null)
        setMetadataFailure(body)
      } else {
        setMetadata(body)
      }
    } catch {
      setMetadata(null)
      setMetadataFailure({ status: 'unavailable', message: 'Stock workbook metadata is unavailable.' })
    } finally {
      setLoadingMetadata(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void requestMetadata()
      .then(body => {
        if (!active) return
        if (isFailure(body)) {
          setMetadata(null)
          setMetadataFailure(body)
        } else {
          setMetadata(body)
        }
      })
      .catch(() => {
        if (!active) return
        setMetadata(null)
        setMetadataFailure({ status: 'unavailable', message: 'Stock workbook metadata is unavailable.' })
      })
      .finally(() => {
        if (active) setLoadingMetadata(false)
      })
    return () => { active = false }
  }, [])

  const selectedTitle = useMemo(() => {
    if (!metadata) return requestedSheet
    return metadata.worksheets.some(sheet => sheet.title === requestedSheet) ? requestedSheet : 'Today'
  }, [metadata, requestedSheet])

  useEffect(() => {
    if (!metadata || selectedTitle === requestedSheet) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('sheet', selectedTitle)
    router.replace(`${pathname}?${params.toString()}`)
  }, [metadata, pathname, requestedSheet, router, searchParams, selectedTitle])

  useEffect(() => {
    if (!metadata || !selectedTitle) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        title: selectedTitle,
        page: String(page),
        pageSize: '50',
      })
      if (search) params.set('search', search)
      if (brand) params.set('brand', brand)
      if (category) params.set('category', category)
      if (sortColumn !== null && sortDirection) {
        params.set('sortColumn', String(sortColumn))
        params.set('sortDirection', sortDirection)
      }
      if (refreshRequested.current) params.set('refresh', '1')
      refreshRequested.current = false

      setLoadingData(true)
      setDataFailure(null)
      void fetch(`/api/internal/stock-intelligence/worksheet?${params.toString()}`, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then(async response => ({ response, body: await response.json() as WorksheetDataResponse }))
        .then(({ response, body }) => {
          if (!response.ok || isFailure(body)) {
            setData(null)
            setDataFailure(isFailure(body) ? body : { status: 'unavailable', message: 'Worksheet data is unavailable.' })
          } else {
            setData(body)
          }
        })
        .catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setData(null)
          setDataFailure({ status: 'unavailable', message: 'Worksheet data is unavailable.' })
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingData(false)
        })
    }, 250)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [brand, category, metadata, page, refreshVersion, search, selectedTitle, sortColumn, sortDirection])

  const selectSheet = useCallback((title: string) => {
    setData(null)
    setDataFailure(null)
    setPage(1)
    setSearch('')
    setBrand('')
    setCategory('')
    setSortColumn(null)
    setSortDirection(null)
    const params = new URLSearchParams(searchParams.toString())
    params.set('sheet', title)
    router.push(`${pathname}?${params.toString()}`)
  }, [pathname, router, searchParams])

  const refreshData = useCallback(() => {
    refreshRequested.current = true
    setRefreshVersion(version => version + 1)
    void loadMetadata(true)
  }, [loadMetadata])

  const clearFilters = useCallback(() => {
    setPage(1)
    setSearch('')
    setBrand('')
    setCategory('')
  }, [])

  const changeSort = useCallback((column: number) => {
    setPage(1)
    if (sortColumn !== column) {
      setSortColumn(column)
      setSortDirection('asc')
      return
    }
    if (sortDirection === 'asc') {
      setSortDirection('desc')
      return
    }
    setSortColumn(null)
    setSortDirection(null)
  }, [sortColumn, sortDirection])

  if (loadingMetadata) {
    return <div className="space-y-4"><Skeleton className="h-9 w-72" /><Skeleton className="h-[560px] w-full" /></div>
  }

  if (metadataFailure || !metadata) {
    return (
      <div className="mx-auto max-w-2xl border-y border-border py-16 text-center">
        <WifiOff className="mx-auto size-8 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Stock Intelligence is not connected</h1>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          {metadataFailure?.message ?? 'The stock workbook is unavailable.'}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          An administrator must configure a read-only Google Sheets service account. The original workbook remains unchanged.
        </p>
        <Button variant="outline" className="mt-5" onClick={() => void loadMetadata()}>
          <RefreshCw />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">Stock Intelligence</h1>
            <Badge variant="outline"><Wifi className="size-3" />Connected source</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{metadata.spreadsheetTitle}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Source refresh: {data?.sourceRefreshLabel ?? metadata.sourceRefreshLabel ?? 'Unavailable'}
            {' · '}Workbook time zone: {metadata.timeZone}
            {' · '}View fetched: {new Date(data?.fetchedAt ?? metadata.fetchedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refreshData} disabled={loadingData}>
            <RefreshCw className={loadingData ? 'animate-spin' : ''} />
            Refresh displayed data
          </Button>
          <Button
            variant="outline"
            render={<Link href={data?.worksheetUrl ?? metadata.spreadsheetUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
            Open original worksheet
          </Button>
        </div>
      </header>

      <div className="grid min-h-[620px] gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-r border-border pr-3">
          <div className="mb-3 flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <SheetIcon className="size-4" />
            <span>{metadata.visibleSheetCount} visible worksheets</span>
          </div>
          <WorksheetNavigation worksheets={metadata.worksheets} selectedTitle={selectedTitle} onSelect={selectSheet} />
        </aside>

        <main className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{selectedTitle}</h2>
              <p className="text-xs text-muted-foreground">
                Read-only source data. Refreshing this view does not execute Apps Script or Amazon synchronization.
              </p>
            </div>
            {data?.warning && (
              <div className="flex max-w-lg items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{data.warning}</span>
              </div>
            )}
          </div>

          {loadingData && !data ? (
            <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-[420px] w-full" /></div>
          ) : dataFailure ? (
            <div className="border-y border-border py-14 text-center">
              <AlertTriangle className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">Worksheet data unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">{dataFailure.message}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={refreshData}>Retry</Button>
            </div>
          ) : data?.mode === 'today' ? (
            <TodayView rows={data.rows} onNavigate={selectSheet} />
          ) : data?.mode === 'run_health' ? (
            <RunHealthView rows={data.rows} />
          ) : data ? (
            <WorksheetTableView
              data={data}
              search={search}
              brand={brand}
              category={category}
              onSearchChange={value => { setPage(1); setSearch(value) }}
              onBrandChange={value => { setPage(1); setBrand(value) }}
              onCategoryChange={value => { setPage(1); setCategory(value) }}
              onClearFilters={clearFilters}
              onPageChange={setPage}
              onSort={changeSort}
              sortColumn={sortColumn}
              sortDirection={sortDirection}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}
