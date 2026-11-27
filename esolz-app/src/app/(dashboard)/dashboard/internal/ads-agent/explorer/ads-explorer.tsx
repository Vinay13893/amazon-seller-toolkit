'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type Level = 'campaign' | 'target' | 'term'
type Item = {
  key: string; campaignId: string; campaignName: string
  adGroupId: string | null; adGroupName: string | null; targetId: string | null
  target: string | null; searchTerm: string | null
  impressions: number; clicks: number; spend: number; purchases: number; sales: number; acosPercent: number | null
}
type Result = { profileId: string; fromDate: string; throughDate: string; sourceRows: number; items: Item[] }

export function AdsExplorer() {
  const [level, setLevel] = useState<Level>('campaign')
  const [campaign, setCampaign] = useState<{ id: string; name: string } | null>(null)
  const [adGroup, setAdGroup] = useState<{ id: string; name: string } | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ level })
    if (campaign) params.set('campaignId', campaign.id)
    if (adGroup) params.set('adGroupId', adGroup.id)
    fetch(`/api/internal/ads-agent/explorer?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load complete Ads report rows.')
        setResult(await response.json() as Result)
        setError(null)
      })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load complete Ads report rows. Try again later.') })
    return () => controller.abort()
  }, [level, campaign, adGroup])

  function showCampaigns() { setResult(null); setLevel('campaign'); setCampaign(null); setAdGroup(null) }
  function showTargets(item: Item) { setResult(null); setLevel('target'); setCampaign({ id: item.campaignId, name: item.campaignName }); setAdGroup(null) }
  function showTerms(item: Item) {
    if (!item.adGroupId) return
    setResult(null); setLevel('term'); setAdGroup({ id: item.adGroupId, name: item.adGroupName ?? item.adGroupId })
  }
  return <main className="mx-auto max-w-7xl space-y-5 p-6">
    <div>
      <Link href="/dashboard/internal/ads-agent" className="text-sm text-blue-700 underline">← Shadow recommendations</Link>
      <h1 className="mt-3 text-2xl font-semibold">Ads report drilldown</h1>
      <p className="text-sm text-slate-600">Read-only report totals. The most recent three days are excluded because attributed sales may still change.</p>
    </div>
    <nav className="flex gap-2 text-sm">
      <button onClick={showCampaigns} className="rounded border px-3 py-2">Campaigns</button>
      {campaign && <button onClick={() => { setResult(null); setLevel('target'); setAdGroup(null) }} className="rounded border px-3 py-2">{campaign.name} targets</button>}
      {adGroup && <span className="rounded bg-slate-100 px-3 py-2">{adGroup.name} search terms</span>}
    </nav>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{error}</p>}
    {!result && !error && <p>Loading report…</p>}
    {result && <>
      <p className="text-sm text-slate-600">Profile {result.profileId} · {result.fromDate} to {result.throughDate} · {result.sourceRows} source rows</p>
      {result.items.length === 0 && <p className="rounded border p-5">No rows for this selection.</p>}
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100"><tr><th className="p-3">{level === 'campaign' ? 'Campaign' : level === 'target' ? 'Target' : 'Search term'}</th><th className="p-3">Impressions</th><th className="p-3">Clicks</th><th className="p-3">Spend</th><th className="p-3">Orders</th><th className="p-3">Sales</th><th className="p-3">ACOS</th></tr></thead>
          <tbody>{result.items.slice(0, 200).map(item => <tr key={item.key} className="border-t">
            <td className="p-3">{level === 'campaign'
              ? <button className="text-left text-blue-700 underline" onClick={() => showTargets(item)}>{item.campaignName}</button>
              : level === 'target'
                ? <button className="text-left text-blue-700 underline" onClick={() => showTerms(item)}>{item.target ?? item.targetId}</button>
                : item.searchTerm}</td>
            <td className="p-3">{item.impressions.toLocaleString()}</td><td className="p-3">{item.clicks.toLocaleString()}</td>
            <td className="p-3">₹{item.spend.toFixed(2)}</td><td className="p-3">{item.purchases.toLocaleString()}</td>
            <td className="p-3">₹{item.sales.toFixed(2)}</td><td className="p-3">{item.acosPercent == null ? '—' : `${item.acosPercent.toFixed(1)}%`}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {result.items.length > 200 && <p className="text-sm text-slate-600">Showing the top 200 by spend of {result.items.length} groups. Narrow the selection to see more.</p>}
    </>}
  </main>
}
