'use client'

import Image from 'next/image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
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

type ReplenishmentPaymentSignalSummary = {
  priorityFlag: 'profitable_high_demand' | 'profitable_low_stock' | 'loss_or_review' | 'missing_cost' | 'insufficient_data'
  estimatedMarginPercent: number | null
  costAvailable: boolean
}

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
    fcDiagnostics: Array<{
      asin: string
      sku: string | null
      marketplaceId: string | null
      title: string | null
      fulfillmentCenterId: string
      fulfillmentCenterType: 'seller_flex' | 'fba_fc' | 'unknown'
      shipments30d: number
      ledgerBalanceStock: number | null
      ledgerBalanceAmbiguous: boolean
      latestReportDate: string | null
    }>
  }
  paymentContext: {
    stateZoneDemand: Array<{
      state: string
      zone: string | null
      amazonSku: string
      componentSku: string | null
      unitsSold: number
      componentDemandUnits: number
      transactionCount: number
      grossSales: number
      refundUnits: number
      refundAmount: number
    }>
    paymentSignals: Array<{
      amazonSku: string
      unitsSold: number
      grossSales: number
      refundUnits: number
      refundAmount: number
      amazonFees: number
      costAvailable: boolean
      estimatedContribution: number | null
      estimatedMarginPercent: number | null
      priorityFlag: 'profitable_high_demand' | 'profitable_low_stock' | 'loss_or_review' | 'missing_cost' | 'insufficient_data'
      note: string
    }>
    diagnostics: {
      transactionRowsRead: number
      salesTransactionRowsUsed: number
      refundTransactionRowsUsed: number
      rowsMissingSku: number
      rowsMissingState: number
      mappedComponentRows: number
      stateZoneMappedRows: number
      transactionRowLimitReached: boolean
      exactPnlAvailable: false
    }
  }
  fcReplenishmentRows: Array<{
    productTitle: string | null
    asin: string
    amazonSku: string | null
    fcCode: string
    fcType: 'fba_fc'
    zone: string | null
    demand30d: number
    dailyVelocity: number
    growthFactor: number
    targetStockDays: number
    requiredStock: number
    currentFcStockApprox: number | null
    inboundToFc: number | null
    suggestedSendQty: number
    confidenceStatus: 'high' | 'medium' | 'low'
    action: 'send_to_fc' | 'monitor' | 'no_action'
    reason: string
    stateZoneSignal: string | null
    paymentSignal: ReplenishmentPaymentSignalSummary | null
  }>
  fcReplenishmentSummary: {
    rows: number
    skusToSend: number
    unitsSuggested: number
    rowsNeedingStockContext: number
    rowsInboundNotIncluded: number
    rowsMarginReview: number
  }
  flexReplenishmentRows: Array<{
    componentSku: string
    wmsParentSkuCount: number
    linkedAmazonSkuCount: number
    amazonDemand30d: number
    componentAdjustedDemand: number
    dailyComponentVelocity: number
    growthFactor: number
    targetStockDays: number
    requiredComponentStock: number
    currentXhzuComponentStock: number | null
    suggestedVendorReplenishQty: number | null
    confidenceStatus: 'high' | 'medium' | 'low'
    action: 'send_to_vendor' | 'monitor' | 'needs_xhzu_stock_context'
    reason: string
    stateZoneSignal: string | null
    paymentSignal: ReplenishmentPaymentSignalSummary | null
  }>
  flexReplenishmentSummary: {
    rows: number
    componentSkusToReplenish: number
    componentUnitsRequired: number
    rowsNeedingXhzuStockContext: number
    rowsMissingMapping: number
    rowsMarginReview: number
  }
  fcStockMatrixRows: Array<{
    productTitle: string
    asin: string | null
    amazonSku: string | null
    totalDemand30d: number
    xhzuOrSellerFlexStock: number | null
    totalSuggestedSendQty: number
    action: string
    reason: string
    fcCells: Array<{
      fcCode: string
      zone: string | null
      demand30d: number
      currentFcStockApprox: number | null
      inboundToFc: number | null
      suggestedSendQty: number
      action: string
      reason: string
    }>
  }>
  fcStockMatrixColumns: string[]
  diagnostics: {
    products_with_sales: number
    products_missing_sales: number
    products_with_inventory: number
    products_missing_inventory: number
    products_with_demand_signal: number
    products_missing_demand_signal: number
    products_with_fba_inventory_api: number
    products_with_ledger_balance: number
    products_with_location_stock: number
    products_with_any_stock_context: number
    products_missing_any_stock_context: number
    unattributed_daily_sales_units: number
    products_with_unattributed_daily_sales: number
    products_with_blank_fc_shipments: number
    products_with_generic_source_labels: number
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

type PlanningAssumptions = {
  lookbackDays: 15 | 30 | 60 | 90
  planningCycleDays: 15 | 30 | 45 | 60 | 90
  transitBufferDays: 7 | 15 | 21 | 30
  growthMultiplier: 1 | 1.25 | 1.5 | 2
}

type CsvColumn<Row> = {
  header: string
  value: (row: Row) => string | number | boolean | null | undefined
}

const statuses: StockStatus[] = ['OOS', 'Low stock', 'Healthy', 'Overstock', 'Missing data']
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const DEFAULT_PLANNING_ASSUMPTIONS: PlanningAssumptions = {
  lookbackDays: 30,
  planningCycleDays: 30,
  transitBufferDays: 15,
  growthMultiplier: 1.5,
}

type FcReplenishmentRow = StockResponse['fcReplenishmentRows'][number]
type FlexReplenishmentRow = StockResponse['flexReplenishmentRows'][number]
type FcStockMatrixRow = StockResponse['fcStockMatrixRows'][number]
type FcStockMatrixCell = FcStockMatrixRow['fcCells'][number]
type NextPlanRow = StockResponse['nextStockPlan']['rows'][number]
type StateZoneDemandRow = StockResponse['paymentContext']['stateZoneDemand'][number]
type PaymentSignalRow = StockResponse['paymentContext']['paymentSignals'][number]
type PaymentPriority = PaymentSignalRow['priorityFlag']
type PlanFilterId = 'fba' | 'flex' | 'missingStock' | 'unknownSource' | 'zoneGap'

const NEXT_PLAN_FILTERS: Array<{ id: PlanFilterId; label: string; predicate: (row: NextPlanRow) => boolean }> = [
  { id: 'fba', label: 'FBA SKUs needing replenishment', predicate: row => row.suggestedFbaReplenishment > 0 },
  { id: 'flex', label: 'Seller Flex channel SKUs needing replenishment', predicate: row => row.suggestedSellerFlexReplenishment > 0 },
  {
    id: 'missingStock',
    label: 'Demand but missing stock data',
    predicate: row => row.missingDataWarnings.includes('Sales exist but inventory missing; sync fulfillment report.'),
  },
  { id: 'unknownSource', label: 'Unattributed daily sales', predicate: row => row.unknownSourceSales30d > 0 },
  {
    id: 'zoneGap',
    label: 'Zone mapping gaps',
    predicate: row => row.missingDataWarnings.includes('Zone mapping missing; add state-zone map.'),
  },
]

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text
  return `"${protectedText.replaceAll('"', '""')}"`
}

