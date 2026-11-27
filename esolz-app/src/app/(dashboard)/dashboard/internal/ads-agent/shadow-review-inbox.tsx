'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { DecisionSignals } from '@/lib/internal/ads-agent-signals'

type Evidence = {
  clicks?: number; spend?: number; purchases?: number; sales?: number
  acosPercent?: number | null; lookbackDays?: number
  signals?: DecisionSignals
}
type Action = {
  id: string; profile_id: string; action_type: string; reason_code: string
  entity_type: string; entity_id: string; campaign_id: string; ad_group_id: string
  current_value: number | null; proposed_value: number | null; change_percent: number | null
  evidence: Evidence; data_through: string; status: string; created_at: string
}
type Review = { action_id: string; decision: 'approve' | 'reject'; reviewed_at: string }
type LatestRun = { status: string; error_code: string | null; started_at: string; data_through: string | null; evaluated_count: number; proposed_count: number }
type Payload = { actions: Action[]; reviews: Review[]; latestRun: LatestRun | null }

export function ShadowReviewInbox() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/internal/ads-agent/reviews', { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load shadow recommendations.')
      setData(await response.json() as Payload)
      setError(null)
    } catch { setError('Could not load shadow recommendations.'); setData(null) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/internal/ads-agent/reviews', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load shadow recommendations.')
        setData(await response.json() as Payload)
      })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load shadow recommendations.') })
    return () => controller.abort()
  }, [])

  async function review(actionId: string, decision: 'approve' | 'reject') {
    setSaving(actionId)
    try {
      const response = await fetch('/api/internal/ads-agent/reviews', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, decision }),
      })
      if (!response.ok) throw new Error('Could not save review.')
      await load()
    } catch { setError('Could not save review. Please retry.') }
    finally { setSaving(null) }
  }

  const reviews = new Map(data?.reviews.map(row => [row.action_id, row]) ?? [])
  return <main className="mx-auto max-w-6xl space-y-6 p-6">
    <div>
      <h1 className="text-2xl font-semibold">Ads shadow recommendations</h1>
      <p className="mt-2 text-sm text-slate-600">Review decisions are feedback only. They do not change Amazon bids or budgets.</p>
      <Link href="/dashboard/internal/ads-agent/explorer" className="mt-2 inline-block text-sm text-blue-700 underline">Explore campaigns, targets and search terms</Link>
    </div>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{error}</p>}
    {!data && !error && <p>Loading recommendations…</p>}
    {data && <>
      <section className="rounded border p-4 text-sm">
        {data.latestRun
          ? <>Latest evaluation: {data.latestRun.status} · {new Date(data.latestRun.started_at).toLocaleString()} · {data.latestRun.evaluated_count} targets checked · {data.latestRun.proposed_count} proposals
            {data.latestRun.error_code && <> · {data.latestRun.error_code}</>}</>
          : 'No shadow evaluation has run yet.'}
      </section>
      {data.actions.length === 0 && <p className="rounded border p-6">No recommendations yet. This can mean the data gate has not passed or no target met the safety thresholds.</p>}
      <div className="space-y-4">
        {data.actions.map(action => {
          const reviewRecord = reviews.get(action.id)
          const evidence = action.evidence ?? {}
          return <article key={action.id} className="rounded border bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{action.action_type === 'decrease_bid' ? 'Suggested bid decrease' : 'Suggested target pause'}</h2>
                <p className="text-sm text-slate-600">{action.reason_code.replaceAll('_', ' ')} · Profile {action.profile_id} · Data through {action.data_through}</p>
              </div>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs">{reviewRecord ? `Reviewed: ${reviewRecord.decision}` : action.status}</span>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-slate-500">Target ID</dt><dd className="break-all">{action.entity_id}</dd></div>
              <div><dt className="text-slate-500">Campaign / ad group</dt><dd className="break-all">{action.campaign_id} / {action.ad_group_id}</dd></div>
              <div><dt className="text-slate-500">Bid proposal</dt><dd>{action.current_value ?? '—'} → {action.proposed_value ?? '—'} ({action.change_percent ?? '—'}%)</dd></div>
              <div><dt className="text-slate-500">Evidence</dt><dd>{evidence.clicks ?? '—'} clicks · ₹{evidence.spend ?? '—'} spend · {evidence.purchases ?? '—'} orders</dd></div>
              <div><dt className="text-slate-500">ACOS</dt><dd>{evidence.acosPercent == null ? 'Unknown' : `${evidence.acosPercent.toFixed(1)}%`}</dd></div>
              <div><dt className="text-slate-500">Organic rank</dt><dd>{evidence.signals?.rankStatus === 'fresh' ? (evidence.signals.organicRank == null ? 'Not found' : `#${evidence.signals.organicRank}`) : 'Unknown'} · {evidence.signals?.organicTrend ?? 'unknown'} trend</dd></div>
              <div><dt className="text-slate-500">Sponsored rank</dt><dd>{evidence.signals?.rankStatus === 'fresh' ? (evidence.signals.sponsoredRank == null ? 'Not found' : `#${evidence.signals.sponsoredRank}`) : 'Unknown'}</dd></div>
              <div><dt className="text-slate-500">Pincode availability</dt><dd>{evidence.signals?.availability ?? 'unknown'} · {evidence.signals?.confirmedPincodes ?? 0}/{evidence.signals?.configuredPincodes ?? 0} confirmed{evidence.signals?.unavailablePincodes ? ` · ${evidence.signals.unavailablePincodes} unavailable` : ''}</dd></div>
              <div><dt className="text-slate-500">Product match</dt><dd>{evidence.signals?.mapping === 'single_product' ? 'One advertised product' : 'Unknown or multiple products'}</dd></div>
              <div><dt className="text-slate-500">Projected sales impact / confidence</dt><dd>Not estimated from available evidence</dd></div>
            </dl>
            {action.status === 'proposed' && <div className="mt-4 flex gap-2">
              <button disabled={saving === action.id} onClick={() => void review(action.id, 'approve')} className="rounded bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50">Approve as feedback</button>
              <button disabled={saving === action.id} onClick={() => void review(action.id, 'reject')} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Reject</button>
            </div>}
          </article>
        })}
      </div>
    </>}
  </main>
}
