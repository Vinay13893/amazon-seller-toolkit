'use client'

import { ArrowDown, ArrowUp, ArrowUpDown, Check, Clipboard, Minus, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSourceStatusTone } from '@/lib/stock-intelligence/presentation'
import { cn } from '@/lib/utils'

type Props = {
  headers: Array<string | null>
  rows: Array<Array<string | null>>
  preambleRows?: Array<Array<string | null>>
  frozenColumns?: number
  compact?: boolean
  onSort?: (column: number) => void
  sortColumn?: number | null
  sortDirection?: 'asc' | 'desc' | null
}

const STICKY_COLUMN_WIDTH = 180

function stickyColumnStyle(index: number) {
  return {
    left: `${index * STICKY_COLUMN_WIDTH}px`,
    width: `${STICKY_COLUMN_WIDTH}px`,
    minWidth: `${STICKY_COLUMN_WIDTH}px`,
    maxWidth: `${STICKY_COLUMN_WIDTH}px`,
  }
}

function differenceClass(header: string, value: string | null): string {
  if (!header.toLocaleLowerCase().includes('difference') || !value) return ''
  const number = Number(value.replace(/[,+]/g, ''))
  if (!Number.isFinite(number) || number === 0) return ''
  return number < 0
    ? 'bg-destructive/10 text-destructive font-semibold'
    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold'
}

function SourceValue({ header, value }: { header: string; value: string | null }) {
  if (value === null || value === '') return <span className="text-muted-foreground">—</span>
  if (header === 'Packed') {
    const packed = value.toLocaleLowerCase() === 'true'
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', packed ? 'text-emerald-600' : 'text-muted-foreground')}>
        {packed ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
        {packed ? 'Packed' : 'Not packed'}
      </span>
    )
  }
  if (header.toLocaleLowerCase().includes('status')) {
    const tone = getSourceStatusTone(value)
    const Icon = tone === 'danger'
      ? X
      : tone === 'warning'
        ? TriangleAlert
        : tone === 'success'
          ? Check
          : null
    return <span className="inline-flex items-center gap-1">{Icon && <Icon className="size-3.5" />}{value}</span>
  }
  if (header.toLocaleLowerCase().includes('case text')) {
    return (
      <span className="flex min-w-64 items-start gap-2 whitespace-normal">
        <span>{value}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Copy case text"
          aria-label="Copy case text"
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          <Clipboard />
        </Button>
      </span>
    )
  }
  return <>{value}</>
}

export function SourceTable({
  headers,
  rows,
  preambleRows = [],
  frozenColumns = 0,
  compact = false,
  onSort,
  sortColumn = null,
  sortDirection = null,
}: Props) {
  const stickyCount = Math.min(3, Math.max(0, frozenColumns))
  return (
    <div className="w-full overflow-auto border-y border-border">
      <table className="min-w-max border-collapse text-xs">
        <thead className="sticky top-0 z-20 bg-muted">
          {preambleRows.map((row, rowIndex) => (
            <tr key={`preamble-${rowIndex}`} className="bg-background text-muted-foreground">
              {headers.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-80 border-b border-r border-border/70 px-2 py-1.5 align-top whitespace-normal last:border-r-0"
                >
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            {headers.map((header, index) => {
              const sticky = index < stickyCount
              const activeSort = sortColumn === index
              const SortIcon = !activeSort ? ArrowUpDown : sortDirection === 'asc' ? ArrowUp : ArrowDown
              return (
                <th
                  key={`${header ?? 'column'}-${index}`}
                  style={sticky ? stickyColumnStyle(index) : undefined}
                  className={cn(
                    'min-w-32 border-b border-r border-border px-2 py-2 text-left font-semibold text-foreground last:border-r-0',
                    sticky && 'sticky z-30 overflow-hidden whitespace-normal break-words bg-muted',
                  )}
                >
                  {onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(index)}
                      className="flex w-full items-center justify-between gap-2 text-left"
                    >
                      <span>{header || `Column ${index + 1}`}</span>
                      <SortIcon className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ) : (header || `Column ${index + 1}`)}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-background even:bg-muted/30 hover:bg-muted/60">
              {headers.map((header, columnIndex) => {
                const sticky = columnIndex < stickyCount
                const value = row[columnIndex] ?? null
                return (
                  <td
                    key={columnIndex}
                    style={sticky ? stickyColumnStyle(columnIndex) : undefined}
                    className={cn(
                      'max-w-80 border-b border-r border-border/70 px-2 align-top last:border-r-0',
                      compact ? 'py-1.5' : 'py-2',
                      sticky && 'sticky z-10 overflow-hidden whitespace-normal break-words bg-background',
                      differenceClass(header ?? '', value),
                    )}
                  >
                    <SourceValue header={header ?? ''} value={value} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
