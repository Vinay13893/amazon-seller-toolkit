'use client'

import { useState, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/dashboard/KpiCard'
import {
  CITY_PRESETS,
  MOCK_PINCODE_RESULTS,
  PINCODE_ALERTS,
  parsePincodes,
  availabilityScore,
  scoreToStatus,
  checkAsinPincodeAvailability,
  type PincodeResult,
  type PincodeAlert,
  type AvailabilityStatus,
} from '@/lib/mock-pincode'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  MapPin,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Clock,
  Truck,
  IndianRupee,
  ShieldCheck,
  ShieldAlert,
  BarChart2,
  Play,
  RefreshCw,
  ExternalLink,
  Bell,
} from 'lucide-react'


// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AvailabilityStatus }) {
  const map = {
    healthy:  { label: 'Healthy',  cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
    warning:  { label: 'Warning',  cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    critical: { label: 'Critical', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  }
  const { label, cls } = map[status]
  return (
    <span className={cn('inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 border', cls)}>
      {label}
    </span>
  )
}

function FulfillmentBadge({ type }: { type: 'FBA' | 'FBM' | null }) {
  if (!type) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className={cn(
      'inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5',
      type === 'FBA'
        ? 'bg-primary/15 text-primary'
        : 'bg-muted text-muted-foreground',
    )}>
      {type}
    </span>
  )
}

function StockBadge({ status }: { status: 'in_stock' | 'limited' | 'oos' | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>
  const map = {
    in_stock: { label: 'In Stock',  cls: 'text-green-400' },
    limited:  { label: 'Limited',   cls: 'text-yellow-400' },
    oos:      { label: 'Out of Stock', cls: 'text-red-400' },
  }
  const { label, cls } = map[status]
  return <span className={cn('text-xs font-medium', cls)}>{label}</span>
}

function AlertRow({ alert }: { alert: PincodeAlert }) {
  const iconMap = {
    success: <CheckCircle2 className="size-3.5 shrink-0 text-green-400" />,
    warning: <AlertTriangle className="size-3.5 shrink-0 text-yellow-400" />,
    error:   <XCircle       className="size-3.5 shrink-0 text-red-400" />,
    info:    <Info          className="size-3.5 shrink-0 text-blue-400" />,
  }
  const bgMap = {
    success: 'border-green-500/20 bg-green-500/5',
    warning: 'border-yellow-500/20 bg-yellow-500/5',
    error:   'border-red-500/20 bg-red-500/5',
    info:    'border-blue-500/20 bg-blue-500/5',
  }
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5', bgMap[alert.severity])}>
      <div className="mt-0.5">{iconMap[alert.severity]}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{alert.city}</span>
          {alert.pincode && (
            <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1">
              {alert.pincode}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">{alert.message}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1 flex items-center gap-1">
          <Clock className="size-2.5" />{timeAgo(alert.timestamp)}
        </p>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PincodePage() {
  const formRef = useRef<HTMLDivElement>(null)

  // Form state
  const [asin, setAsin] = useState('B0BN5NZCGH')
  const [selectedCities, setSelectedCities] = useState<Set<string>>(
    () => new Set(CITY_PRESETS.map(c => c.city)),
  )
  const [pincodeText, setPincodeText] = useState(
    () => CITY_PRESETS.flatMap(c => c.pincodes).join('\n'),
  )
  const [isChecking, setIsChecking] = useState(false)
  const [results, setResults] = useState<PincodeResult[]>(MOCK_PINCODE_RESULTS)
  const [checkedAsin, setCheckedAsin] = useState('B0BN5NZCGH')

  // Toggle a city preset on/off, syncing pincodes to textarea
  function toggleCity(city: string) {
    const next = new Set(selectedCities)
    if (next.has(city)) {
      next.delete(city)
    } else {
      next.add(city)
    }
    setSelectedCities(next)
    const pins = CITY_PRESETS
      .filter(cp => next.has(cp.city))
      .flatMap(cp => cp.pincodes)
    setPincodeText(pins.join('\n'))
  }

  // Run availability check (uses integration placeholder — returns mock data)
  async function handleCheck() {
    const pincodes = parsePincodes(pincodeText)
    if (!pincodes.length) return
    setIsChecking(true)
    try {
      const data = await checkAsinPincodeAvailability(asin, pincodes)
      setResults(data)
      setCheckedAsin(asin)
    } finally {
      setIsChecking(false)
    }
  }

  function handleRunNew() {
    formRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const available   = useMemo(() => results.filter(r => r.available), [results])
  const unavailable = useMemo(() => results.filter(r => !r.available), [results])
  const score       = useMemo(() => availabilityScore(results), [results])

  const avgDeliveryDays = useMemo(() => {
    const days = available.map(r => r.delivery_days).filter((d): d is number => d !== null)
    if (!days.length) return null
    return (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1)
  }, [available])

  const buyboxConsistency = useMemo(() => {
    if (!available.length) return null
    const selfCount = available.filter(r => r.buybox_is_self).length
    return Math.round((selfCount / available.length) * 100)
  }, [available])

  const cityBreakdown = useMemo(() => {
    return CITY_PRESETS.map(cp => {
      const rows = results.filter(r => r.city === cp.city)
      const avail = rows.filter(r => r.available)
      const pct   = rows.length ? Math.round((avail.length / rows.length) * 100) : 0
      const prices = avail.map(r => r.price).filter((p): p is number => p !== null)
      const hasMismatch = prices.length > 1 && new Set(prices).size > 1
      const hasSeller   = avail.some(r => !r.buybox_is_self)
      const fastest     = avail.reduce<number | null>((best, r) => {
        if (r.delivery_days === null) return best
        return best === null ? r.delivery_days : Math.min(best, r.delivery_days)
      }, null)
      const sellers = avail.map(r => r.buybox_seller).filter(Boolean)
      const primarySeller = sellers.length
        ? (sellers.sort((a, b) =>
            sellers.filter(s => s === b).length - sellers.filter(s => s === a).length
          )[0] ?? null)
        : null
      const status = scoreToStatus(
        hasMismatch || hasSeller ? Math.min(pct, 79) : pct,
      )
      return { city: cp.city, rows, avail, pct, fastest, primarySeller, hasMismatch, status }
    })
  }, [results])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pincode Availability Checker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Check product availability, delivery promise, Buy Box owner and pricing across Indian pincodes.
          </p>
        </div>
        <Button type="button" onClick={handleRunNew} className="gap-2 shrink-0">
          <Play className="size-4" />
          Run New Check
        </Button>
      </div>

      {/* ── Check form ─────────────────────────────────────────────────────── */}
      <div ref={formRef} className="rounded-xl border border-border bg-card p-5 space-y-5">
        <h2 className="font-semibold text-foreground">Configure Check</h2>

        {/* Row 1: ASIN + Marketplace */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">ASIN</label>
            <input
              type="text"
              value={asin}
              onChange={e => setAsin(e.target.value.toUpperCase().trim())}
              placeholder="e.g. B0BN5NZCGH"
              maxLength={10}
              className="text-sm bg-muted/50 border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Marketplace</label>
            <select
              className="text-sm bg-muted/50 border border-border rounded-md px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              defaultValue="IN"
            >
              <option value="IN">🇮🇳 Amazon India (amazon.in)</option>
              <option value="US" disabled>🇺🇸 Amazon US (coming soon)</option>
            </select>
          </div>
        </div>

        {/* Row 2: City presets */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Preset Cities</label>
          <div className="flex flex-wrap gap-2">
            {CITY_PRESETS.map(cp => (
              <button
                key={cp.city}
                type="button"
                onClick={() => toggleCity(cp.city)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                  selectedCities.has(cp.city)
                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                    : 'bg-muted/40 text-muted-foreground border-border hover:border-primary/40 hover:text-foreground',
                )}
              >
                {cp.city}
              </button>
            ))}
          </div>
        </div>

        {/* Row 3: Pincodes textarea + Check button */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-end">
          <div className="lg:col-span-2 flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Pincodes{' '}
              <span className="text-muted-foreground/60">
                ({parsePincodes(pincodeText).length} entered)
              </span>
            </label>
            <textarea
              value={pincodeText}
              onChange={e => setPincodeText(e.target.value)}
              placeholder="One 6-digit pincode per line&#10;110001&#10;400001&#10;560001"
              rows={4}
              className="text-sm bg-muted/50 border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-none"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              onClick={handleCheck}
              disabled={isChecking || parsePincodes(pincodeText).length === 0}
              className="w-full gap-2"
            >
              {isChecking ? (
                <><RefreshCw className="size-4 animate-spin" /> Checking…</>
              ) : (
                <><Play className="size-4" /> Check Availability</>
              )}
            </Button>
            <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
              Demo mode — using mock data for {checkedAsin}
            </p>
          </div>
        </div>
      </div>

      {/* ── Summary KPI cards ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard
          label="Total Pincodes"
          value={String(results.length)}
          sub="pincodes checked"
          icon={MapPin}
        />
        <KpiCard
          label="Available"
          value={String(available.length)}
          sub={`of ${results.length} pincodes`}
          icon={CheckCircle2}
          trend={available.length === results.length ? { value: -1, label: '100% coverage' } : undefined}
        />
        <KpiCard
          label="Unavailable"
          value={String(unavailable.length)}
          sub="pincodes out of stock"
          icon={XCircle}
          trend={unavailable.length > 0 ? { value: unavailable.length, label: 'need attention' } : undefined}
        />
        <KpiCard
          label="Avg Delivery"
          value={avgDeliveryDays !== null ? `${avgDeliveryDays}d` : '—'}
          sub="avg delivery time"
          icon={Truck}
        />
        <KpiCard
          label="Buy Box"
          value={buyboxConsistency !== null ? `${buyboxConsistency}%` : '—'}
          sub="pincodes you own"
          icon={ShieldCheck}
          trend={
            buyboxConsistency !== null
              ? { value: buyboxConsistency >= 80 ? -1 : 1, label: `${buyboxConsistency}% self` }
              : undefined
          }
        />
        <KpiCard
          label="Availability Score"
          value={`${score}%`}
          sub={scoreToStatus(score) === 'healthy' ? 'Healthy' : scoreToStatus(score) === 'warning' ? 'Warning' : 'Critical'}
          icon={BarChart2}
          trend={{ value: score >= 80 ? -1 : 1, label: `${score}% score` }}
        />
      </div>

      {/* ── City-wise cards ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="font-semibold text-foreground mb-4">City-wise Overview</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {cityBreakdown.map(c => (
            <div
              key={c.city}
              className={cn(
                'rounded-xl border bg-card p-4 flex flex-col gap-3',
                c.status === 'healthy'  && 'border-border',
                c.status === 'warning'  && 'border-yellow-500/30',
                c.status === 'critical' && 'border-red-500/30',
              )}
            >
              {/* City header */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MapPin className="size-3.5 text-primary shrink-0" />
                  <span className="text-sm font-semibold text-foreground">{c.city}</span>
                </div>
                <StatusBadge status={c.status} />
              </div>

              {/* Availability bar */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">Availability</span>
                  <span className={cn(
                    'text-xs font-bold',
                    c.pct >= 80 ? 'text-green-400' : c.pct >= 50 ? 'text-yellow-400' : 'text-red-400',
                  )}>
                    {c.pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      c.pct >= 80 ? 'bg-green-500' : c.pct >= 50 ? 'bg-yellow-500' : 'bg-red-500',
                    )}
                    style={{ width: `${c.pct}%` }}
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="flex flex-col gap-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Truck className="size-3" /> Fastest
                  </span>
                  <span className="text-foreground font-medium">
                    {c.fastest !== null ? `${c.fastest}d` : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <IndianRupee className="size-3" /> Price
                  </span>
                  <span className={cn('font-medium', c.hasMismatch ? 'text-yellow-400' : 'text-foreground')}>
                    {c.avail[0]?.price ? `₹${c.avail[0].price.toLocaleString('en-IN')}` : '—'}
                    {c.hasMismatch && ' ⚠️'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1">
                    {c.avail.every(r => r.buybox_is_self)
                      ? <ShieldCheck className="size-3 text-green-400" />
                      : <ShieldAlert className="size-3 text-yellow-400" />}
                    Buy Box
                  </span>
                  <span className="text-foreground font-medium truncate max-w-[100px] text-right">
                    {c.primarySeller ?? '—'}
                  </span>
                </div>
              </div>

              {/* Pincode count */}
              <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                <span className="text-[10px] text-muted-foreground">
                  {c.avail.length}/{c.rows.length} pincodes available
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Results table ───────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">Pincode Results</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Full availability breakdown — {checkedAsin}
            </p>
          </div>
          <Badge variant="secondary" className="text-xs">{results.length} pincodes</Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs text-muted-foreground font-medium px-5 py-3">City</th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3">Pincode</th>
                <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3">Availability</th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden md:table-cell">Delivery</th>
                <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3 hidden sm:table-cell">Price</th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden lg:table-cell">Buy Box Seller</th>
                <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3 hidden md:table-cell">FBA/FBM</th>
                <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3 hidden sm:table-cell">Stock</th>
                <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 hidden xl:table-cell">Checked</th>
                <th className="text-right text-xs text-muted-foreground font-medium px-5 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {results.map(r => (
                <tr key={`${r.city}-${r.pincode}`} className="hover:bg-muted/20 transition-colors">
                  <td className="px-5 py-3 text-sm font-medium text-foreground">{r.city}</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-foreground bg-muted/50 rounded px-1.5 py-0.5">
                      {r.pincode}
                    </span>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{r.state}</p>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {r.available ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400 font-medium">
                        <CheckCircle2 className="size-3.5" /> Available
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-red-400 font-medium">
                        <XCircle className="size-3.5" /> Unavailable
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={cn(
                      'text-xs',
                      r.delivery_days && r.delivery_days >= 4 ? 'text-yellow-400' : 'text-foreground',
                    )}>
                      {r.delivery_promise ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell">
                    {r.price !== null ? (
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        ₹{r.price.toLocaleString('en-IN')}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {r.buybox_seller ? (
                      <div className="flex items-center gap-1.5">
                        {r.buybox_is_self
                          ? <ShieldCheck className="size-3.5 text-green-400 shrink-0" />
                          : <ShieldAlert className="size-3.5 text-yellow-400 shrink-0" />}
                        <span className="text-xs text-foreground truncate max-w-[120px]">
                          {r.buybox_seller}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center hidden md:table-cell">
                    <FulfillmentBadge type={r.fulfillment} />
                  </td>
                  <td className="px-4 py-3 text-center hidden sm:table-cell">
                    <StockBadge status={r.stock_status} />
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="size-3" />{timeAgo(r.checked_at)}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/dashboard/asins/B0BN5NZCGH`}
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

      {/* ── Alerts ─────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="size-4 text-primary shrink-0" />
          <h2 className="font-semibold text-foreground">Pincode Alerts</h2>
          <Badge variant="secondary" className="ml-auto text-xs">{PINCODE_ALERTS.length}</Badge>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {PINCODE_ALERTS.map(alert => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </div>
      </div>
    </div>
  )
}