function exportFilteredCsv<Row>(
  reportName: string,
  columns: CsvColumn<Row>[],
  rows: Row[],
  assumptions: StockResponse['nextStockPlan']['assumptions'],
  filters: string,
) {
  const generatedAt = new Date().toISOString()
  const contextColumns: CsvColumn<Row>[] = [
    { header: 'Report Name', value: () => reportName },
    { header: 'Generated Date', value: () => generatedAt },
    { header: 'Lookback Days', value: () => assumptions.salesLookbackDays },
    { header: 'Planning Cycle Days', value: () => assumptions.planningCycleDays },
    { header: 'Transit Buffer Days', value: () => assumptions.transitBufferDays },
    { header: 'Growth Factor', value: () => assumptions.growthMultiplier },
    { header: 'Active Filters', value: () => filters },
  ]
  const exportColumns = [...contextColumns, ...columns]
  const csv = [
    exportColumns.map(column => csvCell(column.header)).join(','),
    ...rows.map(row => exportColumns.map(column => csvCell(column.value(row))).join(',')),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${reportName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${generatedAt.slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

type SortDirection = 'asc' | 'desc'
type SortState = { column: string; direction: SortDirection } | null

function toggleSort(current: SortState, column: string): SortState {
  if (current?.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { column, direction: 'asc' }
}

function compareForSort(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined
  const bMissing = b === null || b === undefined
  if (aMissing && bMissing) return 0
  if (aMissing) return -1
  if (bMissing) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

function sortRows<Row>(
  rows: Row[],
  sort: SortState,
  accessors: Record<string, (row: Row) => unknown>,
): Row[] {
  const accessor = sort ? accessors[sort.column] : undefined
  if (!sort || !accessor) return rows
  const sorted = [...rows].sort((a, b) => compareForSort(accessor(a), accessor(b)))
  return sort.direction === 'desc' ? sorted.reverse() : sorted
}

function SortableTh({
  label,
  column,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string
  column: string
  sort: SortState
  onSort: (column: string) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort?.column === column
  const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className={`px-3 py-3 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </button>
    </th>
  )
}

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

function ReportStatCards({ cards }: { cards: Array<[string, number]> }) {
  return (
    <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-6">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-border bg-card p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-black">{value.toLocaleString('en-IN')}</p>
        </div>
      ))}
    </div>
  )
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
  const [activeTab, setActiveTab] = useState<'fc' | 'flex'>('fc')
  const [planningDraft, setPlanningDraft] = useState<PlanningAssumptions>(DEFAULT_PLANNING_ASSUMPTIONS)
  const [planningAssumptions, setPlanningAssumptions] = useState<PlanningAssumptions>(DEFAULT_PLANNING_ASSUMPTIONS)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const [planPage, setPlanPage] = useState(1)
  const [fcDiagnosticsPage, setFcDiagnosticsPage] = useState(1)
  const [actionsPage, setActionsPage] = useState(1)
  const [stateDemandPage, setStateDemandPage] = useState(1)
  const [paymentSignalPage, setPaymentSignalPage] = useState(1)
  const [planSort, setPlanSort] = useState<SortState>(null)
  const [fcDiagnosticsSort, setFcDiagnosticsSort] = useState<SortState>(null)
  const [actionsSort, setActionsSort] = useState<SortState>(null)
  const [stateDemandSort, setStateDemandSort] = useState<SortState>({ column: 'componentDemandUnits', direction: 'desc' })
  const [paymentSignalSort, setPaymentSignalSort] = useState<SortState>({ column: 'unitsSold', direction: 'desc' })
  const [stateDemandQuery, setStateDemandQuery] = useState('')
  const [paymentSignalQuery, setPaymentSignalQuery] = useState('')
  const [paymentPriority, setPaymentPriority] = useState<'All' | PaymentPriority>('All')
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
      const params = new URLSearchParams({
        lookbackDays: String(planningAssumptions.lookbackDays),
        planningCycleDays: String(planningAssumptions.planningCycleDays),
        transitBufferDays: String(planningAssumptions.transitBufferDays),
        growthMultiplier: String(planningAssumptions.growthMultiplier),
      })
      const response = await fetch(`/api/internal/stock-actions?${params.toString()}`, {
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
  }, [planningAssumptions])

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

  const filteredFcDiagnostics = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (data?.nextStockPlan.fcDiagnostics ?? []).filter(row => (
      !normalizedQuery || [
        row.title,
        row.asin,
        row.sku,
        row.fulfillmentCenterId,
        row.fulfillmentCenterType,
      ].some(value => value?.toLowerCase().includes(normalizedQuery))
    ))
  }, [data?.nextStockPlan.fcDiagnostics, query])

  const filteredStateDemand = useMemo(() => {
    const normalizedQuery = stateDemandQuery.trim().toLowerCase()
    return (data?.paymentContext.stateZoneDemand ?? []).filter(row => (
      !normalizedQuery || [
        row.state,
        row.zone,
        row.amazonSku,
        row.componentSku,
      ].some(value => value?.toLowerCase().includes(normalizedQuery))
    ))
  }, [data?.paymentContext.stateZoneDemand, stateDemandQuery])

  const filteredPaymentSignals = useMemo(() => {
    const normalizedQuery = paymentSignalQuery.trim().toLowerCase()
    return (data?.paymentContext.paymentSignals ?? []).filter(row => {
      const matchesPriority = paymentPriority === 'All' || row.priorityFlag === paymentPriority
      const matchesQuery = !normalizedQuery || row.amazonSku.toLowerCase().includes(normalizedQuery)
      return matchesPriority && matchesQuery
    })
  }, [data?.paymentContext.paymentSignals, paymentPriority, paymentSignalQuery])

  const planSortAccessors = useMemo<Record<string, (row: NextPlanRow) => unknown>>(() => ({
    title: row => row.title ?? row.asin,
    asin: row => row.asin,
    primarySource: row => row.primarySource,
    totalSales30d: row => row.totalSales30d,
    fbaSales30d: row => row.fbaSales30d,
    sellerFlexSales30d: row => row.sellerFlexSales30d,
    easyShipMfnSales30d: row => row.easyShipMfnSales30d,
    unknownSourceSales30d: row => row.unknownSourceSales30d,
    availableStock: row => row.availableFbaStock + row.availableSellerFlexStock,
    inboundStock: row => row.inboundStock,
    ledgerBalanceStock: row => row.ledgerBalanceStock,
    daysCover: row => row.daysCover,
    suggestedFbaReplenishment: row => row.suggestedFbaReplenishment,
    suggestedSellerFlexReplenishment: row => row.suggestedSellerFlexReplenishment,
    actionMessage: row => row.actionMessage,
  }), [])

  type FcDiagnosticRow = StockResponse['nextStockPlan']['fcDiagnostics'][number]
  const fcDiagnosticsSortAccessors = useMemo<Record<string, (row: FcDiagnosticRow) => unknown>>(() => ({
    title: row => row.title ?? row.asin,
    asin: row => row.asin,
    fulfillmentCenterId: row => row.fulfillmentCenterId,
    fulfillmentCenterType: row => row.fulfillmentCenterType,
    shipments30d: row => row.shipments30d,
    ledgerBalanceStock: row => row.ledgerBalanceStock,
    latestReportDate: row => row.latestReportDate,
    ledgerBalanceAmbiguous: row => row.ledgerBalanceAmbiguous,
  }), [])

  const actionsSortAccessors = useMemo<Record<string, (row: StockAction) => unknown>>(() => ({
    title: row => row.title ?? row.asin,
    asin: row => row.asin,
    available: row => row.available,
    inbound: row => row.inbound,
    units30d: row => row.units30d,
    velocityPerDay: row => row.velocityPerDay,
    daysCover: row => row.daysCover,
    suggestedReorder: row => row.suggestedReorder,
    status: row => row.status,
  }), [])

  const stateDemandSortAccessors = useMemo<Record<string, (row: StateZoneDemandRow) => unknown>>(() => ({
    state: row => row.state,
    zone: row => row.zone,
    amazonSku: row => row.amazonSku,
    componentSku: row => row.componentSku,
    unitsSold: row => row.unitsSold,
    componentDemandUnits: row => row.componentDemandUnits,
    transactionCount: row => row.transactionCount,
    grossSales: row => row.grossSales,
    refundUnits: row => row.refundUnits,
    refundAmount: row => row.refundAmount,
  }), [])

  const paymentSignalSortAccessors = useMemo<Record<string, (row: PaymentSignalRow) => unknown>>(() => ({
    amazonSku: row => row.amazonSku,
    unitsSold: row => row.unitsSold,
    grossSales: row => row.grossSales,
    refundAmount: row => row.refundAmount,
    amazonFees: row => row.amazonFees,
    costAvailable: row => row.costAvailable,
    estimatedContribution: row => row.estimatedContribution,
    estimatedMarginPercent: row => row.estimatedMarginPercent,
    priorityFlag: row => row.priorityFlag,
  }), [])

  const sortedPlanRows = useMemo(
    () => sortRows(filteredPlanRows, planSort, planSortAccessors),
    [filteredPlanRows, planSort, planSortAccessors],
  )
  const sortedFcDiagnostics = useMemo(
    () => sortRows(filteredFcDiagnostics, fcDiagnosticsSort, fcDiagnosticsSortAccessors),
    [filteredFcDiagnostics, fcDiagnosticsSort, fcDiagnosticsSortAccessors],
  )
  const sortedActions = useMemo(
    () => sortRows(filteredActions, actionsSort, actionsSortAccessors),
    [filteredActions, actionsSort, actionsSortAccessors],
  )
  const sortedStateDemand = useMemo(
    () => sortRows(filteredStateDemand, stateDemandSort, stateDemandSortAccessors),
    [filteredStateDemand, stateDemandSort, stateDemandSortAccessors],
  )
  const sortedPaymentSignals = useMemo(
    () => sortRows(filteredPaymentSignals, paymentSignalSort, paymentSignalSortAccessors),
    [filteredPaymentSignals, paymentSignalSort, paymentSignalSortAccessors],
  )

  useEffect(() => {
    setPlanPage(1)
  }, [planFilter, query, pageSize, planSort])

  useEffect(() => {
    setActionsPage(1)
  }, [status, query, pageSize, actionsSort])

  useEffect(() => {
    setFcDiagnosticsPage(1)
  }, [query, fcDiagnosticsSort])

  useEffect(() => {
    setStateDemandPage(1)
  }, [stateDemandQuery, stateDemandSort])

  useEffect(() => {
    setPaymentSignalPage(1)
  }, [paymentPriority, paymentSignalQuery, paymentSignalSort])

  const planTotalPages = Math.max(1, Math.ceil(sortedPlanRows.length / pageSize))
  const fcDiagnosticsPageSize = 20
  const fcDiagnosticsTotalPages = Math.max(
    1,
    Math.ceil(sortedFcDiagnostics.length / fcDiagnosticsPageSize),
  )
  const actionsTotalPages = Math.max(1, Math.ceil(sortedActions.length / pageSize))
  const supportingSignalPageSize = 20
  const stateDemandTotalPages = Math.max(1, Math.ceil(sortedStateDemand.length / supportingSignalPageSize))
  const paymentSignalTotalPages = Math.max(1, Math.ceil(sortedPaymentSignals.length / supportingSignalPageSize))
  const safePlanPage = Math.min(planPage, planTotalPages)
  const safeFcDiagnosticsPage = Math.min(fcDiagnosticsPage, fcDiagnosticsTotalPages)
  const safeActionsPage = Math.min(actionsPage, actionsTotalPages)
  const safeStateDemandPage = Math.min(stateDemandPage, stateDemandTotalPages)
  const safePaymentSignalPage = Math.min(paymentSignalPage, paymentSignalTotalPages)
  const paginatedPlanRows = sortedPlanRows.slice((safePlanPage - 1) * pageSize, safePlanPage * pageSize)
  const paginatedFcDiagnostics = sortedFcDiagnostics.slice(
    (safeFcDiagnosticsPage - 1) * fcDiagnosticsPageSize,
    safeFcDiagnosticsPage * fcDiagnosticsPageSize,
  )
  const paginatedActions = sortedActions.slice((safeActionsPage - 1) * pageSize, safeActionsPage * pageSize)
  const paginatedStateDemand = sortedStateDemand.slice(
    (safeStateDemandPage - 1) * supportingSignalPageSize,
    safeStateDemandPage * supportingSignalPageSize,
  )
  const paginatedPaymentSignals = sortedPaymentSignals.slice(
    (safePaymentSignalPage - 1) * supportingSignalPageSize,
    safePaymentSignalPage * supportingSignalPageSize,
  )
  const hasActiveFilter = status !== 'All' || planFilter !== null || query.trim().length > 0
  const tabFilterText = `tab=${activeTab === 'fc' ? 'FC Replenishment' : 'Flex Replenishment'}`
  const planFilterText = [
    tabFilterText,
    planFilter ? `plan=${NEXT_PLAN_FILTERS.find(filter => filter.id === planFilter)?.label}` : null,
    query.trim() ? `search=${query.trim()}` : null,
  ].filter(Boolean).join('; ')
  const fcFilterText = [
    tabFilterText,
    query.trim() ? `search=${query.trim()}` : null,
  ].filter(Boolean).join('; ')
  const actionFilterText = [
    tabFilterText,
    status !== 'All' ? `status=${status}` : null,
    query.trim() ? `search=${query.trim()}` : null,
  ].filter(Boolean).join('; ')
  const stateDemandFilterText = [
    tabFilterText,
    stateDemandQuery.trim() ? `search=${stateDemandQuery.trim()}` : null,
  ].filter(Boolean).join('; ')
  const paymentSignalFilterText = [
    tabFilterText,
    paymentPriority !== 'All' ? `priority=${paymentPriority}` : null,
    paymentSignalQuery.trim() ? `search=${paymentSignalQuery.trim()}` : null,
  ].filter(Boolean).join('; ')

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
      : data.diagnostics.products_with_demand_signal === 0
        ? 'No demand signal (sales or shipments) is available for any product. Replenishment estimates are intentionally not calculated.'
        : data.diagnostics.products_missing_demand_signal > 0
          ? `Demand signal (sales or fulfillment shipments) available for ${data.diagnostics.products_with_demand_signal} products; missing for ${data.diagnostics.products_missing_demand_signal}.`
          : null,
    data.diagnostics.products_with_any_stock_context === 0
      ? 'No stock context (FBA inventory, ledger balance, or location stock) is available for any product yet.'
      : `FBA stock context available for ${data.diagnostics.products_with_fba_inventory_api} products (via inventory API).`,
    data.diagnostics.products_with_ledger_balance > 0
      ? `Ledger balance diagnostic available for ${data.diagnostics.products_with_ledger_balance} products (approximate; not used in replenishment).`
      : null,
    data.diagnostics.products_with_location_stock > 0
      ? `FC/Seller Flex location-level stock available for ${data.diagnostics.products_with_location_stock} products.`
      : null,
    data.diagnostics.products_with_any_stock_context > 0 && data.diagnostics.products_missing_any_stock_context > 0
      ? `No stock context at all for ${data.diagnostics.products_missing_any_stock_context} products.`
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

      <div className="rounded-xl border border-border bg-card p-4">
        <div>
          <h2 className="font-bold">Planning assumptions</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Shared scenario controls for replenishment planning. Settings are temporary and are not saved.
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="text-xs font-medium text-muted-foreground">
            Lookback days
            <select
              value={planningDraft.lookbackDays}
              onChange={event => setPlanningDraft(current => ({
                ...current,
                lookbackDays: Number(event.target.value) as PlanningAssumptions['lookbackDays'],
              }))}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {[15, 30, 60, 90].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Planning cycle days
            <select
              value={planningDraft.planningCycleDays}
              onChange={event => setPlanningDraft(current => ({
                ...current,
                planningCycleDays: Number(event.target.value) as PlanningAssumptions['planningCycleDays'],
              }))}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {[15, 30, 45, 60, 90].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Transit buffer days
            <select
              value={planningDraft.transitBufferDays}
              onChange={event => setPlanningDraft(current => ({
                ...current,
                transitBufferDays: Number(event.target.value) as PlanningAssumptions['transitBufferDays'],
              }))}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {[7, 15, 21, 30].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Growth factor
            <select
              value={planningDraft.growthMultiplier}
              onChange={event => setPlanningDraft(current => ({
                ...current,
                growthMultiplier: Number(event.target.value) as PlanningAssumptions['growthMultiplier'],
              }))}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {[1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}x</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              className="w-full"
              disabled={JSON.stringify(planningDraft) === JSON.stringify(planningAssumptions)}
              onClick={() => setPlanningAssumptions(planningDraft)}
            >
              Apply assumptions
            </Button>
          </div>
        </div>
      </div>

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

      <div className="flex rounded-xl border border-border bg-card p-1">
        <button
          type="button"
          onClick={() => setActiveTab('fc')}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'fc' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          FC Replenishment
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('flex')}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'flex' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          Flex Replenishment
        </button>
      </div>

      {activeTab === 'fc' ? (
        <>
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black">FC Stock Matrix</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              What should I send today? One row per Amazon SKU with FC-wise stock, demand, and send quantity.
              Inbound shipment quantity is not synced yet, so it is treated as zero.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={data.fcStockMatrixRows.length === 0}
            onClick={() => exportFilteredCsv(
              'FC Stock Matrix',
              [
                { header: 'Product Title', value: row => row.productTitle },
                { header: 'ASIN', value: row => row.asin },
                { header: 'Amazon SKU', value: row => row.amazonSku },
                { header: 'Total 30D Demand', value: row => row.totalDemand30d },
                { header: 'XHZU/Flex Stock', value: row => row.xhzuOrSellerFlexStock },
                { header: 'Total Suggested Send Qty', value: row => row.totalSuggestedSendQty },
                { header: 'Overall Action', value: row => row.action },
                { header: 'Overall Reason', value: row => row.reason },
                { header: 'FC Code', value: row => row.fcCode },
                { header: 'Zone', value: row => row.zone },
                { header: 'FC 30D Demand', value: row => row.demand30d },
                { header: 'FC Stock Approx', value: row => row.currentFcStockApprox },
                { header: 'Inbound to FC', value: row => row.inboundToFc },
                { header: 'FC Suggested Send Qty', value: row => row.suggestedSendQty },
                { header: 'FC Action', value: row => row.action },
                { header: 'FC Reason', value: row => row.reason },
              ],
              data.fcStockMatrixRows.flatMap(row => row.fcCells.map(cell => ({
                productTitle: row.productTitle,
                asin: row.asin,
                amazonSku: row.amazonSku,
                totalDemand30d: row.totalDemand30d,
                xhzuOrSellerFlexStock: row.xhzuOrSellerFlexStock,
                totalSuggestedSendQty: row.totalSuggestedSendQty,
                action: row.action,
                reason: row.reason,
                fcCode: cell.fcCode,
                zone: cell.zone,
                demand30d: cell.demand30d,
                currentFcStockApprox: cell.currentFcStockApprox,
                inboundToFc: cell.inboundToFc,
                suggestedSendQty: cell.suggestedSendQty,
              }))),
              data.nextStockPlan.assumptions,
              'report=FC Stock Matrix (one row per SKU/FC cell)',
            )}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
        <ReportStatCards
          cards={[
            ['SKUs needing FC send', data.fcStockMatrixRows.filter(row => row.totalSuggestedSendQty > 0).length],
            ['Total units to send', data.fcStockMatrixRows.reduce((sum, row) => sum + row.totalSuggestedSendQty, 0)],
            ['FCs involved', data.fcStockMatrixColumns.length],
            ['Inbound not included', data.fcReplenishmentSummary.rowsInboundNotIncluded],
            ['Needs stock context', data.fcReplenishmentSummary.rowsNeedingStockContext],
          ]}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: `${760 + data.fcStockMatrixColumns.length * 160}px` }}>
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Product</th>
                <th className="px-3 py-3 text-left">ASIN</th>
                <th className="px-3 py-3 text-left">Amazon SKU</th>
                <th className="px-3 py-3 text-right">Total 30D Demand</th>
                <th className="px-3 py-3 text-right">XHZU/Flex Stock</th>
                <th className="px-3 py-3 text-right">Total Send Qty</th>
                {data.fcStockMatrixColumns.map(fcCode => (
                  <th key={fcCode} className="px-3 py-3 text-left font-mono">{fcCode}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.fcStockMatrixRows.slice(0, 50).map((row: FcStockMatrixRow, index, page) => {
                const cellsByFc = new Map(row.fcCells.map(cell => [cell.fcCode, cell]))
                return (
                  <tr
                    key={`fc-matrix-${row.asin}-${row.amazonSku}`}
                    className={index < page.length - 1 ? 'border-b border-border/50' : ''}
                  >
                    <td className="max-w-[220px] truncate px-4 py-3">{row.productTitle}</td>
                    <td className="px-3 py-3 font-mono text-xs">{row.asin ?? '—'}</td>
                    <td className="px-3 py-3 font-mono text-xs">{row.amazonSku ?? '—'}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.totalDemand30d)}</td>
                    <td className="px-3 py-3 text-right">
                      {row.xhzuOrSellerFlexStock === null ? '—' : formatNumber(row.xhzuOrSellerFlexStock)}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.totalSuggestedSendQty)}</td>
                    {data.fcStockMatrixColumns.map((fcCode: string) => {
                      const cell: FcStockMatrixCell | undefined = cellsByFc.get(fcCode)
                      return (
                        <td key={fcCode} className="px-3 py-3 text-xs">
                          {cell ? (
                            <div className="space-y-0.5">
                              <p>Stock: {cell.currentFcStockApprox === null ? '—' : formatNumber(cell.currentFcStockApprox)}</p>
                              <p>Demand: {formatNumber(cell.demand30d)}</p>
                              <p className={cell.suggestedSendQty > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
                                Send: {formatNumber(cell.suggestedSendQty)}
                              </p>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.fcStockMatrixRows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No FC stock matrix rows are available yet.
            </div>
          )}
        </div>
        {data.fcStockMatrixRows.length > 50 && (
          <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Showing top 50 of {data.fcStockMatrixRows.length.toLocaleString('en-IN')} rows. Export CSV for the full list.
          </div>
        )}
      </div>
      <p className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Technical detail (channel-wise breakdown, diagnostics, and supporting signals)
      </p>
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black">Next Stock Plan</h2>
            <p className="text-xs text-muted-foreground">
              Amazon SKU/channel planning for FBA, Seller Flex, Easy Ship/MFN and unattributed daily sales signals.
            </p>
            <p className="text-xs text-muted-foreground">
              Applied: Lookback {data.nextStockPlan.assumptions.salesLookbackDays}d · Planning cycle {data.nextStockPlan.assumptions.planningCycleDays}d · Buffer {data.nextStockPlan.assumptions.transitBufferDays}d · Growth {data.nextStockPlan.assumptions.growthMultiplier}x
            </p>
            <p className="text-xs text-muted-foreground">
              Ledger balance is diagnostic from FBA Ledger Detail report and is not yet used in suggested replenishment.
            </p>
            <p className="mt-1 max-w-4xl text-xs text-muted-foreground">
              Unattributed units come from daily or imported sales where the ingestion source does not identify the
              fulfillment channel. They remain separate and are not treated as FBA or Seller Flex unless a valid
              FC/location code exists.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Unattributed units: {data.diagnostics.unattributed_daily_sales_units.toLocaleString('en-IN')} ·
              {' '}Products affected: {data.diagnostics.products_with_unattributed_daily_sales.toLocaleString('en-IN')} ·
              {' '}Generic-source products: {data.diagnostics.products_with_generic_source_labels.toLocaleString('en-IN')} ·
              {' '}Blank-FC shipment products: {data.diagnostics.products_with_blank_fc_shipments.toLocaleString('en-IN')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={filteredPlanRows.length === 0}
            onClick={() => exportFilteredCsv(
              'Next Stock Plan',
              [
                { header: 'Product Title', value: row => row.title },
                { header: 'ASIN', value: row => row.asin },
                { header: 'SKU', value: row => row.sku },
                { header: 'Data Source', value: row => row.primarySource },
                { header: 'Total Sales', value: row => row.totalSales30d },
                { header: 'FBA Sales', value: row => row.fbaSales30d },
                { header: 'Seller Flex Sales', value: row => row.sellerFlexSales30d },
                { header: 'Easy Ship/MFN Sales', value: row => row.easyShipMfnSales30d },
                { header: 'Unattributed Daily Sales', value: row => row.unknownSourceSales30d },
                { header: 'Available Stock', value: row => row.availableFbaStock + row.availableSellerFlexStock },
                { header: 'Inbound Stock', value: row => row.inboundStock },
                { header: 'Ledger Balance Approx', value: row => row.ledgerBalanceStock },
                { header: 'Suggested FBA Quantity', value: row => row.suggestedFbaReplenishment },
                { header: 'Suggested Seller Flex Channel Quantity', value: row => row.suggestedSellerFlexReplenishment },
                { header: 'Warnings', value: row => row.missingDataWarnings.join(' | ') },
                { header: 'Reason', value: row => row.actionMessage },
              ],
              sortedPlanRows,
              data.nextStockPlan.assumptions,
              planFilterText,
            )}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-5">
          {([
            ['fba', 'FBA SKUs needing replenishment', data.nextStockPlan.summary.fbaReplenishmentNeeded],
            ['flex', 'Seller Flex channel SKUs needing replenishment', data.nextStockPlan.summary.sellerFlexReplenishmentNeeded],
            ['missingStock', 'Demand but missing stock data', data.nextStockPlan.summary.productsMissingStockData],
            ['unknownSource', 'Unattributed daily sales', data.nextStockPlan.summary.productsUnknownSourceSales],
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
          <table className="w-full min-w-[2240px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh label="Product" column="title" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} className="px-4" />
                <SortableTh label="ASIN/SKU" column="asin" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} />
                <SortableTh label="Primary source" column="primarySource" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} />
                <SortableTh label={`${data.nextStockPlan.assumptions.salesLookbackDays}d Sales`} column="totalSales30d" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="FBA Sales" column="fbaSales30d" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Flex Sales" column="sellerFlexSales30d" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Easy Ship/MFN Sales" column="easyShipMfnSales30d" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Unattributed Daily Sales" column="unknownSourceSales30d" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Available Stock" column="availableStock" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Inbound" column="inboundStock" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Ledger Balance Stock (approx.)" column="ledgerBalanceStock" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Days Cover" column="daysCover" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Suggested FBA Qty" column="suggestedFbaReplenishment" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Suggested Flex Qty" column="suggestedSellerFlexReplenishment" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} align="right" />
                <th className="px-3 py-3 text-left">State/Zone insight</th>
                <SortableTh label="Action" column="actionMessage" sort={planSort} onSort={column => setPlanSort(current => toggleSort(current, column))} className="px-4" />
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
                  <td className="px-3 py-3 text-right">{formatNumber(row.unknownSourceSales30d)}</td>
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
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black">FC-wise Ledger Diagnostics</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Diagnostic only. Ledger balance is approximate and not yet used in replenishment.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={filteredFcDiagnostics.length === 0}
            onClick={() => exportFilteredCsv(
              'FC-wise Ledger Diagnostics',
              [
                { header: 'Product Title', value: row => row.title },
                { header: 'ASIN', value: row => row.asin },
                { header: 'SKU', value: row => row.sku },
                { header: 'FC Code', value: row => row.fulfillmentCenterId },
                { header: 'FC Type', value: row => row.fulfillmentCenterType },
                { header: 'Shipments Demand', value: row => row.shipments30d },
                { header: 'Ledger Balance Approx', value: row => row.ledgerBalanceStock },
                { header: 'Latest Date', value: row => row.latestReportDate },
                { header: 'Warning', value: row => row.ledgerBalanceAmbiguous ? 'Multiple balances share the latest date; displayed value is approximate.' : '' },
              ],
              sortedFcDiagnostics,
              data.nextStockPlan.assumptions,
              fcFilterText,
            )}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>

        <div className="border-b border-border p-4">
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search product, ASIN, SKU, FC code, or FC type"
              className="pl-9"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh label="Product" column="title" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} className="px-4" />
                <SortableTh label="ASIN/SKU" column="asin" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} />
                <SortableTh label="FC" column="fulfillmentCenterId" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} />
                <SortableTh label="FC Type" column="fulfillmentCenterType" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} />
                <SortableTh label={`${data.nextStockPlan.assumptions.salesLookbackDays}D Shipments`} column="shipments30d" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Ledger Balance Stock (approx.)" column="ledgerBalanceStock" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Latest Date" column="latestReportDate" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} />
                <SortableTh label="Warning" column="ledgerBalanceAmbiguous" sort={fcDiagnosticsSort} onSort={column => setFcDiagnosticsSort(current => toggleSort(current, column))} className="px-4" />
              </tr>
            </thead>
            <tbody>
              {paginatedFcDiagnostics.map((row, index) => (
                <tr
                  key={`fc-diagnostic-${row.marketplaceId}-${row.sku}-${row.asin}-${row.fulfillmentCenterId}`}
                  className={index < paginatedFcDiagnostics.length - 1 ? 'border-b border-border/50' : ''}
                >
                  <td className="max-w-[300px] px-4 py-3">
                    <p className="truncate font-medium">{row.title ?? 'Product title unavailable'}</p>
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-mono text-xs">{row.asin}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{row.sku ?? 'SKU unavailable'}</p>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">{row.fulfillmentCenterId}</td>
                  <td className="px-3 py-3">
                    <Badge variant="outline" className="text-[10px]">{row.fulfillmentCenterType}</Badge>
                  </td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.shipments30d)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.ledgerBalanceStock)}</td>
                  <td className="px-3 py-3 text-xs">{formatDate(row.latestReportDate)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.ledgerBalanceAmbiguous
                      ? 'Multiple balances share the latest date; displayed value is approximate.'
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredFcDiagnostics.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {data.nextStockPlan.fcDiagnostics.length === 0
                ? 'No FC-wise ledger diagnostics are available yet.'
                : 'No FC diagnostics match the current search.'}
            </div>
          )}
        </div>

        <PaginationControls
          page={safeFcDiagnosticsPage}
          totalPages={fcDiagnosticsTotalPages}
          pageSize={fcDiagnosticsPageSize}
          totalRows={filteredFcDiagnostics.length}
          onPageChange={setFcDiagnosticsPage}
        />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-black">State/Zone Sales Demand</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Supporting signal from aggregated payment transactions. Component demand expands mapped Amazon SKUs; it does not change replenishment quantities.
            </p>
            {data.paymentContext.diagnostics.transactionRowLimitReached && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Payment signal safety limit reached; narrow the planning lookback for a complete aggregate.
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={sortedStateDemand.length === 0}
            onClick={() => exportFilteredCsv(
              'State Zone Sales Demand',
              [
                { header: 'State', value: row => row.state },
                { header: 'Zone', value: row => row.zone },
                { header: 'Amazon SKU', value: row => row.amazonSku },
                { header: 'Component SKU', value: row => row.componentSku },
                { header: 'Units Sold', value: row => row.unitsSold },
                { header: 'Component Demand Units', value: row => row.componentDemandUnits },
                { header: 'Transaction Count', value: row => row.transactionCount },
                { header: 'Gross Sales', value: row => row.grossSales },
                { header: 'Refund Units', value: row => row.refundUnits },
                { header: 'Refund Amount', value: row => row.refundAmount },
              ],
              sortedStateDemand,
              data.nextStockPlan.assumptions,
              stateDemandFilterText,
            )}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
        <div className="border-b border-border p-4">
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={stateDemandQuery}
              onChange={event => setStateDemandQuery(event.target.value)}
              placeholder="Search state, zone, Amazon SKU, or component SKU"
              className="pl-9"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1260px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh label="State" column="state" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} className="px-4" />
                <SortableTh label="Zone" column="zone" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} />
                <SortableTh label="Amazon SKU" column="amazonSku" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} />
                <SortableTh label="Component SKU" column="componentSku" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} />
                <SortableTh label="Units sold" column="unitsSold" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Component demand" column="componentDemandUnits" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Transactions" column="transactionCount" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Gross sales" column="grossSales" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Refund units" column="refundUnits" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Refund amount" column="refundAmount" sort={stateDemandSort} onSort={column => setStateDemandSort(current => toggleSort(current, column))} align="right" className="px-4" />
              </tr>
            </thead>
            <tbody>
              {paginatedStateDemand.map((row, index) => (
                <tr
                  key={`${row.state}-${row.zone}-${row.amazonSku}-${row.componentSku ?? 'unmapped'}`}
                  className={index < paginatedStateDemand.length - 1 ? 'border-b border-border/50' : ''}
                >
                  <td className="px-4 py-3 font-medium">{row.state}</td>
                  <td className="px-3 py-3">{row.zone ?? 'Unmapped'}</td>
                  <td className="px-3 py-3 font-mono text-xs">{row.amazonSku}</td>
                  <td className="px-3 py-3 font-mono text-xs">{row.componentSku ?? 'Not mapped'}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.unitsSold)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.componentDemandUnits)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.transactionCount)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.grossSales, 2)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.refundUnits)}</td>
                  <td className="px-4 py-3 text-right">{formatNumber(row.refundAmount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredStateDemand.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No aggregated state/zone payment demand matches the current search.
            </div>
          )}
        </div>
        <PaginationControls
          page={safeStateDemandPage}
          totalPages={stateDemandTotalPages}
          pageSize={supportingSignalPageSize}
          totalRows={filteredStateDemand.length}
          onPageChange={setStateDemandPage}
        />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-black">Payment Signal for Replenishment</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Supporting signal only. Estimated margin uses available SKU/component costs and Amazon fee fields; exact GST-aware P&amp;L is deferred.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={sortedPaymentSignals.length === 0}
            onClick={() => exportFilteredCsv(
              'Payment Signal for Replenishment',
              [
                { header: 'Amazon SKU', value: row => row.amazonSku },
                { header: 'Units Sold', value: row => row.unitsSold },
                { header: 'Gross Sales', value: row => row.grossSales },
                { header: 'Refund Units', value: row => row.refundUnits },
                { header: 'Refund Amount', value: row => row.refundAmount },
                { header: 'Amazon Fees', value: row => row.amazonFees },
                { header: 'Cost Available', value: row => row.costAvailable },
                { header: 'Estimated Contribution', value: row => row.estimatedContribution },
                { header: 'Estimated Margin Percent', value: row => row.estimatedMarginPercent },
                { header: 'Priority Flag', value: row => row.priorityFlag },
                { header: 'Note', value: row => row.note },
              ],
              sortedPaymentSignals,
              data.nextStockPlan.assumptions,
              paymentSignalFilterText,
            )}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row">
          <div className="relative max-w-xl flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={paymentSignalQuery}
              onChange={event => setPaymentSignalQuery(event.target.value)}
              placeholder="Search Amazon SKU"
              className="pl-9"
            />
          </div>
          <select
            value={paymentPriority}
            onChange={event => setPaymentPriority(event.target.value as 'All' | PaymentPriority)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            aria-label="Filter payment priority"
          >
            <option value="All">All payment signals</option>
            <option value="profitable_high_demand">Profitable high demand</option>
            <option value="profitable_low_stock">Profitable low stock</option>
            <option value="loss_or_review">Loss or review</option>
            <option value="missing_cost">Missing cost</option>
            <option value="insufficient_data">Insufficient data</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1220px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh label="Amazon SKU" column="amazonSku" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} className="px-4" />
                <SortableTh label="Units sold" column="unitsSold" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Gross sales" column="grossSales" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Refund amount" column="refundAmount" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Amazon fees" column="amazonFees" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Cost available" column="costAvailable" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} />
                <SortableTh label="Est. contribution" column="estimatedContribution" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Est. margin" column="estimatedMarginPercent" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Priority" column="priorityFlag" sort={paymentSignalSort} onSort={column => setPaymentSignalSort(current => toggleSort(current, column))} className="px-4" />
              </tr>
            </thead>
            <tbody>
              {paginatedPaymentSignals.map((row, index) => (
                <tr
                  key={row.amazonSku}
                  className={index < paginatedPaymentSignals.length - 1 ? 'border-b border-border/50' : ''}
                >
                  <td className="px-4 py-3 font-mono text-xs">{row.amazonSku}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.unitsSold)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.grossSales, 2)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.refundAmount, 2)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.amazonFees, 2)}</td>
                  <td className="px-3 py-3">{row.costAvailable ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.estimatedContribution, 2)}</td>
                  <td className="px-3 py-3 text-right">
                    {row.estimatedMarginPercent === null ? '—' : `${formatNumber(row.estimatedMarginPercent, 1)}%`}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-[10px]">
                      {row.priorityFlag.replaceAll('_', ' ')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredPaymentSignals.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No payment signals match the current search and priority filter.
            </div>
          )}
        </div>
        <PaginationControls
          page={safePaymentSignalPage}
          totalPages={paymentSignalTotalPages}
          pageSize={supportingSignalPageSize}
          totalRows={filteredPaymentSignals.length}
          onPageChange={setPaymentSignalPage}
        />
      </div>
        </>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-black">Vendor / Component Replenishment</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                What should I buy from the vendor today? XHZU is the mother warehouse feeding both Seller Flex direct
                fulfilment and FC replenishment shipments, so component demand uses total trusted Amazon demand
                (FBA Ledger Detail shipments + Seller Flex shipments/sales), not Seller Flex sales alone.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={data.flexReplenishmentRows.length === 0}
              onClick={() => exportFilteredCsv(
                'Vendor Component Replenishment',
                [
                  { header: 'Component SKU', value: row => row.componentSku },
                  { header: 'Linked Amazon SKUs', value: row => row.linkedAmazonSkuCount },
                  { header: 'WMS Parent SKU Count', value: row => row.wmsParentSkuCount },
                  { header: '30D Amazon Demand', value: row => row.amazonDemand30d },
                  { header: 'Component Units Required', value: row => row.componentAdjustedDemand },
                  { header: 'Current XHZU Stock', value: row => row.currentXhzuComponentStock },
                  { header: 'Suggested Vendor Qty', value: row => row.suggestedVendorReplenishQty },
                  { header: 'Action', value: row => row.action },
                  { header: 'Reason', value: row => row.reason },
                ],
                data.flexReplenishmentRows,
                data.nextStockPlan.assumptions,
                'report=Vendor/Component Replenishment (full list)',
              )}
            >
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </div>
          <ReportStatCards
            cards={[
              ['Component SKUs required', data.flexReplenishmentSummary.componentSkusToReplenish],
              ['Component units required', data.flexReplenishmentSummary.componentUnitsRequired],
              ['Needs XHZU stock context', data.flexReplenishmentSummary.rowsNeedingXhzuStockContext],
              ['Missing mapping', data.flexReplenishmentSummary.rowsMissingMapping],
              ['Margin review', data.flexReplenishmentSummary.rowsMarginReview],
            ]}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1320px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 text-left">Component SKU</th>
                  <th className="px-3 py-3 text-right">Linked Amazon SKUs</th>
                  <th className="px-3 py-3 text-right">WMS Parent SKU Count</th>
                  <th className="px-3 py-3 text-right">30D Amazon Demand</th>
                  <th className="px-3 py-3 text-right">Component Units Required</th>
                  <th className="px-3 py-3 text-right">Current XHZU Stock</th>
                  <th className="px-3 py-3 text-right">Suggested Vendor Qty</th>
                  <th className="px-3 py-3 text-left">Action</th>
                  <th className="px-4 py-3 text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.flexReplenishmentRows.slice(0, 50).map((row: FlexReplenishmentRow, index, page) => (
                  <tr
                    key={`flex-replenish-${row.componentSku}`}
                    className={index < page.length - 1 ? 'border-b border-border/50' : ''}
                  >
                    <td className="px-4 py-3 font-mono text-xs">{row.componentSku}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.linkedAmazonSkuCount)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.wmsParentSkuCount)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.amazonDemand30d)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.componentAdjustedDemand)}</td>
                    <td className="px-3 py-3 text-right">
                      {row.currentXhzuComponentStock === null ? '—' : formatNumber(row.currentXhzuComponentStock)}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold">
                      {row.suggestedVendorReplenishQty === null ? '—' : formatNumber(row.suggestedVendorReplenishQty)}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className="text-[10px]">{row.action.replaceAll('_', ' ')}</Badge>
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-xs text-muted-foreground">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.flexReplenishmentRows.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No Vendor/Component replenishment rows are available yet.
              </div>
            )}
          </div>
          {data.flexReplenishmentRows.length > 50 && (
            <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
              Showing top 50 of {data.flexReplenishmentRows.length.toLocaleString('en-IN')} rows. Export CSV for the full list.
            </div>
          )}
        </div>
      )}

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
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground">
              Matching {filteredActions.length.toLocaleString('en-IN')} of {data.actions.length.toLocaleString('en-IN')} products
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={filteredActions.length === 0}
              onClick={() => exportFilteredCsv(
                'Stock Actions',
                [
                  { header: 'Product Title', value: row => row.title },
                  { header: 'ASIN', value: row => row.asin },
                  { header: 'SKU', value: row => row.sku },
                  { header: 'Available Stock', value: row => row.available },
                  { header: 'Inbound Stock', value: row => row.inbound },
                  { header: 'Sales', value: row => row.units30d },
                  { header: 'Velocity Per Day', value: row => row.velocityPerDay },
                  { header: 'Days Cover', value: row => row.daysCover },
                  { header: 'Suggested Quantity', value: row => row.suggestedReorder },
                  { header: 'Status', value: row => row.status },
                  { header: 'Inventory Source', value: row => row.inventorySource },
                  { header: 'Sales Source', value: row => row.salesSource },
                  { header: 'Reason', value: row => row.action },
                ],
                sortedActions,
                data.nextStockPlan.assumptions,
                actionFilterText,
              )}
            >
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1340px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh label="Product" column="title" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} className="px-4" />
                <SortableTh label="ASIN / SKU" column="asin" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} />
                <SortableTh label="Available" column="available" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Inbound" column="inbound" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="30d Sales" column="units30d" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Velocity/day" column="velocityPerDay" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Days Cover" column="daysCover" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Suggested Reorder" column="suggestedReorder" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} align="right" />
                <SortableTh label="Status" column="status" sort={actionsSort} onSort={column => setActionsSort(current => toggleSort(current, column))} />
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
