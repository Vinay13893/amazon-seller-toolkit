'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { DataFreshnessBadge } from '@/components/dashboard/DataFreshnessBadge'
import {
  CITY_PRESETS,
  parsePincodes,
  scoreToStatus,
  type AvailabilityStatus,
} from '@/lib/mock-pincode'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  MapPin, CheckCircle2, XCircle, Clock, Truck,
  ShieldCheck, ShieldAlert, BarChart2, Play, RefreshCw,
  ExternalLink, Loader2,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrackedAsin {
  id:            string
  asin:          string
  product_title: string | null
}

interface DbPincodeCheck {
  id:               string
  tracked_asin_id:  string
  pincode:          string
  city:             string | null
  available:        boolean | null
  delivery_promise: string | null
  price:            number | null
  buy_box_seller:   string | null
  fulfillment_type: string | null
  checked_at:       string
}

function isFailedCheck(row: DbPincodeCheck): boolean {
  return (row.delivery_promise ?? '').toLowerCase().startsWith('check failed:')
}

function isAvailabilityUnknown(row: DbPincodeCheck): boolean {
  return row.available == null && !isFailedCheck(row)
}

// ─── Pincode → city lookup ────────────────────────────────────────────────────

const PINCODE_TO_CITY: Record<string, string> = {}
CITY_PRESETS.forEach(cp => cp.pincodes.forEach(p => { PINCODE_TO_CITY[p] = cp.city }))

