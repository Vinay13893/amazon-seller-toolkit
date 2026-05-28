'use client'

import { useState, useEffect, useRef } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
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
  Plus,
  Store,
  BarChart2,
  Bell,
  AlertCircle,
} from 'lucide-react'
import {
  MOCK_BUYBOX_ENTRIES,
  MOCK_BUYBOX_HISTORY,
  MOCK_COMPETITORS,
  MOCK_BUYBOX_ALERTS,
  checkBuyBoxStatus,
  buyBoxHealthScore,
  healthLabel,
  healthColor,
  healthBg,
  type BuyBoxEntry,
  type CompetitorSeller,
  type BuyBoxAlert,
} from '@/lib/mock-buybox'

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BuyBoxEntry['status'] }) {
  if (status === 'won')
    return (
      <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-xs">Won</Badge>
    )
  if (status === 'lost')
    return <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">Lost</Badge>
  return (
    <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/20 text-xs">
      Suppressed
    </Badge>
  )
}

function FulfillmentBadge({ type }: { type: 'FBA' | 'FBM' | null | undefined }) {
  if (!type) return <span className="text-muted-foreground text-xs">—</span>
  return type === 'FBA' ? (
    <Badge className="bg-primary/15 text-primary border-primary/20 text-xs">FBA</Badge>
  ) : (
    <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/20 text-xs">FBM</Badge>
  )
}

function RiskBadge({ risk }: { risk: CompetitorSeller['risk'] }) {
  if (risk === 'low')
    return (
      <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-xs">Low</Badge>
    )
  if (risk === 'medium')
    return (
      <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/20 text-xs">
        Medium
      </Badge>
    )
  return <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">High</Badge>
}

