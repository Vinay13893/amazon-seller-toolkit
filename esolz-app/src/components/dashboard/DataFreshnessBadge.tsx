'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface DataFreshnessBadgeProps {
  checkedAt: string | null | undefined
  staleAfterHours?: number
  className?: string
}

export function DataFreshnessBadge({
  checkedAt,
  staleAfterHours = 24,
  className,
}: DataFreshnessBadgeProps) {
  if (!checkedAt) {
    return (
      <Badge className={cn('text-[10px] bg-muted text-muted-foreground border-border', className)}>
        Never checked
      </Badge>
    )
  }

  const ageMs = Date.now() - new Date(checkedAt).getTime()
  const staleMs = staleAfterHours * 60 * 60 * 1000

  if (Number.isNaN(ageMs) || ageMs < 0) {
    return (
      <Badge className={cn('text-[10px] bg-muted text-muted-foreground border-border', className)}>
        Never checked
      </Badge>
    )
  }

  const isFresh = ageMs <= staleMs

  return isFresh ? (
    <Badge className={cn('text-[10px] bg-green-500/15 text-green-400 border-green-500/25', className)}>
      Fresh
    </Badge>
  ) : (
    <Badge className={cn('text-[10px] bg-yellow-500/15 text-yellow-400 border-yellow-500/25', className)}>
      Stale
    </Badge>
  )
}
