'use client'

import Image from 'next/image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  Loader2,
  PackageX,
  RefreshCw,
  Search,
  RefreshCcw,
  Upload,
  Warehouse,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { StockAction, StockStatus } from '@/lib/internal-stock-actions'

type StockResponse = {
  summary: Record<StockStatus, number>
  actions: StockAction[]
  nextStockPlan: {
    assumptions: {
      salesLookbackDays: number
      planningCycleDays: number
      transitBufferDays: number
      growthMultiplier: number
      maxLookbackDays: number
    }
    summary: {
      fbaReplenishmentNeeded: number
      sellerFlexReplenishmentNeeded: number
      productsMissingStockData: number
      productsUnknownSourceSales: number
      zoneMappingGaps: number
    }
    rows: Array<{
      asin: string
      sku: string | null
      marketplaceId: string | null
      title: string | null
      brand: string | null
      imageUrl: string | null
      primarySource: 'fulfillment_report' | 'inventory_api' | 'sales_api' | 'csv_upload' | 'missing'
      totalSales30d: number
      fbaSales30d: number
      sellerFlexSales30d: number
      easyShipMfnSales30d: number
      unknownSourceSales30d: number
      availableFbaStock: number
      availableSellerFlexStock: number
      inboundStock: number
      reservedStock: number
      unsellableStock: number
      daysCover: number | null
      targetCoverDays: number
      safetyStock: number
      suggestedFbaReplenishment: number
      suggestedSellerFlexReplenishment: number
      ledgerBalanceStock: number | null
      ledgerBalanceSource: 'fulfillment_report' | null
      ledgerBalanceAmbiguous: boolean
      missingDataWarnings: string[]
      stateZoneInsight: string
      actionMessage: string
    }>
  }
  diagnostics: {
    products_with_sales: number
    products_missing_sales: number
    products_with_inventory: number
    products_missing_inventory: number
    last_sync_status: string | null
    last_sync_warnings: string[]
    fulfillment_report_type: string | null
    fulfillment_report_status: string | null
    fulfillment_report_completed_at: string | null
    fulfillment_report_rows: number
    fulfillment_fc_available: boolean | null
    state_zone_rows: number
    fulfillment_location_rows: number
    fulfillment_sales_daily_rows: number
    inventory_by_location_rows: number
  }
  freshness: {
    inventoryUpdatedAt: string | null
    salesThroughDate: string | null
    inventoryDataAvailable: boolean
    salesDataAvailable: boolean
    salesTableAvailable: boolean
    amazonSyncCompletedAt: string | null
    resultLimitReached: boolean
  }
}

type UploadResult = {
  accepted: number
  rejected: number
  errors: Array<{ row: number; message: string }>
}

type AmazonSyncResult = {
  jobId: string
  status: 'running' | 'completed' | 'partial_success' | 'failed'
  phase: 'listings' | 'inventory' | 'sales' | 'completed'
  listingsUpdated: number
  listingsUsed: number
  inventoryUpdated: number
  salesRowsUpdated: number
  warnings: string[]
  warehouseStockAvailable: boolean
}

type FulfillmentReportResult = {
  jobId: string
  reportType: string
  processingStatus: string
  storedRows: number
  fcFieldAvailable: boolean | null
  completedAt?: string | null
}

const statuses: StockStatus[] = ['OOS', 'Low stock', 'Healthy', 'Overstock', 'Missing data']
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const

type NextPlanRow = StockResponse['nextStockPlan']['rows'][number]
type PlanFilterId = 'fba' | 'flex' | 'missingStock' | 'unknownSource' | 'zoneGap'

const NEXT_PLAN_FILTERS: Array<{ id: PlanFilterId; label: string; predicate: (row: NextPlanRow) => boolean }> = [
  { id: 'fba', label: 'FBA SKUs needing replenishment', predicate: row => row.suggestedFbaReplenishment > 0 },
  { id: 'flex', label: 'Seller Flex SKUs needing replenishment', predicate: row => row.suggestedSellerFlexReplenishment > 0 },
  {
    id: 'missingStock',
    label: 'Demand but missing stock data',
    predicate: row => row.missingDataWarnings.includes('Sales exist but inventory missing; sync fulfillment report.'),
  },
  { id: 'unknownSource', label: 'Unknown source sales', predicate: row => row.unknownSourceSales30d > 0 },
  {
    id: 'zoneGap',
    label: 'Zone mapping gaps',
    predicate: row => row.missingDataWarnings.includes('Zone mapping missing; add state-zone map.'),
  },
]

