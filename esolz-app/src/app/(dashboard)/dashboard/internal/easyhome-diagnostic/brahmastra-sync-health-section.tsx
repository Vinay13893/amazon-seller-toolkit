'use client'

// Sync Health Layer: a single, always-visible source-of-truth panel so
// nobody (dashboard viewer or future Top 5 Actions Engine) trusts stale or
// broken data silently. Fetches its own data independently of the main
// diagnostic API so it renders even if that larger fetch is slow/erroring.
import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, ShieldCheck, XCircle } from 'lucide-react'
import type { BrahmastraDataHealth, OverallHealthLevel, SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

const STATUS_STYLE: Record<SourceHealthStatus, string> = {
  healthy: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300',
  stale: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
  rate_limited: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
  auth_required: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  failed: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  not_configured: 'border-border bg-muted text-muted-foreground',
}

// Seller-friendly wording — avoid raw technical terms like "auth" and "429".
const STATUS_LABEL: Record<SourceHealthStatus, string> = {
  healthy: 'Healthy',
  stale: 'Running behind',
  rate_limited: 'Slowed down',
  auth_required: 'Needs reconnect',
  failed: 'Sync issue',
  not_configured: 'Not set up yet',
}

const OVERALL_STYLE: Record<OverallHealthLevel, string> = {
  healthy: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
  healthy_with_warnings: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  critical: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
}

const OVERALL_LABEL: Record<OverallHealthLevel, string> = {
  healthy: 'Healthy',
  healthy_with_warnings: 'Healthy with warnings',
  warning: 'Warning',
  critical: 'Critical',
}

function OverallIcon({ level }: { level: OverallHealthLevel }) {
  if (level === 'critical') return <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
  if (level === 'warning') return <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
  return <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
}

function overallMessage(health: BrahmastraDataHealth): string {
  const nonBlockingWarnings = health.sources.filter(s => s.status !== 'healthy' && !s.blocksActions)
  switch (health.overallLevel) {
    case 'healthy':
      return 'All sources are healthy — action recommendations can be trusted.'
    case 'healthy_with_warnings':
      return `Healthy — ${nonBlockingWarnings.length} warning${nonBlockingWarnings.length === 1 ? '' : 's'}: ${nonBlockingWarnings.map(s => s.label).join(', ')}. This does not block action recommendations.`
    case 'warning':
      return 'Some sources need attention. Recommendations tied to those sources should wait until they recover.'
    case 'critical':
      return 'Do not trust action recommendations until every required source below is healthy.'
  }
}

export function BrahmastraSyncHealthSection() {
  const [health, setHealth] = useState<BrahmastraDataHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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

  function toggleExpanded(source: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

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

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-foreground">Brahmastra Sync Health</h2>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${OVERALL_STYLE[health.overallLevel]}`}>
            {OVERALL_LABEL[health.overallLevel]}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          Checked {new Date(health.generatedAt).toLocaleString('en-IN')}
        </span>
      </div>

      <div className={`flex items-start gap-2 rounded-lg border p-3 mb-3 text-sm ${OVERALL_STYLE[health.overallLevel]}`}>
        <OverallIcon level={health.overallLevel} />
        <span>{overallMessage(health)}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {health.sources.map(source => {
          const isExpanded = expanded.has(source.source)
          return (
            <div key={source.source} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold text-foreground">{source.label}</p>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[source.status]}`}>
                  {STATUS_LABEL[source.status]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{source.message}</p>
              <button
                type="button"
                onClick={() => toggleExpanded(source.source)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {isExpanded ? 'Hide details' : 'Show details'}
              </button>
              {isExpanded && (
                <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
                  {source.details.map((line, i) => (
                    <li key={i} className="text-[11px] text-muted-foreground flex gap-1.5">
                      <span>•</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
