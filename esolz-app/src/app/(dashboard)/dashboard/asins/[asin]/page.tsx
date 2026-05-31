'use client'

import { use, useMemo, useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { DataFreshnessBadge } from '@/components/dashboard/DataFreshnessBadge'
// ─── Local types (no longer from mock-asin-detail) ──────────────────────────
interface BuyBoxPoint {
  date: string
  winner: string
  is_self: boolean
}
interface KeywordRank {
  keyword: string
  rank: number | null
  prev_rank: number | null
  movement: number | null
  search_volume: number
  trend: 'up' | 'down' | 'flat'
  page_status?: string | null
  checked_at?: string | null
  found: boolean
  scrape_status: 'never_checked' | 'success' | 'failed' | 'checker_unavailable'
  error_message: string | null
}
interface AsinAlert {
  id: string
  type: 'bsr_drop' | 'bsr_rise' | 'buybox_lost' | 'buybox_won' | 'price_change' | 'low_stock' | 'oos'
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}
import { formatPrice, timeAgo } from '@/lib/format'
import { sanitizeCheckerError } from '@/lib/checker-errors'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { getWorkspaceId, getAsinDetail, type AsinDetailRow } from '@/lib/supabase/asins'
import { createClient } from '@/lib/supabase/client'
import { Marketplace } from '@/types'
import {
  ArrowLeft,
  Package,
  TrendingDown,
  IndianRupee,
  Star,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Activity,
  BarChart2,
  TrendingUp,
  Minus,
  MapPin,
  Bell,
  Lock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  Check,
  X,
  Users,
  Loader2,
  RefreshCw,
  Plus,
} from 'lucide-react'

// ─── Tooltip components ───────────────────────────────────────────────────────

function BsrTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">#{payload[0].value?.toLocaleString('en-IN')}</p>
    </div>
  )
}

function PriceTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">₹{payload[0].value?.toLocaleString('en-IN')}</p>
    </div>
  )
}

// ─── Range Toggle ─────────────────────────────────────────────────────────────

function RangeToggle({
  value,
  onChange,
}: {
  value: 7 | 14 | 30
  onChange: (v: 7 | 14 | 30) => void
}) {
  const opts: (7 | 14 | 30)[] = [7, 14, 30]
  return (
    <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5">
      {opts.map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={cn(
            'px-2.5 py-1 text-xs rounded transition-colors font-medium',
            value === n
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          {n}d
        </button>
      ))}
    </div>
  )
}

// ─── Chart skeleton ───────────────────────────────────────────────────────────

function ChartSkeleton() {
  return (
    <div className="h-[220px] flex items-center justify-center">
      <div className="text-muted-foreground/40 text-sm">Loading chart…</div>
    </div>
  )
}

// ─── Alert item ───────────────────────────────────────────────────────────────

function AlertItem({ alert }: { alert: AsinAlert }) {
  const iconMap = {
    success: <CheckCircle2 className="size-3.5 shrink-0 text-green-400" />,
    warning: <AlertTriangle className="size-3.5 shrink-0 text-yellow-400" />,
    error:   <XCircle       className="size-3.5 shrink-0 text-red-400"   />,
    info:    <Info          className="size-3.5 shrink-0 text-blue-400"  />,
  }
  const bgMap = {
    success: 'border-green-500/20 bg-green-500/5',
    warning: 'border-yellow-500/20 bg-yellow-500/5',
    error:   'border-red-500/20 bg-red-500/5',
    info:    'border-blue-500/20 bg-blue-500/5',
  }
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5', bgMap[alert.severity])}>
      {iconMap[alert.severity]}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground leading-snug">{alert.message}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(alert.timestamp)}</p>
      </div>
    </div>
  )
}

// ─── Buy Box timeline ─────────────────────────────────────────────────────────