function PaginationControls({
  page,
  totalPages,
  pageSize,
  totalRows,
  onPageChange,
}: {
  page: number
  totalPages: number
  pageSize: number
  totalRows: number
  onPageChange: (page: number) => void
}) {
  if (totalRows === 0) return null
  const start = (page - 1) * pageSize + 1
  const end = Math.min(totalRows, page * pageSize)
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>Showing {start.toLocaleString('en-IN')}–{end.toLocaleString('en-IN')} of {totalRows.toLocaleString('en-IN')}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span>Page {page} of {totalPages}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function formatDate(value: string | null): string {
  if (!value) return 'Not available'
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: value.includes('T') ? 'short' : undefined,
  }).format(new Date(value))
}

function formatNumber(value: number | null, decimals = 0): string {
  if (value === null) return '—'
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function statusBadge(status: StockStatus) {
  const className = {
    OOS: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
    'Low stock': 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    Healthy: 'border-green-300 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300',
    Overstock: 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300',
    'Missing data': 'border-border bg-muted text-muted-foreground',
  }[status]

  return <Badge variant="outline" className={className}>{status}</Badge>
}

export function InternalStockDashboard() {
  const [data, setData] = useState<StockResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'All' | StockStatus>('All')
  const [planFilter, setPlanFilter] = useState<PlanFilterId | null>(null)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const [planPage, setPlanPage] = useState(1)
  const [actionsPage, setActionsPage] = useState(1)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [syncDays, setSyncDays] = useState(90)
  const [syncingAmazon, setSyncingAmazon] = useState(false)
  const [amazonSyncError, setAmazonSyncError] = useState<string | null>(null)
  const [amazonSyncResult, setAmazonSyncResult] = useState<AmazonSyncResult | null>(null)
  const [syncingFulfillment, setSyncingFulfillment] = useState(false)
  const [fulfillmentError, setFulfillmentError] = useState<string | null>(null)
  const [fulfillmentResult, setFulfillmentResult] = useState<FulfillmentReportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/internal/stock-actions', {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Unable to load stock actions.')
      setData(await response.json() as StockResponse)
    } catch {
      setError('Unable to load stock actions right now.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const downloadTemplate = useCallback(() => {
    const csv = 'sales_date,asin,ordered_units,sku,marketplace_id,ordered_revenue\r\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'internal-daily-sales-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const uploadCsv = useCallback(async (file: File) => {
    setUploading(true)
    setUploadError(null)
    setUploadResult(null)

    try {
      const body = new FormData()
      body.set('file', file)
      const response = await fetch('/api/internal/stock-actions/sales-upload', {
        method: 'POST',
        body,
        credentials: 'same-origin',
      })
      const result = await response.json() as UploadResult & { error?: string }
      if (!response.ok) {
        throw new Error(result.error ?? 'CSV upload failed.')
      }
      setUploadResult(result)
      if (result.accepted > 0) await load()
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : 'CSV upload failed.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [load])

  const syncAmazonData = useCallback(async () => {
    setSyncingAmazon(true)
    setAmazonSyncError(null)
    setAmazonSyncResult(null)

    try {
      let response = await fetch('/api/internal/stock-actions/sync-amazon-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ days: syncDays }),
      })
      let result = await response.json() as AmazonSyncResult & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Amazon sync could not start.')
      setAmazonSyncResult(result)

      let steps = 0
      while (result.status === 'running' && steps < 2000) {
        await new Promise(resolve => setTimeout(resolve, 1100))
        response = await fetch('/api/internal/stock-actions/sync-amazon-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ jobId: result.jobId }),
        })
        result = await response.json() as AmazonSyncResult & { error?: string }
        if (!response.ok) throw new Error(result.error ?? 'Amazon sync stopped.')
        setAmazonSyncResult(result)
        steps += 1
        if (result.phase === 'sales' && steps % 10 === 0) {
          await load(true)
        }
      }

      if (result.status !== 'completed' && result.status !== 'partial_success') {
        throw new Error('Amazon sync did not complete in this session.')
      }
      await load()
    } catch (syncFailure) {
      setAmazonSyncError(syncFailure instanceof Error ? syncFailure.message : 'Amazon sync failed.')
    } finally {
      setSyncingAmazon(false)
    }
  }, [load, syncDays])

  const syncFulfillmentReport = useCallback(async () => {
    setSyncingFulfillment(true)
    setFulfillmentError(null)
    setFulfillmentResult(null)

    try {
      let response = await fetch('/api/internal/stock-actions/fulfillment-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'start', days: 30 }),
      })
      let result = await response.json() as FulfillmentReportResult & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Fulfillment report could not start.')
      setFulfillmentResult(result)

      let polls = 0
      while (
        !['DONE', 'FATAL', 'CANCELLED'].includes(result.processingStatus)
        && polls < 120
      ) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        response = await fetch('/api/internal/stock-actions/fulfillment-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'continue', jobId: result.jobId }),
        })
        result = await response.json() as FulfillmentReportResult & { error?: string }
        if (!response.ok) throw new Error(result.error ?? 'Fulfillment report sync stopped.')
        setFulfillmentResult(result)
        polls += 1
      }

      if (result.processingStatus !== 'DONE') {
        throw new Error(
          result.processingStatus === 'FATAL' || result.processingStatus === 'CANCELLED'
            ? 'Amazon could not generate the fulfillment report.'
            : 'Fulfillment report is still processing. Retry later.',
        )
      }
      await load()
    } catch (syncFailure) {
      setFulfillmentError(
        syncFailure instanceof Error ? syncFailure.message : 'Fulfillment report sync failed.',
      )
    } finally {
      setSyncingFulfillment(false)
    }
  }, [load])

  const filteredActions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (data?.actions ?? []).filter(row => {
      const matchesStatus = status === 'All' || row.status === status
      const matchesQuery = !normalizedQuery || [
        row.title,
        row.asin,
        row.sku,
        row.brand,
        row.marketplaceId,
      ].some(value => value?.toLowerCase().includes(normalizedQuery))
      return matchesStatus && matchesQuery
    })
  }, [data?.actions, query, status])

  const filteredPlanRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const activePredicate = NEXT_PLAN_FILTERS.find(filter => filter.id === planFilter)?.predicate
    return (data?.nextStockPlan.rows ?? []).filter(row => {
      const matchesFilter = !activePredicate || activePredicate(row)
      const matchesQuery = !normalizedQuery || [
        row.title,
        row.asin,
        row.sku,
        row.brand,
      ].some(value => value?.toLowerCase().includes(normalizedQuery))
      return matchesFilter && matchesQuery
    })
  }, [data?.nextStockPlan.rows, planFilter, query])

  useEffect(() => {
    setPlanPage(1)
  }, [planFilter, query, pageSize])

  useEffect(() => {
    setActionsPage(1)
  }, [status, query, pageSize])

  const planTotalPages = Math.max(1, Math.ceil(filteredPlanRows.length / pageSize))
  const actionsTotalPages = Math.max(1, Math.ceil(filteredActions.length / pageSize))
  const safePlanPage = Math.min(planPage, planTotalPages)
  const safeActionsPage = Math.min(actionsPage, actionsTotalPages)
  const paginatedPlanRows = filteredPlanRows.slice((safePlanPage - 1) * pageSize, safePlanPage * pageSize)
  const paginatedActions = filteredActions.slice((safeActionsPage - 1) * pageSize, safeActionsPage * pageSize)
  const hasActiveFilter = status !== 'All' || planFilter !== null || query.trim().length > 0

  const clearAllFilters = useCallback(() => {
    setStatus('All')
    setPlanFilter(null)
    setQuery('')
  }, [])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading Emount stock actions…</span>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-border bg-card p-8 text-center">
        <CircleAlert className="mx-auto h-8 w-8 text-destructive" />
        <p className="mt-3 font-semibold">{error ?? 'Stock actions are unavailable.'}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" /> Retry
        </Button>
      </div>
    )
  }

  const warnings = [
    !data.freshness.salesTableAvailable
      ? 'Daily sales storage is not available yet. Apply migration 025.'
      : data.diagnostics.products_with_sales === 0
        ? 'Sales data is missing for all products. Replenishment estimates are intentionally not calculated.'
        : data.diagnostics.products_missing_sales > 0
          ? `Sales data available for ${data.diagnostics.products_with_sales} products; missing for ${data.diagnostics.products_missing_sales}.`
          : null,
    data.diagnostics.products_with_inventory === 0
      ? 'Inventory data is missing for all products. Stock availability is intentionally not inferred.'
      : data.diagnostics.products_missing_inventory > 0
        ? `Inventory data available for ${data.diagnostics.products_with_inventory} products; missing for ${data.diagnostics.products_missing_inventory}.`
        : null,
    data.freshness.resultLimitReached
      ? 'The safety result limit was reached. Narrower server-side paging can be added before expanding this dataset.'
      : null,
  ].filter(Boolean)

  const cards = [
    { label: 'OOS', value: data.summary.OOS, icon: PackageX, tone: 'text-red-600' },
    { label: 'Low stock', value: data.summary['Low stock'], icon: AlertTriangle, tone: 'text-amber-600' },
    { label: 'Healthy', value: data.summary.Healthy, icon: CheckCircle2, tone: 'text-green-600' },
    { label: 'Overstock', value: data.summary.Overstock, icon: Boxes, tone: 'text-blue-600' },
    { label: 'Missing data', value: data.summary['Missing data'], icon: CircleAlert, tone: 'text-muted-foreground' },
  ]

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Internal Dashboard</p>
          <h1 className="mt-1 text-2xl font-black">Emount Stock Actions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only replenishment intelligence using structured listing, inventory, and daily sales data.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh data
        </Button>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.map(warning => <p key={warning}>• {warning}</p>)}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold">Sync Amazon Stock &amp; Sales</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Refreshes structured listings, FBA inventory summaries, and daily SKU sales metrics.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last sync: {formatDate(data.freshness.amazonSyncCompletedAt)}
              {data.diagnostics.last_sync_status ? ` · ${data.diagnostics.last_sync_status.replace('_', ' ')}` : ''}
            </p>
            {data.diagnostics.last_sync_warnings.map(warning => (
              <p key={warning} className="mt-1 text-xs text-amber-700 dark:text-amber-300">• {warning}</p>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={syncDays}
              onChange={event => setSyncDays(Number(event.target.value))}
              disabled={syncingAmazon}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Amazon sales lookback"
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
              <option value={365}>Last 365 days</option>
            </select>
            <Button type="button" onClick={() => void syncAmazonData()} disabled={syncingAmazon}>
              {syncingAmazon
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <RefreshCcw className="mr-2 h-4 w-4" />}
              {syncingAmazon ? 'Syncing Amazon…' : 'Sync Amazon Stock & Sales'}
            </Button>
          </div>
        </div>

        {amazonSyncResult && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium">
              {amazonSyncResult.status === 'completed'
                ? 'Amazon sync completed'
                : amazonSyncResult.status === 'partial_success'
                  ? 'Amazon sync completed with warnings'
                  : `Syncing ${amazonSyncResult.phase}…`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Listings used: {amazonSyncResult.listingsUsed.toLocaleString('en-IN')} ·{' '}
              Listings updated: {amazonSyncResult.listingsUpdated.toLocaleString('en-IN')} ·{' '}
              Inventory updated: {amazonSyncResult.inventoryUpdated.toLocaleString('en-IN')} ·{' '}
              Sales rows updated: {amazonSyncResult.salesRowsUpdated.toLocaleString('en-IN')}
            </p>
            {amazonSyncResult.warnings.map(warning => (
              <p key={warning} className="mt-1 text-xs text-amber-700 dark:text-amber-300">• {warning}</p>
            ))}
          </div>
        )}

        {amazonSyncError && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {amazonSyncError}
          </div>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          {data.diagnostics.fulfillment_fc_available === true
            ? 'Warehouse/FC identifiers are available from the latest fulfillment report.'
            : 'Warehouse/FC-wise stock is not available from the current Amazon data yet.'}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold">FBA Fulfillment Report</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Structured 30-day ledger detail report. Raw report rows are not retained.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Latest: {data.diagnostics.fulfillment_report_status ?? 'Not synced'} ·{' '}
              {data.diagnostics.fulfillment_report_rows.toLocaleString('en-IN')} rows ·{' '}
              FC/warehouse: {data.diagnostics.fulfillment_fc_available === true
                ? 'Available'
                : data.diagnostics.fulfillment_fc_available === false
                  ? 'Not provided'
                  : 'Unknown'}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={syncingFulfillment}
            onClick={() => void syncFulfillmentReport()}
          >
            {syncingFulfillment
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <RefreshCcw className="mr-2 h-4 w-4" />}
            {syncingFulfillment ? 'Syncing fulfillment…' : 'Sync fulfillment report'}
          </Button>
        </div>

        {fulfillmentResult && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium">Status: {fulfillmentResult.processingStatus}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Structured rows stored: {fulfillmentResult.storedRows.toLocaleString('en-IN')} ·{' '}
              FC/warehouse field: {fulfillmentResult.fcFieldAvailable === true
                ? 'available'
                : fulfillmentResult.fcFieldAvailable === false
                  ? 'not provided'
                  : 'unknown'}
            </p>
          </div>
        )}

        {fulfillmentError && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {fulfillmentError}
          </div>
        )}
      </div>

      <details className="rounded-xl border border-border bg-card p-4">
        <summary className="cursor-pointer font-bold">Manual fallback upload</summary>
        <div className="mt-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold">Upload daily sales CSV</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Aggregated rows only. Required: sales_date, asin, ordered_units. Maximum 2 MB or 5,000 accepted rows.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={downloadTemplate}>
              <Download className="mr-2 h-4 w-4" /> Download template
            </Button>
            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Upload className="mr-2 h-4 w-4" />}
              {uploading ? 'Uploading…' : 'Choose CSV'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0]
                if (file) void uploadCsv(file)
              }}
            />
          </div>
        </div>

        {uploadError && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {uploadError}
          </div>
        )}

        {uploadResult && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium">
              {uploadResult.accepted.toLocaleString('en-IN')} rows accepted ·{' '}
              {uploadResult.rejected.toLocaleString('en-IN')} rows rejected
            </p>
            {uploadResult.errors.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {uploadResult.errors.map(errorItem => (
                  <li key={`${errorItem.row}-${errorItem.message}`}>
                    Row {errorItem.row}: {errorItem.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </div>
      </details>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {cards.map(card => {
          const isActive = status === card.label
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => setStatus(isActive ? 'All' : card.label as StockStatus)}
              className={`rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/40 ${isActive ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
                <card.icon className={`h-4 w-4 ${card.tone}`} />
              </div>
              <p className="mt-2 text-2xl font-black">{card.value.toLocaleString('en-IN')}</p>
            </button>
          )
        })}
      </div>

      {hasActiveFilter && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2 text-sm">
          <span className="font-medium">Active filter:</span>
          {status !== 'All' && <Badge variant="outline">Status: {status}</Badge>}
          {planFilter && (
            <Badge variant="outline">
              {NEXT_PLAN_FILTERS.find(filter => filter.id === planFilter)?.label}
            </Badge>
          )}
          {query.trim().length > 0 && <Badge variant="outline">Search: &quot;{query.trim()}&quot;</Badge>}
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={clearAllFilters}>
            Clear filter
          </Button>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-2 border-b border-border p-4">
          <h2 className="text-lg font-black">Next Stock Plan</h2>
          <p className="text-xs text-muted-foreground">
            Replenishment model with separate FBA, Seller Flex, Easy Ship/MFN and unknown-source flows.
          </p>
          <p className="text-xs text-muted-foreground">
            Defaults: Lookback {data.nextStockPlan.assumptions.salesLookbackDays}d · Planning cycle {data.nextStockPlan.assumptions.planningCycleDays}d · Buffer {data.nextStockPlan.assumptions.transitBufferDays}d · Growth {data.nextStockPlan.assumptions.growthMultiplier}x
          </p>
          <p className="text-xs text-muted-foreground">
            Ledger balance is diagnostic from FBA Ledger Detail report and is not yet used in suggested replenishment.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-5">
          {([
            ['fba', 'FBA SKUs needing replenishment', data.nextStockPlan.summary.fbaReplenishmentNeeded],
            ['flex', 'Seller Flex SKUs needing replenishment', data.nextStockPlan.summary.sellerFlexReplenishmentNeeded],
            ['missingStock', 'Demand but missing stock data', data.nextStockPlan.summary.productsMissingStockData],
            ['unknownSource', 'Unknown source sales', data.nextStockPlan.summary.productsUnknownSourceSales],
            ['zoneGap', 'Zone mapping gaps', data.nextStockPlan.summary.zoneMappingGaps],
          ] as Array<[PlanFilterId, string, number]>).map(([id, label, value]) => {
            const isActive = planFilter === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPlanFilter(isActive ? null : id)}
                className={`rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/40 ${isActive ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
                <p className="mt-2 text-2xl font-black">{value.toLocaleString('en-IN')}</p>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={event => setPageSize(Number(event.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Rows per page"
          >
            {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[2080px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Product</th>
                <th className="px-3 py-3 text-left">ASIN/SKU</th>
                <th className="px-3 py-3 text-left">Primary source</th>
                <th className="px-3 py-3 text-right">30d Sales</th>
                <th className="px-3 py-3 text-right">FBA Sales</th>
                <th className="px-3 py-3 text-right">Flex Sales</th>
                <th className="px-3 py-3 text-right">Easy Ship/MFN Sales</th>
                <th className="px-3 py-3 text-right">Available Stock</th>
                <th className="px-3 py-3 text-right">Inbound</th>
                <th className="px-3 py-3 text-right">Ledger Balance Stock (approx.)</th>
                <th className="px-3 py-3 text-right">Days Cover</th>
                <th className="px-3 py-3 text-right">Suggested FBA Qty</th>
                <th className="px-3 py-3 text-right">Suggested Flex Qty</th>
                <th className="px-3 py-3 text-left">State/Zone insight</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {paginatedPlanRows.map((row, index) => (
                <tr key={`next-plan-${row.marketplaceId}-${row.sku}-${row.asin}`} className={index < paginatedPlanRows.length - 1 ? 'border-b border-border/50' : ''}>
                  <td className="px-4 py-3">
                    <div className="flex min-w-[220px] items-center gap-3">
                      <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                        {row.imageUrl ? (
                          <Image src={row.imageUrl} alt="" fill unoptimized className="object-contain" sizes="40px" />
                        ) : (
                          <Warehouse className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="max-w-[260px] truncate font-medium">{row.title ?? 'Product title unavailable'}</p>
                        <p className="text-xs text-muted-foreground">{[row.brand, row.marketplaceId].filter(Boolean).join(' · ') || 'Metadata unavailable'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-mono text-xs">{row.asin}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{row.sku ?? 'SKU unavailable'}</p>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="outline" className="text-[10px]">{row.primarySource}</Badge>
                  </td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.totalSales30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.fbaSales30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.sellerFlexSales30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.easyShipMfnSales30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.availableFbaStock + row.availableSellerFlexStock)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.inboundStock)}</td>
                  <td className="px-3 py-3 text-right">
                    {row.ledgerBalanceStock === null ? '—' : formatNumber(row.ledgerBalanceStock)}
                    {row.ledgerBalanceAmbiguous && (
                      <span className="ml-1 text-amber-600" title="Multiple same-day ledger entries; balance may be imprecise.">⚠</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.daysCover, 1)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.suggestedFbaReplenishment)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.suggestedSellerFlexReplenishment)}</td>
                  <td className="max-w-[260px] px-3 py-3 text-xs text-muted-foreground">{row.stateZoneInsight}</td>
                  <td className="max-w-[320px] px-4 py-3 text-xs text-muted-foreground">
                    <p>{row.actionMessage}</p>
                    {row.missingDataWarnings.length > 0 && (
                      <p className="mt-1 text-[11px]">{row.missingDataWarnings.join(' | ')}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredPlanRows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {data.nextStockPlan.rows.length === 0
                ? 'Next Stock Plan requires synced internal stock and sales data.'
                : 'No rows match the current filter or search.'}
            </div>
          )}
        </div>

        <PaginationControls
          page={safePlanPage}
          totalPages={planTotalPages}
          pageSize={pageSize}
          totalRows={filteredPlanRows.length}
          onPageChange={setPlanPage}
        />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row">
            <div className="relative max-w-xl flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search title, ASIN, SKU, brand, or marketplace"
                className="pl-9"
              />
            </div>
            <select
              value={status}
              onChange={event => setStatus(event.target.value as 'All' | StockStatus)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Filter stock status"
            >
              <option value="All">All statuses</option>
              {statuses.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Matching {filteredActions.length.toLocaleString('en-IN')} of {data.actions.length.toLocaleString('en-IN')} products
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1340px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Product</th>
                <th className="px-3 py-3 text-left">ASIN / SKU</th>
                <th className="px-3 py-3 text-right">Available</th>
                <th className="px-3 py-3 text-right">Inbound</th>
                <th className="px-3 py-3 text-right">30d Sales</th>
                <th className="px-3 py-3 text-right">Velocity/day</th>
                <th className="px-3 py-3 text-right">Days Cover</th>
                <th className="px-3 py-3 text-right">Suggested Reorder</th>
                <th className="px-3 py-3 text-left">Status</th>
                <th className="px-3 py-3 text-left">Data source</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {paginatedActions.map((row, index) => (
                <tr key={`${row.marketplaceId}-${row.sku}-${row.asin}`} className={index < paginatedActions.length - 1 ? 'border-b border-border/50' : ''}>
                  <td className="px-4 py-3">
                    <div className="flex min-w-[240px] items-center gap-3">
                      <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                        {row.imageUrl ? (
                          <Image src={row.imageUrl} alt="" fill unoptimized className="object-contain" sizes="44px" />
                        ) : (
                          <Warehouse className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="max-w-[280px] truncate font-medium">{row.title ?? 'Product title unavailable'}</p>
                        <p className="text-xs text-muted-foreground">
                          {[row.brand, row.marketplaceId].filter(Boolean).join(' · ') || 'Metadata unavailable'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-mono text-xs">{row.asin}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{row.sku ?? 'SKU unavailable'}</p>
                  </td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.available)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.inbound)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.units30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.velocityPerDay, 2)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.daysCover, 1)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.suggestedReorder)}</td>
                  <td className="px-3 py-3">{statusBadge(row.status)}</td>
                  <td className="px-3 py-3">
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      <Badge variant="outline" className="text-[9px]">
                        {row.inventorySource ?? 'missing'}
                      </Badge>
                      <Badge variant="outline" className="text-[9px]">
                        {row.salesSource ?? 'missing'}
                      </Badge>
                    </div>
                  </td>
                  <td className="max-w-[300px] px-4 py-3 text-xs text-muted-foreground">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredActions.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No products match the current search and status filter.
            </div>
          )}
        </div>

        <PaginationControls
          page={safeActionsPage}
          totalPages={actionsTotalPages}
          pageSize={pageSize}
          totalRows={filteredActions.length}
          onPageChange={setActionsPage}
        />

        <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>Inventory updated: {formatDate(data.freshness.inventoryUpdatedAt)}</span>
          <span>Sales through: {formatDate(data.freshness.salesThroughDate)}</span>
        </div>
      </div>
    </div>
  )
}
