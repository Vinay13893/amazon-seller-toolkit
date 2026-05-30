'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/dashboard/KpiCard'
import {
  Users,
  TrendingUp,
  Star,
  ShoppingCart,
  Tag,
  Key,
  Search,
} from 'lucide-react'

// ─── Page ──────────────────────────────────────────────────────────────────────────────

export default function CompetitorsPage() {
  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-foreground">Competitor Tracker</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Competitor Intelligence is coming soon. Start by tracking your own ASINs first.
          </p>
        </div>
        <Button type="button" size="sm" render={<Link href="/dashboard/asins" />}>
          Track My ASINs
        </Button>
      </div>

      {/* KPI Summary Cards — all zero until data is connected */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Tracked Competitors" value={0} sub="active ASINs" icon={Users} />
        <KpiCard label="Price Drops" value={0} sub="competitors cut price" icon={Tag} />
        <KpiCard label="BSR Gainers" value={0} sub="ranking improved" icon={TrendingUp} />
        <KpiCard label="Velocity Leaders" value={0} sub="100+ reviews / 30d" icon={Star} />
        <KpiCard label="Buy Box Threats" value={0} sub="lost or shared" icon={ShoppingCart} />
        <KpiCard label="Keyword Overlap" value={0} sub="shared keywords" icon={Key} />
      </div>

      {/* Empty state */}
      <div className="bg-card border border-border rounded-xl flex flex-col items-center justify-center gap-4 py-20 px-6 text-center">
        <div className="rounded-full bg-muted p-4">
          <Search className="w-8 h-8 text-muted-foreground/40" />
        </div>
        <div className="space-y-1.5 max-w-sm">
          <h2 className="text-sm font-semibold text-foreground">
            Competitor Intelligence is coming soon.
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Start by tracking your own ASINs first.
          </p>
        </div>
        <Button type="button" size="sm" render={<Link href="/dashboard/asins" />}>
          Track My ASINs
        </Button>
      </div>

    </div>
  )
}
