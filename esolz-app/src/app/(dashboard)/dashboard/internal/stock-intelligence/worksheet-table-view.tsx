'use client'

import { ChevronLeft, ChevronRight, Download, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { WorksheetData } from '@/lib/stock-intelligence/types'
import { SourceTable } from './source-table'

type Props = {
  data: WorksheetData
  search: string
  brand: string
  category: string
  onSearchChange: (value: string) => void
  onBrandChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onClearFilters: () => void
  onPageChange: (page: number) => void
  onSort: (column: number) => void
  sortColumn: number | null
  sortDirection: 'asc' | 'desc' | null
}

function csvCell(value: string | null): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function exportCurrentPage(data: WorksheetData) {
  const content = [data.headers, ...data.rows]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n')
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${data.sheet.title.replaceAll(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-page-${data.page}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function WorksheetTableView({
  data,
  search,
  brand,
  category,
  onSearchChange,
  onBrandChange,
  onCategoryChange,
  onClearFilters,
  onPageChange,
  onSort,
  sortColumn,
  sortDirection,
}: Props) {
  const hasFilters = Boolean(search || brand || category)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Search SKU, ASIN or product"
            className="pl-8"
          />
        </div>
        {data.availableBrands.length > 0 && (
          <select
            aria-label="Filter by brand"
            value={brand}
            onChange={event => onBrandChange(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All brands</option>
            {data.availableBrands.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        )}
        {data.availableCategories.length > 0 && (
          <select
            aria-label="Filter by category"
            value={category}
            onChange={event => onCategoryChange(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All categories</option>
            {data.availableCategories.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={onClearFilters}>
            <X />
            Clear filters
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => exportCurrentPage(data)} disabled={data.rows.length === 0}>
          <Download />
          Export current page
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {data.filteredRows.toLocaleString()} matching source rows
          {hasFilters && ` of ${data.totalRows.toLocaleString()}`}
        </span>
        <span>Page data only is exported</span>
      </div>

      {data.rows.length === 0 ? (
        <div className="border-y border-border py-14 text-center">
          <p className="text-sm font-medium">No matching source records</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasFilters ? 'Clear the filters to return to the worksheet.' : 'The source worksheet currently has no data rows.'}
          </p>
          {hasFilters && <Button variant="outline" size="sm" className="mt-4" onClick={onClearFilters}>Clear filters</Button>}
        </div>
      ) : (
        <SourceTable
          headers={data.headers}
          rows={data.rows}
          preambleRows={data.preambleRows}
          frozenColumns={data.sheet.frozenColumnCount}
          compact
          onSort={onSort}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
        />
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Page {data.page.toLocaleString()} of {data.totalPages.toLocaleString()}
        </p>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            title="Previous page"
            disabled={data.page <= 1}
            onClick={() => onPageChange(data.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            title="Next page"
            disabled={data.page >= data.totalPages}
            onClick={() => onPageChange(data.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
