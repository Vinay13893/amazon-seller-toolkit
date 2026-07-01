'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { AddAsinDialog } from '@/components/asins/AddAsinDialog'
import { AsinDashboardTable } from '@/components/asins/AsinDashboardTable'
import { ProductCard } from '@/components/asins/ProductCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Marketplace, ProductSnapshot } from '@/types'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { formatPrice, pricingUnavailableLabel } from '@/lib/format'
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
  ShoppingBag,
  RefreshCw,
  Search,
} from 'lucide-react'

type ViewMode = 'table' | 'cards'
type AsinTab = 'products' | 'competitors'

interface AmazonListingSnapshot {
  price:              number | null
  bsr:                number | null
  buy_box_owner:      string | null
  buy_box_status:     string | null
  availability_score: number | null
  scrape_status:      string | null
  checked_at:         string
  last_attempted_at:  string | null
  last_successful_price_checked_at: string | null
  last_successful_bsr_checked_at: string | null
  last_successful_pricing_checked_at: string | null
  latest_failure_reason: string | null
  next_retry_at: string | null
  price_source_status: string
  bsr_source_status: string
  buy_box_source_status: string
  availability_source_status: string
  deal_tag_source_status: string
  queue_status: string | null
}

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
  snapshot:       AmazonListingSnapshot | null
}

interface ListingSyncSummary {
  status: string
  importedCount: number
  hasMore: boolean
  lastSyncAt: string | null
}

const LISTINGS_PAGE_SIZE = 50

interface CheckerSummary {
  queued: number
  queueDueNow: number
  queueWaiting: number
  processing: number
  succeeded: number
  failed: number
  rateLimited: number
  lastAttemptedAt: string | null
  lastSuccessfulAt: string | null
  nextRetryAt: string | null
  suggestedAction: string | null
}

function compactDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function AsinsPage() {
  const [activeAsinTab, setActiveAsinTab] = useState<AsinTab>('products')
  const [checkingNow, setCheckingNow] = useState(false)
  const [checkStatus, setCheckStatus] = useState<string | null>(null)
  const [products, setProducts]       = useState<ProductSnapshot[]>([])
  const [viewMode, setViewMode]       = useState<ViewMode>('table')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [maxAsins, setMaxAsins]       = useState(5)
  const [loading, setLoading]         = useState(true)

  // Amazon account listings
  const [amazonListings, setAmazonListings]         = useState<AmazonListingItem[]>([])
  const [amazonConnected, setAmazonConnected]       = useState<boolean | null>(null)
  const [listingsLoading, setListingsLoading]       = useState(true)
  const [listingsLoadingMore, setListingsLoadingMore] = useState(false)
  const [listingSearch, setListingSearch]           = useState('')
  const [listingTotal, setListingTotal]             = useState(0)
  const [listingsHasMore, setListingsHasMore]       = useState(false)
  const [listingSync, setListingSync]               = useState<ListingSyncSummary | null>(null)
  const [checkerSummary, setCheckerSummary]         = useState<CheckerSummary | null>(null)
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

  const loadAmazonListings = useCallback(async (options?: { append?: boolean; search?: string; offset?: number }) => {
    const append = options?.append ?? false
    const search = options?.search ?? listingSearch
    if (append) setListingsLoadingMore(true)
    else setListingsLoading(true)
    try {
      // Check if connected
      const statusRes = await fetch('/api/amazon/connect/status')
      if (!statusRes.ok) { setAmazonConnected(false); return }
      const statusData = await statusRes.json()
      setAmazonConnected(!!statusData.connected)
      if (!statusData.connected) return

      const offset = append ? (options?.offset ?? 0) : 0
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(LISTINGS_PAGE_SIZE),
      })
      if (search.trim()) params.set('q', search.trim())

      const listingsRes = await fetch(`/api/asins/listings?${params.toString()}`, { cache: 'no-store' })
      const listingData = await listingsRes.json() as {
        items?: AmazonListingItem[]
        total?: number
        hasMore?: boolean
        sync?: ListingSyncSummary | null
        checker?: CheckerSummary | null
      }
      if (listingsRes.ok) {
        const nextItems = listingData.items ?? []
        setAmazonListings(previous => append ? [...previous, ...nextItems] : nextItems)
        setListingTotal(listingData.total ?? 0)
        setListingsHasMore(Boolean(listingData.hasMore))
        setListingSync(listingData.sync ?? null)
        setCheckerSummary(listingData.checker ?? null)
      }
    } catch {
      // non-fatal
    } finally {
      if (append) setListingsLoadingMore(false)
      else setListingsLoading(false)
    }
  }, [listingSearch])

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

  // Refresh Amazon listings when the background watcher finishes a sync
  useEffect(() => {
    function onSyncDone() {
      if (workspaceId) void loadAmazonListings({ search: listingSearch })
    }
    window.addEventListener('amazon:listings-synced', onSyncDone)
    return () => window.removeEventListener('amazon:listings-synced', onSyncDone)
  }, [workspaceId, listingSearch, loadAmazonListings])

  useEffect(() => {
    if (!workspaceId) return
    const timer = window.setTimeout(() => {
      void loadAmazonListings({ search: listingSearch })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [workspaceId, listingSearch, loadAmazonListings])

  async function handleCheckNow() {
    setCheckingNow(true)
    setCheckStatus('Queuing product checks…')
    try {
      const enqueueRes = await fetch('/api/asins/jobs/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5, force: true }),
      })
      const enqueueData = await enqueueRes.json() as {
        enqueuedMyProducts?: number
        enqueuedCompetitors?: number
        insertedCount?: number
        warning?: string | null
        detail?: string
        error?: string
      }
      if (!enqueueRes.ok) {
        setCheckStatus(enqueueData.detail ?? enqueueData.error ?? 'Could not queue product checks.')
        return
      }

      const queued = enqueueData.insertedCount ?? ((enqueueData.enqueuedMyProducts ?? 0) + (enqueueData.enqueuedCompetitors ?? 0))
      setCheckStatus(
        queued > 0
          ? `Queued ${queued} product check${queued === 1 ? '' : 's'}; running first safe batch...`
          : (enqueueData.warning ?? 'No new checks were due right now.'),
      )
      const processRes = await fetch('/api/asins/jobs/process-next', { method: 'POST' })
      const processData = await processRes.json() as {
        claimed?: number
        completed?: number
        retried?: number
        failed?: number
        pricingRateLimited?: number
        message?: string
      }

      if (!processRes.ok) {
        setCheckStatus('Checks were queued, but the processor could not run yet. Queue status below will update after the next worker run.')
        return
      }

      if (processData.message) {
        setCheckStatus(processData.message)
        return
      }

      const claimed = processData.claimed ?? 0
      if (claimed === 0) {
        setCheckStatus('No checks were due right now. Existing queue/status is shown below.')
        return
      }

      setCheckStatus(
        `Checked ${processData.completed ?? 0} of ${claimed}` +
        (processData.retried ? `, ${processData.retried} retrying` : '') +
        (processData.failed ? `, ${processData.failed} failed` : '') +
        (processData.pricingRateLimited ? `, ${processData.pricingRateLimited} rate-limited` : '') +
        '.',
      )
      await loadAmazonListings({ search: listingSearch })
      if (workspaceId) setProducts(await getTrackedAsins(workspaceId))
    } catch {
      setCheckStatus('Product check failed unexpectedly.')
    } finally {
      setCheckingNow(false)
    }
  }

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
              My Products shows items synced from your connected Amazon account. Competitors is for ASINs you add manually.
            </p>
          </div>
        </div>
        {activeAsinTab === 'competitors' && (
          <AddAsinDialog onAdd={handleAddAsin} currentCount={used} maxCount={max} />
        )}
      </div>

      {/* ── My Products / Competitors sub-tabs ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex w-fit rounded-lg border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setActiveAsinTab('products')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              activeAsinTab === 'products' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            My Products
          </button>
          <button
            type="button"
            onClick={() => setActiveAsinTab('competitors')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              activeAsinTab === 'competitors' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Competitors
          </button>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checkingNow}
            onClick={() => void handleCheckNow()}
          >
            {checkingNow ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Check now
          </Button>
          {checkStatus && (
            <p className="text-xs text-muted-foreground max-w-xs text-right">{checkStatus}</p>
          )}
          <p className="text-xs text-muted-foreground/70 max-w-xs text-right">
            Product checks run automatically in the background. Manual check queues an immediate refresh.
          </p>
        </div>
      </div>

      {activeAsinTab === 'competitors' && (
      <>
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
              <p className="text-base font-medium text-muted-foreground">No competitor ASINs tracked yet</p>
              <p className="text-sm text-muted-foreground/60 max-w-xs">
                Add a competitor ASIN to start monitoring their BSR, pricing, and performance.
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
      </>
      )}

      {activeAsinTab === 'products' && (
      <>
      {/* ── My Products: missing-data explanation ── */}
      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        Product checks use SP-API Catalog for BSR and SP-API Product Pricing for price, Buy Box, and offer availability. Deal tag checking is not implemented yet.
        {checkerSummary && (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2 text-xs">
              <div><span className="text-muted-foreground/70">Due now</span><p className="text-foreground font-medium">{checkerSummary.queueDueNow}</p></div>
              <div><span className="text-muted-foreground/70">Waiting</span><p className="text-foreground font-medium">{checkerSummary.queueWaiting}</p></div>
              <div><span className="text-muted-foreground/70">Processing</span><p className="text-foreground font-medium">{checkerSummary.processing}</p></div>
              <div><span className="text-muted-foreground/70">Rate-limited</span><p className="text-foreground font-medium">{checkerSummary.rateLimited}</p></div>
              <div><span className="text-muted-foreground/70">Succeeded</span><p className="text-foreground font-medium">{checkerSummary.succeeded}</p></div>
              <div><span className="text-muted-foreground/70">Failed</span><p className="text-foreground font-medium">{checkerSummary.failed}</p></div>
              <div><span className="text-muted-foreground/70">Last success</span><p className="text-foreground font-medium">{compactDateTime(checkerSummary.lastSuccessfulAt)}</p></div>
              <div><span className="text-muted-foreground/70">Last attempted</span><p className="text-foreground font-medium">{compactDateTime(checkerSummary.lastAttemptedAt)}</p></div>
              <div>
                <span className="text-muted-foreground/70">{checkerSummary.queueDueNow > 0 ? 'Retry' : 'Next retry'}</span>
                <p className="text-foreground font-medium">
                  {checkerSummary.queueDueNow > 0 ? 'Due now' : compactDateTime(checkerSummary.nextRetryAt)}
                </p>
              </div>
            </div>
            {checkerSummary.suggestedAction && (
              <p className="text-xs text-amber-400">{checkerSummary.suggestedAction}</p>
            )}
          </div>
        )}
      </div>

      {/* ── My Products (connected Amazon account listings) ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
              <ShoppingBag className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">My Products</h2>
              <p className="text-sm text-muted-foreground">
                Products synced from your Seller Central account via SP-API
              </p>
            </div>
          </div>
          {listingSync && (
            <div className="text-right text-xs text-muted-foreground">
              <p>
                Sync: {listingSync.status === 'completed'
                  ? 'Full'
                  : listingSync.status === 'running'
                    ? 'In progress'
                    : 'Partial / failed'}
              </p>
              <p>
                {listingSync.importedCount} imported
                {listingSync.lastSyncAt
                  ? ` · ${new Date(listingSync.lastSyncAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                  : ''}
              </p>
            </div>
          )}
        </div>

        {amazonConnected && (
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={listingSearch}
              onChange={event => setListingSearch(event.target.value)}
              placeholder="Search title, ASIN, SKU, brand, or marketplace"
              className="pl-9"
            />
          </div>
        )}

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
            {listingSearch.trim() ? (
              <>
                <Search className="size-10 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground">No products match your search</p>
                <p className="text-xs text-muted-foreground">Try a title, ASIN, SKU, brand, or marketplace.</p>
              </>
            ) : (
              <>
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
              </>
            )}
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
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Category</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Marketplace</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Price</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">BSR</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Buy Box</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Availability</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Deal Tag</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Last Checked</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs">Updated</th>
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
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {item.product_type ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {marketplaceFromMarketplaceId(item.marketplace_id)}
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
                      {(() => {
                        const snapshot = item.snapshot
                        const notChecked = <span className="text-xs text-muted-foreground/70 italic">Not checked yet</span>
                        const sourceLine = (text: string | null | undefined, extra?: string | null) => (
                          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{text}{extra ? ` · ${extra}` : ''}</p>
                        )

                        return (
                          <>
                            {/* Price */}
                            <td className="px-4 py-3 text-xs">
                              {!snapshot ? notChecked : (
                                <>
                                  <span className="text-xs text-foreground">{snapshot.price !== null ? formatPrice(snapshot.price, 'INR') : '—'}</span>
                                  {sourceLine(snapshot.price_source_status, snapshot.last_successful_price_checked_at ? `last success ${compactDateTime(snapshot.last_successful_price_checked_at)}` : null)}
                                  {snapshot.next_retry_at && sourceLine(`Retry scheduled ${compactDateTime(snapshot.next_retry_at)}`)}
                                </>
                              )}
                            </td>
                            {/* BSR */}
                            <td className="px-4 py-3 text-xs">
                              {!snapshot ? notChecked : (
                                <>
                                  <span className="text-xs text-foreground">{snapshot.bsr !== null ? `#${snapshot.bsr.toLocaleString('en-IN')}` : '—'}</span>
                                  {sourceLine(snapshot.bsr_source_status, snapshot.last_successful_bsr_checked_at ? `last success ${compactDateTime(snapshot.last_successful_bsr_checked_at)}` : null)}
                                </>
                              )}
                            </td>
                            {/* Buy Box */}
                            <td className="px-4 py-3 text-xs">
                              {!snapshot ? notChecked : (
                                <>
                                  {snapshot.buy_box_owner ? (
                                    <span className="text-xs text-foreground truncate max-w-[110px]" title={snapshot.buy_box_owner}>{snapshot.buy_box_owner}</span>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">{snapshot.buy_box_status === 'no_buybox' ? 'No Buy Box' : 'Seller unknown'}</span>
                                  )}
                                  {sourceLine(snapshot.buy_box_source_status, snapshot.last_successful_pricing_checked_at ? `last success ${compactDateTime(snapshot.last_successful_pricing_checked_at)}` : null)}
                                </>
                              )}
                            </td>
                            {/* Availability */}
                            <td className="px-4 py-3 text-xs">
                              {!snapshot ? notChecked : (
                                <>
                                  <span className="text-xs text-foreground">{snapshot.availability_score !== null ? `${snapshot.availability_score}%` : '—'}</span>
                                  {sourceLine(snapshot.availability_source_status)}
                                </>
                              )}
                            </td>
                            {/* Deal Tag */}
                            <td className="px-4 py-3 text-xs text-muted-foreground/70 italic">{snapshot?.deal_tag_source_status ?? 'Deal checker not implemented yet'}</td>
                            {/* Last Checked */}
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              {snapshot ? (
                                <>
                                  <p>Attempt: {compactDateTime(snapshot.last_attempted_at ?? snapshot.checked_at)}</p>
                                  {snapshot.latest_failure_reason && <p className="text-[10px]">Latest: {pricingUnavailableLabel(snapshot.scrape_status) ?? snapshot.latest_failure_reason}</p>}
                                </>
                              ) : 'Not checked yet'}
                            </td>
                          </>
                        )
                      })()}
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
            <div className="px-4 py-3 bg-muted/20 border-t border-border flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-muted-foreground">
                Showing {amazonListings.length} of {listingTotal} product{listingTotal !== 1 ? 's' : ''}
                {listingSearch.trim() ? ' matching your search' : ''}
              </p>
              {listingsHasMore && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={listingsLoadingMore}
                  onClick={() => void loadAmazonListings({
                    append: true,
                    search: listingSearch,
                    offset: amazonListings.length,
                  })}
                >
                  {listingsLoadingMore ? (
                    <><Loader2 className="size-4 animate-spin" /> Loading...</>
                  ) : (
                    'Load More'
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}
