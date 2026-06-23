'use client'

import { ArrowUp, ArrowDown, Minus } from 'lucide-react'

interface BsrBadgeProps {
  rank: number | null
  prevRank?: number | null
  checkedAt?: string | null
  scrapeStatus?: string | null
  hasOtherSignals?: boolean
  staleAfterHours?: number
  size?: 'sm' | 'md'
}

/**
 * Displays a BSR rank with a coloured movement indicator.
 * Green ↑ = rank improved (number went down).
 * Red ↓ = rank worsened (number went up).
 */
export function BsrBadge({
  rank,
  prevRank,
  checkedAt = null,
  scrapeStatus = null,
  hasOtherSignals = false,
  staleAfterHours = 24,
  size = 'md',
}: BsrBadgeProps) {
  if (rank === null) {
    if (!checkedAt) {
      return <span className="text-muted-foreground/70 text-xs">Never checked</span>
    }
    if (scrapeStatus === 'failed') {
      return <span className="text-red-400 text-xs">Check failed</span>
    }
    if (scrapeStatus === 'partial_success') {
      return <span className="text-yellow-400 text-xs">BSR not available</span>
    }
    if (hasOtherSignals) {
      return <span className="text-muted-foreground text-xs">Product checked</span>
    }
    return <span className="text-yellow-400 text-xs">BSR not available</span>
  }

  // Positive delta → improved (lower rank number = better)
  const delta = prevRank != null ? prevRank - rank : null
  const rankStr = `#${rank.toLocaleString('en-IN')}`
  const ageMs = checkedAt ? Date.now() - new Date(checkedAt).getTime() : null
  const isStale = ageMs !== null && ageMs > staleAfterHours * 60 * 60 * 1000

  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`font-semibold font-mono leading-none text-foreground ${
          size === 'sm' ? 'text-xs' : 'text-sm'
        }`}
      >
        {rankStr}
      </span>

      {isStale && (
        <span className="text-[10px] leading-none text-yellow-400">Stale</span>
      )}

      {delta !== null && delta !== 0 && (
        <span
          className={`flex items-center gap-0.5 text-xs leading-none ${
            delta > 0 ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {delta > 0 ? (
            <ArrowUp className="size-3 shrink-0" />
          ) : (
            <ArrowDown className="size-3 shrink-0" />
          )}
          {Math.abs(delta).toLocaleString('en-IN')}
        </span>
      )}

      {delta === 0 && (
        <span className="flex items-center gap-0.5 text-xs leading-none text-muted-foreground">
          <Minus className="size-3 shrink-0" />
          no change
        </span>
      )}
    </div>
  )
}
