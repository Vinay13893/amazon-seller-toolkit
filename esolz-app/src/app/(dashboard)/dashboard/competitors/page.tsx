'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Users,
  Plus,
  TrendingUp,
  TrendingDown,
  Minus,
  Star,
  ShoppingCart,
  Tag,
  Key,
  Eye,
  BarChart2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Zap,
  Search,
} from 'lucide-react'
import {
  MOCK_COMPETITOR_ASINS,
  MOCK_BUYBOX_THREATS,
  MOCK_KEYWORD_OVERLAP,
  getCompetitorSummary,
  type CompetitorAsin,
  type PriceMovement,
  type BsrMovement,
  type BuyBoxStatus,
  type RiskLevel,
  type BuyBoxThreatExtra,
  type KeywordOverlapEntry,
  type FulfillmentType,
} from '@/lib/mock-competitor-tracker'

// ─── Delta chips ──────────────────────────────────────────────────────────────

function PriceChip({ movement, current, previous }: {
  movement: PriceMovement
  current: number
  previous: number
}) {
  const diff = current - previous
  const pct = previous > 0 ? ((diff / previous) * 100).toFixed(1) : '0'

  if (movement === 'stable') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
        <Minus className="w-3 h-3" /> Stable
      </span>
    )
  }
  if (movement === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-500">
        <TrendingDown className="w-3 h-3" /> {pct}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-red-400">
      <TrendingUp className="w-3 h-3" /> +{pct}%
    </span>
  )
}

function BsrChip({ movement, current, previous }: {
  movement: BsrMovement
  current: number
  previous: number
}) {
  const diff = Math.abs(current - previous)

  if (movement === 'stable') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
        <Minus className="w-3 h-3" /> Stable
      </span>
    )
  }
  if (movement === 'improved') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-orange-400">
        <TrendingUp className="w-3 h-3" /> ↑{diff.toLocaleString()}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-muted-foreground">
      <TrendingDown className="w-3 h-3" /> ↓{diff.toLocaleString()}
    </span>
  )
}

// ─── Status badges ────────────────────────────────────────────────────────────

const BUY_BOX_STYLES: Record<BuyBoxStatus, string> = {
  owned: 'bg-green-500/15 text-green-400 border-green-500/30',
  shared: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  lost:   'bg-red-500/15 text-red-400 border-red-400/30',
  suppressed: 'bg-border/40 text-muted-foreground border-border',
}

const BUY_BOX_LABELS: Record<BuyBoxStatus, string> = {
  owned: 'Owned',
  shared: 'Shared',
  lost: 'Lost',
  suppressed: 'Suppressed',
}

function BuyBoxBadge({ status }: { status: BuyBoxStatus }) {
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-md border text-[11px] font-semibold',
      BUY_BOX_STYLES[status]
    )}>
      {BUY_BOX_LABELS[status]}
    </span>
  )
}

const RISK_STYLES: Record<RiskLevel, string> = {
  High:   'bg-red-500/15 text-red-400 border-red-400/30',
  Medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  Low:    'bg-green-500/15 text-green-400 border-green-500/30',
}

function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold',
      RISK_STYLES[level]
    )}>
      {level === 'High' && <AlertTriangle className="w-2.5 h-2.5" />}
      {level}
    </span>
  )
}

function AvailabilityScore({ score }: { score: number }) {
  const color = score >= 90 ? 'text-green-400' : score >= 70 ? 'text-yellow-400' : 'text-red-400'
  return (
    <span className={cn('text-sm font-semibold tabular-nums', color)}>
      {score}%
    </span>
  )
}

// ─── Movement: Price Droppers ───────────────────────────────────────────────────

