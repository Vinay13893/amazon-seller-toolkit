'use client'

import { useEffect, useState } from 'react'

export type PageSize = 20 | 50 | 100

const PAGE_SIZE_OPTIONS: PageSize[] = [20, 50, 100]

/**
 * Simple client-side pagination over an already-filtered/sorted array.
 * Resets to page 1 whenever the input array reference changes (i.e. whenever
 * filters/search upstream produce a new filtered result).
 */
export function usePaginatedRows<T>(rows: T[], defaultPageSize: PageSize = 20) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(defaultPageSize)

  useEffect(() => {
    setPage(1)
  }, [rows])

  const totalRows = rows.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const page_ = Math.min(Math.max(1, page), totalPages)
  const startIndex = totalRows === 0 ? 0 : (page_ - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, totalRows)
  const pageRows = rows.slice(startIndex, endIndex)

  return {
    page: page_,
    setPage,
    pageSize,
    setPageSize,
    pageRows,
    totalRows,
    totalPages,
    startIndex,
    endIndex,
  }
}

export function TablePaginationControls({
  page,
  setPage,
  pageSize,
  setPageSize,
  totalPages,
  totalRows,
  startIndex,
  endIndex,
}: {
  page: number
  setPage: (updater: (p: number) => number) => void
  pageSize: PageSize
  setPageSize: (size: PageSize) => void
  totalPages: number
  totalRows: number
  startIndex: number
  endIndex: number
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs text-muted-foreground">
      <span>
        {totalRows === 0 ? 'No rows to show.' : `Showing ${startIndex + 1}–${endIndex} of ${totalRows} rows`}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          Rows per page
          <select
            className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value) as PageSize)}
          >
            {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="border border-border rounded-md px-2 py-1 text-xs text-foreground disabled:opacity-40 hover:bg-muted"
          disabled={page <= 1}
          onClick={() => setPage(p => Math.max(1, p - 1))}
        >
          Previous
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          type="button"
          className="border border-border rounded-md px-2 py-1 text-xs text-foreground disabled:opacity-40 hover:bg-muted"
          disabled={page >= totalPages}
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </div>
  )
}
