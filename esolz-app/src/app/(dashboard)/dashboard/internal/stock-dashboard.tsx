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
  diagnostics: {
    products_with_sales: number
    products_missing_sales: number
    products_with_inventory: number
    products_missing_inventory: number
    last_sync_status: string | null
    last_sync_warnings: string[]
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

const statuses: StockStatus[] = ['OOS', 'Low stock', 'Healthy', 'Overstock', 'Missing data']

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
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [syncDays, setSyncDays] = useState(90)
  const [syncingAmazon, setSyncingAmazon] = useState(false)
  const [amazonSyncError, setAmazonSyncError] = useState<string | null>(null)
  const [amazonSyncResult, setAmazonSyncResult] = useState<AmazonSyncResult | null>(null)
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
          Warehouse/FC-wise stock is not available from the current Amazon data yet.
        </p>
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
        {cards.map(card => (
          <div key={card.label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
              <card.icon className={`h-4 w-4 ${card.tone}`} />
            </div>
            <p className="mt-2 text-2xl font-black">{card.value.toLocaleString('en-IN')}</p>
          </div>
        ))}
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
            Showing {filteredActions.length.toLocaleString('en-IN')} of {data.actions.length.toLocaleString('en-IN')} products
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
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
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredActions.map((row, index) => (
                <tr key={`${row.marketplaceId}-${row.sku}-${row.asin}`} className={index < filteredActions.length - 1 ? 'border-b border-border/50' : ''}>
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

        <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>Inventory updated: {formatDate(data.freshness.inventoryUpdatedAt)}</span>
          <span>Sales through: {formatDate(data.freshness.salesThroughDate)}</span>
        </div>
      </div>
    </div>
  )
}
