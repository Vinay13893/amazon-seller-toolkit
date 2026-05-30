'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ShoppingBag, Loader2, CheckCircle2, AlertCircle,
  Clock, Link2Off, RefreshCw, Package,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AmazonStatus {
  connected:                boolean
  status:                   string
  selling_partner_id:       string | null
  marketplace_id:           string | null
  marketplace_name:         string | null
  brand_analytics_eligible: boolean
  brand_registry_enrolled:  boolean
  last_sync_at:             string | null
  error_message:            string | null
  configured?:              boolean   // false when SPAPI_APPLICATION_ID not set
}

interface ListingsSyncStatus {
  status:         string
  pages:          number
  items_upserted: number
  error_message?: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  type BadgeCfg = { label: string; className: string; Icon: React.ElementType }
  const map: Record<string, BadgeCfg> = {
    active:        { label: 'Active',        Icon: CheckCircle2, className: 'text-green-600 bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800' },
    expired:       { label: 'Token expired', Icon: Clock,        className: 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800' },
    revoked:       { label: 'Revoked',       Icon: Link2Off,     className: 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800' },
    error:         { label: 'Error',         Icon: AlertCircle,  className: 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800' },
    not_connected: { label: 'Not connected', Icon: Link2Off,     className: 'text-muted-foreground bg-muted/50 border-border' },
  }
  const cfg: BadgeCfg = map[status] ?? map['not_connected']
  const Icon = cfg.Icon
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium',
      cfg.className
    )}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  )
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AmazonConnectionCard() {
  const [loading, setLoading]           = useState(true)
  const [status, setStatus]             = useState<AmazonStatus | null>(null)
  const [connecting, setConnecting]     = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [syncing, setSyncing]             = useState(false)
  const [syncingListings, setSyncingListings] = useState(false)
  const [localhostBlock, setLocalhostBlock] = useState(false)
  const [listingsJobId, setListingsJobId] = useState<string | null>(null)
  const [listingsSyncStatus, setListingsSyncStatus] = useState<ListingsSyncStatus | null>(null)

  function fetchStatus() {
    setLoading(true)
    fetch('/api/amazon/connect/status')
      .then(r => r.json())
      .then((data: AmazonStatus) => setStatus(data))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }

  // ── On mount: load status + handle ?amazon= redirect result ───────────────
  useEffect(() => {
    fetchStatus()

    try {
      const existingJobId = localStorage.getItem('amazon_listings_sync_job_id')
      if (existingJobId) setListingsJobId(existingJobId)
    } catch { /* SSR guard */ }

    function onJobStarted(e: Event) {
      const detail = (e as CustomEvent<{ job_id: string }>).detail
      if (!detail?.job_id) return
      setListingsJobId(detail.job_id)
      setListingsSyncStatus({ status: 'running', pages: 0, items_upserted: 0, error_message: null })
    }
    window.addEventListener('amazon:listings-sync-started', onJobStarted)

    // Block OAuth when on localhost and SPAPI_REDIRECT_URI points to production
    // Amazon requires HTTPS and a registered domain — use the Vercel URL to connect
    const redirectUri = process.env.NEXT_PUBLIC_APP_URL
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    const isRedirectLocal = !redirectUri || redirectUri.startsWith('http://localhost') || redirectUri.startsWith('http://127.0.0.1')
    if (isLocalhost && !isRedirectLocal) {
      setLocalhostBlock(true)
    }

    const params    = new URLSearchParams(window.location.search)
    const amazon    = params.get('amazon')
    const reason    = params.get('reason')

    if (amazon === 'connected') {
      toast.success('Amazon account connected successfully!')
      window.history.replaceState({}, '', window.location.pathname)
    } else if (amazon === 'error') {
      const msg = reason ? reason.replace(/_/g, ' ') : 'unknown error'
      toast.error(`Failed to connect Amazon account: ${msg}`)
      window.history.replaceState({}, '', window.location.pathname)
    }

    return () => {
      window.removeEventListener('amazon:listings-sync-started', onJobStarted)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!listingsJobId) return
    const jobId = listingsJobId

    let cancelled = false
    async function pullStatus() {
      try {
        const res = await fetch(`/api/amazon/sync/listings/status?job_id=${encodeURIComponent(jobId)}`)
        if (!res.ok) return
        const data = await res.json() as ListingsSyncStatus
        if (cancelled) return

        setListingsSyncStatus({
          status: data.status,
          pages: data.pages ?? 0,
          items_upserted: data.items_upserted ?? 0,
          error_message: data.error_message ?? null,
        })

        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          try { localStorage.removeItem('amazon_listings_sync_job_id') } catch { /* SSR guard */ }
          setListingsJobId(null)
          fetchStatus()
        }
      } catch {
        // non-fatal: watcher toast is the primary feedback channel
      }
    }

    void pullStatus()
    const timer = setInterval(() => {
      void pullStatus()
    }, 5000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [listingsJobId])

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/amazon/sync/basic', { method: 'POST' })
      // Parse body safely — server may return HTML on unexpected crash
      let data: { error?: string; ok?: boolean } = {}
      try { data = await res.json() } catch { /* body not JSON */ }
      if (res.ok) {
        toast.success('Sync complete — marketplace data updated.')
        fetchStatus()
      } else {
        const msg = data?.error ?? `Sync failed (HTTP ${res.status}). Please try again.`
        toast.error(msg)
      }
    } catch {
      toast.error('Network error — please try again.')
    } finally {
      setSyncing(false)
    }
  }

