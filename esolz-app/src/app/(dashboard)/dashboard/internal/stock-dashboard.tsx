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
      demandDays: number
      demandStartDate: string
      demandEndDate: string
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
    currentFcStockSource: 'location_inventory' | 'ledger_balance_approx' | 'missing'
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
    rowsUsingLedgerFallback: number
    rowsInboundNotIncluded: number
    rowsMarginReview: number
  }
  flexReplenishmentRows: Array<{
    componentSku: string
    wmsParentSkuCount: number
    linkedAmazonSkuCount: number
    amazonDemand30d: number
    fbaFc30dUnits: number
    xhzuFlex30dUnits: number
    demandSourceUsed: string
    componentAdjustedDemand: number
    dailyComponentVelocity: number
    growthFactor: number
    targetStockDays: number
    requiredComponentStock: number
    currentXhzuComponentStock: number | null
    suggestedVendorReplenishQty: number | null
    confidenceStatus: 'high' | 'medium' | 'low'
    action: 'send_to_vendor' | 'monitor' | 'needs_xhzu_stock_context' | 'no_recent_demand'
    reason: string
    stateZoneSignal: string | null
    paymentSignal: ReplenishmentPaymentSignalSummary | null
    sellerCentralPeriodUnits: number
    sellerCentralComponentUnits: number
    planningComponentUnitsUsed: number
    planningDemandSource: 'trusted_fulfillment' | 'seller_central_uploaded' | 'seller_central_missing_fallback_trusted' | 'seller_central_period_mismatch_fallback_trusted'
  }>
  flexReplenishmentSummary: {
    rows: number
    componentsWithDemand: number
    componentUnitsDemanded: number
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
  fcFulfillmentRows: Array<{
    componentSku: string
    currentXhzuComponentStock: number
    fcComponentRequirement: number
    componentShortage: number
    componentSurplus: number
    coveragePercent: number
    linkedAmazonSkuCount: number
    fastestSellingAmazonSku: string | null
    allocatableFinishedUnitsNow: number
    shortFinishedUnits: number
    amazonRecommendationStatus: 'not_connected' | 'not_available' | 'pending_fetch' | 'available'
    action: 'fully_covered' | 'partially_covered' | 'no_requirement'
    reason: string
  }>
  fcAllocationCsvRows: Array<{
    componentSku: string
    amazonSku: string
    fcCode: string
    skuDemand30d: number
    fcDemand30d: number
    requiredSendUnits: number
    componentQtyPerUnit: number
    componentUnitsRequired: number
    currentXhzuComponentStock: number
    allocatedSendUnitsNow: number
    unfulfilledSendUnits: number
    amazonRecommendedQty: number | null
    amazonRecommendationStatus: 'not_connected' | 'not_available' | 'pending_fetch' | 'available'
    allocationPriority: number
    reason: string
  }>
  fcFulfillmentSummary: {
    fcUnitsRequested: number
    fcUnitsAllocatableNow: number
    finishedUnitsShort: number
    componentUnitsShort: number
    componentsConstrained: number
    amazonRecommendationsSynced: number
    amazonRecommendationsNotSynced: number
  }
  activeXhzuBatch: {
    originalFilename: string
    uploadedBy: string | null
    uploadedAt: string
    acceptedCount: number
    rejectedCount: number
  } | null
  assumptionsSource: {
    flex: 'default' | 'saved'
    fc: 'default' | 'saved'
  }
  activeSellerCentralBatch: {
    originalFilename: string
    uploadedAt: string
    reportStartDate: string | null
    reportEndDate: string | null
    periodLabel: string | null
    acceptedCount: number
    rejectedCount: number
  } | null
  sellerCentralPeriodMatch: boolean
  flexDemandBreakdownRows: Array<{
    componentSku: string
    amazonSku: string
    wmsParentSku: string | null
    amazonDemand30d: number
    fbaDemand30d: number
    sellerFlexDemand30d: number
    componentQuantityPerAmazonUnit: number
    componentUnitsRequiredContribution: number
    demandSourceLabel: string
    matchStatus:
      | 'Matched with trusted demand'
      | 'Mapped but no trusted demand'
      | 'Mapped but only untrusted/non-FBA demand'
      | 'SKU mismatch / no demand source match'
    reason: string
    sellerCentralPeriodUnits: number
    sellerCentralComponentUnits: number
    planningComponentUnitsUsed: number
    planningDemandSource: 'trusted_fulfillment' | 'seller_central_uploaded' | 'seller_central_missing_fallback_trusted' | 'seller_central_period_mismatch_fallback_trusted'
  }>
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
    component_mapping_rows: number
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

type XhzuStockImportResult = {
  written: boolean
  parsedRows: number
  acceptedRows: number
  rejectedRows: number
  insertedCount: number
  updatedCount: number
}

type SellerCentralSalesUploadResult = {
  accepted: number
  rejected: number
  batchId: string
  reportStartDate: string | null
  reportEndDate: string | null
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

type DemandPreset = '7d' | '15d' | '30d' | '45d' | '60d' | 'custom'

type PlanningAssumptions = {
  lookbackDays: 7 | 15 | 30 | 45 | 60 | 90
  planningCycleDays: 15 | 30 | 45 | 60 | 90
  transitBufferDays: 7 | 15 | 21 | 30
  growthMultiplier: 1 | 1.25 | 1.5 | 2
  demandPreset: DemandPreset
  demandStartDate?: string
  demandEndDate?: string
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
  demandPreset: '30d',
}

type FcReplenishmentRow = StockResponse['fcReplenishmentRows'][number]
type FlexReplenishmentRow = StockResponse['flexReplenishmentRows'][number]
type FlexDemandBreakdownRow = StockResponse['flexDemandBreakdownRows'][number]
type FcStockMatrixRow = StockResponse['fcStockMatrixRows'][number]
type FcStockMatrixCell = FcStockMatrixRow['fcCells'][number]
type FcFulfillmentRow = StockResponse['fcFulfillmentRows'][number]
type FcAllocationCsvRow = StockResponse['fcAllocationCsvRows'][number]
type AmazonRecommendationStatus = FcAllocationCsvRow['amazonRecommendationStatus']
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

function flexActionLabel(action: 'send_to_vendor' | 'monitor' | 'needs_xhzu_stock_context' | 'no_recent_demand'): string {
  switch (action) {
    case 'needs_xhzu_stock_context':
      return 'Demand known · Add XHZU stock'
    case 'no_recent_demand':
      return 'No recent demand'
    case 'send_to_vendor':
      return 'Send to vendor'
    case 'monitor':
      return 'Monitor'
  }
}

function fcFulfillmentActionLabel(action: FcFulfillmentRow['action']): string {
  switch (action) {
    case 'fully_covered':
      return 'Fully covered'
    case 'partially_covered':
      return 'Stock short'
    case 'no_requirement':
      return 'No requirement'
  }
}

function amazonRecommendationStatusLabel(status: AmazonRecommendationStatus): string {
  switch (status) {
    case 'available':
      return 'Synced'
    case 'pending_fetch':
      return 'Amazon recommendation not synced yet'
    case 'not_connected':
      return 'Amazon account not connected'
    case 'not_available':
      return 'Not available from Amazon'
  }
}

function formatDemandPeriodLabel(demandDays: number, startDate: string, endDate: string): string {
  const presetMap: Record<number, string> = { 7: '7D', 15: '15D', 30: '30D', 45: '45D', 60: '60D', 90: '90D' }
  if (presetMap[demandDays]) return presetMap[demandDays]
  const fmt = (iso: string) => {
    const parts = iso.split('-')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${Number(parts[2])} ${months[Number(parts[1]) - 1]}`
  }
  return `${fmt(startDate)}–${fmt(endDate)}`
}

function exportFcAllocationPlanCsv(rows: FcAllocationCsvRow[], salesLookbackDays: number) {
  const columns: CsvColumn<FcAllocationCsvRow>[] = [
    { header: 'Component SKU', value: row => row.componentSku },
    { header: 'Amazon SKU', value: row => row.amazonSku },
    { header: 'FC / Warehouse', value: row => row.fcCode },
    { header: `${salesLookbackDays}D SKU Demand`, value: row => row.skuDemand30d },
    { header: `${salesLookbackDays}D FC Demand`, value: row => row.fcDemand30d },
    { header: 'Required Send Units', value: row => row.requiredSendUnits },
    { header: 'Component Qty Per Unit', value: row => row.componentQtyPerUnit },
    { header: 'Component Units Required', value: row => row.componentUnitsRequired },
    { header: 'Current XHZU Component Stock', value: row => row.currentXhzuComponentStock },
    { header: 'Allocated Send Units Now', value: row => row.allocatedSendUnitsNow },
    { header: 'Unfulfilled Send Units', value: row => row.unfulfilledSendUnits },
    { header: 'Amazon Recommended Qty', value: row => row.amazonRecommendedQty },
    { header: 'Amazon Recommendation Status', value: row => amazonRecommendationStatusLabel(row.amazonRecommendationStatus) },
    { header: 'Allocation Priority', value: row => row.allocationPriority },
    { header: 'Reason', value: row => row.reason },
  ]

  const generatedAt = new Date().toISOString()
  const csv = [
    columns.map(column => csvCell(column.header)).join(','),
    ...rows.map(row => columns.map(column => csvCell(column.value(row))).join(',')),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `fc-allocation-plan-${generatedAt.slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function exportFlexPurchasePlanCsv(rows: FlexReplenishmentRow[], periodLabel: string) {
  const sortedRows = [...rows].sort((a, b) => {
    const sentA = a.suggestedVendorReplenishQty ?? 0
    const sentB = b.suggestedVendorReplenishQty ?? 0
    if (sentA !== sentB) return sentB - sentA
    if (a.componentAdjustedDemand !== b.componentAdjustedDemand) {
      return b.componentAdjustedDemand - a.componentAdjustedDemand
    }
    return b.amazonDemand30d - a.amazonDemand30d
  })

  const columns: CsvColumn<FlexReplenishmentRow>[] = [
    { header: 'Component SKU', value: row => row.componentSku },
    { header: 'Linked Amazon SKUs Count', value: row => row.linkedAmazonSkuCount },
    { header: 'WMS Parent SKU Count', value: row => row.wmsParentSkuCount },
    { header: `FBA/FC ${periodLabel} Finished Units`, value: row => row.fbaFc30dUnits },
    { header: `XHZU/Flex ${periodLabel} Finished Units`, value: row => row.xhzuFlex30dUnits },
    { header: `Total Trusted ${periodLabel} Finished Units`, value: row => row.amazonDemand30d },
    { header: `${periodLabel} Component Units Sold`, value: row => row.componentAdjustedDemand },
    { header: `SC ${periodLabel} Finished Units`, value: row => row.sellerCentralPeriodUnits },
    { header: `SC ${periodLabel} Component Units`, value: row => row.sellerCentralComponentUnits },
    { header: `Planning ${periodLabel} Component Units Used`, value: row => row.planningComponentUnitsUsed },
    { header: 'Planning Demand Source', value: row => row.planningDemandSource },
    { header: 'Current XHZU Stock', value: row => row.currentXhzuComponentStock },
    { header: 'Required Component Stock', value: row => row.requiredComponentStock },
    { header: 'Suggested Vendor Qty', value: row => row.suggestedVendorReplenishQty },
    { header: 'Demand Source Used', value: row => row.demandSourceUsed },
    { header: 'Action Label', value: row => flexActionLabel(row.action) },
    { header: 'Reason', value: row => row.reason },
  ]

  const generatedAt = new Date().toISOString()
  const csv = [
    columns.map(column => csvCell(column.header)).join(','),
    ...sortedRows.map(row => columns.map(column => csvCell(column.value(row))).join(',')),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `flex-vendor-purchase-plan-${generatedAt.slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function exportFlexDemandBreakdownCsv(rows: FlexDemandBreakdownRow[], periodLabel: string) {
  const columns: CsvColumn<FlexDemandBreakdownRow>[] = [
    { header: 'Component SKU', value: row => row.componentSku },
    { header: 'Amazon SKU', value: row => row.amazonSku },
    { header: 'WMS Parent SKU', value: row => row.wmsParentSku },
    { header: 'Component Qty Per Unit', value: row => row.componentQuantityPerAmazonUnit },
    { header: `FBA/FC ${periodLabel} Units`, value: row => row.fbaDemand30d },
    { header: `XHZU/Flex ${periodLabel} Units`, value: row => row.sellerFlexDemand30d },
    { header: `Total Trusted ${periodLabel} Units`, value: row => row.amazonDemand30d },
    { header: 'Component Units Sold', value: row => row.componentUnitsRequiredContribution },
    { header: `SC ${periodLabel} Finished Units`, value: row => row.sellerCentralPeriodUnits },
    { header: `SC ${periodLabel} Component Units`, value: row => row.sellerCentralComponentUnits },
    { header: `Planning ${periodLabel} Component Units Used`, value: row => row.planningComponentUnitsUsed },
    { header: 'Planning Demand Source', value: row => row.planningDemandSource },
    { header: 'Match Status', value: row => row.matchStatus },
    { header: 'Reason', value: row => row.reason },
  ]

  const generatedAt = new Date().toISOString()
  const csv = [
    columns.map(column => csvCell(column.header)).join(','),
    ...rows.map(row => columns.map(column => csvCell(column.value(row))).join(',')),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `flex-demand-breakdown-${generatedAt.slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export function InternalStockDashboard() {
  const [data, setData] = useState<StockResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'All' | StockStatus>('All')
  const [planFilter, setPlanFilter] = useState<PlanFilterId | null>(null)
  const [activeTab, setActiveTab] = useState<'fc' | 'flex'>('fc')
  const [showZeroDemandFlexRows, setShowZeroDemandFlexRows] = useState(false)
  const [planningDraft, setPlanningDraft] = useState<PlanningAssumptions>(DEFAULT_PLANNING_ASSUMPTIONS)
  const [planningAssumptions, setPlanningAssumptions] = useState<PlanningAssumptions>(DEFAULT_PLANNING_ASSUMPTIONS)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const [planPage, setPlanPage] = useState(1)
  const [fcDiagnosticsPage, setFcDiagnosticsPage] = useState(1)
  const [actionsPage, setActionsPage] = useState(1)
  const [stateDemandPage, setStateDemandPage] = useState(1)
  const [paymentSignalPage, setPaymentSignalPage] = useState(1)
  const [fcStockMatrixPage, setFcStockMatrixPage] = useState(1)
  const [fcFulfillmentPage, setFcFulfillmentPage] = useState(1)
  const [flexPage, setFlexPage] = useState(1)
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
  const [xhzuUploading, setXhzuUploading] = useState(false)
  const [xhzuUploadError, setXhzuUploadError] = useState<string | null>(null)
  const [xhzuUploadResult, setXhzuUploadResult] = useState<XhzuStockImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhzuFileInputRef = useRef<HTMLInputElement>(null)
  const scFileInputRef = useRef<HTMLInputElement>(null)
  const [scUploading, setScUploading] = useState(false)
  const [scUploadError, setScUploadError] = useState<string | null>(null)
  const [scUploadResult, setScUploadResult] = useState<SellerCentralSalesUploadResult | null>(null)
  const [scReportStartDate, setScReportStartDate] = useState('')
  const [scReportEndDate, setScReportEndDate] = useState('')

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
      if (
        planningAssumptions.demandPreset === 'custom'
        && planningAssumptions.demandStartDate
        && planningAssumptions.demandEndDate
        && planningAssumptions.demandStartDate <= planningAssumptions.demandEndDate
      ) {
        params.set('demandStartDate', planningAssumptions.demandStartDate)
        params.set('demandEndDate', planningAssumptions.demandEndDate)
      }
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

  const uploadXhzuStock = useCallback(async (file: File) => {
    setXhzuUploading(true)
    setXhzuUploadError(null)
    setXhzuUploadResult(null)

    try {
      const body = new FormData()
      body.set('file', file)
      const response = await fetch('/api/internal/stock-actions/xhzu-stock/import', {
        method: 'POST',
        body,
        credentials: 'same-origin',
      })
      const result = await response.json() as XhzuStockImportResult & { error?: string }
      if (!response.ok) {
        throw new Error(result.error ?? 'XHZU stock upload failed.')
      }
      setXhzuUploadResult(result)
      if (result.acceptedRows > 0) await load()
    } catch (uploadFailure) {
      setXhzuUploadError(uploadFailure instanceof Error ? uploadFailure.message : 'XHZU stock upload failed.')
    } finally {
      setXhzuUploading(false)
      if (xhzuFileInputRef.current) xhzuFileInputRef.current.value = ''
    }
  }, [load])

  const downloadXhzuStockTemplate = useCallback(() => {
    const csv = 'component_sku,location_code,available_quantity,reserved_quantity,inbound_quantity\r\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'internal-xhzu-stock-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const downloadSellerCentralTemplate = useCallback(() => {
    const csv = 'sku,units_sold,asin,title\r\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'seller-central-sales-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const uploadSellerCentralSales = useCallback(async (file: File) => {
    setScUploading(true)
    setScUploadError(null)
    setScUploadResult(null)

    try {
      const body = new FormData()
      body.set('file', file)
      if (scReportStartDate) body.set('reportStartDate', scReportStartDate)
      if (scReportEndDate) body.set('reportEndDate', scReportEndDate)
      const response = await fetch('/api/internal/stock-actions/seller-central-sales/import', {
        method: 'POST',
        body,
        credentials: 'same-origin',
      })
      const result = await response.json() as SellerCentralSalesUploadResult & { error?: string }
      if (!response.ok) {
        throw new Error(result.error ?? 'Seller Central sales upload failed.')
      }
      setScUploadResult(result)
      if (result.accepted > 0) await load()
    } catch (uploadFailure) {
      setScUploadError(uploadFailure instanceof Error ? uploadFailure.message : 'Seller Central sales upload failed.')
    } finally {
      setScUploading(false)
      if (scFileInputRef.current) scFileInputRef.current.value = ''
    }
  }, [load, scReportStartDate, scReportEndDate])

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

  const visibleFlexRows = useMemo(() => {
    const rows = data?.flexReplenishmentRows ?? []
    return showZeroDemandFlexRows ? rows : rows.filter(row => row.componentAdjustedDemand > 0)
  }, [data?.flexReplenishmentRows, showZeroDemandFlexRows])

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

  useEffect(() => {
    setFlexPage(1)
  }, [showZeroDemandFlexRows])

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
  const fcStockMatrixPageSize = 20
  const fcStockMatrixTotalPages = Math.max(1, Math.ceil((data?.fcStockMatrixRows.length ?? 0) / fcStockMatrixPageSize))
  const safeFcStockMatrixPage = Math.min(fcStockMatrixPage, fcStockMatrixTotalPages)
  const paginatedFcStockMatrixRows = (data?.fcStockMatrixRows ?? []).slice(
    (safeFcStockMatrixPage - 1) * fcStockMatrixPageSize,
    safeFcStockMatrixPage * fcStockMatrixPageSize,
  )
  const fcFulfillmentPageSize = 20
  const fcFulfillmentTotalPages = Math.max(1, Math.ceil((data?.fcFulfillmentRows.length ?? 0) / fcFulfillmentPageSize))
  const safeFcFulfillmentPage = Math.min(fcFulfillmentPage, fcFulfillmentTotalPages)
  const paginatedFcFulfillmentRows = (data?.fcFulfillmentRows ?? []).slice(
    (safeFcFulfillmentPage - 1) * fcFulfillmentPageSize,
    safeFcFulfillmentPage * fcFulfillmentPageSize,
  )
  const flexPageSize = 20
  const flexTotalPages = Math.max(1, Math.ceil(visibleFlexRows.length / flexPageSize))
  const safeFlexPage = Math.min(flexPage, flexTotalPages)
  const paginatedFlexRows = visibleFlexRows.slice(
    (safeFlexPage - 1) * flexPageSize,
    safeFlexPage * flexPageSize,
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
    data.diagnostics.component_mapping_rows === 0
      ? 'No SKU-to-warehouse component mapping data found. Vendor/Component (Flex) replenishment cannot be calculated until mappings are imported.'
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <label className="text-xs font-medium text-muted-foreground">
            Demand period
            <select
              value={planningDraft.demandPreset}
              onChange={event => {
                const preset = event.target.value as DemandPreset
                const presetToLookback: Record<Exclude<DemandPreset, 'custom'>, PlanningAssumptions['lookbackDays']> = {
                  '7d': 7, '15d': 15, '30d': 30, '45d': 45, '60d': 60,
                }
                setPlanningDraft(current => ({
                  ...current,
                  demandPreset: preset,
                  ...(preset !== 'custom' ? { lookbackDays: presetToLookback[preset] } : {}),
                }))
              }}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="7d">Last 7 days</option>
              <option value="15d">Last 15 days</option>
              <option value="30d">Last 30 days</option>
              <option value="45d">Last 45 days</option>
              <option value="60d">Last 60 days</option>
              <option value="custom">Custom range…</option>
            </select>
          </label>
          {planningDraft.demandPreset === 'custom' && (
            <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
              Custom date range
              <div className="mt-1 flex gap-2">
                <input
                  type="date"
                  value={planningDraft.demandStartDate ?? ''}
                  onChange={event => setPlanningDraft(current => ({ ...current, demandStartDate: event.target.value }))}
                  className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  placeholder="Start date"
                />
                <span className="flex items-center text-muted-foreground">–</span>
                <input
                  type="date"
                  value={planningDraft.demandEndDate ?? ''}
                  onChange={event => setPlanningDraft(current => ({ ...current, demandEndDate: event.target.value }))}
                  className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  placeholder="End date"
                />
              </div>
            </label>
          )}
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
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              FC stock is blank where FC stock source is unavailable. Inbound shipment quantity is not included yet.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Planning assumptions: {data.assumptionsSource.fc === 'saved' ? 'Saved for this workspace' : 'Default (not yet saved)'}.
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
                { header: `Total ${data.nextStockPlan.assumptions.salesLookbackDays}D Demand`, value: row => row.totalDemand30d },
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
            ['Stock approx. via ledger', data.fcReplenishmentSummary.rowsUsingLedgerFallback],
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
                <th className="px-3 py-3 text-right">Total {data.nextStockPlan.assumptions.salesLookbackDays}D Demand</th>
                <th className="px-3 py-3 text-right">XHZU/Flex Stock</th>
                <th className="px-3 py-3 text-right">Total Send Qty</th>
                {data.fcStockMatrixColumns.map(fcCode => (
                  <th key={fcCode} className="px-3 py-3 text-left font-mono">{fcCode}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedFcStockMatrixRows.map((row: FcStockMatrixRow, index, page) => {
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
        <PaginationControls
          page={safeFcStockMatrixPage}
          totalPages={fcStockMatrixTotalPages}
          pageSize={fcStockMatrixPageSize}
          totalRows={data.fcStockMatrixRows.length}
          onPageChange={setFcStockMatrixPage}
        />
      </div>
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black">Complete FC Fulfilment &amp; XHZU Allocation</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Shows how much of the FC replenishment plan can be completed from current XHZU stock, what is short,
              and which SKUs/FCs should be filled first.
            </p>
          </div>
          <Button
            type="button"
            disabled={data.fcAllocationCsvRows.length === 0}
            onClick={() => exportFcAllocationPlanCsv(data.fcAllocationCsvRows, data.nextStockPlan.assumptions.salesLookbackDays)}
          >
            <Download className="mr-2 h-4 w-4" /> Export FC Allocation Plan
          </Button>
        </div>
        <ReportStatCards
          cards={[
            ['FC units requested', data.fcFulfillmentSummary.fcUnitsRequested],
            ['FC units allocatable now', data.fcFulfillmentSummary.fcUnitsAllocatableNow],
            ['Finished units short', data.fcFulfillmentSummary.finishedUnitsShort],
            ['Component units short', data.fcFulfillmentSummary.componentUnitsShort],
            ['Components constrained', data.fcFulfillmentSummary.componentsConstrained],
            ['Amazon recommendations synced', data.fcFulfillmentSummary.amazonRecommendationsSynced],
            ['Amazon recommendations not synced', data.fcFulfillmentSummary.amazonRecommendationsNotSynced],
          ]}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1380px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Component SKU</th>
                <th className="px-3 py-3 text-right">Current XHZU Stock</th>
                <th className="px-3 py-3 text-right">FC Component Requirement</th>
                <th className="px-3 py-3 text-right">Component Shortage</th>
                <th className="px-3 py-3 text-right">Coverage %</th>
                <th className="px-3 py-3 text-right">Linked Amazon SKUs</th>
                <th className="px-3 py-3 text-left">Fastest Selling SKU</th>
                <th className="px-3 py-3 text-right">Allocatable Finished Units Now</th>
                <th className="px-3 py-3 text-right">Short Finished Units</th>
                <th className="px-3 py-3 text-left">Amazon Recommendation Status</th>
                <th className="px-3 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {paginatedFcFulfillmentRows.map((row: FcFulfillmentRow, index, page) => (
                <tr
                  key={`fc-fulfillment-${row.componentSku}`}
                  className={index < page.length - 1 ? 'border-b border-border/50' : ''}
                >
                  <td className="px-4 py-3 font-mono text-xs">{row.componentSku}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.currentXhzuComponentStock)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.fcComponentRequirement)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.componentShortage)}</td>
                  <td className="px-3 py-3 text-right">{row.coveragePercent}%</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.linkedAmazonSkuCount)}</td>
                  <td className="px-3 py-3 font-mono text-xs">{row.fastestSellingAmazonSku ?? '—'}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.allocatableFinishedUnitsNow)}</td>
                  <td className="px-3 py-3 text-right">{formatNumber(row.shortFinishedUnits)}</td>
                  <td className="px-3 py-3 text-xs">{amazonRecommendationStatusLabel(row.amazonRecommendationStatus)}</td>
                  <td className="px-3 py-3">
                    <Badge variant="outline" className="text-[10px]">{fcFulfillmentActionLabel(row.action)}</Badge>
                  </td>
                  <td className="max-w-[280px] px-4 py-3 text-xs text-muted-foreground">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.fcFulfillmentRows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No component-mapped FC requirement yet. Import SKU-to-component mappings and XHZU stock to see allocation.
            </div>
          )}
        </div>
        <PaginationControls
          page={safeFcFulfillmentPage}
          totalPages={fcFulfillmentTotalPages}
          pageSize={fcFulfillmentPageSize}
          totalRows={data.fcFulfillmentRows.length}
          onPageChange={setFcFulfillmentPage}
        />
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
              Ledger balance is diagnostic from the FBA Ledger Detail report and is not used in this Next Stock Plan
              table. It is used as an approximate fallback for FC-level stock only in FC Stock Matrix rows where
              location-level inventory has not synced yet (see Stock Source/Reason there).
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
              Ledger balance shown here is approximate. It is also used as a fallback for FC Stock Matrix rows above
              when location-level FC inventory is not available; those rows are labelled in their Reason text.
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
        <>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="font-bold">Upload XHZU Component Stock</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Upload current XHZU/component stock so suggested vendor replenishment can be calculated.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                CSV columns: component_sku,location_code,available_quantity,reserved_quantity,inbound_quantity
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={downloadXhzuStockTemplate}>
                <Download className="mr-2 h-4 w-4" /> Download template
              </Button>
              <Button
                type="button"
                onClick={() => xhzuFileInputRef.current?.click()}
                disabled={xhzuUploading}
              >
                {xhzuUploading
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Upload className="mr-2 h-4 w-4" />}
                {xhzuUploading ? 'Importing…' : 'Import XHZU stock'}
              </Button>
              <input
                ref={xhzuFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) void uploadXhzuStock(file)
                }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
            {data.activeXhzuBatch ? (
              <>
                <p className="font-medium">
                  Last XHZU upload: <span className="font-mono text-xs">{data.activeXhzuBatch.originalFilename}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Uploaded at {formatDate(data.activeXhzuBatch.uploadedAt)}
                  {data.activeXhzuBatch.uploadedBy ? ` by ${data.activeXhzuBatch.uploadedBy}` : ''} ·{' '}
                  Accepted {data.activeXhzuBatch.acceptedCount.toLocaleString('en-IN')} rows
                  {data.activeXhzuBatch.rejectedCount > 0
                    ? ` · Rejected ${data.activeXhzuBatch.rejectedCount.toLocaleString('en-IN')}`
                    : ''}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This stock file is currently used for suggested vendor quantity.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No XHZU stock file has been uploaded yet.</p>
            )}
          </div>

          {xhzuUploadError && (
            <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {xhzuUploadError}
            </div>
          )}

          {xhzuUploadResult && (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
              <p className="font-medium">
                Parsed {xhzuUploadResult.parsedRows.toLocaleString('en-IN')} rows ·{' '}
                Accepted {xhzuUploadResult.acceptedRows.toLocaleString('en-IN')} ·{' '}
                Rejected {xhzuUploadResult.rejectedRows.toLocaleString('en-IN')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Inserted {xhzuUploadResult.insertedCount.toLocaleString('en-IN')} ·{' '}
                Updated {xhzuUploadResult.updatedCount.toLocaleString('en-IN')}
              </p>
              {xhzuUploadResult.rejectedRows > 0 && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {xhzuUploadResult.rejectedRows.toLocaleString('en-IN')} row(s) were rejected. Check the CSV format and try again.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="font-bold">Upload Seller Central Sales Demand</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Upload Seller Central Manage Inventory demand export to use as planning source when its units exceed trusted FBA/Flex ledger demand.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Required CSV columns: sku, units_sold. Optional: asin, title.
                Also accepted: merchant_sku / seller_sku / amazon_sku, units_ordered / ordered_units / units_sold_last_30_days.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Optionally enter the report date range so the tool can verify the period matches your selected demand window.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={downloadSellerCentralTemplate}>
                <Download className="mr-2 h-4 w-4" /> Download template
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-muted-foreground">
              Report start date (optional)
              <input
                type="date"
                value={scReportStartDate}
                onChange={event => setScReportStartDate(event.target.value)}
                className="mt-1 h-9 w-44 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Report end date (optional)
              <input
                type="date"
                value={scReportEndDate}
                onChange={event => setScReportEndDate(event.target.value)}
                className="mt-1 h-9 w-44 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
            </label>
            <Button
              type="button"
              onClick={() => scFileInputRef.current?.click()}
              disabled={scUploading}
            >
              {scUploading
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Upload className="mr-2 h-4 w-4" />}
              {scUploading ? 'Importing…' : 'Import SC sales'}
            </Button>
            <input
              ref={scFileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0]
                if (file) void uploadSellerCentralSales(file)
              }}
            />
          </div>

          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
            {data.activeSellerCentralBatch ? (
              <>
                <p className="font-medium">
                  Active SC batch: <span className="font-mono text-xs">{data.activeSellerCentralBatch.originalFilename}</span>
                  {data.sellerCentralPeriodMatch
                    ? <span className="ml-2 text-xs text-green-700 dark:text-green-400">· Period matches selected demand window</span>
                    : <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">· Period does not match selected demand window — planning falls back to trusted demand</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Uploaded at {formatDate(data.activeSellerCentralBatch.uploadedAt)} ·{' '}
                  {data.activeSellerCentralBatch.reportStartDate && data.activeSellerCentralBatch.reportEndDate
                    ? `Period: ${data.activeSellerCentralBatch.reportStartDate} to ${data.activeSellerCentralBatch.reportEndDate} · `
                    : 'No period dates stored · '}
                  Accepted {data.activeSellerCentralBatch.acceptedCount.toLocaleString('en-IN')} rows
                  {data.activeSellerCentralBatch.rejectedCount > 0
                    ? ` · Rejected ${data.activeSellerCentralBatch.rejectedCount.toLocaleString('en-IN')}`
                    : ''}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No Seller Central sales file uploaded yet. Upload one to enable SC-based planning.</p>
            )}
          </div>

          {scUploadError && (
            <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {scUploadError}
            </div>
          )}

          {scUploadResult && (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm">
              <p className="font-medium">
                Accepted {scUploadResult.accepted.toLocaleString('en-IN')} rows ·{' '}
                Rejected {scUploadResult.rejected.toLocaleString('en-IN')} rows
              </p>
              {scUploadResult.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {scUploadResult.errors.map(errorItem => (
                    <li key={`${errorItem.row}-${errorItem.message}`}>Row {errorItem.row}: {errorItem.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-black">Vendor / Component Replenishment</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                What should I buy from the vendor today? XHZU is the mother warehouse feeding both Seller Flex direct
                fulfilment and FC replenishment shipments, so component demand uses total trusted Amazon demand
                (FBA Ledger Detail shipments + Seller Flex shipments/sales), not Seller Flex sales alone.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Demand period: <strong>{formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate)}</strong> ({data.nextStockPlan.assumptions.demandDays} days, {data.nextStockPlan.assumptions.demandStartDate} to {data.nextStockPlan.assumptions.demandEndDate}).
                Change the demand period in Planning assumptions above.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Trusted demand = FBA/FC ledger shipped units + XHZU/Seller Flex dispatched units for the selected period.
                Easy Ship, MFN, and unattributed sources are excluded unless explicitly enabled.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                If a Seller Central sales file is uploaded and its period matches the selected demand window,
                SC demand is used for planning instead of trusted demand. Trusted demand is the fallback when SC is not uploaded or the period does not match.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Component Units Consumed = sum across linked Amazon SKUs of (that SKU&apos;s period units × component quantity).
                Required Component Stock is the forecasted stock target (daily rate × planning + transit days × growth),
                and Suggested Vendor Qty is that target minus Current XHZU Stock.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Planning assumptions: {data.assumptionsSource.flex === 'saved' ? 'Saved for this workspace' : 'Default (not yet saved)'}.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowZeroDemandFlexRows(current => !current)}
              >
                {showZeroDemandFlexRows ? 'Hide zero-demand mapped components' : 'Show zero-demand mapped components'}
              </Button>
              <Button
                type="button"
                disabled={data.flexReplenishmentRows.length === 0}
                onClick={() => exportFlexPurchasePlanCsv(data.flexReplenishmentRows, formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate))}
              >
                <Download className="mr-2 h-4 w-4" /> Export Purchase Plan
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={data.flexReplenishmentRows.length === 0}
                onClick={() => {
                  const pl = formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate)
                  exportFilteredCsv(
                    'Vendor Component Replenishment',
                    [
                      { header: 'Component SKU', value: row => row.componentSku },
                      { header: 'Linked Amazon SKUs Count', value: row => row.linkedAmazonSkuCount },
                      { header: 'WMS Parent SKU Count', value: row => row.wmsParentSkuCount },
                      { header: `FBA/FC ${pl} Finished Units`, value: row => row.fbaFc30dUnits },
                      { header: `XHZU/Flex ${pl} Finished Units`, value: row => row.xhzuFlex30dUnits },
                      { header: `Total Trusted ${pl} Finished Units`, value: row => row.amazonDemand30d },
                      { header: `${pl} Component Units Sold`, value: row => row.componentAdjustedDemand },
                      { header: `SC ${pl} Finished Units`, value: row => row.sellerCentralPeriodUnits },
                      { header: `SC ${pl} Component Units`, value: row => row.sellerCentralComponentUnits },
                      { header: `Planning ${pl} Component Units Used`, value: row => row.planningComponentUnitsUsed },
                      { header: 'Planning Demand Source', value: row => row.planningDemandSource },
                      { header: 'Current XHZU Stock', value: row => row.currentXhzuComponentStock },
                      { header: 'Required Component Stock', value: row => row.requiredComponentStock },
                      { header: 'Suggested Vendor Qty', value: row => row.suggestedVendorReplenishQty },
                      { header: 'Demand Source Used', value: row => row.demandSourceUsed },
                      { header: 'Action', value: row => row.action },
                      { header: 'Reason', value: row => row.reason },
                    ],
                    data.flexReplenishmentRows,
                    data.nextStockPlan.assumptions,
                    'report=Vendor/Component Replenishment (full list)',
                  )
                }}
              >
                <Download className="mr-2 h-4 w-4" /> Export Full CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={data.flexDemandBreakdownRows.length === 0}
                onClick={() => exportFlexDemandBreakdownCsv(data.flexDemandBreakdownRows, formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate))}
              >
                <Download className="mr-2 h-4 w-4" /> Export Demand Breakdown
              </Button>
            </div>
          </div>
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Use Export Purchase Plan for daily vendor ordering. Full CSV remains available for diagnostics.
          </p>
          {data.flexDemandBreakdownRows.some(row => row.matchStatus !== 'Matched with trusted demand') && (
            <p className="px-4 pt-1 text-xs text-amber-700 dark:text-amber-300">
              {`Some mapped Amazon SKUs have no trusted ${formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate)} demand. Use Export Demand Breakdown to verify pack/combo SKUs.`}
            </p>
          )}
          <ReportStatCards
            cards={[
              ['Components with demand', data.flexReplenishmentSummary.componentsWithDemand],
              [`Component units consumed (${formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate)})`, data.flexReplenishmentSummary.componentUnitsDemanded],
              ['Needs XHZU stock', data.flexReplenishmentSummary.rowsNeedingXhzuStockContext],
              ['Missing mapping', data.flexReplenishmentSummary.rowsMissingMapping],
              ['Margin review', data.flexReplenishmentSummary.rowsMarginReview],
            ]}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[2200px] text-sm">
              <thead>
                {(() => {
                  const pl = formatDemandPeriodLabel(data.nextStockPlan.assumptions.demandDays, data.nextStockPlan.assumptions.demandStartDate, data.nextStockPlan.assumptions.demandEndDate)
                  return (
                    <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-3 text-left">Component SKU</th>
                      <th className="px-3 py-3 text-right">Linked Amazon SKUs Count</th>
                      <th className="px-3 py-3 text-right">WMS Parent SKU Count</th>
                      <th className="px-3 py-3 text-right">FBA/FC {pl} Finished Units</th>
                      <th className="px-3 py-3 text-right">XHZU/Flex {pl} Finished Units</th>
                      <th className="px-3 py-3 text-right">Total Trusted {pl} Finished Units</th>
                      <th className="px-3 py-3 text-right">{pl} Component Units Sold</th>
                      <th className="px-3 py-3 text-right">SC {pl} Finished Units</th>
                      <th className="px-3 py-3 text-right">SC {pl} Component Units</th>
                      <th className="px-3 py-3 text-right">Planning {pl} Component Units Used</th>
                      <th className="px-3 py-3 text-left">Planning Demand Source</th>
                      <th className="px-3 py-3 text-right">Current XHZU Stock</th>
                      <th className="px-3 py-3 text-right">Required Component Stock</th>
                      <th className="px-3 py-3 text-right">Suggested Vendor Qty</th>
                      <th className="px-3 py-3 text-left">Demand Source Used</th>
                      <th className="px-3 py-3 text-left">Action</th>
                      <th className="px-4 py-3 text-left">Reason</th>
                    </tr>
                  )
                })()}
              </thead>
              <tbody>
                {paginatedFlexRows.map((row: FlexReplenishmentRow, index, page) => (
                  <tr
                    key={`flex-replenish-${row.componentSku}`}
                    className={index < page.length - 1 ? 'border-b border-border/50' : ''}
                  >
                    <td className="px-4 py-3 font-mono text-xs">{row.componentSku}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.linkedAmazonSkuCount)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.wmsParentSkuCount)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.fbaFc30dUnits)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.xhzuFlex30dUnits)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.amazonDemand30d)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.componentAdjustedDemand)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.sellerCentralPeriodUnits)}</td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.sellerCentralComponentUnits)}</td>
                    <td className="px-3 py-3 text-right font-semibold">{formatNumber(row.planningComponentUnitsUsed)}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {row.planningDemandSource === 'seller_central_uploaded'
                        ? 'Seller Central'
                        : row.planningDemandSource === 'seller_central_missing_fallback_trusted'
                          ? 'SC (SKU missing → Trusted)'
                          : row.planningDemandSource === 'seller_central_period_mismatch_fallback_trusted'
                            ? 'SC (period mismatch → Trusted)'
                            : 'Trusted'}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {row.currentXhzuComponentStock === null ? '—' : formatNumber(row.currentXhzuComponentStock)}
                    </td>
                    <td className="px-3 py-3 text-right">{formatNumber(row.requiredComponentStock)}</td>
                    <td className="px-3 py-3 text-right font-semibold">
                      {row.suggestedVendorReplenishQty === null ? '—' : formatNumber(row.suggestedVendorReplenishQty)}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{row.demandSourceUsed}</td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className="text-[10px]">{flexActionLabel(row.action)}</Badge>
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-xs text-muted-foreground">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleFlexRows.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {data.diagnostics.component_mapping_rows === 0
                  ? 'No SKU-to-warehouse component mapping data found. Import mappings to calculate vendor replenishment.'
                  : data.flexReplenishmentRows.length === 0
                    ? 'No Vendor/Component replenishment rows are available yet.'
                    : 'No components with recent demand. Use "Show zero-demand mapped components" to see all mapped components.'}
              </div>
            )}
          </div>
          <PaginationControls
            page={safeFlexPage}
            totalPages={flexTotalPages}
            pageSize={flexPageSize}
            totalRows={visibleFlexRows.length}
            onPageChange={setFlexPage}
          />
        </div>
        </>
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
