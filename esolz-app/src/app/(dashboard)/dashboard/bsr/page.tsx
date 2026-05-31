'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
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
import { createClient } from '@/lib/supabase/client'
import { getWorkspaceId, getTrackedAsins } from '@/lib/supabase/asins'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ProductSnapshot } from '@/types'
import {
  Package,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart2,
  ExternalLink,
  Bell,
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  Tag,
  Clock,
  Loader2,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BsrPoint { date: string; rank: number }

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function BsrTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">
        #{payload[0].value?.toLocaleString('en-IN')}
      </p>
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
  return (
    <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5">
      {([7, 14, 30] as const).map(n => (
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
    <div className="h-[260px] flex items-center justify-center">
      <p className="text-muted-foreground/40 text-sm">Loading chart…</p>
    </div>
  )
}

// ─── Movement chip ────────────────────────────────────────────────────────────

function MovementChip({ movement }: { movement: number | null }) {
  if (movement === null) return <span className="text-muted-foreground text-xs">—</span>
  if (movement === 0)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" /> —
      </span>
    )
  const improved = movement > 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5',
        improved
          ? 'bg-green-500/10 text-green-400 border border-green-500/20'
          : 'bg-red-500/10 text-red-400 border border-red-500/20',
      )}
    >
      {improved ? (
        <ArrowUpRight className="size-3" />
      ) : (
        <ArrowDownRight className="size-3" />
      )}
      {improved ? '+' : ''}
      {movement.toLocaleString('en-IN')}
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BsrTrackerPage() {
  const [products, setProducts]                 = useState<ProductSnapshot[]>([])
  const [loading, setLoading]                   = useState(true)
  const [selectedAsinCode, setSelectedAsinCode] = useState<string>('')
  const [selectedAsinId, setSelectedAsinId]     = useState<string>('')
  const [chartRange, setChartRange]             = useState<7 | 14 | 30>(30)
  const [bsrHistory, setBsrHistory]             = useState<BsrPoint[]>([])
  const [chartLoading, setChartLoading]         = useState(false)
  const [mounted, setMounted]                   = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // ── Load workspace products ────────────────────────────────────────────────

  const loadProducts = useCallback(async () => {
    setLoading(true)
    const wsId = await getWorkspaceId()
    if (!wsId) { setLoading(false); return }
    const asins = await getTrackedAsins(wsId)
    setProducts(asins)
    const first = asins.find(a => a.bsr_rank !== null) ?? asins[0]
    if (first) {
      setSelectedAsinCode(first.asin)
      setSelectedAsinId(first.id)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void loadProducts() }, [loadProducts])

  // ── Load real BSR history from asin_snapshots ─────────────────────────────

  const loadHistory = useCallback(async (asinId: string, days: number) => {
    if (!asinId) return
    setChartLoading(true)
    const supabase = createClient()
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    const { data } = await supabase
      .from('asin_snapshots')
      .select('bsr, checked_at')
      .eq('tracked_asin_id', asinId)
      .gte('checked_at', since)
      .not('bsr', 'is', null)
      .order('checked_at', { ascending: true })

    const points: BsrPoint[] = (data ?? []).map(row => ({
      date: new Date(row.checked_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short',
      }),
      rank: row.bsr as number,
    }))
    setBsrHistory(points)
    setChartLoading(false)
  }, [])

  useEffect(() => {
    if (selectedAsinId) void loadHistory(selectedAsinId, chartRange)
  }, [selectedAsinId, chartRange, loadHistory])

  // ── Derived data ───────────────────────────────────────────────────────────

  const productsWithBsr = useMemo(
    () => products.filter(p => p.bsr_rank !== null),
    [products],
  )

  const avgBsr = useMemo(() => {
    if (!productsWithBsr.length) return null
    return Math.round(
      productsWithBsr.reduce((s, p) => s + p.bsr_rank!, 0) / productsWithBsr.length,
    )
  }, [productsWithBsr])

  const movementsWithData = useMemo(
    () =>
      products
        .filter(p => p.bsr_rank !== null && p.bsr_rank_prev !== null)
        .map(p => ({ ...p, movement: p.bsr_rank_prev! - p.bsr_rank! })),
    [products],
  )

  const gainers = useMemo(
    () =>
      [...movementsWithData]
        .filter(p => p.movement > 0)
        .sort((a, b) => b.movement - a.movement),
    [movementsWithData],
  )

  const losers = useMemo(
    () =>
      [...movementsWithData]
        .filter(p => p.movement < 0)
        .sort((a, b) => a.movement - b.movement),
    [movementsWithData],
  )

  const biggestGainer  = gainers[0] ?? null
  const biggestLoser   = losers[0] ?? null
  const improvingCount = movementsWithData.filter(p => p.movement > 0).length
  const decliningCount = movementsWithData.filter(p => p.movement < 0).length

  const selectedProduct = useMemo(
    () => products.find(p => p.asin === selectedAsinCode) ?? null,
    [products, selectedAsinCode],
  )

  function deriveBsrState(p: ProductSnapshot): 'never_checked' | 'bsr_not_found' | 'failed' | 'stale' | 'ok' {
    if (!p.captured_at) return 'never_checked'

    const hasCatalogSignals = p.label !== p.asin || p.category !== null

    if (p.bsr_rank === null) return hasCatalogSignals ? 'bsr_not_found' : 'failed'

    const ageMs = Date.now() - new Date(p.captured_at).getTime()
    if (ageMs > 24 * 60 * 60 * 1000) return 'stale'
    return 'ok'
  }

  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, { products: ProductSnapshot[]; count: number }>()
    for (const p of products) {
      if (!p.category) continue
      if (!map.has(p.category)) map.set(p.category, { products: [], count: 0 })
      const entry = map.get(p.category)!
      entry.products.push(p)
      entry.count++
    }
    return Array.from(map.entries()).map(([cat, data]) => {
      const withBsr = data.products.filter(p => p.bsr_rank !== null)
      const avg = withBsr.length
        ? Math.round(withBsr.reduce((s, p) => s + p.bsr_rank!, 0) / withBsr.length)
        : null
      const best = withBsr.length ? Math.min(...withBsr.map(p => p.bsr_rank!)) : null
      const improving = withBsr.filter(
        p => p.bsr_rank_prev !== null && p.bsr_rank! < p.bsr_rank_prev!,
      ).length
      return { category: cat, count: data.count, avgBsr: avg, bestBsr: best, improving, products: data.products }
    })
  }, [products])

  // ── Loading / empty states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading BSR data…</span>
      </div>
    )
  }

  if (products.length === 0) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="flex flex-col items-center justify-center py-20 text-center gap-4 bg-card border border-border rounded-xl">
          <BarChart2 className="size-12 text-muted-foreground/30" />
          <div>
            <p className="font-semibold text-lg">No ASINs tracked yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add your first ASIN to start tracking BSR.
            </p>
          </div>
          <Button render={<Link href="/dashboard/asins" />} className="mt-2">
            <Plus className="size-4 mr-1.5" /> Add ASIN to Track
          </Button>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">BSR Tracker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor Best Seller Rank movement and category performance for your tracked ASINs. Next: refresh ASIN data to keep ranks current. Data source: Amazon Catalog API first, backed by tracked_asins and asin_snapshots.
          </p>
        </div>
        <Button render={<Link href="/dashboard/asins" />} className="gap-2 shrink-0">
          <Plus className="size-4" />
          Add ASIN to Track
        </Button>
      </div>

      {/* ── Summary KPI cards ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard
          label="Tracked ASINs"
          value={String(products.length)}
          sub={`${productsWithBsr.length} with BSR data`}
          icon={Package}
        />
        <KpiCard
          label="Average BSR"
          value={avgBsr !== null ? `#${avgBsr.toLocaleString('en-IN')}` : '—'}
          sub={avgBsr !== null ? 'across all categories' : 'Refresh an ASIN first'}
          icon={BarChart2}
        />
        <KpiCard
          label="Biggest Gainer"
          value={biggestGainer ? `#${biggestGainer.bsr_rank!.toLocaleString('en-IN')}` : '—'}
          sub={biggestGainer ? biggestGainer.label : 'Need 2+ snapshots per ASIN'}
          icon={TrendingUp}
          trend={
            biggestGainer
              ? { value: -biggestGainer.movement, label: `+${biggestGainer.movement} positions` }
              : undefined
          }
        />
        <KpiCard
          label="Biggest Loser"
          value={biggestLoser ? `#${biggestLoser.bsr_rank!.toLocaleString('en-IN')}` : '—'}
          sub={biggestLoser ? biggestLoser.label : 'No drops detected'}
          icon={TrendingDown}
          trend={
            biggestLoser
              ? { value: Math.abs(biggestLoser.movement), label: `${biggestLoser.movement} positions` }
              : undefined
          }
        />
        <KpiCard
          label="Improving"
          value={String(improvingCount)}
          sub="products gaining rank"
          icon={ArrowUpRight}
          trend={
            improvingCount > 0
              ? { value: -1, label: `${improvingCount} of ${products.length}` }
              : undefined
          }
        />
        <KpiCard
          label="Declining"
          value={String(decliningCount)}
          sub="products losing rank"
          icon={ArrowDownRight}
          trend={
            decliningCount > 0
              ? { value: 1, label: `${decliningCount} of ${products.length}` }
              : undefined
          }
        />
      </div>

      {/* ── BSR Trend Chart ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h2 className="font-semibold text-foreground">BSR Trend</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Historical rank movement — lower BSR = better
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={selectedAsinCode}
              onChange={e => {
                const code = e.target.value
                const prod = products.find(p => p.asin === code)
                setSelectedAsinCode(code)
                if (prod) setSelectedAsinId(prod.id)
              }}
              className="text-xs bg-muted border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              {products.map(p => (
                <option key={p.asin} value={p.asin}>
                  {p.label}
                </option>
              ))}
            </select>
            <RangeToggle value={chartRange} onChange={setChartRange} />
          </div>
        </div>

        {!mounted || chartLoading ? (
          <ChartSkeleton />
        ) : bsrHistory.length < 2 ? (
          <div className="h-[260px] flex flex-col items-center justify-center gap-2">
            <BarChart2 className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No BSR history yet</p>
            <p className="text-xs text-muted-foreground/70">
              Refresh this ASIN over time to build BSR history.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={bsrHistory}
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
                  reversed={true}
                  domain={['auto', 'auto']}
                  tick={{ fill: '#94a3b8', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `#${(v / 1000).toFixed(1)}k` : `#${v}`
                  }
                  width={48}
                />
                <Tooltip content={<BsrTooltip />} />
                <Line
                  type="monotone"
                  dataKey="rank"
                  stroke="oklch(0.741 0.174 66.5)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: 'oklch(0.741 0.174 66.5)', stroke: 'oklch(0.741 0.174 66.5)' }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing last {chartRange} days ·{' '}
            {selectedProduct?.category ?? 'No category data'}
          </span>
          {selectedAsinCode && (
            <Link
              href={`/dashboard/asins/${selectedAsinCode}`}
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              View full detail <ExternalLink className="size-3" />
            </Link>
          )}
        </div>
      </div>

      {/* ── Top Movers ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Gainers */}
        <div className="rounded-xl border border-green-500/20 bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="size-6 rounded-full bg-green-500/15 flex items-center justify-center">
              <TrendingUp className="size-3.5 text-green-400" />
            </div>
            <h2 className="font-semibold text-foreground">Biggest Gainers</h2>
            <Badge
              variant="secondary"
              className="ml-auto text-[10px] bg-green-500/10 text-green-400 border border-green-500/20"
            >
              {gainers.length} products
            </Badge>
          </div>

          {gainers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {productsWithBsr.length === 0
                ? 'Click Refresh Data on an ASIN detail page to collect BSR data from Amazon Catalog.'
                : 'No improvements detected — need 2+ snapshots per ASIN.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {gainers.map(p => (
                <div
                  key={p.asin}
                  className="flex items-center gap-3 rounded-lg bg-green-500/5 border border-green-500/10 px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.label}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1">
                        {p.asin}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-green-400">
                      #{p.bsr_rank!.toLocaleString('en-IN')}
                    </p>
                    <MovementChip movement={p.movement} />
                  </div>
                  <Link
                    href={`/dashboard/asins/${p.asin}`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Losers */}
        <div className="rounded-xl border border-red-500/20 bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="size-6 rounded-full bg-red-500/15 flex items-center justify-center">
              <TrendingDown className="size-3.5 text-red-400" />
            </div>
            <h2 className="font-semibold text-foreground">Biggest Drops</h2>
            <Badge
              variant="secondary"
              className="ml-auto text-[10px] bg-red-500/10 text-red-400 border border-red-500/20"
            >
              {losers.length} products
            </Badge>
          </div>

          {losers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {productsWithBsr.length === 0
                ? 'Click Refresh Data on an ASIN detail page to collect BSR data from Amazon Catalog.'
                : 'No drops detected yet.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {losers.map(p => (
                <div
                  key={p.asin}
                  className="flex items-center gap-3 rounded-lg bg-red-500/5 border border-red-500/10 px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.label}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1">
                        {p.asin}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-red-400">
                      #{p.bsr_rank!.toLocaleString('en-IN')}
                    </p>
                    <MovementChip movement={p.movement} />
                  </div>
                  <Link
                    href={`/dashboard/asins/${p.asin}`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── BSR Tracking Table ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">BSR Tracking Table</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              All tracked ASINs with rank movement
            </p>
          </div>
          <Badge variant="secondary" className="text-xs">
            {products.length} ASINs
          </Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs text-muted-foreground font-medium px-5 py-3">
                  Product
                </th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden md:table-cell">
                  Marketplace
                </th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden lg:table-cell">
                  Category
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3">
                  Current BSR
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3 hidden sm:table-cell">
                  Previous BSR
                </th>
                <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3">
                  Movement
                </th>
                <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3 hidden sm:table-cell">
                  Trend
                </th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden xl:table-cell">
                  Last Checked
                </th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden xl:table-cell">
                  Freshness
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium px-5 py-3">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {products.map(p => {
                const movement =
                  p.bsr_rank !== null && p.bsr_rank_prev !== null
                    ? p.bsr_rank_prev - p.bsr_rank
                    : null
                const isImproving = movement !== null && movement > 0
                const isDeclining = movement !== null && movement < 0

                return (
                  <tr key={p.asin} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-foreground text-sm leading-snug">
                          {p.label}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5 w-fit">
                          {p.asin}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <span className="text-xs text-muted-foreground">🇮🇳 {p.marketplace}</span>
                    </td>
                    <td className="px-4 py-3.5 hidden lg:table-cell">
                      {p.category ? (
                        <span className="text-xs text-muted-foreground truncate max-w-[160px] block">
                          {p.category}
                          {p.sub_category && (
                            <span className="text-muted-foreground/60"> · {p.sub_category}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {p.bsr_rank !== null ? (
                        <span className="font-semibold text-foreground tabular-nums">
                          #{p.bsr_rank.toLocaleString('en-IN')}
                        </span>
                      ) : (
                        (() => {
                          const state = deriveBsrState(p)
                          if (state === 'never_checked') {
                            return <Badge variant="secondary" className="text-[10px]">Never checked</Badge>
                          }
                          if (state === 'bsr_not_found') {
                            return <Badge className="text-[10px] bg-yellow-500/15 text-yellow-400 border-yellow-500/20">BSR not found</Badge>
                          }
                          return <Badge className="text-[10px] bg-red-500/15 text-red-400 border-red-500/20">Failed</Badge>
                        })()
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right hidden sm:table-cell">
                      {p.bsr_rank_prev !== null ? (
                        <span className="text-muted-foreground tabular-nums text-xs">
                          #{p.bsr_rank_prev.toLocaleString('en-IN')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <MovementChip movement={movement} />
                    </td>
                    <td className="px-4 py-3.5 text-center hidden sm:table-cell">
                      {isImproving ? (
                        <TrendingUp className="size-4 text-green-400 mx-auto" />
                      ) : isDeclining ? (
                        <TrendingDown className="size-4 text-red-400 mx-auto" />
                      ) : (
                        <Minus className="size-4 text-muted-foreground/40 mx-auto" />
                      )}
                    </td>
                    <td className="px-4 py-3.5 hidden xl:table-cell">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="size-3" />
                        {timeAgo(p.captured_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 hidden xl:table-cell">
                      <DataFreshnessBadge checkedAt={p.captured_at} />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        href={`/dashboard/asins/${p.asin}`}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors font-medium"
                      >
                        <ExternalLink className="size-3.5" />
                        <span className="hidden sm:inline">View Detail</span>
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Category Breakdown + Alerts ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Category Breakdown */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="size-4 text-primary shrink-0" />
            <h2 className="font-semibold text-foreground">Category Breakdown</h2>
          </div>

          {categoryBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Category data will appear after refreshing an ASIN.
            </p>
          ) : (
          <div className="flex flex-col gap-3">
            {categoryBreakdown.map(cat => (
              <div
                key={cat.category}
                className="rounded-lg border border-border bg-muted/20 p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{cat.category}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {cat.count} product{cat.count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  {cat.improving > 0 && (
                    <span className="text-[10px] font-medium text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 flex items-center gap-1 shrink-0">
                      <TrendingUp className="size-2.5" />
                      {cat.improving} improving
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md bg-muted/30 p-2.5">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Best BSR</p>
                    <p className="text-sm font-bold text-foreground">
                      {cat.bestBsr !== null
                        ? `#${cat.bestBsr.toLocaleString('en-IN')}`
                        : '—'}
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/30 p-2.5">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Avg BSR</p>
                    <p className="text-sm font-bold text-foreground">
                      {cat.avgBsr !== null
                        ? `#${cat.avgBsr.toLocaleString('en-IN')}`
                        : '—'}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-1.5">
                  {cat.products.map(p => (
                    <div key={p.asin} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate flex-1">
                        {p.label}
                      </span>
                      <span className="text-xs font-medium text-foreground shrink-0">
                        {p.bsr_rank !== null
                          ? `#${p.bsr_rank.toLocaleString('en-IN')}`
                          : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {products.filter(p => !p.category).length > 0 && (
              <div className="rounded-lg border border-dashed border-border bg-muted/10 p-4">
                <p className="text-sm font-medium text-muted-foreground">Uncategorised</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  {products.filter(p => !p.category).length} product(s) pending first scrape
                </p>
                <div className="mt-2 flex flex-col gap-1">
                  {products
                    .filter(p => !p.category)
                    .map(p => (
                      <div key={p.asin} className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground truncate flex-1">
                          {p.label}
                        </span>
                        <Badge variant="secondary" className="text-[9px]">
                          No Data
                        </Badge>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        {/* BSR Alerts — placeholder until alerts engine is built */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="size-4 text-primary shrink-0" />
            <h2 className="font-semibold text-foreground">BSR Alerts</h2>
            <Badge variant="secondary" className="ml-auto text-xs">
              Coming soon
            </Badge>
          </div>

          <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
            <Bell className="size-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground font-medium">Alert detection coming soon</p>
            <p className="text-xs text-muted-foreground/70 max-w-[260px]">
              Automatic BSR drop and rank gain alerts will notify you when significant changes occur.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
