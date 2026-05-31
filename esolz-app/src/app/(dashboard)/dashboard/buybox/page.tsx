'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { DataFreshnessBadge } from '@/components/dashboard/DataFreshnessBadge'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { toast } from 'sonner'
import {
  Package,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  ExternalLink,
  RefreshCw,
  Store,
  BarChart2,
  Bell,
  AlertCircle,
  Loader2,
  ChevronDown,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type BBStatus = 'won' | 'lost' | 'unknown' | 'no_buybox' | 'partial_success' | 'failed'

interface LiveEntry {
  asin:             string
  asin_id:          string
  product_name:     string
  has_snapshot:     boolean
  current_owner:    string | null
  status:           BBStatus
  buy_box_price:    number | null
  your_price:       number | null
  price_gap:        number | null
  fulfillment_type: string | null
  offers_count:      number | null
  eligible_offers:   number | null
  lowest_price:      number | null
  lowest_price_currency: string | null
  source:            string | null
  checked_at:       string | null
}

interface HistoryPoint {
  date: string; you: number; competitor: number; suppressed: number; unknown: number
}

interface LiveCompetitor {
  name:            string
  asin_count:      number
  price_advantage: number | null
  asins:           string[]
  risk:            'low' | 'medium' | 'high'
}

interface LiveAlert {
  id:          string
  title:       string
  description: string | null
  severity:    string
  created_at:  string
}

interface CheckResult {
  asin:             string
  buy_box_owner:    string | null
  buy_box_status:   string | null
  buy_box_price:    number | null
  your_price:       number | null
  price_gap:        number | null
  fulfillment_type: string | null
  offers_count:      number | null
  eligible_offers:   number | null
  lowest_price:      number | null
  lowest_price_currency: string | null
  source:            string | null
  message:           string | null
  checked_at:       string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type HealthStatus = 'Healthy' | 'Warning' | 'Critical'

function calcHealth(entries: { status: BBStatus }[]): number {
  const active = entries.filter(e => e.status === 'won' || e.status === 'lost')
  if (!active.length) return 0
  return Math.round(active.filter(e => e.status === 'won').length / active.length * 100)
}
function healthLabel(s: number): HealthStatus {
  return s >= 80 ? 'Healthy' : s >= 50 ? 'Warning' : 'Critical'
}
function healthColor(hs: HealthStatus) {
  return hs === 'Healthy' ? 'text-green-400' : hs === 'Warning' ? 'text-yellow-400' : 'text-red-400'
}
function healthBg(hs: HealthStatus) {
  return hs === 'Healthy' ? 'bg-green-500/5 border-green-500/20'
    : hs === 'Warning' ? 'bg-yellow-500/5 border-yellow-500/20'
    : 'bg-red-500/5 border-red-500/20'
}

function normalizeStatus(raw: string | null): BBStatus {
  if (raw === 'won') return 'won'
  if (raw === 'lost') return 'lost'
  if (raw === 'no_buybox' || raw === 'suppressed') return 'no_buybox'
  if (raw === 'partial_success') return 'partial_success'
  if (raw === 'failed' || raw === 'checker_unavailable') return 'failed'
  return 'unknown'
}

function statusLabel(status: BBStatus): string {
  if (status === 'won') return 'Won'
  if (status === 'lost') return 'Lost'
  if (status === 'no_buybox') return 'No Buy Box'
  if (status === 'partial_success') return 'Partial data'
  if (status === 'failed') return 'Check failed'
  return 'Unknown'
}

function ownerDisplay(entry: LiveEntry): string {
  if (!entry.has_snapshot) return 'Not checked yet'
  if (entry.status === 'unknown' || entry.status === 'partial_success') {
    return 'Offer data available, ownership not confirmed'
  }
  if (entry.status === 'failed') return 'Check failed safely'
  return entry.current_owner ?? '—'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BBStatus }) {
  if (status === 'won')
    return <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-xs">Won</Badge>
  if (status === 'lost')
    return <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">Lost</Badge>
  if (status === 'no_buybox')
    return <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/20 text-xs">No Buy Box</Badge>
  if (status === 'partial_success')
    return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/20 text-xs">Partial Data</Badge>
  if (status === 'failed')
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/20 text-xs">Failed safely</Badge>
  return <Badge className="bg-zinc-500/20 text-zinc-300 border-zinc-500/30 text-xs">Unknown</Badge>
}

function FulfillmentBadge({ type }: { type: string | null | undefined }) {
  if (!type) return <span className="text-muted-foreground text-xs">—</span>
  const norm = type.toUpperCase()
  return norm === 'FBA'
    ? <Badge className="bg-primary/15 text-primary border-primary/20 text-xs">FBA</Badge>
    : <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/20 text-xs">{norm}</Badge>
}

function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  if (risk === 'low')
    return <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-xs">Low</Badge>
  if (risk === 'medium')
    return <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/20 text-xs">Medium</Badge>
  return <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">High</Badge>
}

