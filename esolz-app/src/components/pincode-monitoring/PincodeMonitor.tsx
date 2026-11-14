'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { AsinProductSelector } from '@/components/asins/AsinProductSelector'
import { useAsinProductDomains } from '@/hooks/use-asin-product-domains'
import type { TrackerProductRow } from '@/lib/pincode-monitoring/tracker'

type Context = { workspaceId: string; marketplaceId: string | null; monitoringEnabled: boolean; canEdit: boolean; quota: number }
type HistoryRow = { id: string; asin: string; pincode: string; checked_at: string | null; check_status: string | null;
  availability_status: string | null; delivery_message: string | null; error_code: string | null; tracking_target_id: string | null }
const field = 'rounded-lg border border-border bg-background px-3 py-2 text-sm'
function date(value: string | null) { return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not checked yet' }
function label(value: string | null) { return (value ?? 'not confirmed').replaceAll('_', ' ') }
function Result({ status }: { status: string | null }) {
  const tone = status === 'available' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' :
    status === 'unavailable' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
  return <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium capitalize ${tone}`}>{label(status)}</span>
}
async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? body.message ?? 'Could not complete this request.')
  return body
}

export function PincodeMonitor() {
  const [context, setContext] = useState<Context | null>(null)
  const [tab, setTab] = useState<'watchlist' | 'history'>('watchlist')
  const [products, setProducts] = useState<TrackerProductRow[]>([])
  const [history, setHistory] = useState<{ items: HistoryRow[]; total: number }>({ items: [], total: 0 })
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [pins, setPins] = useState('')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const domains = useAsinProductDomains()
  useEffect(() => { let alive = true; void read<Context>('/api/pincode-monitoring/context')
    .then(value => { if (alive) { setContext(value); if (!value.monitoringEnabled || new URLSearchParams(window.location.search).get('view') === 'history') setTab('history') } })
    .catch(e => { if (alive) { setError(e.message); setLoading(false) } }); return () => { alive = false } }, [])

  const reload = useCallback(async () => {
    if (!context) return
    const current = ++sequence.current
    setLoading(true)
    try {
      if (tab === 'watchlist' && context.monitoringEnabled) {
        const query = new URLSearchParams({ workspaceId: context.workspaceId, marketplaceId: context.marketplaceId!, limit: '100' })
        const data = await read<{ items: TrackerProductRow[] }>(`/api/pincode-monitoring/tracker?${query}`)
        if (current === sequence.current) setProducts(data.items)
      } else {
        const query = new URLSearchParams({ workspaceId: context.workspaceId, offset: String(offset), search })
        if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString())
        if (to) { const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate() + 1); query.set('to', end.toISOString()) }
        const data = await read<{ items: HistoryRow[]; total: number }>(`/api/pincode-monitoring/history?${query}`)
        if (current === sequence.current) setHistory(data)
      }
      if (current === sequence.current) setError('')
    } catch (e) { if (current === sequence.current) setError(e instanceof Error ? e.message : 'Could not load results.') }
    finally { if (current === sequence.current) setLoading(false) }
  }, [context, tab, offset, search, from, to])
  useEffect(() => {
    const delay = setTimeout(() => { void reload() }, 250)
    const timer = setInterval(() => { if (!document.hidden) void reload() }, 30_000)
    return () => { clearTimeout(delay); clearInterval(timer) }
  }, [reload])

  async function mutate(path: string, body: Record<string, unknown>, method = 'POST') {
    if (!context) return false
    setBusy(true); setError(''); setNotice('')
    try {
      await read(`/api/pincode-monitoring/${path}`, { method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: context.workspaceId, marketplaceId: context.marketplaceId, ...body }) })
      await reload(); return true
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes.'); return false }
    finally { setBusy(false) }
  }
  async function enroll() {
    const pincodes = Array.from(new Set(pins.trim().split(/[\s,]+/).filter(Boolean)))
    if (!pincodes.length || pincodes.some(pin => !/^[1-9][0-9]{5}$/.test(pin))) { setError('Enter valid six-digit Indian pincodes, separated by commas or new lines.'); return }
    const chosen = [...domains.myProducts, ...domains.competitorProducts].filter(p => selected.includes(p.key))
    if (!chosen.length) { setError('Select at least one product.'); return }
    if (await mutate('products', { products: chosen.map(p => ({ asin: p.asin, productSource: p.domain === 'my' ? 'owned' : 'other',
      amazonListingItemId: p.domain === 'my' ? p.primarySourceId : null,
      titleSnapshot: p.title, imageUrlSnapshot: p.imageUrl, brandSnapshot: p.brand, pincodes })) })) {
      setAdding(false); setSelected([]); setPins(''); setNotice('Saved. The first check is queued, then checks repeat every 24 hours. You can close this page.')
    }
  }
  function exportPage() {
    const cell = (value: unknown) => { let text = String(value ?? ''); if (/^[=+@\-\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"` }
    const rows = [['ASIN', 'Pincode', 'Checked at', 'Result', 'Delivery', 'Source'], ...history.items.map(row => [row.asin, row.pincode,
      row.checked_at, row.check_status === 'failed' || row.check_status === 'blocked' ? row.check_status : row.availability_status ?? 'not confirmed',
      row.delivery_message, row.tracking_target_id ? 'Watchlist' : 'Earlier one-time check'])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'pincode-history.csv'; anchor.click(); URL.revokeObjectURL(url)
  }
  const targets = products.flatMap(p => p.targets)
  return <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-sm text-muted-foreground">Delivery monitoring</p><h1 className="text-3xl font-semibold">Pincode Checker</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Save a watchlist for daily checks. See where customers can buy your products and keep every result in History.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void reload()} disabled={loading}>Refresh view</Button>
        {context?.monitoringEnabled && context.canEdit && <Button onClick={() => { setTab('watchlist'); setAdding(!adding) }}>Add products & pincodes</Button>}</div>
    </header>
    {error && <div role="alert" className="rounded-xl border border-red-300 bg-red-500/10 p-4 text-sm">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-500/10 p-4 text-sm">{notice}</div>}
    <div className="rounded-xl border bg-card p-4 text-sm"><strong>{context?.monitoringEnabled ? 'Daily monitoring is enabled' : context ? 'Daily monitoring is not enabled for this workspace' : 'Loading your workspace…'}</strong>
      <p className="mt-1 text-muted-foreground">{context?.monitoringEnabled ? `Saved pairs are checked every 24 hours. Queued checks are picked up every 5 minutes. Up to ${context.quota} active product–pincode pairs.` : 'Your previously saved checks remain available below.'} Refresh view only reloads saved results.</p>
      {context?.monitoringEnabled && <p className="mt-2 text-xs text-muted-foreground">Blocked checks retry after 48 hours. Five consecutive failures pause the pair until you resume it. Results reflect the time recorded, not continuous stock availability.</p>}
    </div>
    <nav aria-label="Pincode views" className="flex gap-2 border-b pb-3"><Button variant={tab === 'watchlist' ? 'default' : 'outline'} disabled={!context?.monitoringEnabled} onClick={() => setTab('watchlist')}>Watchlist</Button><Button variant={tab === 'history' ? 'default' : 'outline'} onClick={() => { setTab('history'); setAdding(false) }}>History</Button></nav>
    {tab === 'watchlist' && <>
      {adding && <section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">Start daily monitoring</h2>
        <AsinProductSelector {...domains} myProducts={domains.myProducts.filter(p => p.marketplaceId === context?.marketplaceId)} competitorProducts={domains.competitorProducts.filter(p => p.marketplace === 'IN')} selectedKeys={selected} onSelectedKeysChange={setSelected} maxSelected={10} />
        <label className="block space-y-2 text-sm"><span>Pincodes for all selected products</span><textarea className={`${field} w-full`} rows={2} placeholder="e.g. 110001, 560001" value={pins} onChange={e => setPins(e.target.value)} /></label>
        <div className="flex gap-2"><Button disabled={busy || !selected.length} onClick={() => void enroll()}>{busy ? 'Saving…' : 'Save & start daily checks'}</Button><Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button></div>
      </section>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[['Products watched', products.length], ['Pincode pairs', targets.length], ['Available at last check', targets.filter(t => t.availabilityState === 'available').length], ['Needs attention', targets.filter(t => ['blocked', 'check_failed', 'unavailable'].includes(t.availabilityState)).length]].map(([name, value]) => <div key={name} className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{name}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>)}</div>
      {!products.length && !loading && <div className="rounded-xl border border-dashed p-10 text-center"><h2 className="font-semibold">Your daily watchlist is empty</h2><p className="mt-2 text-sm text-muted-foreground">Add products and pincodes above. Earlier checks are already saved in History.</p><Button className="mt-4" variant="outline" onClick={() => setTab('history')}>View previous results</Button></div>}
      {products.map(product => <section key={product.id} className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div className="min-w-0"><h2 className="break-words font-semibold">{product.titleSnapshot ?? product.asin}</h2><p className="mt-1 text-xs text-muted-foreground">{product.asin} · {product.productSource === 'owned' ? 'My product' : 'Other product'} · {label(product.trackerState)}</p></div>
          {context?.canEdit && <Button variant="outline" size="sm" disabled={busy || product.targets.some(t => t.status === 'checking')} onClick={async () => {
            const action = product.trackerState === 'paused' || product.trackerState === 'failed' ? 'resume' : 'pause'
            if (await mutate(`products/${product.id}/${action}`, {}, 'PATCH')) setNotice(action === 'pause' ? 'Daily checks paused. History is retained.' : 'Daily checks resumed.')
          }}>{product.trackerState === 'paused' || product.trackerState === 'failed' ? 'Resume daily checks' : 'Pause daily checks'}</Button>}</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{['Pincode', 'Latest result', 'Last checked', 'Next check', ''].map((name, i) => <th key={i} className="p-3 font-medium">{name}</th>)}</tr></thead>
          <tbody>{product.targets.map(target => <tr key={target.id} className="border-t align-top"><td className="p-3 font-medium">{target.pincode}</td><td className="max-w-72 p-3"><Result status={target.availabilityState} /><p className="mt-2 break-words text-xs text-muted-foreground">{target.deliveryMessage ?? target.errorMessage}</p>
            {target.lastConfirmedAvailability && ['blocked', 'check_failed'].includes(target.availabilityState) && <p className="mt-1 text-xs">Previously {target.lastConfirmedAvailability.availabilityStatus} · {date(target.lastConfirmedAvailability.checkedAt)}</p>}</td>
            <td className="p-3 text-xs">{date(target.lastCheckedAt)}</td><td className="p-3 text-xs">{target.status === 'checking' ? 'Checking now' : target.status === 'paused' ? 'Paused' : target.status === 'failed' ? 'Paused after failures — resume to retry' : target.nextCheckAt && new Date(target.nextCheckAt).getTime() <= Date.now() ? 'Queued for next available run' : target.nextCheckAt ? date(target.nextCheckAt) : 'Not scheduled'}</td>
            <td className="p-3">{context?.canEdit && <Button variant="outline" size="sm" disabled={busy || target.status !== 'active'} onClick={async () => { if (await mutate('check-now', { targetId: target.id })) setNotice('Check queued. Results update automatically when the checker finishes.') }}>Check now</Button>}</td></tr>)}</tbody></table></div>
      </section>)}
    </>}
    {tab === 'history' && <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-xs">ASIN or pincode<input className={field} value={search} maxLength={10} placeholder="Search saved results" onChange={e => { setSearch(e.target.value); setOffset(0) }} /></label>
        <label className="grid gap-1 text-xs">From<input type="date" className={field} value={from} onChange={e => { setFrom(e.target.value); setOffset(0) }} /></label>
        <label className="grid gap-1 text-xs">Through<input type="date" className={field} value={to} min={from} onChange={e => { setTo(e.target.value); setOffset(0) }} /></label>
        <Button variant="outline" onClick={() => { setSearch(''); setFrom(''); setTo(''); setOffset(0) }}>All dates</Button><Button variant="outline" disabled={loading || !history.items.length} onClick={exportPage}>Export this page</Button></div>
      <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground"><span>{history.total} saved results · newest first · local timezone</span><Link className="underline" href="/dashboard/pincode">Older legacy checker records</Link></div>
      <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-muted/50"><tr>{['Checked at', 'ASIN', 'Pincode', 'Result', 'Delivery / check details', 'Source'].map(name => <th key={name} className="p-3 text-xs font-medium">{name}</th>)}</tr></thead>
        <tbody>{history.items.map(row => <tr key={row.id} className="border-t align-top"><td className="whitespace-nowrap p-3 text-xs">{date(row.checked_at)}</td><td className="p-3 font-mono text-xs">{row.asin}</td><td className="p-3">{row.pincode}</td><td className="p-3"><Result status={row.check_status === 'failed' || row.check_status === 'blocked' ? row.check_status : row.availability_status} /></td><td className="max-w-sm break-words p-3 text-xs text-muted-foreground">{row.delivery_message || (row.error_code ? 'Check could not confirm availability' : 'No delivery message recorded')}</td><td className="p-3 text-xs">{row.tracking_target_id ? 'Watchlist' : 'Earlier one-time check'}</td></tr>)}</tbody></table>
        {!history.items.length && <p className="p-10 text-center text-sm text-muted-foreground">{loading ? 'Loading saved checks…' : 'No saved results match these filters.'}</p>}</div>
      <div className="flex items-center justify-between"><Button variant="outline" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><span className="text-xs">Page {Math.floor(offset / 50) + 1}</span><Button variant="outline" disabled={loading || offset + 50 >= history.total} onClick={() => setOffset(offset + 50)}>Next</Button></div>
    </section>}
  </div>
}
