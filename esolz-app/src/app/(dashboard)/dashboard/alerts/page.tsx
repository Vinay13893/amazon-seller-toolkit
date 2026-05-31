'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  Bell,
  BellOff,
  XCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Search,
  ExternalLink,
  Eye,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ShoppingCart,
  BarChart2,
  Tag,
  MapPin,
  DollarSign,
  Star,
  Users,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import {
  type CenterAlert,
  type AlertSeverity,
  type AlertModule,
  type AlertStatus,
} from '@/lib/mock-alerts'

// ─── Module meta ──────────────────────────────────────────────────────────────

const MODULE_LABELS: Record<AlertModule, string> = {
  buybox: 'Buy Box',
  bsr: 'BSR',
  keywords: 'Keywords',
  pincode: 'Pincode',
  price: 'Price',
  reviews: 'Reviews',
  competitor: 'Competitor',
}

const MODULE_ICONS: Record<AlertModule, React.ComponentType<{ className?: string }>> = {
  buybox: ShoppingCart,
  bsr: BarChart2,
  keywords: Tag,
  pincode: MapPin,
  price: DollarSign,
  reviews: Star,
  competitor: Users,
}

const MODULE_COLORS: Record<AlertModule, string> = {
  buybox: 'text-primary bg-primary/10',
  bsr: 'text-blue-400 bg-blue-500/10',
  keywords: 'text-purple-400 bg-purple-500/10',
  pincode: 'text-cyan-400 bg-cyan-500/10',
  price: 'text-yellow-400 bg-yellow-500/10',
  reviews: 'text-orange-400 bg-orange-500/10',
  competitor: 'text-pink-400 bg-pink-500/10',
}

const WHY_IT_MATTERS: Record<AlertModule, string> = {
  bsr: 'BSR is the key indicator of your sales velocity relative to competitors. A worsening rank means fewer organic sales.',
  buybox: 'Buy Box ownership drives ~82% of Amazon sales. Any change directly impacts your conversion and revenue.',
  pincode: 'Product unavailability in key pincodes means lost sales and lower customer satisfaction scores.',
  keywords: 'Keyword rankings determine organic visibility. Page 1 rankings are critical for discoverability.',
  price: 'Pricing changes affect Buy Box eligibility, customer conversion, and overall margins.',
  reviews: 'Review count and star rating are core ranking signals and directly affect customer trust.',
  competitor: 'Competitor actions can erode your market share, rankings, and keyword positioning.',
}

// ─── DB alert shape (from join) ───────────────────────────────────────────────

interface RawDbAlert {
  id:                string
  workspace_id:      string
  tracked_asin_id:   string | null
  title:             string
  description:       string | null
  severity:          AlertSeverity
  module:            AlertModule
  status:            AlertStatus
  recommended_action: string | null
  created_at:        string
  tracked_asins:     {
    asin:          string
    product_title: string | null
    marketplace:   string
  } | null
}