function AlertRow({ alert }: { alert: LiveAlert }) {
  const config: Record<string, { icon: typeof XCircle; color: string; border: string }> = {
    critical:    { icon: XCircle,       color: 'text-red-400',    border: 'border-l-red-500' },
    warning:     { icon: AlertTriangle, color: 'text-yellow-400', border: 'border-l-yellow-500' },
    opportunity: { icon: CheckCircle2,  color: 'text-green-400',  border: 'border-l-green-500' },
    info:        { icon: Info,          color: 'text-blue-400',   border: 'border-l-blue-500' },
  }
  const { icon: Icon, color, border } = config[alert.severity] ?? config.info
  return (
    <div className={cn('flex gap-3 p-3 rounded-lg bg-card border border-border border-l-2', border)}>
      <Icon className={cn('size-4 mt-0.5 flex-shrink-0', color)} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground">{alert.title}</p>
        {alert.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{alert.description}</p>
        )}
        <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(alert.created_at)}</p>
      </div>
    </div>
  )
}

function HistoryTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { value: number; dataKey: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const hit = payload.find(p => p.value > 0)
  const labels: Record<string, string> = {
    you: 'You (Won)', competitor: 'Competitor', suppressed: 'No Buy Box', unknown: 'Unknown',
  }
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">{hit ? (labels[hit.dataKey] ?? hit.dataKey) : 'No data'}</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyboxPage() {
  const [entries, setEntries]         = useState<LiveEntry[]>([])
  const [loading, setLoading]         = useState(true)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [trackedAsins, setTrackedAsins] = useState<{ id: string; asin: string; product_title: string | null }[]>([])
  const [alerts, setAlerts]           = useState<LiveAlert[]>([])
  const [competitors, setCompetitors] = useState<LiveCompetitor[]>([])

  // History chart
  const [selectedAsinId, setSelectedAsinId] = useState<string>('')
  const [selectedAsin, setSelectedAsin]     = useState<string>('')
  const [historyPoints, setHistoryPoints]   = useState<HistoryPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [isMounted, setIsMounted]           = useState(false)

  // Check form
  const [checkAsin, setCheckAsin]     = useState('')
  const [isChecking, setIsChecking]   = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [checkError, setCheckError]   = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setIsMounted(true) }, [])

  // ── Load all data ─────────────────────────────────────────────────────────

  const loadAll = useCallback(async (wid?: string) => {
    const id = wid ?? workspaceId
    if (!id) return
    const supabase = createClient()

    // 1. Tracked ASINs
    const { data: asins } = await supabase
      .from('tracked_asins')
      .select('id, asin, product_title')
      .eq('workspace_id', id)
      .neq('status', 'archived')
      .order('asin')

    if (!asins?.length) {
      setEntries([])
      setLoading(false)
      return
    }
    setTrackedAsins(asins as typeof trackedAsins)

    const asinIds = asins.map((a: { id: string }) => a.id)
    const asinById = new Map(
      (asins as { id: string; asin: string; product_title: string | null }[]).map(a => [a.id, a])
    )

    // 2. Latest buybox_snapshot per ASIN
    const detailedSelect = 'tracked_asin_id, buy_box_owner, buy_box_status, buy_box_price, your_price, price_gap, fulfillment_type, number_of_offers, number_of_buybox_eligible_offers, lowest_price, lowest_price_currency, source, checked_at'
    const baseSelect = 'tracked_asin_id, buy_box_owner, buy_box_status, buy_box_price, your_price, price_gap, fulfillment_type, checked_at'

    const detailedResult = await supabase
      .from('buybox_snapshots')
      .select(detailedSelect)
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })

    // Backward-compatible fallback for DBs that don't yet have optional Product Pricing fields.
    let snaps: SnapRow[] = (detailedResult.data ?? []) as SnapRow[]
    if (detailedResult.error) {
      console.warn('[buybox-page] detailed snapshot select failed, retrying base select:', detailedResult.error.message)
      const baseResult = await supabase
        .from('buybox_snapshots')
        .select(baseSelect)
        .in('tracked_asin_id', asinIds)
        .order('checked_at', { ascending: false })
      snaps = (baseResult.data ?? []) as SnapRow[]
    }

    type SnapRow = {
      tracked_asin_id: string; buy_box_owner: string | null; buy_box_status: string | null
      buy_box_price: number | null; your_price: number | null; price_gap: number | null
      fulfillment_type: string | null; number_of_offers: number | null
      number_of_buybox_eligible_offers: number | null; lowest_price: number | null
      lowest_price_currency: string | null; source: string | null; checked_at: string
    }
    const latestSnap = new Map<string, SnapRow>()
    for (const s of ((snaps ?? []) as SnapRow[])) {
      if (!latestSnap.has(s.tracked_asin_id)) latestSnap.set(s.tracked_asin_id, s)
    }

    const liveEntries: LiveEntry[] = (asins as { id: string; asin: string; product_title: string | null }[]).map(a => {
      const s = latestSnap.get(a.id)
      return {
        asin:             a.asin,
        asin_id:          a.id,
        product_name:     a.product_title ?? a.asin,
        has_snapshot:     Boolean(s),
        current_owner:    s?.buy_box_owner ?? null,
        status:           normalizeStatus(s?.buy_box_status ?? null),
        buy_box_price:    s?.buy_box_price ?? null,
        your_price:       s?.your_price ?? null,
        price_gap:        s?.price_gap ?? null,
        fulfillment_type: s?.fulfillment_type ?? null,
        offers_count:     s?.number_of_offers ?? null,
        eligible_offers:  s?.number_of_buybox_eligible_offers ?? null,
        lowest_price:     s?.lowest_price ?? null,
        lowest_price_currency: s?.lowest_price_currency ?? null,
        source:           s?.source ?? null,
        checked_at:       s?.checked_at ?? null,
      }
    })
    setEntries(liveEntries)

    // Default select first entry with data for history
    const firstWithData = liveEntries.find(e => e.checked_at) ?? liveEntries[0]
    if (firstWithData && !selectedAsinId) {
      setSelectedAsinId(firstWithData.asin_id)
      setSelectedAsin(firstWithData.asin)
      setCheckAsin(firstWithData.asin)
    }

    // 3. Competitors — gather all lost snaps, group by buy_box_owner
    const { data: lostSnaps } = await supabase
      .from('buybox_snapshots')
      .select('tracked_asin_id, buy_box_owner, price_gap')
      .in('tracked_asin_id', asinIds)
      .eq('buy_box_status', 'lost')
      .not('buy_box_owner', 'is', null)
      .order('checked_at', { ascending: false })
      .limit(200)

    type LostRow = { tracked_asin_id: string; buy_box_owner: string; price_gap: number | null }
    const compMap = new Map<string, { asins: Set<string>; gaps: number[] }>()
    for (const row of ((lostSnaps ?? []) as LostRow[])) {
      const owner = row.buy_box_owner
      const a = asinById.get(row.tracked_asin_id)
      if (!a) continue
      const entry = compMap.get(owner) ?? { asins: new Set(), gaps: [] }
      entry.asins.add(a.asin)
      if (row.price_gap != null) entry.gaps.push(row.price_gap)
      compMap.set(owner, entry)
    }
    const liveComps: LiveCompetitor[] = [...compMap.entries()]
      .map(([name, { asins, gaps }]) => ({
        name,
        asin_count:      asins.size,
        asins:           [...asins],
        price_advantage: gaps.length ? -(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
        risk:            (asins.size >= 3 ? 'high' : asins.size >= 2 ? 'medium' : 'low') as 'low' | 'medium' | 'high',
      }))
      .sort((a, b) => b.asin_count - a.asin_count)
      .slice(0, 10)
    setCompetitors(liveComps)

    // 4. Buybox alerts
    const { data: alertRows } = await supabase
      .from('alerts')
      .select('id, title, description, severity, created_at')
      .eq('workspace_id', id)
      .eq('module', 'buybox')
      .neq('status', 'resolved')
      .order('created_at', { ascending: false })
      .limit(10)

    setAlerts((alertRows ?? []) as LiveAlert[])
  }, [workspaceId, selectedAsinId])

  useEffect(() => {
    let cancelled = false
    async function init() {
      setLoading(true)
      const wid = await getWorkspaceId()
      if (cancelled) return
      setWorkspaceId(wid)
      if (wid) await loadAll(wid)
      setLoading(false)
    }
    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load history for selected ASIN ────────────────────────────────────────

  const loadHistory = useCallback(async (asinId: string) => {
    if (!asinId) return
    setHistoryLoading(true)
    const supabase = createClient()
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()

    const { data } = await supabase
      .from('buybox_snapshots')
      .select('buy_box_status, checked_at')
      .eq('tracked_asin_id', asinId)
      .gte('checked_at', since)
      .order('checked_at', { ascending: true })

    // Latest status per calendar day (IST)
    const dayMap = new Map<string, string>()
    for (const row of (data ?? [])) {
      const day = new Date(row.checked_at as string).toLocaleDateString('en-GB', {
        timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
      })
      dayMap.set(day, (row.buy_box_status as string) ?? 'unknown')
    }

    const points: HistoryPoint[] = [...dayMap.entries()].map(([date, status]) => ({
      date,
      you:        status === 'won' ? 1 : 0,
      competitor: status === 'lost' ? 1 : 0,
      suppressed: status === 'no_buybox' ? 1 : 0,
      unknown:    !['won', 'lost', 'no_buybox'].includes(status) ? 1 : 0,
    }))
    setHistoryPoints(points)
    setHistoryLoading(false)
  }, [])

  useEffect(() => {
    if (selectedAsinId) void loadHistory(selectedAsinId)
  }, [selectedAsinId, loadHistory])

  // ── Check Buy Box ─────────────────────────────────────────────────────────

  async function handleCheck(e: React.FormEvent) {
    e.preventDefault()
    if (!checkAsin) return
    setIsChecking(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      const res = await fetch(`/api/asins/${checkAsin}/buybox`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setCheckError(body.error ?? 'Check failed')
        await loadAll()
      } else {
        const r = body.snap ?? body.result
        setCheckResult({
          asin:             checkAsin,
          buy_box_owner:    r?.buy_box_owner ?? null,
          buy_box_status:   r?.buy_box_status ?? null,
          buy_box_price:    r?.buy_box_price ?? null,
          your_price:       r?.your_price ?? null,
          price_gap:        r?.price_gap ?? null,
          fulfillment_type: r?.fulfillment_type ?? null,
          offers_count:     r?.number_of_offers ?? null,
          eligible_offers:  r?.number_of_buybox_eligible_offers ?? null,
          lowest_price:     r?.lowest_price ?? null,
          lowest_price_currency: r?.lowest_price_currency ?? null,
          source:           body.source ?? r?.source ?? null,
          message:          body.message ?? null,
          checked_at:       r?.checked_at ?? new Date().toISOString(),
        })
        toast.success(body.message ?? 'Buy Box check complete')
        await loadAll()
      }
    } catch {
      setCheckError('Network error while running check')
    }
    setIsChecking(false)
  }

  // ── Derived stats ─────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const won = entries.filter(e => e.status === 'won').length
    const lost = entries.filter(e => e.status === 'lost').length
    const noBuyBox = entries.filter(e => e.status === 'no_buybox').length
    const unknown = entries.filter(e => e.status === 'unknown').length
    const partial = entries.filter(e => e.status === 'partial_success').length
    const failed = entries.filter(e => e.status === 'failed').length
    const unknownUnconfirmed = entries.filter(e => e.status !== 'won' && e.status !== 'lost').length
    const active = entries.filter(e => e.status === 'won' || e.status === 'lost').length
    const winRate = active > 0 ? Math.round((won / active) * 100) : 0
    const highRisk = competitors.filter(c => c.risk === 'high').length
    const score = calcHealth(entries)
    const hs = healthLabel(score)
    return { won, lost, noBuyBox, unknown, partial, failed, unknownUnconfirmed, active, winRate, highRisk, score, hs }
  }, [entries, competitors])

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Buy Box Monitor</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track Buy Box ownership, pricing gaps and competing sellers across tracked ASINs. Next: run Buy Box Check and review confirmed lost listings. Data source: Amazon Product Pricing API and buybox_snapshots.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => formRef.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <RefreshCw className="size-4" />
          Run Buy Box Check
        </Button>
      </div>

      {/* ── 2. KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Tracked"        value={entries.length} icon={Package} />
        <KpiCard label="Buy Box Won"           value={stats.won}      icon={ShieldCheck}  sub="Active listings" />
        <KpiCard label="Buy Box Lost"          value={stats.lost}     icon={ShieldAlert} />
        <KpiCard label="Unknown / Unconfirmed" value={stats.unknownUnconfirmed} icon={ShieldOff} />
        <KpiCard label="Competitor Sellers"    value={competitors.length} icon={AlertCircle}  sub="Detected" />
        <KpiCard label="BB Win Rate"           value={`${stats.winRate}%`} icon={BarChart2}  sub="Active ASINs" />
      </div>

      {/* ── 3. Check form + Health score ──────────────────────────────────── */}
      <div ref={formRef} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">Check Buy Box</h2>
          {trackedAsins.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No tracked ASINs. <Link href="/dashboard/asins" className="text-primary hover:underline">Add ASINs</Link> first.
            </p>
          ) : (
            <form onSubmit={handleCheck} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground" htmlFor="check-asin">
                  Select ASIN
                </label>
                <div className="relative">
                  <select
                    id="check-asin"
                    value={checkAsin}
                    onChange={e => setCheckAsin(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none pr-8"
                  >
                    <option value="">Select a tracked ASIN…</option>
                    {trackedAsins.map(a => (
                      <option key={a.id} value={a.asin}>
                        {a.asin} — {a.product_title ?? 'Unknown'}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>
              <div>
                <Button type="submit" disabled={isChecking || !checkAsin}>
                  {isChecking
                    ? <><RefreshCw className="size-4 animate-spin" />Checking…</>
                    : <><ShieldCheck className="size-4" />Check Buy Box</>}
                </Button>
              </div>
            </form>
          )}

          {/* Result */}
          {checkResult && (
            <div className="mt-5 p-4 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Result for {checkResult.asin}</p>
                </div>
                <StatusBadge status={normalizeStatus(checkResult.buy_box_status)} />
              </div>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Owner</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">{checkResult.buy_box_owner ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">BB Price</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.buy_box_price != null ? `₹${checkResult.buy_box_price}` : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Your Price</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.your_price != null ? `₹${checkResult.your_price}` : '—'}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-2">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Offers</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">{checkResult.offers_count ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">BB Eligible</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">{checkResult.eligible_offers ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Source</p>
                  <p className="text-xs font-medium text-foreground mt-0.5 truncate">{checkResult.source ?? 'Amazon Product Pricing API'}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-2">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Lowest Price</p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.lowest_price != null
                      ? `${checkResult.lowest_price_currency ?? 'INR'} ${checkResult.lowest_price}`
                      : '—'}
                  </p>
                </div>
              </div>
              {checkResult.price_gap != null && checkResult.price_gap > 0 && (
                <p className="mt-2 text-xs text-red-400">
                  You are ₹{checkResult.price_gap} more expensive than the current Buy Box price.
                </p>
              )}
              {checkResult.message && (
                <p className="mt-2 text-xs text-muted-foreground">{checkResult.message}</p>
              )}
            </div>
          )}
          {checkError && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              {checkError}
            </div>
          )}
        </div>

        {/* Health score */}
        <div className={cn('bg-card border rounded-xl p-6 flex flex-col items-center justify-center gap-3 text-center', healthBg(stats.hs))}>
          <div className={cn('text-6xl font-black leading-none tabular-nums', healthColor(stats.hs))}>
            {stats.score}
          </div>
          <div>
            <p className={cn('text-sm font-semibold', healthColor(stats.hs))}>{stats.hs}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Buy Box Health Score</p>
          </div>
          <div className="w-full bg-border/50 rounded-full h-2 mt-1">
            <div
              className={cn('h-2 rounded-full transition-all duration-500', {
                'bg-green-400': stats.hs === 'Healthy',
                'bg-yellow-400': stats.hs === 'Warning',
                'bg-red-400': stats.hs === 'Critical',
              })}
              style={{ width: `${stats.score}%` }}
            />
          </div>
          <div className="flex w-full justify-between text-[10px] text-muted-foreground px-0.5">
            <span>0</span><span>50</span><span>80</span><span>100</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
            {stats.hs === 'Healthy' && 'You own the Buy Box on most tracked ASINs.'}
            {stats.hs === 'Warning' && 'Some Buy Boxes are at risk. Review lost listings.'}
            {stats.hs === 'Critical' && 'Critical: Most Buy Boxes lost or checks are failing. Immediate action needed.'}
          </p>
          <div className="grid grid-cols-3 gap-2 w-full mt-2 text-center">
            <div className="bg-green-500/10 rounded-lg p-2">
              <p className="text-[10px] text-muted-foreground">≥80</p>
              <p className="text-xs font-semibold text-green-400">Healthy</p>
            </div>
            <div className="bg-yellow-500/10 rounded-lg p-2">
              <p className="text-[10px] text-muted-foreground">50–79</p>
              <p className="text-xs font-semibold text-yellow-400">Warning</p>
            </div>
            <div className="bg-red-500/10 rounded-lg p-2">
              <p className="text-[10px] text-muted-foreground">&lt;50</p>
              <p className="text-xs font-semibold text-red-400">Critical</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── 4. Status table ───────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-foreground">Buy Box Status</h2>
          <span className="text-xs text-muted-foreground">
            {stats.won} won · {stats.lost} lost · {stats.noBuyBox} no buy box · {stats.unknown} unknown · {stats.partial} partial · {stats.failed} failed
          </span>
        </div>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 gap-2 text-center">
            <ShieldOff className="size-7 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No Buy Box data yet.</p>
            <p className="text-xs text-muted-foreground">
              Run a Buy Box check above, or click{' '}
              <Link href="/dashboard/asins" className="text-primary hover:underline">Check Buy Box</Link>{' '}
              from any ASIN detail page.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                  <th className="text-left px-6 py-3">Product</th>
                  <th className="text-left px-4 py-3">ASIN</th>
                  <th className="text-left px-4 py-3">Current Owner</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">BB Price</th>
                  <th className="text-right px-4 py-3">Your Price</th>
                  <th className="text-right px-4 py-3">Gap</th>
                  <th className="text-left px-4 py-3">Fulfillment</th>
                  <th className="text-left px-4 py-3">Checked</th>
                  <th className="text-left px-4 py-3">Freshness</th>
                  <th className="text-center px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map(entry => (
                  <tr key={entry.asin} className="hover:bg-border/20 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Package className="size-3 text-primary" />
                        </div>
                        <span className="text-xs font-medium text-foreground truncate max-w-[140px]">
                          {entry.product_name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="font-mono text-xs text-muted-foreground">{entry.asin}</span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1.5">
                        {entry.status === 'won'
                          ? <ShieldCheck className="size-3 text-green-400 flex-shrink-0" />
                          : entry.status === 'failed'
                            ? <AlertTriangle className="size-3 text-amber-400 flex-shrink-0" />
                          : <Store className="size-3 text-muted-foreground flex-shrink-0" />}
                        <span className="text-xs text-foreground max-w-[220px] truncate" title={ownerDisplay(entry)}>
                          {ownerDisplay(entry)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4"><StatusBadge status={entry.status} /></td>
                    <td className="px-4 py-4 text-right">
                      <span className="text-xs text-foreground">
                        {entry.buy_box_price != null ? `₹${entry.buy_box_price}` : '—'}
                      </span>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {entry.lowest_price != null
                          ? `Lowest: ${entry.lowest_price_currency ?? 'INR'} ${entry.lowest_price}`
                          : 'Lowest: —'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="text-xs text-foreground">
                        {entry.your_price != null ? `₹${entry.your_price}` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      {entry.price_gap != null && entry.price_gap !== 0 ? (
                        <span className={cn('text-xs font-medium', entry.price_gap > 0 ? 'text-red-400' : 'text-green-400')}>
                          {entry.price_gap > 0 ? `+₹${entry.price_gap}` : `-₹${Math.abs(entry.price_gap)}`}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {entry.price_gap === 0 ? 'Even' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <FulfillmentBadge type={entry.fulfillment_type} />
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Offers: {entry.offers_count ?? '—'} · Eligible: {entry.eligible_offers ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-xs text-muted-foreground">
                        {entry.checked_at ? `${timeAgo(entry.checked_at)} · ${statusLabel(entry.status)}` : 'Not checked yet'}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <DataFreshnessBadge checkedAt={entry.checked_at} />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <Link
                        href={`/dashboard/asins/${entry.asin}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        View <ExternalLink className="size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 5. History chart ──────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Buy Box Ownership — Last 7 Days</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Daily ownership status per ASIN</p>
          </div>
          {trackedAsins.length > 0 && (
            <div className="relative">
              <select
                value={selectedAsinId}
                onChange={e => {
                  const a = trackedAsins.find(a => a.id === e.target.value)
                  if (a) { setSelectedAsinId(a.id); setSelectedAsin(a.asin) }
                }}
                className="h-8 rounded-md border border-input bg-transparent px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none pr-7"
              >
                {trackedAsins.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.asin} — {(a.product_title ?? 'Unknown').slice(0, 30)}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
            </div>
          )}
        </div>

        <div className="flex gap-4 mb-4 flex-wrap">
          {[
            { key: 'you',        label: 'You',        color: 'bg-[oklch(0.741_0.174_66.5)]' },
            { key: 'competitor', label: 'Competitor',  color: 'bg-slate-500' },
            { key: 'suppressed', label: 'No Buy Box',  color: 'bg-red-500' },
            { key: 'unknown',    label: 'Unknown',     color: 'bg-zinc-600' },
          ].map(item => (
            <div key={item.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <div className={cn('w-3 h-3 rounded-sm', item.color)} />
              {item.label}
            </div>
          ))}
        </div>

        {historyLoading ? (
          <div className="h-[200px] flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading history…</span>
          </div>
        ) : historyPoints.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center">
            <p className="text-sm text-muted-foreground/50">No history data for this ASIN yet</p>
          </div>
        ) : isMounted ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={historyPoints} barSize={36} barGap={0}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 265)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'oklch(0.55 0.015 265)' }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip content={<HistoryTooltip />} />
              <Bar dataKey="you"        stackId="a" fill="oklch(0.741 0.174 66.5)" />
              <Bar dataKey="competitor" stackId="a" fill="rgb(100,116,139)" />
              <Bar dataKey="suppressed" stackId="a" fill="rgb(239,68,68)" />
              <Bar dataKey="unknown"    stackId="a" fill="rgb(82,82,91)" radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[200px] bg-border/20 rounded-lg animate-pulse" />
        )}
      </div>

      {/* ── 6 & 7. Competitor sellers + Alerts ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Competitor sellers */}
        <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Seller Competition</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {competitors.length > 0
                ? `${competitors.length} competitor${competitors.length !== 1 ? 's' : ''} detected`
                : 'No competitors detected yet'}
            </p>
          </div>
          {competitors.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-xs text-muted-foreground">
                Competitors will appear here once Buy Box checks show other sellers winning the Buy Box.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {competitors.map(seller => (
                <div key={seller.name} className="px-6 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Store className="size-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-semibold text-foreground truncate">{seller.name}</span>
                    </div>
                    <RiskBadge risk={seller.risk} />
                  </div>
                  <div className="flex items-center gap-4 mt-2 flex-wrap">
                    <span className="text-[11px] text-muted-foreground">
                      {seller.asin_count} ASIN{seller.asin_count > 1 ? 's' : ''}
                    </span>
                    {seller.price_advantage != null && (
                      <span className={cn('text-[11px] font-medium', seller.price_advantage < 0 ? 'text-red-400' : 'text-green-400')}>
                        {seller.price_advantage < 0
                          ? `₹${Math.abs(seller.price_advantage).toFixed(0)} cheaper`
                          : `₹${seller.price_advantage.toFixed(0)} pricier`}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {seller.asins.map(a => (
                      <Link key={a} href={`/dashboard/asins/${a}`}
                        className="font-mono text-[10px] text-primary/70 hover:text-primary hover:underline">
                        {a}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Alerts */}
        <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Buy Box Alerts</h2>
            </div>
            {alerts.filter(a => a.severity === 'critical').length > 0 && (
              <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">
                {alerts.filter(a => a.severity === 'critical').length} critical
              </Badge>
            )}
          </div>
          {alerts.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-xs text-muted-foreground">
                No open Buy Box alerts.{' '}
                <Link href="/dashboard/alerts" className="text-primary hover:underline">
                  Generate alerts
                </Link>{' '}
                to detect issues automatically.
              </p>
            </div>
          ) : (
            <div className="p-4 flex flex-col gap-2 max-h-[420px] overflow-y-auto">
              {alerts.map(alert => (
                <AlertRow key={alert.id} alert={alert} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
