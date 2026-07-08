'use client'

// Sync Health Layer MVP: a single, always-visible source-of-truth panel so
// nobody (dashboard viewer or future Top 5 Actions Engine) trusts stale or
// broken data silently. Fetches its own data independently of the main
// diagnostic API so it renders even if that larger fetch is slow/erroring.
import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import type { BrahmastraDataHealth, SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

const STATUS_STYLE: Record<SourceHealthStatus, string> = {
  healthy: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300',
  stale: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
  rate_limited: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
  auth_required: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  failed: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  not_configured: 'border-border bg-muted text-muted-foreground',
}

const STATUS_LABEL: Record<SourceHealthStatus, string> = {
  healthy: 'Healthy',
  stale: 'Stale',
  rate_limited: 'Rate limited',
  auth_required: 'Auth required',
  failed: 'Failed',
  not_configured: 'Not configured',
}

export function BrahmastraSyncHealthSection() {
  const [health, setHealth] = useState<BrahmastraDataHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/internal/brahmastra-data-health')
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to load data health')
        return res.json() as Promise<BrahmastraDataHealth>
      })
      .then(json => { if (!cancelled) setHealth(json) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load data health') })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 text-sm text-muted-foreground">
        Sync Health unavailable: {error}
      </div>
    )
  }

  if (!health) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 text-sm text-muted-foreground">
        Checking data source health…
      </div>
    )
  }

  // Non-blocking warnings (e.g. Settlement running long on its natural lag)
  // must never make an otherwise-healthy panel look broken — they're shown
  // as "healthy with a warning" rather than folded into the same red/amber
  // "don't trust this" banner used for sources that actually block actions.
  const nonBlockingWarnings = health.sources.filter(s => s.status !== 'healthy' && !s.blocksActions)

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-foreground">Brahmastra Sync Health</h2>
        <span className="text-xs text-muted-foreground">
          Checked {new Date(health.generatedAt).toLocaleString('en-IN')}
        </span>
      </div>

      {!health.overallTrustworthy && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 mb-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Do not trust action recommendations until every required source below is healthy.</span>
        </div>
      )}
      {health.overallTrustworthy && nonBlockingWarnings.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 mb-3 text-sm text-green-700 dark:text-green-300">
          <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>All required sources are healthy.</span>
        </div>
      )}
      {health.overallTrustworthy && nonBlockingWarnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 mb-3 text-sm text-green-700 dark:text-green-300">
          <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            Healthy — {nonBlockingWarnings.length} warning{nonBlockingWarnings.length > 1 ? 's' : ''}: {nonBlockingWarnings.map(s => s.label).join(', ')}.
            {' '}This does not block action recommendations.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {health.sources.map(source => (
          <div key={source.source} className="border border-border rounded-lg p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold text-foreground">{source.label}</p>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[source.status]}`}>
                {STATUS_LABEL[source.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{source.message}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
