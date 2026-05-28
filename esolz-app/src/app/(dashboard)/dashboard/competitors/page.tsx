'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KpiCard } from '@/components/dashboard/KpiCard'
import {
  Users,
  Plus,
  TrendingUp,
  Star,
  ShoppingCart,
  Tag,
  Key,
  RefreshCw,
  Search,
} from 'lucide-react'

// ─── Page ──────────────────────────────────────────────────────────────────────────────

export default function CompetitorsPage() {
  const [showAddForm, setShowAddForm] = useState(false)

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
            Competitor Intelligence is not connected yet.
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Add competitor ASINs and connect Amazon / SP-API data to begin monitoring.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Add Competitor ASIN
        </Button>
      </div>

    </div>
  )
}
