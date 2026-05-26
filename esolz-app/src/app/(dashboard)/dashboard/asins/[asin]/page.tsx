'use client'

import { use, useMemo, useState, useEffect } from 'react'
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
import { MOCK_PRODUCT_SNAPSHOTS } from '@/lib/mock-data'
import {
  generateBsrHistory,
  generatePriceHistory,
  generateBuyBoxHistory,
  getMockKeywords,
  getMockAlerts,
  MOCK_PINCODES,
  type BuyBoxPoint,
  type KeywordRank,
  type PincodeData,
  type AsinAlert,
} from '@/lib/mock-asin-detail'
import { formatPrice, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
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
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Rank</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground hidden sm:table-cell">Previous</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground hidden md:table-cell">Search Vol.</th>
            <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Trend</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className="py-3 text-foreground font-medium">{kw.keyword}</td>
              <td className="py-3 text-right font-mono font-semibold text-foreground">
                {kw.rank !== null ? `#${kw.rank}` : '—'}
              </td>
              <td className="py-3 text-right text-muted-foreground font-mono text-xs hidden sm:table-cell">
                {kw.prev_rank !== null ? `#${kw.prev_rank}` : '—'}
              </td>
              <td className="py-3 text-right text-muted-foreground text-xs hidden md:table-cell">
                {kw.search_volume.toLocaleString('en-IN')}
              </td>
              <td className="py-3 text-center">
                {kw.trend === 'up' && (
                  <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                    <TrendingUp className="size-3" />↑
                  </span>
                )}
                {kw.trend === 'down' && (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                    <TrendingDown className="size-3" />↓
                  </span>
                )}
                {kw.trend === 'flat' && (
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

// ─── Pincodes table ───────────────────────────────────────────────────────────

function PincodesTable({ pincodes }: { pincodes: PincodeData[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Pincode</th>
            <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">City</th>
            <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hidden sm:table-cell">State</th>
            <th className="pb-3 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
            <th className="pb-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Delivery</th>
          </tr>
        </thead>
        <tbody>
          {pincodes.map((p, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className="py-3 font-mono text-xs text-foreground">{p.pincode}</td>
              <td className="py-3 text-foreground">{p.city}</td>
              <td className="py-3 text-muted-foreground hidden sm:table-cell">{p.state}</td>
              <td className="py-3 text-center">
                {p.available ? (
                  <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                    <Check className="size-3" />Available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                    <X className="size-3" />Unavailable
                  </span>
                )}
              </td>
              <td className="py-3 text-right text-sm text-muted-foreground">
                {p.available && p.delivery_days ? `${p.delivery_days} days` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AsinDetailPage({ params }: { params: Promise<{ asin: string }> }) {
  const { asin } = use(params)

  const product = useMemo(
    () => MOCK_PRODUCT_SNAPSHOTS.find(p => p.asin === asin) ?? null,
    [asin],
  )

  const bsrHistory   = useMemo(() => generateBsrHistory(asin, product?.bsr_rank ?? null),       [asin, product?.bsr_rank])
  const priceHistory = useMemo(() => generatePriceHistory(asin, product?.price ?? null),         [asin, product?.price])
  const buyboxHist   = useMemo(() => generateBuyBoxHistory(product?.buybox_is_self ?? null, product?.buybox_winner ?? null), [product?.buybox_is_self, product?.buybox_winner])
  const keywords     = useMemo(() => getMockKeywords(asin),  [asin])
  const alerts       = useMemo(() => getMockAlerts(asin),    [asin])

  const [bsrRange,   setBsrRange]   = useState<7 | 14 | 30>(30)
  const [priceRange, setPriceRange] = useState<7 | 14 | 30>(30)
  const [mounted,    setMounted]    = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // ── Not found ──────────────────────────────────────────────────────────────
  if (!product) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <Package className="size-12 text-muted-foreground/30" />
        <h1 className="text-lg font-semibold text-foreground">ASIN not found</h1>
        <p className="text-sm text-muted-foreground">No product data for <span className="font-mono text-primary">{asin}</span></p>
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
  const bsrDisplay = product.bsr_rank !== null ? `#${product.bsr_rank.toLocaleString('en-IN')}` : '—'

  const buyboxValue = product.buybox_is_self === true
    ? 'You ✓'
    : product.buybox_is_self === false
      ? (product.buybox_winner ?? 'Competitor') + ' ✗'
      : '—'

  const availLabel = product.availability === 'in_stock'
    ? 'In Stock'
    : product.availability === 'limited'
      ? 'Limited Stock'
      : product.availability === 'out_of_stock'
        ? 'Out of Stock'
        : '—'

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
            <div className="size-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Package className="size-6 text-primary" />
            </div>
            <div className="min-w-0">
              {/* Chips row */}
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="font-mono text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-md">
                  {asin}
                </span>
                <Badge variant="outline" className="text-xs h-5 px-1.5">
                  {product.marketplace}
                </Badge>
                <span className={cn('flex items-center gap-1 text-xs font-medium', product.is_active ? 'text-green-400' : 'text-muted-foreground')}>
                  <span className={cn('size-1.5 rounded-full', product.is_active ? 'bg-green-400' : 'bg-muted-foreground')} />
                  {product.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              {/* Title */}
              <h1 className="text-xl font-bold text-foreground leading-snug mb-1">
                {product.label}
              </h1>
              {/* Category breadcrumb */}
              {product.category && (
                <p className="text-sm text-muted-foreground">
                  {product.category}
                  {product.sub_category && <> › <span className="text-foreground/70">{product.sub_category}</span></>}
                </p>
              )}
            </div>
          </div>
          {/* Last checked */}
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-0.5">Last checked</p>
            <p className="text-sm font-medium text-foreground">{timeAgo(product.captured_at)}</p>
          </div>
        </div>
      </div>

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Current BSR"
          value={bsrDisplay}
          sub={product.category ?? undefined}
          icon={TrendingDown}
          trend={bsrChange !== null ? { value: bsrChange, label: 'from yesterday' } : undefined}
        />
        <KpiCard
          label="Sub-Category Rank"
          value={product.sub_rank !== null ? `#${product.sub_rank}` : '—'}
          sub={product.sub_category ?? undefined}
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
          sub={product.review_count !== null ? `${product.review_count.toLocaleString('en-IN')} reviews` : undefined}
          icon={Star}
        />
        <KpiCard
          label="Buy Box"
          value={buyboxValue}
          sub={product.buybox_is_self === false ? `Owned by ${product.buybox_winner ?? 'competitor'}` : product.buybox_is_self === true ? 'You own it' : 'No data'}
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
                <p className="text-xs text-muted-foreground mt-0.5">Rank trend — lower is better</p>
              </div>
              <RangeToggle value={bsrRange} onChange={setBsrRange} />
            </div>
            {mounted ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={bsrHistory.slice(-bsrRange)}
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
            ) : (
              <ChartSkeleton />
            )}
          </div>

          {/* Price History */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
              <div>
                <h2 className="font-semibold text-foreground">Price History</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Listed price over time</p>
              </div>
              <RangeToggle value={priceRange} onChange={setPriceRange} />
            </div>
            {mounted ? (
              priceHistory.length === 0 ? (
                <div className="h-[220px] flex flex-col items-center justify-center gap-2">
                  <IndianRupee className="size-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No price data collected yet</p>
                </div>
              ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={priceHistory.slice(-priceRange)}
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
            <BuyBoxTimeline history={buyboxHist} />
          </div>

          {/* Alerts */}
          <div className="rounded-xl border border-border bg-card p-5 flex-1">
            <div className="flex items-center gap-2 mb-4">
              <Bell className="size-4 text-primary shrink-0" />
              <h2 className="font-semibold text-foreground">Recent Alerts</h2>
            </div>
            <div className="flex flex-col gap-2">
              {alerts.map(a => (
                <AlertItem key={a.id} alert={a} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Keyword rank snapshot ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-5">
          <TrendingUp className="size-4 text-primary shrink-0" />
          <div>
            <h2 className="font-semibold text-foreground">Keyword Rank Snapshot</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Organic search position on Amazon India</p>
          </div>
        </div>
        <KeywordsTable keywords={keywords} />
      </div>

      {/* ── Pincode availability ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-5">
          <MapPin className="size-4 text-primary shrink-0" />
          <div>
            <h2 className="font-semibold text-foreground">Pincode Availability</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Product availability across tracked pincodes</p>
          </div>
        </div>
        <PincodesTable pincodes={MOCK_PINCODES} />
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
