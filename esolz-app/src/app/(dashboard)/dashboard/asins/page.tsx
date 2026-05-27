'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { AddAsinDialog } from '@/components/asins/AddAsinDialog'
import { AsinDashboardTable } from '@/components/asins/AsinDashboardTable'
import { ProductCard } from '@/components/asins/ProductCard'
import { Button } from '@/components/ui/button'
import { ProductSnapshot } from '@/types'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { toast } from 'sonner'
import {
  getWorkspaceId,
  getAsinLimit,
  getTrackedAsins,
  addTrackedAsin,
  archiveTrackedAsin,
  incrementAsinUsage,
  type AddAsinInput,
} from '@/lib/supabase/asins'
import {
  Package,
  LayoutGrid,
  List,
  ShieldCheck,
  TrendingDown,
  Star,
  PackageOpen,
  Activity,
  Loader2,
} from 'lucide-react'

type ViewMode = 'table' | 'cards'

export default function AsinsPage() {
  const [products, setProducts]       = useState<ProductSnapshot[]>([])
  const [viewMode, setViewMode]       = useState<ViewMode>('table')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [maxAsins, setMaxAsins]       = useState(5)
  const [loading, setLoading]         = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    const wsId = await getWorkspaceId()
    if (!wsId) { setLoading(false); return }
    setWorkspaceId(wsId)
    const [limit, asins] = await Promise.all([
      getAsinLimit(wsId),
      getTrackedAsins(wsId),
    ])
    setMaxAsins(limit)
    setProducts(asins)
    setLoading(false)
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  async function handleAddAsin(data: AddAsinInput): Promise<{ error?: string }> {
    if (!workspaceId) return { error: 'Not signed in' }
    const newProduct = await addTrackedAsin(workspaceId, data)
    if (!newProduct) return { error: 'Failed to save ASIN. It may already be tracked, or a database error occurred.' }
    setProducts(prev => [newProduct, ...prev])
    void incrementAsinUsage(workspaceId)
    toast.success(`"${data.productTitle}" is now being tracked.`)
    return {}
  }

  async function handleDeleteAsin(id: string) {
    if (!workspaceId) return
    const ok = await archiveTrackedAsin(id, workspaceId)
    if (ok) {
      setProducts(prev => prev.filter(p => p.id !== id))
      toast.success('ASIN removed from tracking.')
    } else {
      toast.error('Failed to remove ASIN. Please try again.')
    }
  }

  const used = products.length
  const max  = maxAsins
  const pct = Math.min(100, Math.round((used / max) * 100))
  const atLimit = used >= max

  // Summary stats
  const tracked = products.filter(p => p.bsr_rank !== null)
  const avgBsr =
    tracked.length > 0
      ? Math.round(tracked.reduce((s, p) => s + (p.bsr_rank ?? 0), 0) / tracked.length)
      : null
  const buyBoxWon = products.filter(p => p.buybox_is_self === true).length
  const ratedProducts = products.filter(p => p.rating !== null)
  const avgRating =
    ratedProducts.length > 0
      ? ratedProducts.reduce((s, p) => s + (p.rating ?? 0), 0) / ratedProducts.length
      : null
  const scoredProducts = products.filter(p => p.availability_score !== null)
  const avgAvailability =
    scoredProducts.length > 0
      ? Math.round(scoredProducts.reduce((s, p) => s + (p.availability_score ?? 0), 0) / scoredProducts.length)
      : null

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">ASIN Tracking</h1>
            <p className="text-sm text-muted-foreground">
              Monitor BSR, pricing, Buy Box, rating, reviews and availability for your Amazon products
            </p>
          </div>
        </div>
        <AddAsinDialog onAdd={handleAddAsin} currentCount={used} maxCount={max} />
      </div>

      {/* ── Plan quota bar ── */}
      <div className="rounded-lg border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground">{used} of {max} ASINs used</span>
            <span
              className={`text-xs font-medium ${
                atLimit ? 'text-red-400' : pct >= 80 ? 'text-yellow-400' : 'text-muted-foreground'
              }`}
            >
              {max - used} remaining
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                atLimit ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-primary'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {atLimit && (
          <p className="text-xs text-muted-foreground shrink-0">
            <Link href="/dashboard/billing" className="text-primary font-medium hover:underline">
              Upgrade to Starter
            </Link>{' '}
            for 25 ASINs
          </p>
        )}
      </div>

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Total ASINs"
          value={products.length}
          sub={`${max - used} slots remaining`}
          icon={Package}
        />
        <KpiCard
          label="Avg BSR"
          value={avgBsr !== null ? `#${avgBsr.toLocaleString('en-IN')}` : '—'}
          sub={`${tracked.length} of ${used} with data`}
          icon={TrendingDown}
        />
        <KpiCard
          label="Buy Box Won"
          value={`${buyBoxWon} / ${products.length}`}
          sub={products.length > 0 ? `${Math.round((buyBoxWon / products.length) * 100)}% win rate` : 'No data'}
          icon={ShieldCheck}
        />
        <KpiCard
          label="Avg Rating"
          value={avgRating !== null ? avgRating.toFixed(1) : '—'}
          sub={`${ratedProducts.length} products rated`}
          icon={Star}
        />
        <KpiCard
          label="Avg Availability"
          value={avgAvailability !== null ? `${avgAvailability}%` : '—'}
          sub={`${scoredProducts.length} products scored`}
          icon={Activity}
        />
      </div>

      {/* ── Product list ── */}
      <div className="flex flex-col gap-3">
        {/* Sub-header: count + view toggle */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">
            {used === 0
              ? 'No ASINs yet'
              : `${used} ASIN${used !== 1 ? 's' : ''} tracked`}
          </h2>
          <div className="flex items-center gap-0.5 border border-border rounded-lg p-0.5">
            <Button
              variant={viewMode === 'table' ? 'default' : 'ghost'}
              size="icon-sm"
              onClick={() => setViewMode('table')}
              title="Table view"
            >
              <List className="size-3.5" />
              <span className="sr-only">Table view</span>
            </Button>
            <Button
              variant={viewMode === 'cards' ? 'default' : 'ghost'}
              size="icon-sm"
              onClick={() => setViewMode('cards')}
              title="Card view"
            >
              <LayoutGrid className="size-3.5" />
              <span className="sr-only">Card view</span>
            </Button>
          </div>
        </div>

        {/* Table view */}
        {viewMode === 'table' && (
          <AsinDashboardTable products={products} onDelete={handleDeleteAsin} />
        )}

        {/* Card view */}
        {viewMode === 'cards' && (
          products.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <PackageOpen className="size-12 text-muted-foreground/40" />
              <p className="text-base font-medium text-muted-foreground">No ASINs tracked yet</p>
              <p className="text-sm text-muted-foreground/60 max-w-xs">
                Add your first ASIN to start monitoring BSR, pricing, and performance.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {products.map(p => (
                <ProductCard key={p.id} product={p} onDelete={handleDeleteAsin} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