function PriceDroppersCard({ items }: { items: CompetitorAsin[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Tag className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">Top Price Droppers</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">{items.length} detected</span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-8 text-xs text-muted-foreground text-center">No price drops detected</p>
      ) : (
        <div className="divide-y divide-border">
          {items.map(c => {
            const drop = ((c.previousPrice - c.currentPrice) / c.previousPrice * 100).toFixed(1)
            return (
              <div key={c.id} className="px-4 py-3 hover:bg-border/10 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground line-clamp-1">{c.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{c.brand}</p>
                  </div>
                  <RiskBadge level={c.riskLevel} />
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] text-muted-foreground line-through tabular-nums">₹{c.previousPrice}</span>
                  <span className="text-sm font-bold text-foreground tabular-nums">₹{c.currentPrice}</span>
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">
                    <TrendingDown className="w-3 h-3" />↓{drop}%
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Movement: BSR Gainers ────────────────────────────────────────────────────

function BsrGainersCard({ items }: { items: CompetitorAsin[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">BSR Gainers</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">{items.length} gaining</span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-8 text-xs text-muted-foreground text-center">No BSR gainers detected</p>
      ) : (
        <div className="divide-y divide-border">
          {items.map(c => {
            const improvement = c.previousBsr - c.currentBsr
            return (
              <div key={c.id} className="px-4 py-3 hover:bg-border/10 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground line-clamp-1">{c.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{c.brand}</p>
                  </div>
                  <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold bg-orange-500/15 text-orange-400 border-orange-500/30">
                    <TrendingUp className="w-2.5 h-2.5" /> Rising
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    #{c.previousBsr.toLocaleString()}
                    <span className="mx-1.5 text-primary">→</span>
                    <span className="font-bold text-foreground">#{c.currentBsr.toLocaleString()}</span>
                  </span>
                  <span className="text-[11px] font-semibold text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">
                    +{improvement.toLocaleString()} ranks
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Movement: Velocity Leaders ──────────────────────────────────────────────

function VelocityLeadersCard({ items }: { items: CompetitorAsin[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Zap className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">Review Velocity Leaders</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">Top {items.length}</span>
      </div>
      <div className="divide-y divide-border">
        {items.map((c, i) => (
          <div key={c.id} className="px-4 py-3 hover:bg-border/10 transition-colors">
            <div className="flex items-start gap-3">
              <span className="text-lg font-black text-primary leading-none mt-0.5 w-5 text-center shrink-0">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground line-clamp-1">{c.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{c.brand}</p>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <span className="text-sm font-black text-orange-400">+{c.reviewVelocity30d.toLocaleString()}</span>
                  <span className="text-[11px] text-muted-foreground">reviews / 30d</span>
                  <span className="text-[11px] text-muted-foreground">{c.reviewCount.toLocaleString()} total</span>
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-yellow-400 font-semibold">
                    <Star className="w-3 h-3 fill-yellow-400" />{c.rating}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Movement: Buy Box Threats ────────────────────────────────────────────────

type BuyBoxThreatRow = CompetitorAsin & BuyBoxThreatExtra

const FULFILLMENT_STYLES: Record<FulfillmentType, string> = {
  FBA: 'bg-primary/10 text-primary border-primary/30',
  AMZ: 'bg-blue-500/15 text-blue-400 border-blue-400/30',
  FBM: 'bg-border/40 text-muted-foreground border-border',
}

function BuyBoxThreatsCard({ items }: { items: BuyBoxThreatRow[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <ShoppingCart className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">Buy Box Threats</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">{items.length} at risk</span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-8 text-xs text-muted-foreground text-center">No Buy Box threats detected</p>
      ) : (
        <div className="divide-y divide-border">
          {items.map(c => (
            <div key={c.id} className="px-4 py-3 hover:bg-border/10 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground line-clamp-1">{c.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-[10px] text-muted-foreground bg-border/30 px-1.5 py-0.5 rounded">{c.asin}</span>
                    <BuyBoxBadge status={c.buyBoxStatus} />
                  </div>
                </div>
                <RiskBadge level={c.riskLevel} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px]">
                <span className="text-muted-foreground">
                  Seller: <span className="text-foreground font-medium">{c.competitorSeller}</span>
                </span>
                <span className={cn(
                  'inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold',
                  FULFILLMENT_STYLES[c.fulfillmentType]
                )}>{c.fulfillmentType}</span>
                <span className={cn(
                  'font-semibold',
                  c.priceGap < 0 ? 'text-red-400' : 'text-green-400'
                )}>
                  Price gap: {c.priceGap < 0 ? '' : '+'}₹{c.priceGap}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Movement: Keyword Overlap ────────────────────────────────────────────────

type KeywordRow = KeywordOverlapEntry & { title: string; brand: string }

function KeywordOverlapCard({ items }: { items: KeywordRow[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Key className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">Keyword Overlap Opportunities</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">{items.length} competitors analysed</span>
      </div>
      <div className="divide-y divide-border">
        {items.map(row => (
          <div key={row.competitorId} className="px-5 py-4 hover:bg-border/10 transition-colors">
            <div className="flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="sm:w-48 shrink-0">
                <p className="text-sm font-semibold text-foreground line-clamp-2">{row.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{row.brand}</p>
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Overlapping ({row.overlappingKeywords.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {row.overlappingKeywords.map(kw => (
                    <span key={kw} className="text-[11px] px-2 py-0.5 rounded-full bg-border/30 text-muted-foreground border border-border">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Gap / Opportunity ({row.missingKeywords.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {row.missingKeywords.map(kw => (
                    <span key={kw} className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] whitespace-nowrap"
                  disabled
                  title="Keyword analysis — coming soon"
                >
                  <Search className="w-3 h-3 mr-1" />
                  Analyze Keywords
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="px-5 py-3 border-t border-border bg-border/5">
        <p className="text-[11px] text-muted-foreground">
          Keyword analysis integration available in upcoming release.
        </p>
      </div>
    </div>
  )
}

// ─── Table row ────────────────────────────────────────────────────────────────

function CompetitorRow({ competitor, index }: { competitor: CompetitorAsin; index: number }) {
  return (
    <tr className="border-b border-border hover:bg-border/10 transition-colors group">
      {/* # */}
      <td className="px-3 py-3 text-center text-xs text-muted-foreground font-medium w-8">
        {index + 1}
      </td>

      {/* Product */}
      <td className="px-3 py-3 min-w-[240px] max-w-[300px]">
        <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2 mb-1">
          {competitor.title}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          <span className="font-mono text-[10px] text-muted-foreground bg-border/30 px-1.5 py-0.5 rounded">
            {competitor.asin}
          </span>
          <span className="text-[10px] text-muted-foreground font-medium">
            {competitor.brand}
          </span>
          <span className="text-[10px] text-primary font-medium">
            {competitor.marketplace}
          </span>
        </div>
      </td>

      {/* Category */}
      <td className="px-3 py-3 min-w-[140px]">
        <span className="text-xs text-muted-foreground leading-tight">{competitor.category}</span>
      </td>

      {/* Price */}
      <td className="px-3 py-3 min-w-[110px]">
        <p className="text-sm font-bold text-foreground tabular-nums">
          ₹{competitor.currentPrice.toLocaleString()}
        </p>
        <p className="text-[11px] text-muted-foreground line-through tabular-nums">
          ₹{competitor.previousPrice.toLocaleString()}
        </p>
        <PriceChip
          movement={competitor.priceMovement}
          current={competitor.currentPrice}
          previous={competitor.previousPrice}
        />
      </td>

      {/* BSR */}
      <td className="px-3 py-3 min-w-[110px]">
        <p className="text-sm font-bold text-foreground tabular-nums">
          #{competitor.currentBsr.toLocaleString()}
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          prev #{competitor.previousBsr.toLocaleString()}
        </p>
        <BsrChip
          movement={competitor.bsrMovement}
          current={competitor.currentBsr}
          previous={competitor.previousBsr}
        />
      </td>

      {/* Rating & Reviews */}
      <td className="px-3 py-3 min-w-[120px]">
        <div className="flex items-center gap-1 mb-0.5">
          <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
          <span className="text-sm font-semibold text-foreground">{competitor.rating}</span>
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {competitor.reviewCount.toLocaleString()} reviews
        </p>
        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-orange-400 mt-0.5">
          +{competitor.reviewVelocity30d} / 30d
        </span>
      </td>

      {/* Buy Box */}
      <td className="px-3 py-3 min-w-[100px]">
        <BuyBoxBadge status={competitor.buyBoxStatus} />
      </td>

      {/* Availability */}
      <td className="px-3 py-3 min-w-[90px] text-center">
        <AvailabilityScore score={competitor.availabilityScore} />
      </td>

      {/* Keyword Overlap */}
      <td className="px-3 py-3 min-w-[90px] text-center">
        <div className="flex items-center justify-center gap-1">
          <Key className="w-3 h-3 text-primary" />
          <span className="text-sm font-semibold text-foreground">{competitor.keywordOverlap}</span>
        </div>
      </td>

      {/* Risk */}
      <td className="px-3 py-3 min-w-[90px]">
        <RiskBadge level={competitor.riskLevel} />
      </td>

      {/* Last Checked */}
      <td className="px-3 py-3 min-w-[110px]">
        <span className="text-xs text-muted-foreground">{timeAgo(competitor.lastChecked)}</span>
      </td>

      {/* Actions */}
      <td className="px-3 py-3 min-w-[130px]">
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled
            title="View Detail — coming soon"
          >
            <Eye className="w-3 h-3 mr-1" />
            Detail
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled
            title="Compare — coming soon"
          >
            <BarChart2 className="w-3 h-3 mr-1" />
            Compare
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CompetitorsPage() {
  const [showAddForm, setShowAddForm] = useState(false)
  const [sortField, setSortField] = useState<keyof CompetitorAsin>('riskLevel')
  const [sortAsc, setSortAsc] = useState(false)

  const summary = getCompetitorSummary(MOCK_COMPETITOR_ASINS)

  // Movement section derived data
  const priceDroppers = [...MOCK_COMPETITOR_ASINS]
    .filter(c => c.priceMovement === 'down')
    .sort((a, b) => {
      const dropA = (a.previousPrice - a.currentPrice) / a.previousPrice
      const dropB = (b.previousPrice - b.currentPrice) / b.previousPrice
      return dropB - dropA
    })

  const bsrGainers = [...MOCK_COMPETITOR_ASINS]
    .filter(c => c.bsrMovement === 'improved')
    .sort((a, b) => (b.previousBsr - b.currentBsr) - (a.previousBsr - a.currentBsr))

  const velocityLeaders = [...MOCK_COMPETITOR_ASINS]
    .sort((a, b) => b.reviewVelocity30d - a.reviewVelocity30d)
    .slice(0, 3)

  const buyBoxThreatRows: BuyBoxThreatRow[] = MOCK_COMPETITOR_ASINS
    .filter(c => c.buyBoxStatus === 'lost' || c.buyBoxStatus === 'shared')
    .map(c => {
      const extra = MOCK_BUYBOX_THREATS.find(t => t.competitorId === c.id)!
      return { ...c, ...extra }
    })

  const keywordRows: KeywordRow[] = MOCK_KEYWORD_OVERLAP.map(k => {
    const c = MOCK_COMPETITOR_ASINS.find(comp => comp.id === k.competitorId)!
    return { ...k, title: c.title, brand: c.brand }
  })

  const sorted = [...MOCK_COMPETITOR_ASINS].sort((a, b) => {
    const va = a[sortField]
    const vb = b[sortField]
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortAsc ? va - vb : vb - va
    }
    return sortAsc
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va))
  })

  function toggleSort(field: keyof CompetitorAsin) {
    if (sortField === field) {
      setSortAsc(prev => !prev)
    } else {
      setSortField(field)
      setSortAsc(false)
    }
  }

  function SortIcon({ field }: { field: keyof CompetitorAsin }) {
    if (sortField !== field) return <ChevronDown className="w-3 h-3 opacity-30" />
    return sortAsc
      ? <ChevronUp className="w-3 h-3 text-primary" />
      : <ChevronDown className="w-3 h-3 text-primary" />
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-foreground">Competitor Tracker</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Monitor competing ASINs — price, BSR, reviews, Buy Box &amp; risk signals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh Data
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setShowAddForm(v => !v)}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add Competitor ASIN
          </Button>
        </div>
      </div>

      {/* Add Competitor form (collapsible) */}
      {showAddForm && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Add Competitor ASIN</h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              placeholder="Enter ASIN — e.g. B07XK3PJMZ"
              className="flex-1 font-mono text-sm"
            />
            <Button type="button" size="sm" disabled>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Track ASIN
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Real ASIN tracking requires backend integration — coming soon.
          </p>
        </div>
      )}

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard
          label="Tracked Competitors"
          value={summary.tracked}
          sub="active ASINs"
          icon={Users}
        />
        <KpiCard
          label="Price Drops"
          value={summary.priceDrops}
          sub="competitors cut price"
          icon={Tag}
        />
        <KpiCard
          label="BSR Gainers"
          value={summary.bsrGainers}
          sub="ranking improved"
          icon={TrendingUp}
        />
        <KpiCard
          label="Velocity Leaders"
          value={summary.velocityLeaders}
          sub="100+ reviews / 30d"
          icon={Star}
        />
        <KpiCard
          label="Buy Box Threats"
          value={summary.buyBoxThreats}
          sub="lost or shared"
          icon={ShoppingCart}
        />
        <KpiCard
          label="Keyword Overlap"
          value={summary.totalKeywordOverlap}
          sub="shared keywords"
          icon={Key}
        />
      </div>

      {/* Competitor Tracking Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">

        {/* Table header bar */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">Competitor ASINs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {MOCK_COMPETITOR_ASINS.length} competitors tracked &mdash; mock data
            </p>
          </div>
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            Last sync: just now
          </Badge>
        </div>

        {/* Scrollable table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-border/10">
                <th className="px-3 py-2.5 text-center w-8">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">#</span>
                </th>
                <th className="px-3 py-2.5 min-w-[240px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('title')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Product <SortIcon field="title" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[140px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('category')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Category <SortIcon field="category" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[110px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('currentPrice')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Price <SortIcon field="currentPrice" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[110px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('currentBsr')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    BSR <SortIcon field="currentBsr" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[120px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('reviewVelocity30d')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Rating / Reviews <SortIcon field="reviewVelocity30d" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[100px]">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Buy Box</span>
                </th>
                <th className="px-3 py-2.5 min-w-[90px] text-center">
                  <button
                    type="button"
                    onClick={() => toggleSort('availabilityScore')}
                    className="flex items-center justify-center gap-1 w-full text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Avail. <SortIcon field="availabilityScore" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[90px] text-center">
                  <button
                    type="button"
                    onClick={() => toggleSort('keywordOverlap')}
                    className="flex items-center justify-center gap-1 w-full text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Keywords <SortIcon field="keywordOverlap" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[90px]">
                  <button
                    type="button"
                    onClick={() => toggleSort('riskLevel')}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Risk <SortIcon field="riskLevel" />
                  </button>
                </th>
                <th className="px-3 py-2.5 min-w-[110px]">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Last Checked</span>
                </th>
                <th className="px-3 py-2.5 min-w-[130px]">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((competitor, index) => (
                <CompetitorRow key={competitor.id} competitor={competitor} index={index} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-border/5">
          <p className="text-[11px] text-muted-foreground">
            Showing {MOCK_COMPETITOR_ASINS.length} competitors &mdash; View Detail and Compare available in upcoming release.
          </p>
        </div>
      </div>

      {/* ─── Competitor Movement Insights ────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold text-foreground">Competitor Movement Insights</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Price cuts, rank surges, review spikes &amp; keyword gaps — all derived from mock data.
        </p>
      </div>

      {/* Row 1: Price Droppers + BSR Gainers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PriceDroppersCard items={priceDroppers} />
        <BsrGainersCard items={bsrGainers} />
      </div>

      {/* Row 2: Velocity Leaders + Buy Box Threats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VelocityLeadersCard items={velocityLeaders} />
        <BuyBoxThreatsCard items={buyBoxThreatRows} />
      </div>

      {/* Row 3: Keyword Overlap — full width */}
      <KeywordOverlapCard items={keywordRows} />

    </div>
  )
}