function deriveCity(row: DbPincodeCheck): string {
  return row.city ?? PINCODE_TO_CITY[row.pincode] ?? 'Other'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AvailabilityStatus | null }) {
  if (status === null) {
    return (
      <span className="inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 border bg-muted text-muted-foreground border-border">
        Checker unavailable
      </span>
    )
  }

  const map = {
    healthy:  { label: 'Healthy',  cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
    warning:  { label: 'Warning',  cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    critical: { label: 'Critical', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  }
  const { label, cls } = map[status]
  return (
    <span className={cn(
      'inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 border',
      cls,
    )}>
      {label}
    </span>
  )
}

function FulfillmentBadge({ type }: { type: string | null }) {
  if (!type) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className={cn(
      'inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5',
      type === 'FBA' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
    )}>
      {type}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PincodePage() {
  const [workspaceId, setWorkspaceId]           = useState<string | null>(null)
  const [trackedAsins, setTrackedAsins]         = useState<TrackedAsin[]>([])
  const [selectedAsinId, setSelectedAsinId]     = useState<string>('')
  const [loading, setLoading]                   = useState(true)
  const [selectedCities, setSelectedCities]     = useState<Set<string>>(new Set())
  const [pincodeText, setPincodeText]           = useState('')
  const [isChecking, setIsChecking]             = useState(false)
  const [checkProgress, setCheckProgress]       = useState<{ done: number; total: number } | null>(null)
  const [results, setResults]                   = useState<DbPincodeCheck[]>([])
  const [pincodeChecksUsed, setPincodeChecksUsed] = useState(0)

  // ── Derived values ─────────────────────────────────────────────────────────

  const selectedAsin  = useMemo(
    () => trackedAsins.find(a => a.id === selectedAsinId)?.asin ?? '',
    [trackedAsins, selectedAsinId],
  )
  const selectedLabel = useMemo(
    () => trackedAsins.find(a => a.id === selectedAsinId)?.product_title ?? selectedAsin,
    [trackedAsins, selectedAsinId, selectedAsin],
  )
  const latestResults = useMemo(() => {
    const latestByPincode = new Map<string, DbPincodeCheck>()
    for (const row of results) {
      if (!latestByPincode.has(row.pincode)) {
        latestByPincode.set(row.pincode, row)
      }
    }
    return Array.from(latestByPincode.values())
  }, [results])
  const failedChecks  = useMemo(() => latestResults.filter(isFailedCheck), [latestResults])
  const unknownChecks = useMemo(() => latestResults.filter(isAvailabilityUnknown), [latestResults])
  const available     = useMemo(() => latestResults.filter(r => r.available === true), [latestResults])
  const unavailable   = useMemo(() => latestResults.filter(r => r.available === false), [latestResults])
  const confirmedChecks = useMemo(
    () => latestResults.filter(r => r.available === true || r.available === false),
    [latestResults],
  )
  const score         = useMemo(
    () => confirmedChecks.length ? Math.round((available.length / confirmedChecks.length) * 100) : null,
    [confirmedChecks, available],
  )
  const latestChecked = useMemo(
    () => latestResults.length ? latestResults[0].checked_at : null,
    [latestResults],
  )
  const cityBreakdown = useMemo(() => {
    const map = new Map<string, DbPincodeCheck[]>()
    latestResults.forEach(r => {
      const city = deriveCity(r)
      if (!map.has(city)) map.set(city, [])
      map.get(city)!.push(r)
    })
    return Array.from(map.entries()).map(([city, rows]) => {
      const confirmed  = rows.filter(r => r.available === true || r.available === false)
      const failed     = rows.filter(isFailedCheck)
      const unknown    = rows.filter(isAvailabilityUnknown)
      const avail      = confirmed.filter(r => r.available === true)
      const pct        = confirmed.length ? Math.round((avail.length / confirmed.length) * 100) : null
      const status: AvailabilityStatus | null = pct === null ? null : (pct >= 80 ? 'healthy' : pct >= 50 ? 'warning' : 'critical')
      const sellers    = confirmed.map(r => r.buy_box_seller).filter(Boolean) as string[]
      const freq       = sellers.reduce<Record<string, number>>((acc, s) => { acc[s] = (acc[s] ?? 0) + 1; return acc }, {})
      const primarySeller = sellers.length
        ? Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]
        : null
      return { city, rows, confirmed, failed, unknown, avail, pct, status, primarySeller }
    })
  }, [latestResults])

  // ── Data loaders ───────────────────────────────────────────────────────────

  const loadInitial = useCallback(async () => {
    setLoading(true)
    try {
      const wid = await getWorkspaceId()
      setWorkspaceId(wid)
      if (!wid) return

      const supabase = createClient()
      const [asinsRes, usageRes] = await Promise.all([
        supabase
          .from('tracked_asins')
          .select('id, asin, product_title')
          .eq('workspace_id', wid)
          .neq('status', 'archived')
          .order('created_at', { ascending: false }),
        supabase
          .from('usage_counters')
          .select('pincode_checks_used')
          .eq('workspace_id', wid)
          .single(),
      ])

      const asins = asinsRes.data ?? []
      setTrackedAsins(asins)
      if (asins.length > 0) setSelectedAsinId(asins[0].id)
      if (usageRes.data) setPincodeChecksUsed(usageRes.data.pincode_checks_used ?? 0)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadResults = useCallback(async (asinId: string) => {
    if (!asinId) { setResults([]); return }
    const supabase = createClient()
    const { data, error } = await supabase
      .from('pincode_checks')
      .select('*')
      .eq('tracked_asin_id', asinId)
      .order('checked_at', { ascending: false })
      .limit(200)
    if (error) { console.error(error); return }
    setResults(data ?? [])
  }, [])

  useEffect(() => { loadInitial() }, [loadInitial])
  useEffect(() => { loadResults(selectedAsinId) }, [selectedAsinId, loadResults])

  // ── Handlers ───────────────────────────────────────────────────────────────

  function toggleCity(city: string, pincodes: string[]) {
    const next = new Set(selectedCities)
    const allSelected = pincodes.every(p => next.has(p))
    if (allSelected) {
      pincodes.forEach(p => next.delete(p))
    } else {
      pincodes.forEach(p => next.add(p))
    }
    setSelectedCities(next)
    // Sync pincodeText
    const allPins = Array.from(next).join('\n')
    setPincodeText(allPins)
  }

  async function handleCheck() {
    const pincodes = parsePincodes(pincodeText)
    if (!pincodes.length || !selectedAsin) return
    setIsChecking(true)
    setCheckProgress({ done: 0, total: pincodes.length })
    let successCount = 0
    let firstError: string | null = null
    for (let i = 0; i < pincodes.length; i++) {
      try {
        const res = await fetch(`/api/asins/${selectedAsin}/pincode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pincode: pincodes[i] }),
        })
        if (res.ok) {
          successCount++
        } else if (!firstError) {
          try {
            const body = await res.json()
            firstError = body?.error ?? `HTTP ${res.status}`
          } catch {
            firstError = `HTTP ${res.status}`
          }
        }
      } catch (err) {
        if (!firstError) firstError = String(err)
      }
      setCheckProgress({ done: i + 1, total: pincodes.length })
    }
    if (successCount > 0) {
      toast.success(`${successCount} of ${pincodes.length} pincode check${pincodes.length > 1 ? 's' : ''} completed.`)
    } else {
      toast.error(firstError ?? 'Pincode checks failed. Check server configuration.')
    }
    await loadResults(selectedAsinId)
    // refresh usage counter
    const wid = workspaceId
    if (wid) {
      const supabase = createClient()
      const { data } = await supabase
        .from('usage_counters')
        .select('pincode_checks_used')
        .eq('workspace_id', wid)
        .single()
      if (data) setPincodeChecksUsed(data.pincode_checks_used ?? 0)
    }
    setIsChecking(false)
    setCheckProgress(null)
  }

  async function handleRunNew() {
    await loadResults(selectedAsinId)
  }

  // ── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!workspaceId || trackedAsins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-center">
        <MapPin className="w-10 h-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">No tracked ASINs found. Add an ASIN first.</p>
        <Link
          href="/dashboard/asins"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          Go to ASINs
        </Link>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Pincode Availability</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Check whether your products are deliverable across important Indian pincodes. Next: select city presets and run Check Availability. Data source: pincode_checks and live checker runs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRunNew} className="gap-2">
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      {/* ASIN selector + check form */}
      <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-5">
        {/* ASIN picker */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Select ASIN
            </label>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={selectedAsinId}
              onChange={e => setSelectedAsinId(e.target.value)}
            >
              {trackedAsins.map(a => (
                <option key={a.id} value={a.id}>
                  {a.asin}{a.product_title ? ` — ${a.product_title.slice(0, 40)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:w-32">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Marketplace
            </label>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              defaultValue="IN"
              disabled
            >
              <option value="IN">Amazon.in</option>
            </select>
          </div>
        </div>

        {/* City presets */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">
            Quick City Presets
          </label>
          <div className="flex flex-wrap gap-2">
            {CITY_PRESETS.map(cp => {
              const allSelected = cp.pincodes.every(p => selectedCities.has(p))
              return (
                <button
                  key={cp.city}
                  type="button"
                  onClick={() => toggleCity(cp.city, cp.pincodes)}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1 border transition-colors',
                    allSelected
                      ? 'bg-primary/15 text-primary border-primary/30'
                      : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground',
                  )}
                >
                  <MapPin className="size-2.5" />
                  {cp.city}
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-0.5">
                    {cp.pincodes.length}
                  </Badge>
                </button>
              )
            })}
          </div>
        </div>

        {/* Pincode textarea + button */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Pincodes
              <span className="ml-2 text-primary font-semibold">
                {parsePincodes(pincodeText).length} selected
              </span>
            </label>
            <textarea
              rows={3}
              placeholder="Enter pincodes (comma, space, or newline separated)&#10;e.g. 110001, 400001, 560001"
              value={pincodeText}
              onChange={e => setPincodeText(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {parsePincodes(pincodeText).length > 1
                ? `${parsePincodes(pincodeText).length} checks — runs sequentially`
                : 'One pincode per check'}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:pt-6">
            <Button
              type="button"
              onClick={handleCheck}
              disabled={isChecking || parsePincodes(pincodeText).length === 0 || !selectedAsinId}
              className="w-full gap-2"
            >
              {isChecking ? (
                <>
                  <RefreshCw className="size-4 animate-spin" />
                  {checkProgress ? `${checkProgress.done}/${checkProgress.total}` : 'Checking...'}
                </>
              ) : (
                <><Play className="size-4" /> Check Availability</>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Checked"      value={String(latestResults.length)} sub="latest pincode checks"                                                     icon={MapPin} />
        <KpiCard label="Available"          value={String(available.length)}  sub={confirmedChecks.length ? `of ${confirmedChecks.length} confirmed checks` : 'not calculated yet'}                 icon={CheckCircle2} />
        <KpiCard label="Unavailable"        value={String(unavailable.length)} sub="pincodes unavailable"
          trend={unavailable.length > 0 ? { value: unavailable.length, label: 'need attention' } : undefined} icon={XCircle} />
        <KpiCard label="Not Calculated"     value={String(unknownChecks.length)} sub="availability unknown"                                                     icon={ShieldAlert} />
        <KpiCard label="Avg Availability"   value={latestResults.length ? (score === null ? 'Not calculated' : `${score}%`) : '—'}
          sub={latestResults.length ? (score === null ? 'waiting for confirmed checks' : scoreToStatus(score)) : 'no checks yet'}                                icon={BarChart2} />
        <KpiCard label="Last Checked"       value={latestChecked ? timeAgo(latestChecked) : '—'}
          sub={latestChecked ? 'latest check' : 'no checks yet'}                                                                                                 icon={Clock} />
        <KpiCard label="Checks This Month"  value={String(pincodeChecksUsed)} sub="used this month"                                                              icon={Truck} />
      </div>

      {/* Results */}
      {results.length === 0 ? (
        <div className="bg-card border border-border rounded-xl flex flex-col items-center justify-center py-16 text-center gap-2 text-muted-foreground">
          <MapPin className="w-8 h-8 opacity-30" />
          <p className="text-sm font-medium">No pincode checks yet for {selectedLabel || selectedAsin}</p>
          <p className="text-xs">Select city presets above and click &quot;Check Availability&quot; to collect data.</p>
        </div>
      ) : (
        <>
          {/* City cards */}
          {cityBreakdown.length > 0 && (
            <div>
              <h2 className="font-semibold text-foreground mb-4">City-wise Overview</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {cityBreakdown.map(c => (
                  <div key={c.city} className={cn(
                    'rounded-xl border bg-card p-4 flex flex-col gap-3',
                    c.status === null       && 'border-border',
                    c.status === 'healthy'  && 'border-border',
                    c.status === 'warning'  && 'border-yellow-500/30',
                    c.status === 'critical' && 'border-red-500/30',
                  )}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <MapPin className="size-3.5 text-primary shrink-0" />
                        <span className="text-sm font-semibold text-foreground">{c.city}</span>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground">Availability</span>
                        <span className={cn(
                          'text-xs font-bold',
                          c.pct === null ? 'text-muted-foreground' : (c.pct >= 80 ? 'text-green-400' : c.pct >= 50 ? 'text-yellow-400' : 'text-red-400'),
                        )}>
                          {c.pct === null ? 'Not calculated' : `${c.pct}%`}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            c.pct === null ? 'bg-muted-foreground/30' : (c.pct >= 80 ? 'bg-green-500' : c.pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'),
                          )}
                          style={{ width: `${c.pct ?? 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground flex items-center gap-1">
                        {c.primarySeller
                          ? <ShieldCheck className="size-3 text-green-400" />
                          : <ShieldAlert className="size-3 text-muted-foreground" />}
                        Buy Box
                      </span>
                      <span className="text-foreground font-medium truncate max-w-[100px] text-right">
                        {c.primarySeller ?? '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                      <span className="text-[10px] text-muted-foreground">
                        {c.confirmed.length === 0
                          ? (c.unknown.length > 0
                            ? `${c.unknown.length} not calculated`
                            : `${c.failed.length} checker failures`)
                          : `${c.avail.length}/${c.confirmed.length} pincodes available`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Results table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-foreground">Pincode Results</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{selectedLabel || selectedAsin}</p>
              </div>
              <Badge variant="secondary" className="text-xs">{latestResults.length} latest checks</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left text-xs text-muted-foreground font-medium px-5 py-3">City</th>
                    <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3">Pincode</th>
                    <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3">Availability</th>
                    <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden md:table-cell">Delivery</th>
                    <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden lg:table-cell">Buy Box Seller</th>
                    <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3 hidden md:table-cell">FBA/FBM</th>
                    <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden xl:table-cell">Checked</th>
                    <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden xl:table-cell">Freshness</th>
                    <th className="text-right text-xs text-muted-foreground font-medium px-5 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {latestResults.map(r => (
                    <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3 text-sm font-medium text-foreground">{deriveCity(r)}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-foreground bg-muted/50 rounded px-1.5 py-0.5">
                          {r.pincode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {isFailedCheck(r) ? (
                          <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                            <ShieldAlert className="size-3.5" /> Failed
                          </span>
                        ) : r.available === true ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                            <CheckCircle2 className="size-3.5" /> Available
                          </span>
                        ) : r.available === false ? (
                          <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                            <XCircle className="size-3.5" /> Unavailable
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground font-medium">
                            <Clock className="size-3.5" /> Not calculated
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs text-foreground">{r.delivery_promise ?? '—'}</span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {r.buy_box_seller
                          ? <span className="text-xs text-foreground truncate max-w-[120px] block">{r.buy_box_seller}</span>
                          : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center hidden md:table-cell">
                        <FulfillmentBadge type={r.fulfillment_type} />
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="size-3" />
                          {timeAgo(r.checked_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <DataFreshnessBadge checkedAt={r.checked_at} />
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/dashboard/asins/${selectedAsin}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLink className="size-3.5" />
                          <span className="hidden sm:inline">View</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
