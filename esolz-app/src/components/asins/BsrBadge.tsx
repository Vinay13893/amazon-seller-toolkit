'use client'

import { ArrowUp, ArrowDown, Minus } from 'lucide-react'

interface BsrBadgeProps {
  rank: number | null
  prevRank?: number | null
  size?: 'sm' | 'md'
}

/**
 * Displays a BSR rank with a coloured movement indicator.
 * Green ↑ = rank improved (number went down).
 * Red ↓ = rank worsened (number went up).
 */
export function BsrBadge({ rank, prevRank, size = 'md' }: BsrBadgeProps) {
  if (rank === null) {
    return <span className="text-muted-foreground/60 text-xs italic">Pending</span>
  }

  // Positive delta → improved (lower rank number = better)
  const delta = prevRank != null ? prevRank - rank : null
  const rankStr = `#${rank.toLocaleString('en-IN')}`

  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`font-semibold font-mono leading-none text-foreground ${
          size === 'sm' ? 'text-xs' : 'text-sm'
        }`}
      >
        {rankStr}
      </span>

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