function mapDbAlert(r: RawDbAlert): CenterAlert {
  const asn = r.tracked_asins
  return {
    id:                 r.id,
    title:              r.title,
    description:        r.description ?? '',
    severity:           r.severity,
    module:             r.module,
    status:             r.status,
    marketplace:        'amazon.in',
    asin:               asn?.asin ?? '—',
    product_name:       asn?.product_title ?? 'Unknown Product',
    timestamp:          r.created_at,
    recommended_action: r.recommended_action ?? '',
    what_happened:      r.description ?? r.title,
    why_it_matters:     WHY_IT_MATTERS[r.module] ?? 'This change may impact your sales.',
    metric:             undefined,
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const map: Record<AlertSeverity, { icon: React.ComponentType<{ className?: string }>; cls: string; label: string }> = {
    critical:    { icon: XCircle,       cls: 'bg-red-500/15 text-red-400 border-red-500/25',       label: 'Critical' },
    warning:     { icon: AlertTriangle, cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25', label: 'Warning' },
    opportunity: { icon: CheckCircle2,  cls: 'bg-green-500/15 text-green-400 border-green-500/25', label: 'Opportunity' },
    info:        { icon: Info,          cls: 'bg-blue-500/15 text-blue-400 border-blue-500/25',    label: 'Info' },
  }
  const { icon: Icon, cls, label } = map[severity]
  return (
    <Badge className={cn('inline-flex items-center gap-1 text-xs font-medium', cls)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  )
}

function ModuleBadge({ module: mod }: { module: AlertModule }) {
  const Icon  = MODULE_ICONS[mod]
  const color = MODULE_COLORS[mod]
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full', color)}>
      <Icon className="size-3" />
      {MODULE_LABELS[mod]}
    </span>
  )
}

function StatusDot({ status }: { status: AlertStatus }) {
  return (
    <span className={cn(
      'inline-block size-2 rounded-full flex-shrink-0',
      status === 'new' ? 'bg-primary' : status === 'read' ? 'bg-border' : 'bg-green-500',
    )} />
  )
}

function AlertRow({
  alert,
  expanded,
  onToggle,
  onMarkRead,
  onResolve,
}: {
  alert:      CenterAlert
  expanded:   boolean
  onToggle:   () => void
  onMarkRead: (id: string) => void
  onResolve:  (id: string) => void
}) {
  const severityBorderColor: Record<AlertSeverity, string> = {
    critical:    'border-l-red-500',
    warning:     'border-l-yellow-500',
    opportunity: 'border-l-green-500',
    info:        'border-l-blue-500',
  }

  return (
    <div className={cn(
      'border border-border border-l-2 rounded-xl overflow-hidden transition-colors',
      severityBorderColor[alert.severity],
      alert.status === 'resolved' && 'opacity-60',
    )}>
      {/* Main row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-4 hover:bg-border/10 transition-colors"
      >
        <div className="flex items-start gap-3">
          <StatusDot status={alert.status} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-foreground">{alert.title}</span>
                <SeverityBadge severity={alert.severity} />
                <ModuleBadge module={alert.module} />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-muted-foreground">{timeAgo(alert.timestamp)}</span>
                {expanded
                  ? <ChevronUp className="size-4 text-muted-foreground" />
                  : <ChevronDown className="size-4 text-muted-foreground" />}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{alert.description}</p>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {alert.asin !== '—' && (
                <span className="font-mono text-[11px] text-muted-foreground/70">{alert.asin}</span>
              )}
              <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                {alert.product_name}
              </span>
              <span className="text-[11px] text-muted-foreground">{alert.marketplace}</span>
            </div>
          </div>
        </div>
      </button>

      {/* Expandable detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border bg-muted/10">
          <div className="pt-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Left: what/why/action */}
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  What Happened
                </p>
                <p className="text-xs text-foreground leading-relaxed">{alert.what_happened}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  Why It Matters
                </p>
                <p className="text-xs text-foreground leading-relaxed">{alert.why_it_matters}</p>
              </div>
              <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                <p className="text-[11px] font-semibold text-primary uppercase tracking-wider mb-1">
                  Recommended Action
                </p>
                <p className="text-xs text-foreground leading-relaxed">{alert.recommended_action}</p>
              </div>
            </div>
            {/* Right: actions */}
            <div className="flex flex-col gap-3">
              {alert.metric && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {alert.metric.label}
                  </p>
                  <div className="flex items-center gap-3 text-xs">
                    <div className="flex flex-col items-center">
                      <span className="text-[10px] text-muted-foreground mb-1">Before</span>
                      <span className="font-mono font-semibold text-muted-foreground">{alert.metric.before}</span>
                    </div>
                    <span className="text-muted-foreground/40">→</span>
                    <div className="flex flex-col items-center">
                      <span className="text-[10px] text-muted-foreground mb-1">After</span>
                      <span className="font-mono font-semibold text-foreground">{alert.metric.after}</span>
                    </div>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {alert.asin !== '—' && (
                  <Link href={`/dashboard/asins/${alert.asin}`}>
                    <Button type="button" variant="outline" size="sm">
                      <ExternalLink className="size-3" />
                      View ASIN
                    </Button>
                  </Link>
                )}
                {alert.status !== 'read' && alert.status !== 'resolved' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={e => { e.stopPropagation(); onMarkRead(alert.id) }}
                  >
                    <Eye className="size-3" />
                    Mark Read
                  </Button>
                )}
                {alert.status !== 'resolved' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={e => { e.stopPropagation(); onResolve(alert.id) }}
                  >
                    <CheckCheck className="size-3" />
                    Resolve
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Filter pill ───────────────────────────────────────────────────────────────

function FilterPill<T extends string>({
  value,
  selected,
  onClick,
  label,
}: {
  value:    T
  selected: boolean
  onClick:  (v: T) => void
  label:    string
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        'px-3 py-1.5 rounded-full text-xs font-medium transition-colors border whitespace-nowrap',
        selected
          ? 'bg-primary text-primary-foreground border-primary'
          : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80 bg-card',
      )}
    >
      {label}
    </button>
  )
}

// ─── Category section ─────────────────────────────────────────────────────────

function CategorySection({
  module: mod,
  alerts,
  expandedId,
  onToggle,
  onMarkRead,
  onResolve,
}: {
  module:     AlertModule
  alerts:     CenterAlert[]
  expandedId: string | null
  onToggle:   (id: string) => void
  onMarkRead: (id: string) => void
  onResolve:  (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const Icon  = MODULE_ICONS[mod]
  const color = MODULE_COLORS[mod]
  if (alerts.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between gap-2 mb-3 group"
      >
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center justify-center size-7 rounded-lg', color)}>
            <Icon className="size-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">{MODULE_LABELS[mod]}</span>
          <span className="text-xs text-muted-foreground">({alerts.length})</span>
        </div>
        {collapsed
          ? <ChevronDown className="size-4 text-muted-foreground" />
          : <ChevronUp className="size-4 text-muted-foreground" />}
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-2">
          {alerts.map(a => (
            <AlertRow
              key={a.id}
              alert={a}
              expanded={expandedId === a.id}
              onToggle={() => onToggle(a.id)}
              onMarkRead={onMarkRead}
              onResolve={onResolve}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const ALL_MODULES: AlertModule[] = [
  'buybox', 'bsr', 'keywords', 'pincode', 'price', 'reviews', 'competitor',
]

export default function AlertsPage() {
  const [alerts, setAlerts]             = useState<CenterAlert[]>([])
  const [loading, setLoading]           = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [workspaceId, setWorkspaceId]   = useState<string | null>(null)
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | 'all'>('all')
  const [moduleFilter, setModuleFilter]     = useState<AlertModule | 'all'>('all')
  const [statusFilter, setStatusFilter]     = useState<AlertStatus | 'all'>('all')
  const [search, setSearch] = useState('')

  const kpiStats = useMemo(() => {
    // Active KPIs exclude resolved/archived alerts to avoid counting historical issues.
    const isInactive = (status?: string | null) =>
      status === 'resolved' || status === 'archived'

    const isActive = (status?: string | null) => {
      if (!status) return true
      return status === 'new' || status === 'open' || status === 'active'
    }

    const activeAlerts = alerts.filter(a => isActive(a.status))

    return {
      activeTotal: activeAlerts.length,
      activeCritical: activeAlerts.filter(a => a.severity === 'critical').length,
      activeWarning: activeAlerts.filter(a => a.severity === 'warning').length,
      activeOpportunity: activeAlerts.filter(a => a.severity === 'opportunity').length,
      resolvedTotal: alerts.filter(a => isInactive(a.status)).length,
      unreadTotal: activeAlerts.filter(a => !a.status || a.status === 'new').length,
    }
  }, [alerts])

  // ── Load alerts ───────────────────────────────────────────────────────────

  const loadAlerts = useCallback(async (wid?: string) => {
    const id = wid ?? workspaceId
    if (!id) return
    const supabase = createClient()
    const { data, error } = await supabase
      .from('alerts')
      .select(`
        id, workspace_id, tracked_asin_id, title, description,
        severity, module, status, recommended_action, created_at,
        tracked_asins(asin, product_title, marketplace)
      `)
      .eq('workspace_id', id)
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) {
      console.error('[alerts-page] load error:', error.message)
      return
    }
    setAlerts((data ?? []).map(r => mapDbAlert(r as unknown as RawDbAlert)))
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    async function init() {
      setLoading(true)
      const wid = await getWorkspaceId()
      if (cancelled) return
      setWorkspaceId(wid)
      if (wid) await loadAlerts(wid)
      setLoading(false)
    }
    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleMarkRead(id: string) {
    const supabase = createClient()
    await supabase.from('alerts').update({ status: 'read' }).eq('id', id)
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'read' as AlertStatus } : a))
  }

  async function handleResolve(id: string) {
    const supabase = createClient()
    await supabase.from('alerts').update({ status: 'resolved' }).eq('id', id)
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'resolved' as AlertStatus } : a))
  }

  async function handleMarkAllRead() {
    const supabase = createClient()
    const newIds = alerts.filter(a => a.status === 'new').map(a => a.id)
    if (newIds.length > 0) {
      await supabase.from('alerts').update({ status: 'read' }).in('id', newIds)
    }
    setAlerts(prev => prev.map(a => a.status === 'new' ? { ...a, status: 'read' as AlertStatus } : a))
  }

  async function handleGenerate() {
    setIsGenerating(true)
    try {
      const res = await fetch('/api/alerts/generate', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.message ?? body.error ?? 'Failed to generate alerts')
      } else if ((body.alerts_created ?? 0) === 0) {
        toast.info(body.message ?? 'No new alerts found. Your tracked ASINs look clear for now.')
      } else {
        toast.success(body.message ?? `Generated ${body.alerts_created} alerts.`)
        await loadAlerts()
      }
    } catch {
      toast.error('Network error while generating alerts')
    } finally {
      setIsGenerating(false)
    }
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id))
  }

  const filtered = useMemo(() => {
    return alerts.filter(a => {
      if (severityFilter !== 'all' && a.severity !== severityFilter) return false
      if (moduleFilter  !== 'all' && a.module   !== moduleFilter)   return false
      if (statusFilter  !== 'all' && a.status   !== statusFilter)   return false
      if (search) {
        const q = search.toLowerCase()
        return (
          a.asin.toLowerCase().includes(q) ||
          a.title.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.product_name.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [alerts, severityFilter, moduleFilter, statusFilter, search])

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
          <h1 className="text-lg font-semibold text-foreground">Alerts Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review critical changes across products, rankings, Buy Box and availability. Next: resolve highest-severity unresolved alerts first. Data source: workspace alerts generated from snapshot checks.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {kpiStats.unreadTotal > 0 && (
            <Button type="button" variant="outline" onClick={handleMarkAllRead}>
              <CheckCheck className="size-4" />
              Mark All Read
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating
              ? <RefreshCw className="size-4 animate-spin" />
              : <Sparkles className="size-4" />}
            {isGenerating ? 'Generating…' : 'Generate Alerts'}
          </Button>
        </div>
      </div>

      {/* ── 2. KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Active Alerts" value={kpiStats.activeTotal}       icon={Bell} />
        <KpiCard label="Critical"      value={kpiStats.activeCritical}    icon={XCircle} />
        <KpiCard label="Warnings"      value={kpiStats.activeWarning}     icon={AlertTriangle} />
        <KpiCard label="Opportunities" value={kpiStats.activeOpportunity} icon={CheckCircle2} />
        <KpiCard label="Resolved"      value={kpiStats.resolvedTotal}     icon={CheckCheck} />
        <KpiCard label="Unread"        value={kpiStats.unreadTotal}       icon={BellOff} />
      </div>

      {/* ── 3. Filters ────────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by ASIN, keyword or product…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider w-16 flex-shrink-0">Severity</span>
          <div className="flex gap-1.5 flex-wrap">
            {(['all', 'critical', 'warning', 'opportunity', 'info'] as const).map(s => (
              <FilterPill
                key={s}
                value={s}
                selected={severityFilter === s}
                onClick={v => setSeverityFilter(v)}
                label={s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider w-16 flex-shrink-0">Module</span>
          <div className="flex gap-1.5 flex-wrap">
            <FilterPill value="all" selected={moduleFilter === 'all'} onClick={v => setModuleFilter(v)} label="All" />
            {ALL_MODULES.map(m => (
              <FilterPill
                key={m}
                value={m}
                selected={moduleFilter === m}
                onClick={v => setModuleFilter(v)}
                label={MODULE_LABELS[m]}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider w-16 flex-shrink-0">Status</span>
          <div className="flex gap-1.5 flex-wrap">
            {(['all', 'new', 'read', 'resolved'] as const).map(s => (
              <FilterPill
                key={s}
                value={s}
                selected={statusFilter === s}
                onClick={v => setStatusFilter(v)}
                label={s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              />
            ))}
          </div>
        </div>
        {filtered.length !== alerts.length && (
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {alerts.length} alerts
          </p>
        )}
      </div>

      {/* ── 4. Empty state ────────────────────────────────────────────────── */}
      {alerts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 rounded-xl border border-dashed border-border gap-3 text-center">
          <Bell className="size-8 text-muted-foreground/30" />
          <p className="text-sm font-medium text-foreground">No alerts yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Click &quot;Generate Alerts&quot; after collecting ASIN, BSR, Buy Box, pincode, or keyword data to detect issues automatically.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1 gap-1.5"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating
              ? <RefreshCw className="size-3.5 animate-spin" />
              : <Sparkles className="size-3.5" />}
            {isGenerating ? 'Generating…' : 'Generate Alerts'}
          </Button>
        </div>
      )}

      {/* ── 5. Flat list (filter/search active) ───────────────────────────── */}
      {alerts.length > 0 && (severityFilter !== 'all' || moduleFilter !== 'all' || statusFilter !== 'all' || search) && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Filtered Results ({filtered.length})
          </h2>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 rounded-xl border border-dashed border-border gap-2">
              <Bell className="size-6 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No alerts match your filters</p>
            </div>
          ) : (
            filtered.map(a => (
              <AlertRow
                key={a.id}
                alert={a}
                expanded={expandedId === a.id}
                onToggle={() => toggleExpand(a.id)}
                onMarkRead={handleMarkRead}
                onResolve={handleResolve}
              />
            ))
          )}
        </div>
      )}

      {/* ── 6. Category sections (default view) ───────────────────────────── */}
      {alerts.length > 0 && severityFilter === 'all' && moduleFilter === 'all' && statusFilter === 'all' && !search && (
        <div className="flex flex-col gap-8">
          {ALL_MODULES.map(mod => (
            <CategorySection
              key={mod}
              module={mod}
              alerts={alerts.filter(a => a.module === mod)}
              expandedId={expandedId}
              onToggle={toggleExpand}
              onMarkRead={handleMarkRead}
              onResolve={handleResolve}
            />
          ))}
        </div>
      )}
    </div>
  )
}
