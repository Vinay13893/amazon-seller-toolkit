'use client'

import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BsrBadge } from './BsrBadge'
import { formatPrice, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ProductSnapshot } from '@/types'
import {
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Star,
  ExternalLink,
  Search,
  MapPin,
  ShoppingCart,
  Trash2,
  PackageOpen,
} from 'lucide-react'

interface AsinDashboardTableProps {
  products: ProductSnapshot[]
  onDelete: (id: string) => void
}

export function AsinDashboardTable({ products, onDelete }: AsinDashboardTableProps) {
  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <PackageOpen className="size-12 text-muted-foreground/40" />
        <p className="text-base font-medium text-muted-foreground">No ASINs tracked yet</p>
        <p className="text-sm text-muted-foreground/60 max-w-xs">
          Add your first ASIN to start monitoring BSR, pricing, and performance trends.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" style={{ minWidth: '860px' }}>
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Product
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              BSR / Move
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Price
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Rating
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hidden md:table-cell">
              Reviews
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Buy Box
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hidden lg:table-cell">
              Availability
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hidden xl:table-cell">
              Updated
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-border">
          {products.map(p => (
            <tr key={p.id} className="group hover:bg-muted/20 transition-colors">
              {/* ── Product: ASIN + label + marketplace + sub-category ── */}
              <td className="px-4 py-3">
                <div className="flex flex-col gap-1 max-w-[200px]">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Link
                      href={`/dashboard/bsr?asin=${p.asin}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {p.asin}
                    </Link>
                    <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
                      {p.marketplace}
                    </Badge>
                  </div>
                  <span className="text-xs font-medium text-foreground line-clamp-1">
                    {p.label}
                  </span>
                  {p.sub_category && (
                    <span className="text-[10px] text-muted-foreground/60 line-clamp-1">
                      {p.sub_category}
                    </span>
                  )}
                </div>
              </td>

              {/* ── BSR + movement ── */}
              <td className="px-4 py-3">
                <BsrBadge
                  rank={p.bsr_rank}
                  prevRank={p.bsr_rank_prev}
                  checkedAt={p.captured_at}
                  hasOtherSignals={
                    p.price !== null ||
                    p.rating !== null ||
                    p.review_count !== null ||
                    p.buybox_winner !== null ||
                    p.availability_score !== null
                  }
                  size="sm"
                />
              </td>

              {/* ── Price ── */}
              <td className="px-4 py-3">
                <span className="text-sm font-medium text-foreground whitespace-nowrap">
                  {formatPrice(p.price, p.price_currency)}
                </span>
              </td>

              {/* ── Rating ── */}
              <td className="px-4 py-3">
                {p.rating !== null ? (
                  <div className="flex items-center gap-1">
                    <Star className="size-3.5 fill-yellow-400 text-yellow-400 shrink-0" />
                    <span className="text-sm font-medium text-foreground">
                      {p.rating.toFixed(1)}
                    </span>
                  </div>
                ) : (
                  <span className="text-muted-foreground/50 text-xs">—</span>
                )}
              </td>

              {/* ── Review count ── */}
              <td className="px-4 py-3 hidden md:table-cell">
                <span className="text-sm text-muted-foreground">
                  {p.review_count !== null
                    ? p.review_count.toLocaleString('en-IN')
                    : '—'}
                </span>
              </td>

              {/* ── Buy Box ── */}
              <td className="px-4 py-3">
                {p.buybox_winner === null ? (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <ShieldOff className="size-3.5 shrink-0" />
                    <span className="text-xs whitespace-nowrap">Suppressed</span>
                  </div>
                ) : p.buybox_is_self ? (
                  <div className="flex items-center gap-1.5 text-green-400">
                    <ShieldCheck className="size-3.5 shrink-0" />
                    <span className="text-xs font-medium whitespace-nowrap">You own it</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-yellow-400">
                    <ShieldAlert className="size-3.5 shrink-0" />
                    <span
                      className="text-xs max-w-[110px] truncate"
                      title={p.buybox_winner}
                    >
                      {p.buybox_winner}
                    </span>
                  </div>
                )}
              </td>

              {/* ── Availability score ── */}
              <td className="px-4 py-3 hidden lg:table-cell">
                {p.availability_score !== null ? (
                  <div className="flex flex-col gap-1 w-[110px]">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {p.availability === 'in_stock'
                          ? 'In Stock'
                          : p.availability === 'limited'
                            ? 'Limited'
                            : 'Out of Stock'}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        {p.availability_score}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', {
                          'bg-green-500': p.availability_score >= 80,
                          'bg-yellow-500':
                            p.availability_score >= 40 && p.availability_score < 80,
                          'bg-red-500': p.availability_score < 40,
                        })}
                        style={{ width: `${p.availability_score}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground/50 text-xs">—</span>
                )}
              </td>

              {/* ── Last updated ── */}
              <td className="px-4 py-3 hidden xl:table-cell">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {timeAgo(p.captured_at)}
                </span>
              </td>

              {/* ── Actions ── */}
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-primary"
                    title="View BSR details"
                    render={<Link href={`/dashboard/asins/${p.asin}`} />}
                  >
                    <ExternalLink className="size-3.5" />
                    <span className="sr-only">View Details</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-primary"
                    title="Track keywords"
                    render={<Link href="/dashboard/keywords" />}
                  >
                    <Search className="size-3.5" />
                    <span className="sr-only">Track Keywords</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-primary"
                    title="Check pincodes"
                    render={<Link href="/dashboard/pincode" />}
                  >
                    <MapPin className="size-3.5" />
                    <span className="sr-only">Check Pincodes</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-primary"
                    title="Check Buy Box"
                    render={<Link href={`/dashboard/buybox?asin=${p.asin}`} />}
                  >
                    <ShoppingCart className="size-3.5" />
                    <span className="sr-only">Buy Box</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove ASIN"
                    onClick={() => onDelete(p.id)}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">Remove</span>
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
