'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Source = { source: string; label: string; status: string; dateThrough: string | null; finishedAt: string | null }
const labels: Record<string, string> = {
  success: 'Last run completed', failed: 'Needs attention', partial_success: 'Incomplete',
  running: 'Updating', skipped: 'Run skipped', not_started: 'Not activated', connection_required: 'Connection required',
}

export function AmazonDataPanel() {
  const [sources, setSources] = useState<Source[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetch('/api/internal/amazon-sync-status', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Could not check sync status. Try again.')
        return response.json() as Promise<{ sources: Source[] }>
      })
      .then(data => { if (!controller.signal.aborted) setSources(data.sources) })
      .catch(error => { if (!controller.signal.aborted) setError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3" aria-label="Amazon data updates">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Amazon data updates</h2>
          <p className="text-sm text-muted-foreground">Scheduled syncs collect Amazon reports. View latest Ads data loads the newest saved results.</p>
        </div>
        <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!error && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite" aria-busy={loading}>
        {sources.map(source => <div key={source.source} className="rounded-lg border border-border p-3 min-w-0">
          <p className="text-sm font-medium">{source.label}</p>
          <p className="text-xs text-muted-foreground">{labels[source.status] ?? 'Status unknown'}</p>
          {source.dateThrough && <p className="text-xs">Last run through {source.dateThrough}</p>}
          {source.finishedAt && <p className="text-xs text-muted-foreground">Checked {new Date(source.finishedAt).toLocaleString('en-IN')}</p>}
        </div>)}
      </div>}
      <p className="text-xs text-muted-foreground">Refresh status checks saved sync results; it does not start a new Amazon sync. Missing sources are not treated as zero. Finance data can arrive late.</p>
      <p className="text-xs text-muted-foreground">Purchase costs, supplier bills and off-Amazon stock: <strong>Unavailable</strong>. Actual profit and off-Amazon replenishment decisions require those sources.</p>
      <Link href="/dashboard/internal/stock-intelligence" className="inline-flex rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Open Stock Reconciliation →</Link>
    </section>
  )
}
