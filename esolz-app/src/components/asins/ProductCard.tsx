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
  Clock,
  ExternalLink,
  Search,
  MapPin,
  ShoppingCart,
  Trash2,
} from 'lucide-react'

// ─── Sub-components ──────────────────────────────────────────────────────────

function BuyBoxStatus({
  winner,
  isSelf,
}: {
  winner: string | null
  isSelf: boolean | null
}) {
  if (winner === null) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ShieldOff className="size-3.5 shrink-0" />
        <span className="text-xs">Suppressed</span>
      </div>
    )
  }
  if (isSelf) {
    return (
      <div className="flex items-center gap-1.5 text-green-400">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span className="text-xs font-medium">You own it</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-yellow-400">
      <ShieldAlert className="size-3.5 shrink-0" />
      <span className="text-xs truncate max-w-[130px]" title={winner}>
        {winner}
      </span>
    </div>
  )
}

function AvailabilityBar({
  score,
  status,
}: {
  score: number
  status: ProductSnapshot['availability']
}) {
  const label =
    status === 'in_stock'
      ? 'In Stock'
      : status === 'limited'
        ? 'Limited Stock'
        : status === 'out_of_stock'
          ? 'Out of Stock'
          : '—'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-semibold text-foreground">{score}/100</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', {
            'bg-green-500': score >= 80,
            'bg-yellow-500': score >= 40 && score < 80,
            'bg-red-500': score < 40,
          })}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

// ─── Main card ───────────────────────────────────────────────────────────────

interface ProductCardProps {
  product: ProductSnapshot
  onDelete: (id: string) => void
}

export function ProductCard({ product, onDelete }: ProductCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5 min-w-0">
          {/* ASIN chip + marketplace + status */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link
              href={`/dashboard/asins/${product.asin}`}
              className="font-mono text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded hover:bg-primary/20 transition-colors"
            >
              {product.asin}
            </Link>
            <Badge variant="outline" className="text-xs h-5 px-1.5">
              {product.marketplace}
            </Badge>
            <span
              className={`flex items-center gap-1 text-xs ${
                product.is_active ? 'text-green-400' : 'text-muted-foreground'
              }`}
            >
              <span
                className={`size-1.5 rounded-full inline-block ${
                  product.is_active ? 'bg-green-400' : 'bg-muted-foreground'
                }`}
              />
              {product.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {/* Product label */}
          <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
            {product.label}
          </p>

          {/* Category breadcrumb */}
          {product.category && (
            <p className="text-xs text-muted-foreground truncate">
              {product.category}
              {product.sub_category && ` › ${product.sub_category}`}
            </p>
          )}
        </div>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(product.id)}
          title="Remove ASIN"
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Remove</span>
        </Button>
      </div>

      {/* ── Data grid ── */}
      <div className="mx-4 mb-0 grid grid-cols-2 gap-px rounded-lg overflow-hidden border border-border bg-border">
        {/* BSR */}
        <div className="bg-card px-3 py-2.5 flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            BSR Rank
          </span>
          <BsrBadge
            rank={product.bsr_rank}
            prevRank={product.bsr_rank_prev}
            checkedAt={product.captured_at}
            hasOtherSignals={
              product.price !== null ||
              product.rating !== null ||
              product.review_count !== null ||
              product.buybox_winner !== null ||
              product.availability_score !== null
            }
          />
        </div>

        {/* Price */}
        <div className="bg-card px-3 py-2.5 flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Price
          </span>
          <span className="text-sm font-semibold text-foreground">
            {formatPrice(product.price, product.price_currency)}
          </span>
        </div>

        {/* Rating + reviews */}
        <div className="bg-card px-3 py-2.5 flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Rating
          </span>
          {product.rating !== null ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <Star className="size-3.5 fill-yellow-400 text-yellow-400" />
                <span className="text-sm font-semibold text-foreground">
                  {product.rating.toFixed(1)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {product.review_count?.toLocaleString('en-IN') ?? '—'} reviews
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground/60 text-xs">—</span>
          )}
        </div>

        {/* Buy Box */}
        <div className="bg-card px-3 py-2.5 flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Buy Box
          </span>
          <BuyBoxStatus winner={product.buybox_winner} isSelf={product.buybox_is_self} />
        </div>

        {/* Availability — full width */}
        {product.availability_score !== null && (
          <div className="col-span-2 bg-card px-3 py-2.5 flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Availability Score
            </span>
            <AvailabilityBar
              score={product.availability_score}
              status={product.availability}
            />
          </div>
        )}

        {/* BSR status hint — full width */}
        {product.bsr_rank === null && (
          <div className="col-span-2 bg-muted/30 px-3 py-3 flex items-center justify-center">
            <span className="text-xs text-muted-foreground">
              {!product.captured_at
                ? 'Never checked'
                : (product.price !== null || product.rating !== null || product.review_count !== null || product.buybox_winner !== null || product.availability_score !== null)
                  ? 'BSR not found'
                  : 'Failed'}
            </span>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 py-3 mt-3 border-t border-border flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3 shrink-0" />
          Last checked: {timeAgo(product.captured_at)}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1 sm:flex-none"
            render={<Link href={`/dashboard/asins/${product.asin}`} />}
          >
            <ExternalLink className="size-3" />
            View Details
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1 sm:flex-none"
            render={<Link href="/dashboard/keywords" />}
          >
            <Search className="size-3" />
            Keywords
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1 sm:flex-none"
            render={<Link href="/dashboard/pincode" />}
          >
            <MapPin className="size-3" />
            Pincodes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1 sm:flex-none"
            render={<Link href={`/dashboard/buybox?asin=${product.asin}`} />}
          >
            <ShoppingCart className="size-3" />
            Buy Box
          </Button>
        </div>
      </div>
    </div>
  )
}
