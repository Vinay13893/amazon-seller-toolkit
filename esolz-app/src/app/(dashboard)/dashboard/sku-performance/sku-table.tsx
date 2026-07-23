import { ArrowUpRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Ratio, SkuPerformanceRow } from '@/lib/sku-performance/types'
import {
  formatMoney, formatCount, formatRatio, mappingStateLabel, mappingStateTone,
  salesTrendLabel, spendTrendLabel, attentionChips, toneBadgeClassName,
} from './format'

const HEADERS = [
  'Product', 'SKU', 'ASIN', 'Sales', 'Units', 'Spend', 'Attributed sales', 'ACOS', 'TACOS',
  'Sales trend', 'Spend trend', 'Attention',
]

/**
 * P1-C1 item 6. Every value here is read directly from the row the summary
 * RPC returned -- no total, ratio, or trend is computed in this component.
 * Identity-conflict rows never carry a selectedRange window (see
 * types.ts), so their metric cells render "Conflict" rather than a
 * fabricated ₹0, with an Explain button that opens the evidence sheet.
 */
export function SkuTable({ rows, currencyCode, onExplainConflict }: {
  rows: SkuPerformanceRow[]
  currencyCode: string | null
  onExplainConflict: (row: SkuPerformanceRow) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1240px] text-left">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {HEADERS.map((header, index) => (
              <th
                key={header}
                className={`px-4 py-3 text-xs font-medium text-muted-foreground ${index >= 3 && index <= 8 ? 'text-right' : ''}`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <SkuRow key={row.sku} row={row} currencyCode={currencyCode} onExplainConflict={onExplainConflict} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SkuRow({ row, currencyCode, onExplainConflict }: {
  row: SkuPerformanceRow
  currencyCode: string | null
  onExplainConflict: (row: SkuPerformanceRow) => void
}) {
  const window = row.selectedRange
  const chips = attentionChips(row)

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/20">
      <td className="max-w-[220px] px-4 py-3 align-top">
        <p className="line-clamp-2 text-sm font-medium text-foreground">{row.productTitle ?? 'Unknown'}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{row.brand ?? 'Unknown brand'}</p>
      </td>
      <td className="px-4 py-3 align-top font-mono text-xs text-foreground">{row.sku}</td>
      <td className="px-4 py-3 align-top font-mono text-xs text-foreground">{row.asin ?? 'Unknown'}</td>

      {window ? (
        <>
          <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.sales, currencyCode)}</td>
          <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatCount(window.units)}</td>
          <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.spend, currencyCode)}</td>
          <td className="px-4 py-3 text-right align-top text-sm text-foreground">{formatMoney(window.attributedSales, currencyCode)}</td>
          <RatioCell ratio={window.acos} />
          <RatioCell ratio={window.tacos} />
        </>
      ) : (
        <td colSpan={6} className="px-4 py-3 text-center align-top text-xs text-muted-foreground">
          Identity conflict — no combined metrics available
        </td>
      )}

      <td className="px-4 py-3 align-top text-sm text-foreground">{salesTrendLabel(row.salesTrend)}</td>
      <td className="px-4 py-3 align-top text-sm text-foreground">{spendTrendLabel(row.spendTrend)}</td>

      <td className="px-4 py-3 align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={toneBadgeClassName(mappingStateTone(row.mappingState))}>
            {mappingStateLabel(row.mappingState)}
          </Badge>
          {chips.map(chip => (
            <Badge key={chip.key} variant="outline" className={toneBadgeClassName(chip.tone)}>
              {chip.label}
            </Badge>
          ))}
          {row.mappingState === 'identity_conflict' && (
            <Button type="button" variant="outline" size="xs" onClick={() => onExplainConflict(row)}>
              Explain
              <ArrowUpRight className="size-3" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

function RatioCell({ ratio }: { ratio: Ratio }) {
  const display = formatRatio(ratio)
  return (
    <td className="px-4 py-3 text-right align-top text-sm" data-tone={display.tone}>
      <span className={display.tone === 'danger' ? 'text-red-700 dark:text-red-400' : display.tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : display.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'}>
        {display.text}
      </span>
    </td>
  )
}
