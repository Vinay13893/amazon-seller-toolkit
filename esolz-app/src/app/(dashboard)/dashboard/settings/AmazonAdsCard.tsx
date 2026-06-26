'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, BarChart3, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type AdsProfile = {
  profile_id: string
  marketplace_id: string | null
  country_code: string | null
  currency_code: string | null
  timezone: string | null
  profile_type: string | null
  status: string | null
  last_synced_at: string | null
}

type AdsStatusResponse = {
  success: boolean
  errorCode?: string
  message?: string
  profilesSynced?: number
  configured?: boolean
  configuredVia?: 'oauth' | 'oauth_ready' | 'env' | 'none'
  envPresence?: {
    configuredEnvNames?: string[]
    missingEnvNames?: string[]
  }
  directCredentials?: {
    configured: boolean
    envNames: string[]
  }
  connection?: {
    status: string
    marketplaceId: string | null
    region: string | null
    lastProfileSyncAt: string | null
    errorCode: string | null
    errorMessage: string | null
  } | null
  profiles?: AdsProfile[]
  lastSyncAt?: string | null
}

function timeAgo(iso?: string | null): string {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function StatusPill({ status }: { status: string }) {
  const active = status === 'active'
  const Icon = active ? CheckCircle2 : AlertCircle
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
      active
        ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300'
        : 'border-border bg-muted/40 text-muted-foreground',
    )}>
      <Icon className="h-3 w-3" />
      {status.replace(/_/g, ' ')}
    </span>
  )
}

export default function AmazonAdsCard() {
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState<AdsStatusResponse | null>(null)

  async function fetchStatus() {
    setLoading(true)
    try {
      const res = await fetch('/api/amazon/ads/status')
      const data = await res.json() as AdsStatusResponse
      setStatus(data)
    } catch {
      setStatus({
        success: false,
        errorCode: 'ads_status_failed',
        message: 'Unable to load Amazon Ads status.',
        profiles: [],
      })
    } finally {
      setLoading(false)
    }
  }

  async function syncProfiles() {
    setSyncing(true)
    try {
      const res = await fetch('/api/amazon/ads/profiles/sync', { method: 'POST' })
      const data = await res.json() as AdsStatusResponse
      setStatus(prev => ({
        ...(prev ?? {}),
        success: data.success,
        errorCode: data.errorCode,
        message: data.message,
      }))
      if (res.ok) await fetchStatus()
    } catch {
      setStatus(prev => ({
        ...(prev ?? {}),
        success: false,
        errorCode: 'ads_profile_sync_failed',
        message: 'Unable to sync Amazon Ads profiles.',
      }))
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ads = params.get('amazon_ads')
    const reason = params.get('reason')
    if (ads === 'connected') {
      window.history.replaceState({}, '', window.location.pathname)
    } else if (ads === 'error') {
      setStatus({
        success: false,
        errorCode: reason ?? 'ads_oauth_failed',
        message: 'Amazon Ads connection failed.',
        profiles: [],
      })
      window.history.replaceState({}, '', window.location.pathname)
    }
    void fetchStatus()
  }, [])

  const profiles = status?.profiles ?? []
  const connectionStatus = status?.connection?.status ?? 'not_configured'
  const connected = connectionStatus === 'active'
  const configuredVia = status?.configuredVia ?? (connected ? 'oauth' : 'none')
  const directCredsConfigured = status?.directCredentials?.configured === true
  const notConfigured = configuredVia === 'none'

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3 border-b border-border bg-muted/20 px-5 py-4">
        <BarChart3 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">Amazon Ads</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Connect Amazon Ads to sync advertising profiles. Report sync and automation are not enabled yet.
          </p>
        </div>
      </div>

      <div className="px-5 py-5">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking Ads status...
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <div className="mt-1">
                  <StatusPill status={connectionStatus} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Profiles</p>
                <p className="mt-1 text-sm font-medium text-foreground">{profiles.length}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Last sync</p>
                <p className="mt-1 text-sm font-medium text-foreground">{timeAgo(status?.lastSyncAt)}</p>
              </div>
            </div>

            {configuredVia === 'oauth' && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
                Connected via OAuth.
              </div>
            )}

            {configuredVia === 'oauth_ready' && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                <span className="font-medium">OAuth ready — not connected.</span> Amazon Ads OAuth is configured. Click Connect Amazon Ads to authorize the account.
              </div>
            )}

            {configuredVia === 'env' && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                Configured via environment credentials. Report sync can run. OAuth profile connection is not required for cron.
              </div>
            )}

            {notConfigured && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                Not configured. Either connect Amazon Ads via OAuth above, or set direct Ads credential environment variables
                (AMZN_ADS_CLIENT_ID/AMAZON_ADS_CLIENT_ID, *_CLIENT_SECRET, *_REFRESH_TOKEN, *_PROFILE_ID) to enable report sync without OAuth.
              </div>
            )}

            {status?.errorCode && status.errorCode !== 'ads_connection_not_configured' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                {status.errorCode}: {status.message ?? 'Amazon Ads is not ready yet.'}
              </div>
            )}

            {profiles.length > 0 ? (
              <div className="rounded-lg border border-border">
                <div className="grid grid-cols-4 gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  <span>Profile</span>
                  <span>Marketplace</span>
                  <span>Status</span>
                  <span>Last sync</span>
                </div>
                {profiles.map(profile => (
                  <div key={profile.profile_id} className="grid grid-cols-4 gap-3 px-3 py-2 text-xs text-foreground">
                    <span className="font-mono">{profile.profile_id}</span>
                    <span>{profile.marketplace_id ?? profile.country_code ?? '-'}</span>
                    <span>{profile.status ?? 'unknown'}</span>
                    <span>{timeAgo(profile.last_synced_at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No Ads profiles synced yet.
              </p>
            )}

            <div className="flex justify-end gap-2">
              {!connected && !directCredsConfigured && (
                <Button
                  size="sm"
                  disabled={connecting || notConfigured}
                  onClick={() => {
                    setConnecting(true)
                    window.location.href = '/api/amazon/ads/connect'
                  }}
                >
                  {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
                  {connecting ? 'Connecting...' : 'Connect Amazon Ads'}
                </Button>
              )}
              {connected && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={syncing}
                  onClick={() => void syncProfiles()}
                >
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {syncing ? 'Syncing...' : 'Sync Ads Profiles'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