function BuyBoxTimeline({ history }: { history: BuyBoxPoint[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {history.map((h, i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-1">
          <span className="text-xs text-muted-foreground w-28 shrink-0">{h.date}</span>
          <div className="flex-1 flex items-center gap-1.5">
            {h.winner === '—' ? (
              <span className="text-xs text-muted-foreground/60">—</span>
            ) : h.is_self ? (
              <>
                <Check className="size-3 text-green-400 shrink-0" />
                <span className="text-xs font-medium text-green-400">{h.winner}</span>
              </>
            ) : (
              <>
                <X className="size-3 text-red-400 shrink-0" />
                <span className="text-xs text-muted-foreground truncate">{h.winner}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Keywords table ───────────────────────────────────────────────────────────

function KeywordsTable({ keywords }: { keywords: KeywordRank[] }) {
  if (keywords.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">No keyword data available.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Keyword</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Latest</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground hidden sm:table-cell">Previous</th>
            <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Movement</th>
            <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Found</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground hidden md:table-cell">Search Vol.</th>
            <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className="py-3 text-foreground font-medium">
                <div>{kw.keyword}</div>
                {kw.checked_at && (
                  <div className="text-xs text-muted-foreground/60 mt-0.5">
                    checked {timeAgo(kw.checked_at)}
                  </div>
                )}
              </td>
              <td className="py-3 text-right font-mono font-semibold text-foreground">
                {kw.rank !== null
                  ? `#${kw.rank}`
                  : kw.page_status === 'not_ranking'
                    ? <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Not ranking</span>
                    : '—'
                }
              </td>
              <td className="py-3 text-right text-muted-foreground font-mono text-xs hidden sm:table-cell">
                {kw.prev_rank !== null ? `#${kw.prev_rank}` : '—'}
              </td>
              <td className="py-3 text-center text-xs text-muted-foreground font-mono">
                {kw.movement !== null ? `${kw.movement > 0 ? '+' : ''}${kw.movement}` : '—'}
              </td>
              <td className="py-3 text-center">
                {kw.scrape_status === 'never_checked' ? (
                  <span className="text-xs text-muted-foreground">Never checked</span>
                ) : kw.scrape_status === 'failed' ? (
                  <span className="text-xs text-red-400">Failed</span>
                ) : kw.found ? (
                  <span className="text-xs text-green-400">Found</span>
                ) : (
                  <span className="text-xs text-yellow-400">Not found</span>
                )}
              </td>
              <td className="py-3 text-right text-muted-foreground text-xs hidden md:table-cell">
                {kw.search_volume ? kw.search_volume.toLocaleString('en-IN') : '—'}
              </td>
              <td className="py-3 text-center">
                {kw.scrape_status === 'checker_unavailable' || kw.scrape_status === 'failed' ? (
                  <span className="text-xs text-amber-400" title={sanitizeCheckerError(kw.error_message) ?? 'Checker not connected'}>
                    Checker not connected
                  </span>
                ) : kw.trend === 'up' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                    <TrendingUp className="size-3" />↑
                  </span>
                ) : kw.trend === 'down' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                    <TrendingDown className="size-3" />↓
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Minus className="size-3" />—
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currencyFor(mp: string) {
  if (mp === 'US') return 'USD'
  if (mp === 'UK') return 'GBP'
  if (mp === 'DE') return 'EUR'
  return 'INR'
}

function availLabelFrom(score: number | null): string {
  if (score === null) return '—'
  if (score >= 70) return 'In Stock'
  if (score >= 30) return 'Limited Stock'
  return 'Out of Stock'
}

function formatDateShort(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

function buyBoxStatusLabel(status: string | null | undefined): string {
  if (status === 'won') return 'Won'
  if (status === 'lost') return 'Lost'
  if (status === 'no_buybox' || status === 'suppressed') return 'No Buy Box'
  if (status === 'partial_success') return 'Partial data'
  if (status === 'failed' || status === 'checker_unavailable') return 'Failed safely'
  return 'Unknown'
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AsinDetailPage({ params }: { params: Promise<{ asin: string }> }) {
  const { asin } = use(params)

  const [detail,  setDetail]  = useState<AsinDetailRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [refreshing, setRefreshing] = useState(false)
  const [bsrRange,   setBsrRange]   = useState<7 | 14 | 30>(30)
  const [priceRange, setPriceRange] = useState<7 | 14 | 30>(30)
  const [mounted,    setMounted]    = useState(false)

  // Pincode check state
  const [pincodeInput, setPincodeInput] = useState('')
  const [checking, setChecking] = useState(false)
  const [pincodeHistory, setPincodeHistory] = useState<any[]>([])
  const [latestCheck, setLatestCheck] = useState<any | null>(null)

  // Buy Box check state
  const [buyboxChecking, setBuyboxChecking] = useState(false)
  const [buyboxHistory, setBuyboxHistory] = useState<any[]>([])
  const [latestBuyBox, setLatestBuyBox] = useState<any | null>(null)

  // Keyword ranks (real data from Supabase)
  const [asinKeywords, setAsinKeywords] = useState<KeywordRank[]>([])
  const [kwInput, setKwInput] = useState('')
  const [trackingAsinKw, setTrackingAsinKw] = useState(false)
  const [kwRefreshing, setKwRefreshing] = useState(false)
  const [asinAlerts, setAsinAlerts] = useState<AsinAlert[]>([])

  useEffect(() => { setMounted(true) }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const wsId = await getWorkspaceId()
    if (!wsId) { setNotFound(true); setLoading(false); return }
    const data = await getAsinDetail(wsId, asin)
    if (!data) { setNotFound(true) } else { setDetail(data) }
    setLoading(false)
  }, [asin])

  const loadPincodeHistory = useCallback(async () => {
    const wsId = await getWorkspaceId()
    if (!wsId || !detail) return
    const supabase = createClient()
    const { data } = await supabase
      .from('pincode_checks')
      .select('*')
      .eq('workspace_id', wsId)
      .eq('tracked_asin_id', detail.id)
      .order('checked_at', { ascending: false })
      .limit(10)
    if (data) {
      setPincodeHistory(data)
      if (data.length > 0) setLatestCheck(data[0])
    }
  }, [detail])

  const loadBuyBoxHistory = useCallback(async () => {
    const wsId = await getWorkspaceId()
    if (!wsId || !detail) return
    const supabase = createClient()
    const { data } = await supabase
      .from('buybox_snapshots')
      .select('*')
      .eq('workspace_id', wsId)
      .eq('tracked_asin_id', detail.id)
      .order('checked_at', { ascending: false })
      .limit(10)
    if (data) {
      setBuyboxHistory(data)
      if (data.length > 0) setLatestBuyBox(data[0])
    }
  }, [detail])

  const loadAsinKeywords = useCallback(async () => {
    if (!detail) return
    const supabase = createClient()

    const { data: kws } = await supabase
      .from('tracked_keywords')
      .select('id, keyword, search_volume')
      .eq('tracked_asin_id', detail.id)

    if (!kws || kws.length === 0) {
      setAsinKeywords([])
      return
    }

    const { data: snaps } = await supabase
      .from('keyword_rank_snapshots')
      .select('tracked_keyword_id, organic_rank, page_status, checked_at, found, scrape_status, error_message')
      .in('tracked_keyword_id', kws.map(k => k.id))
      .order('checked_at', { ascending: false })

    const byKw: Record<string, {
      organic_rank: number | null
      page_status: string | null
      checked_at: string | null
      found: boolean | null
      scrape_status: string | null
      error_message: string | null
    }[]> = {}
    for (const s of snaps ?? []) {
      if (!byKw[s.tracked_keyword_id]) byKw[s.tracked_keyword_id] = []
      byKw[s.tracked_keyword_id].push(s)
    }

    const mapped: KeywordRank[] = kws.map(kw => {
      const kwSnaps   = byKw[kw.id] ?? []
      const cur       = kwSnaps[0]?.organic_rank ?? null
      const prev      = kwSnaps[1]?.organic_rank ?? null
      const movement  = cur !== null && prev !== null ? prev - cur : null
      const scrapeStatus = kwSnaps[0]
        ? ((kwSnaps[0].scrape_status as 'success' | 'failed' | null) ?? 'success')
        : 'never_checked'
      const found = kwSnaps[0]
        ? (kwSnaps[0].found ?? cur !== null)
        : false
      const trend: 'up' | 'down' | 'flat' =
        cur !== null && prev !== null
          ? cur < prev ? 'up' : cur > prev ? 'down' : 'flat'
          : 'flat'
      return {
        keyword:      kw.keyword,
        rank:         cur,
        prev_rank:    prev,
        movement,
        search_volume: kw.search_volume ?? 0,
        trend,
        page_status:  kwSnaps[0]?.page_status ?? null,
        checked_at:   kwSnaps[0]?.checked_at  ?? null,
        found,
        scrape_status: scrapeStatus,
        error_message: kwSnaps[0]?.error_message ?? null,
      }
    })

    setAsinKeywords(mapped)
  }, [detail])

  const handleTrackAsinKeyword = useCallback(async () => {
    if (!kwInput.trim()) return
    setTrackingAsinKw(true)
    try {
      const res = await fetch(`/api/asins/${asin}/keywords/track`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          keyword:     kwInput.trim(),
          marketplace: detail?.marketplace ?? 'IN',
        }),
      })
      const data = await res.json() as { keyword?: unknown; error?: string; debug?: unknown }
      console.log('[asin/keywords/track] response:', { status: res.status, data })
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to track keyword')
      } else {
        toast.success(`Tracking "${kwInput.trim()}"`)
        setKwInput('')
        await loadAsinKeywords()
      }
    } catch (err) {
      console.error('[asin/keywords/track] network error:', err)
      toast.error('Network error — could not track keyword')
    } finally {
      setTrackingAsinKw(false)
    }
  }, [asin, kwInput, detail?.marketplace, loadAsinKeywords])

  const handleRefreshKeywordRanks = useCallback(async () => {
    if (asinKeywords.length === 0) return
    setKwRefreshing(true)
    try {
      const res = await fetch(`/api/asins/${asin}/keywords/refresh`, { method: 'POST' })
      const data = await res.json() as { checked?: number; results?: unknown[]; error?: string; status?: string; message?: string }
      console.log('[asin/keywords/refresh] response:', { status: res.status, data })
      if (!res.ok) {
        toast.error(data.error ?? 'Rank refresh failed')
      } else if (data.status === 'failed' || data.status === 'checker_unavailable') {
        toast.info('Keyword checker is temporarily unavailable. Your keyword was saved and will be checked later.')
        await loadAsinKeywords()
      } else {
        toast.success(`Refreshed ${data.checked ?? 0} keyword ranks`)
        await loadAsinKeywords()
      }
    } catch (err) {
      console.error('[asin/keywords/refresh] network error:', err)
      toast.error('Network error — could not refresh ranks')
    } finally {
      setKwRefreshing(false)
    }
  }, [asin, asinKeywords.length, loadAsinKeywords])

  const loadAsinAlerts = useCallback(async () => {
    if (!detail) return
    const wsId = await getWorkspaceId()
    if (!wsId) return
    const supabase = createClient()
    const { data } = await supabase
      .from('alerts')
      .select('id, title, description, severity, created_at')
      .eq('workspace_id', wsId)
      .eq('tracked_asin_id', detail.id)
      .neq('status', 'resolved')
      .order('created_at', { ascending: false })
      .limit(5)
    setAsinAlerts(
      (data ?? []).map(a => ({
        id: a.id as string,
        type: 'bsr_drop' as AsinAlert['type'],
        message: (a.description as string | null)
          ? `${a.title as string} — ${a.description as string}`
          : (a.title as string),
        severity: (
          a.severity === 'critical' ? 'error'
          : a.severity === 'opportunity' ? 'success'
          : a.severity
        ) as AsinAlert['severity'],
        timestamp: a.created_at as string,
      }))
    )
  }, [detail])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (detail) loadPincodeHistory() }, [detail, loadPincodeHistory])
  useEffect(() => { if (detail) loadBuyBoxHistory() }, [detail, loadBuyBoxHistory])
  useEffect(() => { if (detail) loadAsinKeywords() }, [detail, loadAsinKeywords])
  useEffect(() => { if (detail) loadAsinAlerts() }, [detail, loadAsinAlerts])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res  = await fetch(`/api/asins/${asin}/refresh`, { method: 'POST' })
      const data = await res.json() as { error?: string; detail?: string; scrape_status?: string; success?: boolean; message?: string; source?: string }
      if (!res.ok) {
        const msg = [data.error, data.detail, data.scrape_status].filter(Boolean).join(' — ')
        console.error('[bsr-refresh] API error:', data)
        toast.error(msg || 'Refresh failed')
        await load()
      } else {
        if (data.scrape_status === 'partial_success') {
          toast.warning(data.message || 'Product details found, but BSR was not available from Amazon.')
        } else if (data.scrape_status === 'failed' || data.success === false) {
          toast.info(data.message || 'Amazon Catalog data was not available for this ASIN yet.')
        } else {
          toast.success(data.message || 'Snapshot updated successfully')
        }
        await load()
      }
    } catch (err) {
      console.error('[bsr-refresh] network error:', err)
      toast.error('Network error — could not refresh')
    } finally {
      setRefreshing(false)
    }
  }, [asin, load])

  const handleCheckPincode = useCallback(async () => {
    if (!pincodeInput.trim()) {
      toast.error('Please enter a pincode')
      return
    }
    if (detail?.marketplace === 'IN' && !/^\d{6}$/.test(pincodeInput)) {
      toast.error('Invalid pincode format (expected 6 digits)')
      return
    }
    setChecking(true)
    try {
      const res = await fetch(`/api/asins/${asin}/pincode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pincode: pincodeInput.trim() })
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Pincode check failed')
        await loadPincodeHistory()
      } else {
        toast.success('Pincode check completed')
        setLatestCheck(data.check)
        await loadPincodeHistory()
        setPincodeInput('')
      }
    } catch (err) {
      console.error('[pincode-check] error:', err)
      toast.error('Failed to check pincode')
    } finally {
      setChecking(false)
    }
  }, [asin, pincodeInput, detail?.marketplace, loadPincodeHistory])

  const handleCheckBuyBox = useCallback(async () => {
    setBuyboxChecking(true)
    try {
      const res = await fetch(`/api/asins/${asin}/buybox`, { method: 'POST' })
      const data = await res.json() as { error?: string; message?: string; result?: { buy_box_status?: string | null } }
      if (!res.ok) {
        toast.error(data.error || 'Buy Box check failed')
        await loadBuyBoxHistory()
      } else {
        const status = data.result?.buy_box_status
        if (status === 'failed') {
          toast.info(data.message || 'Buy Box check saved as failed. Please retry later.')
        } else if (status === 'partial_success' || status === 'unknown') {
          toast.warning(data.message || 'Buy Box data was partial. Ownership was not confirmed.')
        } else {
          toast.success(data.message || 'Buy Box check completed')
        }
        await loadBuyBoxHistory()
      }
    } catch (err) {
      console.error('[buybox-check] error:', err)
      toast.error('Failed to run Buy Box check')
    } finally {
      setBuyboxChecking(false)
    }
  }, [asin, loadBuyBoxHistory])

  // ── Derive product shape from real data ────────────────────────────────
  const snapshots = detail?.snapshots ?? []
  const latest    = snapshots[0] ?? null
  const prev      = snapshots[1] ?? null

  // Last non-null BSR — older snapshots used when latest has null BSR
  const lastBsrSnap  = snapshots.find(s => s.bsr != null) ?? null
  const prevBsrSnap  = snapshots.filter(s => s.bsr != null)[1] ?? null

  const product = detail ? {
    id:                 detail.id,
    asin:               detail.asin,
    label:              detail.product_title || detail.asin,
    marketplace:        detail.marketplace as Marketplace,
    is_active:          detail.status === 'active',
    created_at:         detail.created_at,
    bsr_rank:           lastBsrSnap?.bsr      ?? null,
    bsr_rank_prev:      prevBsrSnap?.bsr      ?? null,
    bsr_captured_at:    lastBsrSnap?.checked_at ?? null,
    category:           detail.category,
    sub_rank:           null as null,
    sub_category:       null as null,
    price:              latest?.price != null  ? Number(latest.price)  : null,
    price_currency:     currencyFor(detail.marketplace),
    rating:             latest?.rating != null ? Number(latest.rating) : null,
    review_count:       latest?.review_count  ?? null,
    buybox_winner:      latest?.buy_box_owner ?? null,
    buybox_is_self:     null as null,
    availability:       (latest?.availability_score != null
      ? (latest.availability_score >= 70 ? 'in_stock' : latest.availability_score >= 30 ? 'limited' : 'out_of_stock')
      : null) as 'in_stock' | 'limited' | 'out_of_stock' | null,
    availability_score: latest?.availability_score ?? null,
    captured_at:        latest?.checked_at    ?? null,
  } : null

  // ── Chart data: real snapshots ────────────────────────────────────────────
  const realBsrHistory = snapshots
    .filter(s => s.bsr !== null)
    .map(s => ({ date: formatDateShort(s.checked_at), rank: s.bsr! }))
    .reverse()

  const realPriceHistory = snapshots
    .filter(s => s.price !== null)
    .map(s => ({ date: formatDateShort(s.checked_at), price: Number(s.price) }))
    .reverse()

  const liveBuyboxHist = useMemo((): BuyBoxPoint[] =>
    buyboxHistory
      .slice(0, 7)
      .map(snap => ({
        date: new Date(snap.checked_at as string).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
        winner: (snap.buy_box_owner as string | null) ?? '—',
        is_self: snap.buy_box_status === 'won',
      }))
      .reverse()
  , [buyboxHistory])

  const keywords = asinKeywords

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ── Not found ──────────────────────────────────────────────────────────
  if (notFound || !product) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <Package className="size-12 text-muted-foreground/30" />
        <h1 className="text-lg font-semibold text-foreground">ASIN not found</h1>
        <p className="text-sm text-muted-foreground">
          No tracked product for <span className="font-mono text-primary">{asin}</span>
        </p>
        <Button variant="outline" size="sm" render={<Link href="/dashboard/asins" />}>
          <ArrowLeft className="size-4" />
          Back to ASIN Tracking
        </Button>
      </div>
    )
  }

  const bsrChange  = product.bsr_rank !== null && product.bsr_rank_prev !== null
    ? product.bsr_rank - product.bsr_rank_prev
    : null
  const bsrDisplay = product.bsr_rank !== null ? `#${product.bsr_rank.toLocaleString('en-IN')}` : 'BSR not available'
  // Show "last seen X ago" when BSR is from an older snapshot (latest had null)
  const bsrIsStale = product.bsr_rank !== null && product.bsr_captured_at !== product.captured_at
  const hasCatalogDetails = Boolean(detail?.product_title || detail?.brand || detail?.category || detail?.image_url)
  const bsrCategoryLabel = product.sub_category
    ? `${product.category ?? 'Category'} · ${product.sub_category}`
    : (product.category ?? null)
  const bsrSubLabel = bsrIsStale
    ? `Last seen ${timeAgo(product.bsr_captured_at!)}`
    : bsrChange !== null
      ? bsrChange < 0 ? `▲ ${Math.abs(bsrChange).toLocaleString('en-IN')} improved` : bsrChange > 0 ? `▼ ${bsrChange.toLocaleString('en-IN')} dropped` : 'No change'
      : hasCatalogDetails
        ? 'BSR not available from Amazon.'
        : 'No data yet'
  const bsrCardSubLabel = product.bsr_rank !== null ? (bsrCategoryLabel ?? bsrSubLabel) : bsrSubLabel

  const buyboxValue = product.buybox_is_self === true
    ? 'You ✓'
    : product.buybox_is_self === false
      ? (product.buybox_winner ?? 'Competitor') + ' ✗'
      : product.buybox_winner
        ? product.buybox_winner
        : '—'

  const availLabel = availLabelFrom(product.availability_score)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">

      {/* ── Back nav ── */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
          render={<Link href="/dashboard/asins" />}
        >
          <ArrowLeft className="size-4" />
          ASIN Tracking
        </Button>
      </div>

      {/* ── Product header ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            {/* Image or fallback icon */}
            {detail?.image_url ? (
              <div className="size-14 rounded-xl border border-border overflow-hidden shrink-0 bg-muted">
                <Image
                  src={detail.image_url}
                  alt={product.label}
                  width={56}
                  height={56}
                  className="object-contain w-full h-full"
                  unoptimized
                />
              </div>
            ) : (
              <div className="size-14 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Package className="size-7 text-primary" />
              </div>
            )}
            <div className="min-w-0">
              {/* Chips row */}
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="font-mono text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-md">
                  {asin}
                </span>
                <Badge variant="outline" className="text-xs h-5 px-1.5">
                  {product.marketplace}
                </Badge>
                {detail?.brand && (
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-md">
                    {detail.brand}
                  </span>
                )}
                <span className={cn('flex items-center gap-1 text-xs font-medium', product.is_active ? 'text-green-400' : 'text-muted-foreground')}>
                  <span className={cn('size-1.5 rounded-full', product.is_active ? 'bg-green-400' : 'bg-muted-foreground')} />
                  {product.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              {/* Title */}
              <h1 className="text-xl font-bold text-foreground leading-snug mb-1">
                {product.label}
              </h1>
              <p className="text-xs text-muted-foreground mb-1.5">
                Review this ASIN's latest BSR, Buy Box, pincode and keyword performance. Next: run Refresh Data if this is your first check. Data source: Amazon Catalog API first, then snapshot tables and checker APIs.
              </p>
              {/* Category */}
              {product.category && (
                <p className="text-sm text-muted-foreground">{product.category}</p>
              )}
            </div>
          </div>
          {/* Last checked + Refresh */}
          <div className="text-right shrink-0 flex flex-col items-end gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-0.5">Last checked</p>
              <p className="text-sm font-medium text-foreground">{timeAgo(product.captured_at)}</p>
              <div className="mt-1">
                <DataFreshnessBadge checkedAt={product.captured_at} />
              </div>
              {snapshots.length === 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">No snapshots yet</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleRefresh}
              disabled={refreshing || loading}
            >
              {refreshing
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RefreshCw className="size-3.5" />}
              {refreshing ? 'Refreshing…' : 'Refresh Data'}
            </Button>
          </div>
        </div>
      </div>

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Current BSR"
          value={bsrDisplay}
          sub={bsrCardSubLabel}
          icon={TrendingDown}
          trend={!bsrIsStale && bsrChange !== null ? { value: bsrChange, label: 'from yesterday' } : undefined}
        />
        <KpiCard
          label="Sub-Category Rank"
          value="—"
          sub="No data yet"
          icon={BarChart2}
        />
        <KpiCard
          label="Current Price"
          value={formatPrice(product.price, product.price_currency)}
          sub="Listed price"
          icon={IndianRupee}
        />
        <KpiCard
          label="Rating"
          value={product.rating !== null ? `${product.rating.toFixed(1)} ★` : '—'}
          sub={product.review_count !== null ? `${product.review_count.toLocaleString('en-IN')} reviews` : 'No data yet'}
          icon={Star}
        />
        <KpiCard
          label="Buy Box"
          value={buyboxValue}
          sub={product.buybox_winner ? `Owner: ${product.buybox_winner}` : 'No data yet'}
          icon={product.buybox_is_self === true ? ShieldCheck : product.buybox_is_self === false ? ShieldAlert : ShieldOff}
        />
        <KpiCard
          label="Availability"
          value={product.availability_score !== null ? `${product.availability_score}/100` : '—'}
          sub={availLabel}
          icon={Activity}
        />
      </div>

      {/* ── Charts + Buy Box/Alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: charts (2/3) */}
        <div className="lg:col-span-2 flex flex-col gap-4">

          {/* BSR History */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
              <div>
                <h2 className="font-semibold text-foreground">BSR History</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {realBsrHistory.length > 0 ? 'Rank trend — lower is better' : 'No BSR data collected yet'}
                </p>
              </div>
              {realBsrHistory.length > 0 && <RangeToggle value={bsrRange} onChange={setBsrRange} />}
            </div>
            {mounted ? (
              realBsrHistory.length === 0 ? (
                <div className="h-[220px] flex flex-col items-center justify-center gap-2">
                  <TrendingDown className="size-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No BSR data yet — data populates after first scrape</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart
                    data={realBsrHistory.slice(-bsrRange)}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#94a3b8', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      reversed
                      domain={['auto', 'auto']}
                      tick={{ fill: '#94a3b8', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => v >= 1000 ? `#${(v / 1000).toFixed(1)}k` : `#${v}`}
                      width={48}
                    />
                    <Tooltip content={<BsrTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="rank"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#f59e0b', stroke: '#f59e0b' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )
            ) : (
              <ChartSkeleton />
            )}
          </div>

          {/* Price History */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
              <div>
                <h2 className="font-semibold text-foreground">Price History</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {realPriceHistory.length > 0 ? 'Listed price over time' : 'No price data collected yet'}
                </p>
              </div>
              {realPriceHistory.length > 0 && <RangeToggle value={priceRange} onChange={setPriceRange} />}
            </div>
            {mounted ? (
              realPriceHistory.length === 0 ? (
                <div className="h-[220px] flex flex-col items-center justify-center gap-2">
                  <IndianRupee className="size-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No price data yet — data populates after first scrape</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart
                    data={realPriceHistory.slice(-priceRange)}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#94a3b8', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={['auto', 'auto']}
                      tick={{ fill: '#94a3b8', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `₹${v.toLocaleString('en-IN')}`}
                      width={56}
                    />
                    <Tooltip content={<PriceTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="#38bdf8"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#38bdf8', stroke: '#38bdf8' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )
            ) : (
              <ChartSkeleton />
            )}
          </div>
        </div>

        {/* Right: Buy Box + Alerts (1/3) */}
        <div className="flex flex-col gap-4">

          {/* Buy Box 7-day history */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="size-4 text-primary shrink-0" />
              <h2 className="font-semibold text-foreground">Buy Box — 7 Days</h2>
            </div>
            {buyboxHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No Buy Box data yet</p>
            ) : (
              <BuyBoxTimeline history={liveBuyboxHist} />
            )}
          </div>

          {/* Alerts */}
          <div className="rounded-xl border border-border bg-card p-5 flex-1">
            <div className="flex items-center gap-2 mb-4">
              <Bell className="size-4 text-primary shrink-0" />
              <h2 className="font-semibold text-foreground">Recent Alerts</h2>
            </div>
            <div className="flex flex-col gap-2">
              {asinAlerts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No active alerts</p>
              ) : (
                asinAlerts.map(a => (
                  <AlertItem key={a.id} alert={a} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Keyword rank snapshot ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-primary shrink-0" />
            <div>
              <h2 className="font-semibold text-foreground">Keyword Rank Snapshot</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Organic search position on Amazon India. Next: add a keyword and click Refresh Ranks. Data source: tracked_keywords + keyword_rank_snapshots.</p>
            </div>
          </div>
          <DataFreshnessBadge checkedAt={keywords[0]?.checked_at ?? null} />
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshKeywordRanks}
            disabled={kwRefreshing || asinKeywords.length === 0}
          >
            {kwRefreshing
              ? <><RefreshCw className="size-3.5 animate-spin" /> Refreshing…</>
              : <><RefreshCw className="size-3.5" /> Refresh Ranks</>
            }
          </Button>
        </div>

        {/* ── Track keyword input ── */}
        <div className="flex gap-2 mb-5">
          <input
            type="text"
            placeholder="Add keyword to track (e.g. desi ghee 500ml)"
            value={kwInput}
            onChange={e => setKwInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !trackingAsinKw) handleTrackAsinKeyword() }}
            disabled={trackingAsinKw}
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <Button
            onClick={handleTrackAsinKeyword}
            disabled={trackingAsinKw || !kwInput.trim()}
            size="sm"
          >
            {trackingAsinKw
              ? <><Loader2 className="size-3.5 animate-spin" /> Saving…</>
              : <><Plus className="size-3.5" /> Track</>
            }
          </Button>
        </div>

        <KeywordsTable keywords={keywords} />
      </div>

      {/* ── Pincode availability ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-5">
          <MapPin className="size-4 text-primary shrink-0" />
          <div>
            <h2 className="font-semibold text-foreground">Pincode Availability</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Check delivery availability for important pincodes. Next: run a pincode check above. Data source: pincode_checks and live checker response.</p>
          </div>
        </div>
          <DataFreshnessBadge checkedAt={latestCheck?.checked_at ?? null} />

        {/* Input + Check button */}
        <div className="flex gap-2 mb-6">
          <input
            type="text"
            placeholder="Enter pincode (e.g., 110001)"
            value={pincodeInput}
            onChange={e => setPincodeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !checking) handleCheckPincode() }}
            disabled={checking}
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <Button
            onClick={handleCheckPincode}
            disabled={checking || !pincodeInput.trim()}
            className="gap-1.5"
          >
            {checking ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Checking…
              </>
            ) : (
              <>
                <MapPin className="size-4" />
                Check
              </>
            )}
          </Button>
        </div>

        {/* Latest check result */}
        {latestCheck && (
          <div className="mb-6 p-4 rounded-lg border border-border bg-muted/30">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Latest Check</p>
                <p className="font-mono text-sm text-foreground">Pincode: {latestCheck.pincode}</p>
              </div>
              <p className="text-[10px] text-muted-foreground">{timeAgo(latestCheck.checked_at)}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Availability</p>
                <p className={cn('text-sm font-medium', latestCheck.available ? 'text-green-400' : 'text-red-400')}>
                  {latestCheck.available ? '✓ Available' : '✗ Not Available'}
                </p>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <p className="text-xs text-muted-foreground mb-1">Delivery Options</p>
                {latestCheck.delivery_promise
                  ? latestCheck.delivery_promise.split('\n').map((line: string, i: number) => (
                      <p key={i} className="text-sm font-medium text-foreground leading-snug">{line}</p>
                    ))
                  : <p className="text-sm text-muted-foreground">—</p>
                }
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Fulfillment</p>
                <p className="text-sm font-medium text-foreground">{latestCheck.fulfillment_type || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Seller</p>
                <p className="text-sm font-medium text-foreground truncate" title={latestCheck.buy_box_seller || '—'}>
                  {latestCheck.buy_box_seller || '—'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Check history */}
        {pincodeHistory.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">Recent Checks</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Pincode</th>
                    <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Available</th>
                    <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hidden sm:table-cell">Delivery</th>
                    <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground hidden md:table-cell">Fulfillment</th>
                    <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {pincodeHistory.map((check, i) => (
                    <tr key={check.id || i} className="border-b border-border/50 last:border-0">
                      <td className="py-3 font-mono text-xs text-foreground">{check.pincode}</td>
                      <td className="py-3 text-center">
                        {check.available ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                            <Check className="size-3" />
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                            <X className="size-3" />
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-sm text-muted-foreground hidden sm:table-cell">
                        {check.delivery_promise
                          ? check.delivery_promise.split('\n').map((line: string, i: number) => (
                              <span key={i} className="block">{line}</span>
                            ))
                          : '—'
                        }
                      </td>
                      <td className="py-3 text-center text-xs text-muted-foreground hidden md:table-cell">
                        {check.fulfillment_type || '—'}
                      </td>
                      <td className="py-3 text-right text-xs text-muted-foreground">
                        {timeAgo(check.checked_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="text-center py-8">
            <MapPin className="size-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No pincode checks yet</p>
            <p className="text-xs text-muted-foreground mt-1">Enter a pincode above to check availability</p>
          </div>
        )}
      </div>

      {/* ── Buy Box Checker ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary shrink-0" />
            <div>
              <h2 className="font-semibold text-foreground">Buy Box Checker</h2>
                <p className="text-xs text-muted-foreground mt-0.5">See current Buy Box ownership from Amazon offers data. Next: click Run Check and review recent ownership. Data source: Amazon Product Pricing API and buybox_snapshots.</p>
            </div>
          </div>
          <DataFreshnessBadge checkedAt={latestBuyBox?.checked_at ?? null} />
          <Button
            onClick={handleCheckBuyBox}
            disabled={buyboxChecking}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            {buyboxChecking ? (
              <><Loader2 className="size-3.5 animate-spin" />Checking&hellip;</>
            ) : (
              <><ShieldCheck className="size-3.5" />Run Check</>
            )}
          </Button>
        </div>

        {latestBuyBox && (
          <div className="mb-5 p-4 rounded-lg border border-border bg-muted/30">
            <div className="flex items-start justify-between gap-3 mb-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Latest Result</p>
              <p className="text-[10px] text-muted-foreground">{timeAgo(latestBuyBox.checked_at)}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Buy Box Owner</p>
                <p className="text-sm font-medium text-foreground truncate" title={latestBuyBox.buy_box_owner || '—'}>
                  {latestBuyBox.buy_box_owner || '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Buy Box Price</p>
                <p className="text-sm font-medium text-foreground">
                  {latestBuyBox.buy_box_price != null
                    ? formatPrice(latestBuyBox.buy_box_price, product.price_currency)
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Fulfillment</p>
                <p className="text-sm font-medium text-foreground">{latestBuyBox.fulfillment_type || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Status</p>
                <p className="text-sm font-medium text-foreground">{buyBoxStatusLabel(latestBuyBox.buy_box_status)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Offers</p>
                <p className="text-sm font-medium text-foreground">{latestBuyBox.number_of_offers ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">BB Eligible</p>
                <p className="text-sm font-medium text-foreground">{latestBuyBox.number_of_buybox_eligible_offers ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Lowest Price</p>
                <p className="text-sm font-medium text-foreground">
                  {latestBuyBox.lowest_price != null
                    ? `${latestBuyBox.lowest_price_currency ?? product.price_currency} ${latestBuyBox.lowest_price}`
                    : '—'}
                </p>
              </div>
            </div>
          </div>
        )}

        {buyboxHistory.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">Recent Checks</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner</th>
                    <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground hidden sm:table-cell">Price</th>
                    <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Fulfillment</th>
                    <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground hidden md:table-cell">Status</th>
                    <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {buyboxHistory.map((snap, i) => (
                    <tr key={snap.id || i} className="border-b border-border/50 last:border-0">
                      <td className="py-3 text-foreground font-medium max-w-[160px] truncate">
                        {snap.buy_box_owner || '—'}
                      </td>
                      <td className="py-3 text-right text-muted-foreground hidden sm:table-cell">
                        {snap.buy_box_price != null ? formatPrice(snap.buy_box_price, product.price_currency) : '—'}
                      </td>
                      <td className="py-3 text-center text-xs text-muted-foreground">
                        {snap.fulfillment_type || '—'}
                      </td>
                      <td className="py-3 text-center text-xs text-muted-foreground hidden md:table-cell">
                        {buyBoxStatusLabel(snap.buy_box_status)}
                      </td>
                      <td className="py-3 text-right text-xs text-muted-foreground">
                        {timeAgo(snap.checked_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : !buyboxChecking ? (
          <div className="text-center py-8">
            <ShieldCheck className="size-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No Buy Box checks yet</p>
            <p className="text-xs text-muted-foreground mt-1">Click &quot;Run Check&quot; to see who owns the Buy Box</p>
          </div>
        ) : null}
      </div>

      {/* ── Competitor comparison placeholder ── */}
      <div className="rounded-xl border border-border bg-card p-8 flex flex-col items-center text-center gap-4">
        <div className="size-14 rounded-full bg-muted/50 flex items-center justify-center">
          <Users className="size-7 text-muted-foreground/50" />
        </div>
        <div>
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Lock className="size-3.5 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Competitor Intelligence</h2>
          </div>
          <p className="text-sm text-muted-foreground max-w-sm">
            Unlock with Pro to see competing ASINs side-by-side — BSR, pricing, ratings, buy box win rate and review velocity.
          </p>
        </div>
        <Button render={<Link href="/dashboard/billing" />}>
          Upgrade to Pro
        </Button>
      </div>

    </div>
  )
}
