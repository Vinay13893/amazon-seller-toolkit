'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { AddAsinDialog } from '@/components/asins/AddAsinDialog'
import { AsinDashboardTable } from '@/components/asins/AsinDashboardTable'
import { ProductCard } from '@/components/asins/ProductCard'
import { Button } from '@/components/ui/button'
import { Marketplace, ProductSnapshot } from '@/types'
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
import { createClient } from '@/lib/supabase/client'
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
  ShoppingBag,
  RefreshCw,
} from 'lucide-react'

type ViewMode = 'table' | 'cards'

interface AmazonListingItem {
  id:             string
  sku:            string
  asin:           string | null
  item_name:      string | null
  brand:          string | null
  product_type:   string | null
  status:         string | null
  marketplace_id: string
  image_url:      string | null
  last_synced_at: string | null
}

export default function AsinsPage() {
  const [products, setProducts]       = useState<ProductSnapshot[]>([])
  const [viewMode, setViewMode]       = useState<ViewMode>('table')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [maxAsins, setMaxAsins]       = useState(5)
  const [loading, setLoading]         = useState(true)

  // Amazon account listings
  const [amazonListings, setAmazonListings]         = useState<AmazonListingItem[]>([])
  const [amazonConnected, setAmazonConnected]       = useState<boolean | null>(null)
  const [listingsLoading, setListingsLoading]       = useState(true)
  const [trackingFromListingAsin, setTrackingFromListingAsin] = useState<string | null>(null)

  function marketplaceFromMarketplaceId(marketplaceId: string): Marketplace {
    const map: Record<string, Marketplace> = {
      A21TJRUUN4KGV: 'IN',
      ATVPDKIKX0DER: 'US',
      A1F83G8C2ARO7P: 'UK',
      A1PA6795UKMFR9: 'DE',
    }
    return map[marketplaceId] ?? 'IN'
  }

  const loadAmazonListings = useCallback(async (wsId: string) => {
    setListingsLoading(true)
    try {
      // Check if connected
      const statusRes = await fetch('/api/amazon/connect/status')
      if (!statusRes.ok) { setAmazonConnected(false); return }
      const statusData = await statusRes.json()
      setAmazonConnected(!!statusData.connected)
      if (!statusData.connected) return

      // Fetch listing items via Supabase (RLS allows select for workspace members)
      const supabase = createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('amazon_listing_items')
        .select('id, sku, asin, item_name, brand, product_type, status, marketplace_id, image_url, last_synced_at')
        .eq('workspace_id', wsId)
        .order('item_name', { ascending: true })
        .limit(200)
      if (!error && Array.isArray(data)) {
        setAmazonListings(data as AmazonListingItem[])
      }
    } catch {
      // non-fatal
    } finally {
      setListingsLoading(false)
    }
  }, [])

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
    void loadAmazonListings(wsId)
  }, [loadAmazonListings])

  useEffect(() => { void loadData() }, [loadData])

  // Refresh Amazon listings when the background watcher finishes a sync
  useEffect(() => {
    function onSyncDone() {
      if (workspaceId) void loadAmazonListings(workspaceId)
    }
    window.addEventListener('amazon:listings-synced', onSyncDone)
    return () => window.removeEventListener('amazon:listings-synced', onSyncDone)
  }, [workspaceId, loadAmazonListings])

  async function handleAddAsin(data: AddAsinInput): Promise<{ error?: string }> {
    if (!workspaceId) return { error: 'Not signed in' }
    const newProduct = await addTrackedAsin(workspaceId, data)
    if (!newProduct) return { error: 'Failed to save ASIN. It may already be tracked, or a database error occurred.' }
    setProducts(prev => [newProduct, ...prev])
    void incrementAsinUsage(workspaceId)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('asin:usage-changed'))
    }
    toast.success(`"${data.productTitle}" is now being tracked.`)
    return {}
  }

  async function handleTrackFromListing(item: AmazonListingItem) {
    if (!workspaceId || !item.asin) return

    const normalizedAsin = item.asin.toUpperCase()
    const alreadyTracked = products.some(
      (product) => product.asin.toUpperCase() === normalizedAsin
    )
    if (alreadyTracked) {
      toast.info('Already tracked.')
      return
    }

    if (products.length >= maxAsins) {
      toast.error('You have reached your ASIN limit for this plan.')
      return
    }

    setTrackingFromListingAsin(normalizedAsin)
    try {
      const created = await addTrackedAsin(workspaceId, {
        asin: normalizedAsin,
        marketplace: marketplaceFromMarketplaceId(item.marketplace_id),
        productTitle: item.item_name?.trim() || normalizedAsin,
        brand: item.brand?.trim() || '',
        category: item.product_type?.trim() || '',
        imageUrl: item.image_url?.trim() || '',
      })

      if (!created) {
        const refreshed = await getTrackedAsins(workspaceId)
        setProducts(refreshed)
        const nowTracked = refreshed.some(
          (product) => product.asin.toUpperCase() === normalizedAsin
        )
        if (nowTracked) {
          toast.info('Already tracked.')
          return
        }
        toast.error('Failed to track ASIN from listing. Please try again.')
        return
      }

      await incrementAsinUsage(workspaceId)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('asin:usage-changed'))
      }

      const [asins, limit] = await Promise.all([
        getTrackedAsins(workspaceId),
        getAsinLimit(workspaceId),
      ])
      setProducts(asins)
      setMaxAsins(limit)
      toast.success('ASIN added to tracking from Amazon listings.')
    } finally {
      setTrackingFromListingAsin(null)
    }
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

      {/* ── Amazon Account Listings ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
            <ShoppingBag className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Amazon Account Listings</h2>
            <p className="text-sm text-muted-foreground">
              Products synced from your Seller Central account via SP-API
            </p>
          </div>
        </div>

        {listingsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <Loader2 className="size-4 animate-spin" /> Loading Amazon listings…
          </div>

        ) : amazonConnected === false ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 flex flex-col items-center text-center gap-3">
            <ShoppingBag className="size-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">Amazon account not connected</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Connect your Amazon Seller Central account to sync your product catalogue here.
            </p>
            <Link
              href="/dashboard/settings"
              className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              Connect Amazon
            </Link>
          </div>

        ) : amazonListings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 flex flex-col items-center text-center gap-3">
            <RefreshCw className="size-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">No listings synced yet</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Use the <strong>Sync Listings</strong> button in Settings → Amazon to import your
              products from Seller Central.
            </p>
            <Link
              href="/dashboard/settings"
              className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              Go to Settings
            </Link>
          </div>

        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Product</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">SKU</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">ASIN</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Last synced</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {amazonListings.map(item => (
                    <tr key={item.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {item.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.image_url}
                              alt={item.item_name ?? item.sku}
                              className="size-8 rounded object-contain bg-muted flex-shrink-0"
                            />
                          ) : (
                            <div className="size-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                              <Package className="size-4 text-muted-foreground" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-foreground truncate max-w-[280px]">
                              {item.item_name ?? '—'}
                            </p>
                            {item.brand && (
                              <p className="text-xs text-muted-foreground">{item.brand}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {item.sku}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {item.asin ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        {item.status ? (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            item.status.toLowerCase() === 'buyable'
                              ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {item.status}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {item.last_synced_at
                          ? new Date(item.last_synced_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {item.asin && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={trackingFromListingAsin === item.asin.toUpperCase() || atLimit}
                            onClick={() => void handleTrackFromListing(item)}
                          >
                            {trackingFromListingAsin === item.asin.toUpperCase() ? 'Tracking…' : 'Track ASIN'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 bg-muted/20 border-t border-border">
              <p className="text-xs text-muted-foreground">
                {amazonListings.length} listing{amazonListings.length !== 1 ? 's' : ''} synced from Seller Central
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
