'use client'
import { useEffect, useState } from 'react'
import type { reconciliationGate } from '@/lib/internal/ads-reconciliation'

type Readiness = ReturnType<typeof reconciliationGate>
async function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  const response = await fetch('/api/internal/ads-readiness', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Ads verification status is unavailable. Recommendations remain in validation.')
  return response.json()
}
export function AdsReadinessPanel() {
  const [result, setResult] = useState<Readiness | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  async function refresh(signal?: AbortSignal) {
    try {
      const data = await fetchReadiness(signal)
      if (!signal?.aborted) setResult(data)
    } catch (err) {
      if (!signal?.aborted) { setResult(null); setError(err instanceof Error ? err.message : 'Verification unavailable.') }
    } finally { if (!signal?.aborted) setChecking(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    fetchReadiness(controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult(data) })
      .catch(() => { if (!controller.signal.aborted) setError('Ads verification status is unavailable. Recommendations remain in validation.') })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [])
  return <section className="rounded-xl border border-border bg-card p-4 space-y-3" aria-label="Ads release readiness">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-bold">Daily Ads Actions · Validation</h2>
      <button type="button" disabled={checking} onClick={() => { setChecking(true); setError(''); void refresh() }} className="text-sm text-primary disabled:opacity-50">{checking ? 'Checking…' : 'Refresh status'}</button>
    </div>
    <p role="status" className="text-sm text-muted-foreground">{error || result?.message || 'Checking independent Amazon reconciliation…'}</p>
    {result && <>
      <progress className="w-full h-2" max={result.requiredDays} value={result.consecutiveDays} aria-label="Consecutive verified days" />
      <p className="text-xs text-muted-foreground">{result.lastCheckedAt ? `Last comparison ${new Date(result.lastCheckedAt).toLocaleString('en-IN')}. ` : ''}Three sampled dates are compared across all six Ads reports. Each metric must match within 2%.</p>
    </>}
    <p className="text-xs text-muted-foreground">Refreshing this status reads saved verification results.</p>
  </section>
}
