'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Asin, BsrSummary } from '@/types'
import { Trash2, TrendingUp, TrendingDown, Minus, PackageOpen } from 'lucide-react'
import Link from 'next/link'

interface AsinTableProps {
  asins: Asin[]
  bsrSummary: BsrSummary[]
  onDelete: (id: string) => void
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function BsrTrend({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="text-muted-foreground text-xs">Not tracked</span>
  // Simulate a trend indicator based on rank magnitude (mock only)
  const good = rank < 1000
  const mid = rank < 5000
  if (good) return (
    <span className="flex items-center gap-1 text-green-400 text-sm font-semibold">
      <TrendingUp className="size-3.5" />
      #{rank.toLocaleString('en-IN')}
    </span>
  )
  if (mid) return (
    <span className="flex items-center gap-1 text-yellow-400 text-sm font-semibold">
      <Minus className="size-3.5" />
      #{rank.toLocaleString('en-IN')}
    </span>
  )
  return (
    <span className="flex items-center gap-1 text-red-400 text-sm font-semibold">
      <TrendingDown className="size-3.5" />
      #{rank.toLocaleString('en-IN')}
    </span>
  )
}

export function AsinTable({ asins, bsrSummary, onDelete }: AsinTableProps) {
  if (asins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <PackageOpen className="size-12 text-muted-foreground/40" />
        <p className="text-base font-medium text-muted-foreground">No ASINs tracked yet</p>
        <p className="text-sm text-muted-foreground/60 max-w-xs">
          Add your first ASIN to start monitoring BSR, category rank, and performance trends.
        </p>
      </div>
    )
  }

  const bsrMap = new Map(bsrSummary.map(b => [b.asin_id, b]))

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">ASIN</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Label</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden sm:table-cell">Marketplace</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">BSR Rank</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">Category</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden lg:table-cell">Updated</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {asins.map(item => {
            const bsr = bsrMap.get(item.id)
            return (
              <tr
                key={item.id}
                className="hover:bg-muted/20 transition-colors"
              >
                {/* ASIN code */}
                <td className="px-4 py-3">
                  <Link
                    href={`/dashboard/bsr?asin=${item.asin}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {item.asin}
                  </Link>
                </td>

                {/* Label */}
                <td className="px-4 py-3">
                  <span className="font-medium text-foreground line-clamp-1 max-w-[200px]">
                    {item.label}
                  </span>
                </td>

                {/* Marketplace */}
                <td className="px-4 py-3 hidden sm:table-cell">
                  <Badge variant="outline" className="text-xs">
                    {item.marketplace}
                  </Badge>
                </td>

                {/* BSR Rank */}
                <td className="px-4 py-3">
                  <BsrTrend rank={bsr?.bsr_rank ?? null} />
                </td>

                {/* Category */}
                <td className="px-4 py-3 hidden md:table-cell">
                  {bsr?.category ? (
                    <span className="text-muted-foreground text-xs line-clamp-1 max-w-[160px]">
                      {bsr.category}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40 text-xs">—</span>
                  )}
                </td>

                {/* Last updated */}
                <td className="px-4 py-3 hidden lg:table-cell">
                  <span className="text-muted-foreground text-xs">
                    {timeAgo(bsr?.captured_at ?? null)}
                  </span>
                </td>

                {/* Status badge */}
                <td className="px-4 py-3">
                  {bsr?.bsr_rank != null ? (
                    <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-xs">
                      Tracked
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground text-xs">
                      Pending
                    </Badge>
                  )}
                </td>

                {/* Actions */}
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(item.id)}
                    title="Remove ASIN"
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">Remove</span>
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