function AlertRow({ alert }: { alert: BuyBoxAlert }) {
  const config = {
    error: { icon: XCircle, color: 'text-red-400', border: 'border-l-red-500' },
    warning: { icon: AlertTriangle, color: 'text-yellow-400', border: 'border-l-yellow-500' },
    success: { icon: CheckCircle2, color: 'text-green-400', border: 'border-l-green-500' },
    info: { icon: Info, color: 'text-blue-400', border: 'border-l-blue-500' },
  }[alert.severity]
  const Icon = config.icon
  return (
    <div
      className={cn(
        'flex gap-3 p-3 rounded-lg bg-card border border-border border-l-2',
        config.border,
      )}
    >
      <Icon className={cn('size-4 mt-0.5 flex-shrink-0', config.color)} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground leading-relaxed">{alert.message}</p>
        <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(alert.timestamp)}</p>
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
    you: 'You (Won)',
    competitor: 'Competitor',
    suppressed: 'Suppressed',
    unknown: 'Unknown',
  }
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">
        {hit ? (labels[hit.dataKey] ?? hit.dataKey) : 'No data'}
      </p>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function BuyboxPage() {
  const [asinInput, setAsinInput] = useState('')
  const [marketplace, setMarketplace] = useState<'amazon.in' | 'amazon.com'>('amazon.in')
  const [pincode, setPincode] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<BuyBoxEntry | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [selectedAsin, setSelectedAsin] = useState('B0BN5NZCGH')
  const [isMounted, setIsMounted] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  async function handleCheck(e: React.FormEvent) {
    e.preventDefault()
    if (!asinInput.trim()) return
    setIsChecking(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      const result = await checkBuyBoxStatus(
        asinInput.trim(),
        marketplace,
        pincode || undefined,
      )
      setCheckResult(result)
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Check failed')
    } finally {
      setIsChecking(false)
    }
  }

  const historyData = MOCK_BUYBOX_HISTORY[selectedAsin] ?? []
  const score = buyBoxHealthScore(MOCK_BUYBOX_ENTRIES)
  const hs = healthLabel(score)

  const totalAsins = MOCK_BUYBOX_ENTRIES.length
  const wonCount = MOCK_BUYBOX_ENTRIES.filter(e => e.status === 'won').length
  const lostCount = MOCK_BUYBOX_ENTRIES.filter(e => e.status === 'lost').length
  const suppressedCount = MOCK_BUYBOX_ENTRIES.filter(e => e.status === 'suppressed').length
  const unauthorizedCount = MOCK_COMPETITORS.filter(c => c.risk === 'high').length
  const activeCount = MOCK_BUYBOX_ENTRIES.filter(e => e.status !== 'suppressed').length
  const winRate = activeCount > 0 ? Math.round((wonCount / activeCount) * 100) : 0

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Buy Box Checker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track Buy Box ownership, seller changes, price differences and hijacker risk across
            your Amazon ASINs.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => formRef.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <Plus className="size-4" />
          Run Buy Box Check
        </Button>
      </div>

      {/* ── 2. KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Tracked" value={totalAsins} icon={Package} />
        <KpiCard
          label="Buy Box Won"
          value={wonCount}
          icon={ShieldCheck}
          sub="Active listings"
        />
        <KpiCard label="Buy Box Lost" value={lostCount} icon={ShieldAlert} />
        <KpiCard label="Suppressed" value={suppressedCount} icon={ShieldOff} />
        <KpiCard
          label="Unauthorized Sellers"
          value={unauthorizedCount}
          icon={AlertCircle}
          sub="High-risk detected"
        />
        <KpiCard
          label="BB Win Rate"
          value={`${winRate}%`}
          icon={BarChart2}
          sub="Active ASINs only"
        />
      </div>

      {/* ── 3. Check form + Health score ──────────────────────────────────── */}
      <div ref={formRef} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">Check Buy Box</h2>
          <form onSubmit={handleCheck} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bb-asin">ASIN</Label>
                <Input
                  id="bb-asin"
                  placeholder="e.g. B0BN5NZCGH"
                  value={asinInput}
                  onChange={e => setAsinInput(e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bb-marketplace">Marketplace</Label>
                <select
                  id="bb-marketplace"
                  value={marketplace}
                  onChange={e =>
                    setMarketplace(e.target.value as 'amazon.in' | 'amazon.com')
                  }
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="amazon.in">Amazon India</option>
                  <option value="amazon.com">Amazon US</option>
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 sm:w-1/2">
              <Label htmlFor="bb-pincode">Pincode (India only, optional)</Label>
              <Input
                id="bb-pincode"
                placeholder="e.g. 110001"
                value={pincode}
                onChange={e => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>
            <div>
              <Button type="submit" disabled={isChecking || !asinInput.trim()}>
                {isChecking ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" />
                    Checking…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-4" />
                    Check Buy Box
                  </>
                )}
              </Button>
            </div>
          </form>

          {/* Check result */}
          {checkResult && (
            <div className="mt-5 p-4 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Result for {checkResult.asin}
                  </p>
                  <p className="text-sm font-semibold text-foreground mt-0.5">
                    {checkResult.product_name}
                  </p>
                </div>
                <StatusBadge status={checkResult.status} />
              </div>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Owner
                  </p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.current_owner}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    BB Price
                  </p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.buybox_price != null ? `₹${checkResult.buybox_price}` : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Your Price
                  </p>
                  <p className="text-xs font-medium text-foreground mt-0.5">
                    {checkResult.your_price != null ? `₹${checkResult.your_price}` : '—'}
                  </p>
                </div>
              </div>
              {checkResult.price_gap != null && checkResult.price_gap > 0 && (
                <p className="mt-2 text-xs text-red-400">
                  You are ₹{checkResult.price_gap} more expensive than the current Buy Box
                  price.
                </p>
              )}
            </div>
          )}

          {checkError && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              {checkError}
            </div>
          )}
        </div>

        {/* Health score card */}
        <div
          className={cn(
            'bg-card border rounded-xl p-6 flex flex-col items-center justify-center gap-3 text-center',
            healthBg(hs),
          )}
        >
          <div className={cn('text-6xl font-black leading-none tabular-nums', healthColor(hs))}>
            {score}
          </div>
          <div>
            <p className={cn('text-sm font-semibold', healthColor(hs))}>{hs}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Buy Box Health Score</p>
          </div>
          <div className="w-full bg-border/50 rounded-full h-2 mt-1">
            <div
              className={cn('h-2 rounded-full transition-all duration-500', {
                'bg-green-400': hs === 'Healthy',
                'bg-yellow-400': hs === 'Warning',
                'bg-red-400': hs === 'Critical',
              })}
              style={{ width: `${score}%` }}
            />
          </div>
          <div className="flex w-full justify-between text-[10px] text-muted-foreground px-0.5">
            <span>0</span>
            <span>50</span>
            <span>80</span>
            <span>100</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
            {hs === 'Healthy' && 'You own the Buy Box on most tracked ASINs.'}
            {hs === 'Warning' && 'Some Buy Boxes are at risk. Review lost listings.'}
            {hs === 'Critical' && 'Critical: Most Buy Boxes lost. Immediate action needed.'}
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
            {wonCount} won · {lostCount} lost · {suppressedCount} suppressed
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                <th className="text-left px-6 py-3">Product</th>
                <th className="text-left px-4 py-3">ASIN</th>
                <th className="text-left px-4 py-3">Market</th>
                <th className="text-left px-4 py-3">Current Owner</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">BB Price</th>
                <th className="text-right px-4 py-3">Your Price</th>
                <th className="text-right px-4 py-3">Gap</th>
                <th className="text-left px-4 py-3">FBA/FBM</th>
                <th className="text-left px-4 py-3">Checked</th>
                <th className="text-center px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_BUYBOX_ENTRIES.map(entry => (
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
                    <span className="text-xs text-muted-foreground">{entry.marketplace}</span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-1.5">
                      {entry.owner_is_self ? (
                        <ShieldCheck className="size-3 text-green-400 flex-shrink-0" />
                      ) : (
                        <Store className="size-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="text-xs text-foreground truncate max-w-[120px]">
                        {entry.current_owner}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge status={entry.status} />
                  </td>
                  <td className="px-4 py-4 text-right">
                    <span className="text-xs text-foreground">
                      {entry.buybox_price != null ? `₹${entry.buybox_price}` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <span className="text-xs text-foreground">
                      {entry.your_price != null ? `₹${entry.your_price}` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {entry.price_gap != null && entry.price_gap !== 0 ? (
                      <span
                        className={cn(
                          'text-xs font-medium',
                          entry.price_gap > 0 ? 'text-red-400' : 'text-green-400',
                        )}
                      >
                        {entry.price_gap > 0
                          ? `+₹${entry.price_gap}`
                          : `-₹${Math.abs(entry.price_gap)}`}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {entry.price_gap === 0 ? 'Even' : '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <FulfillmentBadge type={entry.fulfillment} />
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(entry.last_checked)}
                    </span>
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
      </div>

      {/* ── 5. History chart ──────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Buy Box Ownership — Last 7 Days
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Daily ownership status per ASIN
            </p>
          </div>
          <select
            value={selectedAsin}
            onChange={e => setSelectedAsin(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {MOCK_BUYBOX_ENTRIES.map(e => (
              <option key={e.asin} value={e.asin}>
                {e.asin} — {e.product_name.split('(')[0].trim()}
              </option>
            ))}
          </select>
        </div>

        {/* Legend */}
        <div className="flex gap-4 mb-4 flex-wrap">
          {[
            { key: 'you', label: 'You', color: 'bg-[oklch(0.741_0.174_66.5)]' },
            { key: 'competitor', label: 'Competitor', color: 'bg-slate-500' },
            { key: 'suppressed', label: 'Suppressed', color: 'bg-red-500' },
            { key: 'unknown', label: 'Unknown', color: 'bg-zinc-600' },
          ].map(item => (
            <div key={item.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <div className={cn('w-3 h-3 rounded-sm', item.color)} />
              {item.label}
            </div>
          ))}
        </div>

        {isMounted ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={historyData} barSize={36} barGap={0}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="oklch(0.25 0.015 265)"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'oklch(0.55 0.015 265)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip content={<HistoryTooltip />} />
              <Bar dataKey="you" stackId="a" fill="oklch(0.741 0.174 66.5)" />
              <Bar dataKey="competitor" stackId="a" fill="rgb(100,116,139)" />
              <Bar dataKey="suppressed" stackId="a" fill="rgb(239,68,68)" />
              <Bar
                dataKey="unknown"
                stackId="a"
                fill="rgb(82,82,91)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[200px] bg-border/20 rounded-lg animate-pulse" />
        )}
      </div>

      {/* ── 6 & 7. Seller competition + Alerts ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Seller competition */}
        <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Seller Competition</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {MOCK_COMPETITORS.length} competitors detected across your ASINs
            </p>
          </div>
          <div className="divide-y divide-border">
            {MOCK_COMPETITORS.map(seller => (
              <div key={seller.id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Store className="size-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-semibold text-foreground truncate">
                      {seller.name}
                    </span>
                  </div>
                  <RiskBadge risk={seller.risk} />
                </div>
                <div className="flex items-center gap-4 mt-2">
                  <span className="text-[11px] text-muted-foreground">
                    {seller.asin_count} ASIN{seller.asin_count > 1 ? 's' : ''}
                  </span>
                  <FulfillmentBadge type={seller.fulfillment} />
                  <span
                    className={cn(
                      'text-[11px] font-medium',
                      seller.price_advantage < 0 ? 'text-red-400' : 'text-green-400',
                    )}
                  >
                    {seller.price_advantage < 0
                      ? `₹${Math.abs(seller.price_advantage)} cheaper`
                      : `₹${seller.price_advantage} pricier`}
                  </span>
                </div>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {seller.asins.map(a => (
                    <Link
                      key={a}
                      href={`/dashboard/asins/${a}`}
                      className="font-mono text-[10px] text-primary/70 hover:text-primary hover:underline"
                    >
                      {a}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Alerts */}
        <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Alerts</h2>
            </div>
            <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">
              {MOCK_BUYBOX_ALERTS.filter(a => a.severity === 'error').length} critical
            </Badge>
          </div>
          <div className="p-4 flex flex-col gap-2 max-h-[420px] overflow-y-auto">
            {MOCK_BUYBOX_ALERTS.map(alert => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