  async function handleSyncListings() {
    setSyncingListings(true)
    try {
      const res  = await fetch('/api/amazon/sync/listings/start', { method: 'POST' })
      let data: { error?: string; ok?: boolean; job_id?: string } = {}
      try { data = await res.json() } catch { /* body not JSON */ }

      if (res.ok && data.ok && data.job_id) {
        // Save job_id so AmazonSyncWatcher can resume if user navigates away
        try { localStorage.setItem('amazon_listings_sync_job_id', data.job_id) } catch { /* SSR guard */ }
        setListingsJobId(data.job_id)
        setListingsSyncStatus({ status: 'running', pages: 0, items_upserted: 0, error_message: null })
        // Tell the watcher to start processing immediately
        window.dispatchEvent(new CustomEvent('amazon:listings-sync-started', {
          detail: { job_id: data.job_id }
        }))
        toast.info('Listings sync started — importing in the background…')
        fetchStatus()
      } else {
        const msg = data?.error ?? `Failed to start listings sync (HTTP ${res.status}).`
        toast.error(msg)
      }
    } catch {
      toast.error('Network error — please try again.')
    } finally {
      setSyncingListings(false)
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect your Amazon account? This will remove all stored tokens.')) return
    setDisconnecting(true)
    try {
      const res = await fetch('/api/amazon/connect/status', { method: 'DELETE' })
      if (res.ok) {
        toast.success('Amazon account disconnected.')
        fetchStatus()
      } else {
        toast.error('Failed to disconnect. Please try again.')
      }
    } catch {
      toast.error('Network error — please try again.')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* ── Localhost OAuth block ─────────────────────────────────────── */}
      {localhostBlock && (
        <div className="px-5 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-400">
          <strong>Local dev:</strong> Amazon OAuth is available only on the deployed Vercel URL.{' '}
          Open the app on your Vercel domain to connect your Amazon account.
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-muted/20">
        <ShoppingBag className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
        <div>
          <h2 className="font-semibold text-sm text-foreground">Amazon Seller Account</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect your Amazon seller account to unlock SP-API features.
          </p>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="px-5 py-5">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking connection…
          </div>

        ) : status?.connected ? (
          /* ── Connected ────────────────────────────────────────────────── */
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
              <InfoRow label="Seller ID">
                <p className="font-mono text-xs text-foreground">{status.selling_partner_id ?? '—'}</p>
              </InfoRow>

              <InfoRow label="Marketplace">
                <p className="text-xs text-foreground">
                  {status.marketplace_name ?? status.marketplace_id ?? '—'}
                </p>
              </InfoRow>

              <InfoRow label="Status">
                <StatusBadge status={status.status} />
              </InfoRow>

              <InfoRow label="Last sync">
                <p className="text-xs text-foreground">{timeAgo(status.last_sync_at)}</p>
              </InfoRow>

              <InfoRow label="Brand Analytics">
                {status.brand_analytics_eligible
                  ? <span className="text-xs font-medium text-green-600">Eligible</span>
                  : <span className="text-xs text-muted-foreground">Not eligible</span>}
              </InfoRow>

              <InfoRow label="Brand Registry">
                {status.brand_registry_enrolled
                  ? <span className="text-xs font-medium text-green-600">Enrolled</span>
                  : <span className="text-xs text-muted-foreground">Not enrolled</span>}
              </InfoRow>
            </div>

            {status.error_message && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                {status.error_message}
              </div>
            )}

            {listingsSyncStatus?.status === 'running' && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                Listings sync in progress: {listingsSyncStatus.items_upserted} imported across {listingsSyncStatus.pages} page{listingsSyncStatus.pages === 1 ? '' : 's'}.
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                disabled={syncing || syncingListings || disconnecting}
                onClick={handleSync}
              >
                {syncing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />}
                {syncing ? 'Syncing…' : 'Sync Now'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={syncing || syncingListings || disconnecting}
                onClick={handleSyncListings}
              >
                {syncingListings
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Package className="w-3.5 h-3.5" />}
                {syncingListings ? 'Starting…' : 'Sync Listings'}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={disconnecting || syncing}
                onClick={handleDisconnect}
              >
                {disconnecting
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Link2Off className="w-3.5 h-3.5" />}
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </div>

        ) : (
          /* ── Not connected ────────────────────────────────────────────── */
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 flex items-start gap-3">
              <ShoppingBag className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                {status?.configured === false ? (
                  <>
                    <p className="text-sm font-medium text-foreground">Amazon SP-API not configured</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      SPAPI_APPLICATION_ID is not set on this server. Add it to .env.local and restart.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">No account connected</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Connect your Amazon Seller Central account via SP-API OAuth to enable
                      automated data sync, order tracking, and advanced analytics.
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={connecting || status?.configured === false || localhostBlock}
                onClick={() => {
                  setConnecting(true)
                  window.location.href = '/api/amazon/connect/start'
                }}
              >
                {connecting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting…</>
                  : 'Connect Amazon Account'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
