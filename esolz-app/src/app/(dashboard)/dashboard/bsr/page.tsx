'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Bell,
  Check,
  Clock,
  Eye,
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  Tag,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { DataFreshnessBadge } from '@/components/dashboard/DataFreshnessBadge'
import {
  buildBsrTargetView,
  marketplaceLabelForListing,
  resolveBsrCandidateRows,
  resolveBsrSnapshotRows,
  summarizeBsrTargets,
  targetKey,
  untrackBsrTargetPatch,
  type BsrSnapshotRow,
  type BsrSourceProduct,
  type BsrTargetType,
  type BsrTargetView,
  type BsrTrackingTargetRow,
} from '@/lib/bsr/bsr-tracking'
import { createClient } from '@/lib/supabase/client'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

type BsrPoint = { date: string; rank: number }

type ListingCandidateRow = {
  id: string
  asin: string | null
  sku: string | null
  marketplace_id: string | null
  item_name: string | null
  image_url: string | null
}

type TrackedCandidateRow = {
  id: string
  asin: string | null
  marketplace: string | null
  product_title: string | null
  image_url: string | null
  status: string | null
}

type TrackingTargetMutation = {
  amazon_listing_item_id?: string | null
  tracked_asin_id?: string | null
}

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

function MovementChip({ movement }: { movement: number | null }) {
  if (movement === null) return <span className="text-muted-foreground text-xs">-</span>
  if (movement === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" /> -
      </span>
    )
  }
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
      {improved ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {improved ? '+' : ''}
      {movement.toLocaleString('en-IN')}
    </span>
  )
}

function ChartSkeleton() {
  return (
    <div className="h-[260px] flex items-center justify-center">
      <p className="text-muted-foreground/40 text-sm">Loading chart...</p>
    </div>
  )
}

function sourceFromListing(row: ListingCandidateRow): BsrSourceProduct | null {
  if (!row.id || !row.asin) return null
  return {
    targetType: 'my_product',
    sourceId: row.id,
    asin: row.asin,
    marketplace: marketplaceLabelForListing(row.marketplace_id),
    label: row.item_name || row.sku || row.asin,
    sku: row.sku,
    imageUrl: row.image_url,
  }
}

function sourceFromTracked(row: TrackedCandidateRow): BsrSourceProduct | null {
  if (!row.id || !row.asin || !row.marketplace) return null
  return {
    targetType: 'competitor_asin',
    sourceId: row.id,
    asin: row.asin,
    marketplace: row.marketplace,
    label: row.product_title || row.asin,
    imageUrl: row.image_url,
  }
}

function sourceMutation(source: BsrSourceProduct): TrackingTargetMutation {
  return source.targetType === 'my_product'
    ? { amazon_listing_item_id: source.sourceId, tracked_asin_id: null }
    : { amazon_listing_item_id: null, tracked_asin_id: source.sourceId }
}

function rowKeyFromTarget(row: BsrTrackingTargetRow): string | null {
  if (row.amazon_listing_item_id) return targetKey('my_product', row.amazon_listing_item_id)
  if (row.tracked_asin_id) return targetKey('competitor_asin', row.tracked_asin_id)
  return null
}

function includesSearch(source: BsrSourceProduct, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return [source.label, source.asin, source.sku, source.marketplace]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(q))
}

function freshnessLabel(target: BsrTargetView): string {
  if (!target.lastCheckedAt) return 'Never checked'
  if (target.currentRank !== null && target.rankCapturedAt !== target.lastCheckedAt) return 'Using last BSR'
  if (target.currentRank === null && target.latestStatus) return 'BSR not found'
  return 'Current'
}

export default function BsrTrackerPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<BsrTargetType>('my_product')
  const [loading, setLoading] = useState(true)
  const [configUnavailable, setConfigUnavailable] = useState(false)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [trackedUnavailable, setTrackedUnavailable] = useState(false)
  const [myBsrUnavailable, setMyBsrUnavailable] = useState(false)
  const [competitorBsrUnavailable, setCompetitorBsrUnavailable] = useState(false)
  const [myCandidates, setMyCandidates] = useState<BsrSourceProduct[]>([])
  const [competitorCandidates, setCompetitorCandidates] = useState<BsrSourceProduct[]>([])
  const [targets, setTargets] = useState<BsrTrackingTargetRow[]>([])
  const [targetViews, setTargetViews] = useState<BsrTargetView[]>([])
  const [search, setSearch] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [chartRange, setChartRange] = useState<7 | 14 | 30>(30)
  const [bsrHistory, setBsrHistory] = useState<BsrPoint[]>([])
  const [chartLoading, setChartLoading] = useState(false)
  const [chartBsrUnavailable, setChartBsrUnavailable] = useState(false)

  const activeCandidates = activeTab === 'my_product' ? myCandidates : competitorCandidates
  const activeTargets = useMemo(
    () => targetViews.filter(target => target.targetType === activeTab),
    [activeTab, targetViews],
  )

  const activeTargetRowsByKey = useMemo(() => {
    const map = new Map<string, BsrTrackingTargetRow>()
    for (const target of targets) {
      if (target.status !== 'active') continue
      const key = rowKeyFromTarget(target)
      if (key) map.set(key, target)
    }
    return map
  }, [targets])

  const allTargetRowsByKey = useMemo(() => {
    const map = new Map<string, BsrTrackingTargetRow>()
    for (const target of targets) {
      const key = rowKeyFromTarget(target)
      if (key) map.set(key, target)
    }
    return map
  }, [targets])

  const selectedTarget = useMemo(
    () => activeTargets.find(target => targetKey(target.targetType, target.sourceId) === selectedKey) ?? activeTargets[0] ?? null,
    [activeTargets, selectedKey],
  )

  const summary = useMemo(() => summarizeBsrTargets(activeTargets), [activeTargets])

  const movers = useMemo(
    () => activeTargets.filter(target => target.movement !== null),
    [activeTargets],
  )
  const gainers = useMemo(
    () => movers.filter(target => target.movement! > 0).sort((a, b) => b.movement! - a.movement!),
    [movers],
  )
  const drops = useMemo(
    () => movers.filter(target => target.movement! < 0).sort((a, b) => a.movement! - b.movement!),
    [movers],
  )

  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, BsrTargetView[]>()
    for (const target of activeTargets) {
      if (!target.category || target.currentRank === null) continue
      if (!map.has(target.category)) map.set(target.category, [])
      map.get(target.category)?.push(target)
    }
    return Array.from(map.entries()).map(([category, rows]) => {
      const average = Math.round(rows.reduce((sum, target) => sum + target.currentRank!, 0) / rows.length)
      const best = Math.min(...rows.map(target => target.currentRank!))
      const improving = rows.filter(target => target.movement !== null && target.movement > 0).length
      return { category, rows, average, best, improving }
    })
  }, [activeTargets])

  const loadData = useCallback(async () => {
    setLoading(true)
    setConfigUnavailable(false)
    setCatalogUnavailable(false)
    setTrackedUnavailable(false)
    setMyBsrUnavailable(false)
    setCompetitorBsrUnavailable(false)
    const wsId = await getWorkspaceId()
    setWorkspaceId(wsId)
    if (!wsId) {
      setLoading(false)
      return
    }

    const supabase = createClient()
    const [targetResult, listingResult, trackedResult] = await Promise.all([
      supabase
        .from('bsr_tracking_targets')
        .select('id, workspace_id, amazon_listing_item_id, tracked_asin_id, status, created_at, updated_at, removed_at')
        .eq('workspace_id', wsId),
      supabase
        .from('amazon_listing_items')
        .select('id, asin, sku, marketplace_id, item_name, image_url')
        .eq('workspace_id', wsId)
        .not('asin', 'is', null)
        .order('item_name', { ascending: true }),
      supabase
        .from('tracked_asins')
        .select('id, asin, marketplace, product_title, image_url, status')
        .eq('workspace_id', wsId)
        .neq('status', 'archived')
        .order('created_at', { ascending: false }),
    ])

    const targetRows = targetResult.error ? [] : (targetResult.data ?? []) as BsrTrackingTargetRow[]
    if (targetResult.error) {
      setConfigUnavailable(true)
      setTargets([])
    } else {
      setTargets(targetRows)
    }

    const candidateRows = resolveBsrCandidateRows({
      listings: (listingResult.data ?? []) as ListingCandidateRow[],
      trackedAsins: (trackedResult.data ?? []) as TrackedCandidateRow[],
      catalogUnavailable: Boolean(listingResult.error),
      trackedUnavailable: Boolean(trackedResult.error),
    })
    setCatalogUnavailable(candidateRows.catalogUnavailable)
    setTrackedUnavailable(candidateRows.trackedUnavailable)

    const mySources = candidateRows.myRows.map(sourceFromListing).filter((source): source is BsrSourceProduct => Boolean(source))
    const competitorSources = candidateRows.competitorRows.map(sourceFromTracked).filter((source): source is BsrSourceProduct => Boolean(source))

    setMyCandidates(mySources)
    setCompetitorCandidates(competitorSources)

    const allSources = [...mySources, ...competitorSources]
    const sourceByKey = new Map(allSources.map(source => [targetKey(source.targetType, source.sourceId), source]))
    const activeRows = targetRows.filter(row => row.status === 'active')
    const listingIds = candidateRows.catalogUnavailable
      ? []
      : activeRows.map(row => row.amazon_listing_item_id).filter((id): id is string => Boolean(id))
    const trackedIds = candidateRows.catalogUnavailable || candidateRows.trackedUnavailable
      ? []
      : activeRows.map(row => row.tracked_asin_id).filter((id): id is string => Boolean(id))

    const snapshotFields = 'amazon_listing_item_id, tracked_asin_id, bsr, bsr_category, bsr_ranks, scrape_status, checked_at'
    const snapshotResults = await Promise.all([
      listingIds.length
        ? supabase
            .from('asin_snapshots')
            .select(snapshotFields)
            .in('amazon_listing_item_id', listingIds)
            .order('checked_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      trackedIds.length
        ? supabase
            .from('asin_snapshots')
            .select(snapshotFields)
            .in('tracked_asin_id', trackedIds)
            .order('checked_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ])
    const listingSnapshots = resolveBsrSnapshotRows({
      snapshots: (snapshotResults[0].data ?? []) as BsrSnapshotRow[],
      unavailable: Boolean(snapshotResults[0].error),
    })
    const trackedSnapshots = resolveBsrSnapshotRows({
      snapshots: (snapshotResults[1].data ?? []) as BsrSnapshotRow[],
      unavailable: Boolean(snapshotResults[1].error),
    })
    setMyBsrUnavailable(listingSnapshots.unavailable)
    setCompetitorBsrUnavailable(trackedSnapshots.unavailable)
    const snapshots = [...listingSnapshots.snapshots, ...trackedSnapshots.snapshots]

    const views = activeRows.flatMap(row => {
      if (row.amazon_listing_item_id && listingSnapshots.unavailable) return []
      if (row.tracked_asin_id && trackedSnapshots.unavailable) return []
      const key = rowKeyFromTarget(row)
      const source = key ? sourceByKey.get(key) : null
      return source ? [buildBsrTargetView(source, row.id, snapshots)] : []
    })

    setTargetViews(views)
    setSelectedKey(prev => {
      if (prev && views.some(view => targetKey(view.targetType, view.sourceId) === prev)) return prev
      const first = views.find(view => view.targetType === activeTab && view.currentRank !== null)
        ?? views.find(view => view.targetType === activeTab)
      return first ? targetKey(first.targetType, first.sourceId) : ''
    })
    setLoading(false)
  }, [activeTab])

  useEffect(() => {
    queueMicrotask(() => { void loadData() })
  }, [loadData])

  const loadHistory = useCallback(async (target: BsrTargetView | null, days: number) => {
    if (!target) {
      setChartBsrUnavailable(false)
      setBsrHistory([])
      return
    }
    setChartLoading(true)
    setChartBsrUnavailable(false)
    const supabase = createClient()
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const column = target.targetType === 'my_product' ? 'amazon_listing_item_id' : 'tracked_asin_id'

    const { data, error } = await supabase
      .from('asin_snapshots')
      .select('bsr, checked_at')
      .eq(column, target.sourceId)
      .gte('checked_at', since)
      .not('bsr', 'is', null)
      .order('checked_at', { ascending: true })

    if (error) {
      setChartBsrUnavailable(true)
      setBsrHistory([])
      setChartLoading(false)
      return
    }

    setBsrHistory(((data ?? []) as Array<{ bsr: number; checked_at: string }>).map(row => ({
      date: new Date(row.checked_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      rank: row.bsr,
    })))
    setChartLoading(false)
  }, [])

  useEffect(() => {
    queueMicrotask(() => { void loadHistory(selectedTarget, chartRange) })
  }, [selectedTarget, chartRange, loadHistory])

  const trackSource = useCallback(async (source: BsrSourceProduct) => {
    if (!workspaceId) return
    const key = targetKey(source.targetType, source.sourceId)
    setSavingKey(key)
    const supabase = createClient()
    const existing = allTargetRowsByKey.get(key)
    const mutation = sourceMutation(source)
    const result = existing
      ? await supabase
          .from('bsr_tracking_targets')
          .update({ status: 'active', removed_at: null })
          .eq('id', existing.id)
          .eq('workspace_id', workspaceId)
      : await supabase
          .from('bsr_tracking_targets')
          .insert({ workspace_id: workspaceId, status: 'active', ...mutation })

    if (!result.error) await loadData()
    setSelectedKey(key)
    setSavingKey(null)
  }, [allTargetRowsByKey, loadData, workspaceId])

  const untrackSource = useCallback(async (target: BsrTargetView) => {
    if (!workspaceId) return
    const key = targetKey(target.targetType, target.sourceId)
    setSavingKey(key)
    const supabase = createClient()
    await supabase
      .from('bsr_tracking_targets')
      .update(untrackBsrTargetPatch(new Date().toISOString()))
      .eq('id', target.trackingTargetId)
      .eq('workspace_id', workspaceId)
    await loadData()
    setSavingKey(null)
  }, [loadData, workspaceId])

  const filteredCandidates = activeCandidates.filter(source => includesSearch(source, search))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading BSR Tracker...</span>
      </div>
    )
  }

  return (
    <div className="p-6 w-full max-w-[1800px] mx-auto space-y-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">BSR Tracker</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-4xl">
            Select catalog products or confirmed competitors for BSR monitoring. BSR history comes from asin_snapshots and remains available after a target is selected.
          </p>
        </div>
        <Button render={<Link href="/dashboard/asins" />} variant="outline" className="gap-2 shrink-0">
          <Plus className="size-4" />
          Add competitors in ASIN Tracking
        </Button>
      </div>

      {configUnavailable && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          BSR target selection table is not available yet. The migration in this PR must be reviewed and applied before tracking selections can be saved.
        </div>
      )}

      {catalogUnavailable && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          Catalog products are temporarily unavailable. Competitor ASINs are hidden until ownership can be verified.
        </div>
      )}

      {trackedUnavailable && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          Competitor ASINs are temporarily unavailable. Existing competitor targets are hidden until the read succeeds.
        </div>
      )}

      {(myBsrUnavailable || competitorBsrUnavailable) && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          BSR snapshot data is temporarily unavailable for {myBsrUnavailable && competitorBsrUnavailable ? 'My ASINs and competitors' : myBsrUnavailable ? 'My ASINs' : 'competitors'}. Rankings are hidden rather than shown as missing BSR.
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border">
        {([
          ['my_product', 'My ASINs'],
          ['competitor_asin', 'Competitor ASINs'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setActiveTab(value)
              setSearch('')
              const first = targetViews.find(view => view.targetType === value)
              setSelectedKey(first ? targetKey(first.targetType, first.sourceId) : '')
            }}
            className={cn(
              'px-3 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="BSR Targets" value={String(summary.totalTargets)} sub={`${summary.targetsWithBsr} with BSR data`} icon={Package} />
        <KpiCard label="Average BSR" value={summary.averageBsr !== null ? `#${summary.averageBsr.toLocaleString('en-IN')}` : '-'} sub={activeTab === 'my_product' ? 'selected My ASINs only' : 'selected competitors only'} icon={BarChart2} />
        <KpiCard label="Biggest Gainer" value={gainers[0]?.currentRank !== null && gainers[0] ? `#${gainers[0].currentRank.toLocaleString('en-IN')}` : '-'} sub={gainers[0]?.label ?? 'Need 2+ BSR snapshots'} icon={TrendingUp} />
        <KpiCard label="Biggest Drop" value={drops[0]?.currentRank !== null && drops[0] ? `#${drops[0].currentRank.toLocaleString('en-IN')}` : '-'} sub={drops[0]?.label ?? 'No drops detected'} icon={TrendingDown} />
        <KpiCard label="Improving" value={String(summary.improvingCount)} sub={`of ${summary.totalTargets} targets`} icon={ArrowUpRight} />
        <KpiCard label="Declining" value={String(summary.decliningCount)} sub={`of ${summary.totalTargets} targets`} icon={ArrowDownRight} />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h2 className="font-semibold text-foreground">BSR Trend</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Historical rank movement for the selected {activeTab === 'my_product' ? 'My ASIN' : 'competitor'} target.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={selectedTarget ? targetKey(selectedTarget.targetType, selectedTarget.sourceId) : ''}
              onChange={e => setSelectedKey(e.target.value)}
              className="text-xs bg-muted border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer max-w-[280px]"
            >
              {activeTargets.length === 0 ? (
                <option value="">No BSR targets selected</option>
              ) : activeTargets.map(target => (
                <option key={targetKey(target.targetType, target.sourceId)} value={targetKey(target.targetType, target.sourceId)}>
                  {target.label}
                </option>
              ))}
            </select>
            <RangeToggle value={chartRange} onChange={setChartRange} />
          </div>
        </div>

        {chartLoading ? (
          <ChartSkeleton />
        ) : chartBsrUnavailable ? (
          <div className="h-[260px] flex flex-col items-center justify-center gap-2">
            <BarChart2 className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">BSR history temporarily unavailable</p>
            <p className="text-xs text-muted-foreground/70">Snapshot results could not be read, so the chart is hidden for now.</p>
          </div>
        ) : bsrHistory.length < 2 ? (
          <div className="h-[260px] flex flex-col items-center justify-center gap-2">
            <BarChart2 className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No BSR history yet</p>
            <p className="text-xs text-muted-foreground/70">Existing BSR snapshots will appear here after the target is selected.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={bsrHistory} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
              <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis reversed domain={['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => v >= 1000 ? `#${(v / 1000).toFixed(1)}k` : `#${v}`} width={54} />
              <Tooltip content={<BsrTooltip />} />
              <Line type="monotone" dataKey="rank" stroke="oklch(0.741 0.174 66.5)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: 'oklch(0.741 0.174 66.5)', stroke: 'oklch(0.741 0.174 66.5)' }} />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div className="mt-3 text-xs text-muted-foreground">
          Showing last {chartRange} days
          {selectedTarget?.category ? ` in ${selectedTarget.category}` : ''}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h2 className="font-semibold text-foreground">{activeTab === 'my_product' ? 'Add from My Products' : 'Select Competitor ASINs'}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {activeTab === 'my_product'
                ? 'Catalog products stay in amazon_listing_items. Track BSR only creates BSR configuration.'
                : 'Competitor choices come only from ASIN Tracking competitors.'}
            </p>
          </div>
          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search title, ASIN, SKU"
              className="w-[260px] max-w-full rounded-md border border-border bg-muted/30 pl-8 pr-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {activeTab === 'competitor_asin' && (catalogUnavailable || trackedUnavailable) ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium text-foreground">Competitor ASINs temporarily unavailable</p>
            <p className="text-xs text-muted-foreground mt-1">Ownership or competitor data could not be verified, so no tracked ASIN is shown as a confirmed competitor.</p>
          </div>
        ) : activeTab === 'competitor_asin' && competitorCandidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium text-foreground">No competitors available yet</p>
            <p className="text-xs text-muted-foreground mt-1">Add competitors in ASIN Tracking first.</p>
            <Button render={<Link href="/dashboard/asins" />} className="mt-4" size="sm">
              Open ASIN Tracking
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[360px] overflow-y-auto pr-1">
            {filteredCandidates.map(source => {
              const key = targetKey(source.targetType, source.sourceId)
              const isTracking = activeTargetRowsByKey.has(key)
              return (
                <div key={key} className="rounded-lg border border-border bg-muted/10 p-3 flex items-center gap-3">
                  {source.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={source.imageUrl} alt="" className="size-10 rounded object-cover bg-muted shrink-0" />
                  ) : (
                    <div className="size-10 rounded bg-muted flex items-center justify-center shrink-0">
                      <Package className="size-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{source.label}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="font-mono text-[10px] text-muted-foreground bg-background/80 rounded px-1.5 py-0.5">{source.asin}</span>
                      <Badge variant="secondary" className="text-[9px]">{source.marketplace}</Badge>
                      {source.sku && <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{source.sku}</span>}
                    </div>
                  </div>
                  {isTracking ? (
                    <Badge className="bg-green-500/15 text-green-400 border-green-500/20">
                      <Check className="size-3 mr-1" /> Tracking
                    </Badge>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void trackSource(source)} disabled={savingKey === key || configUnavailable}>
                      {savingKey === key ? <Loader2 className="size-3 animate-spin" /> : 'Track BSR'}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MoverPanel title="Biggest Gainers" tone="green" rows={gainers} empty={summary.targetsWithBsr === 0 ? 'Select targets with BSR snapshots to see gainers.' : 'No improvements detected yet.'} onView={target => setSelectedKey(targetKey(target.targetType, target.sourceId))} />
        <MoverPanel title="Biggest Drops" tone="red" rows={drops} empty={summary.targetsWithBsr === 0 ? 'Select targets with BSR snapshots to see drops.' : 'No drops detected yet.'} onView={target => setSelectedKey(targetKey(target.targetType, target.sourceId))} />
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">BSR Tracking Table</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {activeTab === 'my_product' ? 'Selected My ASIN targets only' : 'Selected competitor targets only'}
            </p>
          </div>
          <Badge variant="secondary" className="text-xs">{activeTargets.length} ASINs</Badge>
        </div>

        {activeTargets.length === 0 ? (
          <div className="p-10 text-center">
            <BarChart2 className="size-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="font-medium text-foreground">
              {activeTab === 'my_product' ? 'No products selected for BSR tracking yet' : 'No competitors selected for BSR tracking yet'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {activeTab === 'my_product' ? 'Use Add from My Products above.' : 'Select an existing competitor above, or add competitors in ASIN Tracking first.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left text-xs text-muted-foreground font-medium px-5 py-3 w-[28%]">Product</th>
                  <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 w-[15%]">Category</th>
                  <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3 w-[10%]">Current BSR</th>
                  <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3 w-[12%]">Subcategory Rank</th>
                  <th className="text-right text-xs text-muted-foreground font-medium px-4 py-3 w-[9%]">Previous</th>
                  <th className="text-center text-xs text-muted-foreground font-medium px-4 py-3 w-[9%]">Movement</th>
                  <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 w-[8%]">Last Checked</th>
                  <th className="text-left text-xs text-muted-foreground font-medium px-4 py-3 w-[8%]">Freshness</th>
                  <th className="text-right text-xs text-muted-foreground font-medium px-5 py-3 w-[9%]">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {activeTargets.map(target => (
                  <tr key={targetKey(target.targetType, target.sourceId)} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-foreground leading-snug line-clamp-2">{target.label}</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5">{target.asin}</span>
                          <Badge variant="secondary" className="text-[9px]">{target.marketplace}</Badge>
                          {target.sku && <span className="text-[10px] text-muted-foreground">{target.sku}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {target.category ? <span className="text-xs text-muted-foreground">{target.category}</span> : <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {target.currentRank !== null ? <span className="font-semibold tabular-nums">#{target.currentRank.toLocaleString('en-IN')}</span> : <Badge variant="secondary" className="text-[10px]">No BSR</Badge>}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {target.subcategory && target.subcategoryRank !== null ? (
                        <div className="text-xs">
                          <p className="text-foreground font-medium tabular-nums">#{target.subcategoryRank.toLocaleString('en-IN')}</p>
                          <p className="text-muted-foreground truncate max-w-[150px] ml-auto">{target.subcategory}</p>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {target.previousRank !== null ? <span className="text-xs text-muted-foreground tabular-nums">#{target.previousRank.toLocaleString('en-IN')}</span> : <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-4 py-3.5 text-center"><MovementChip movement={target.movement} /></td>
                    <td className="px-4 py-3.5">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="size-3" />
                        {timeAgo(target.lastCheckedAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col gap-1">
                        <DataFreshnessBadge checkedAt={target.lastCheckedAt} />
                        <span className="text-[10px] text-muted-foreground">{freshnessLabel(target)}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setSelectedKey(targetKey(target.targetType, target.sourceId))}>
                          <Eye className="size-3.5 mr-1" /> View Trend
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void untrackSource(target)} disabled={savingKey === targetKey(target.targetType, target.sourceId)}>
                          Untrack
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="size-4 text-primary shrink-0" />
            <h2 className="font-semibold text-foreground">Category Breakdown</h2>
          </div>
          {categoryBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">BSR category data will appear from Amazon snapshot categories.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {categoryBreakdown.map(category => (
                <div key={category.category} className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{category.category}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{category.rows.length} target{category.rows.length !== 1 ? 's' : ''}</p>
                    </div>
                    {category.improving > 0 && <Badge className="bg-green-500/15 text-green-400 border-green-500/20">{category.improving} improving</Badge>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md bg-muted/30 p-2.5">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Best BSR</p>
                      <p className="text-sm font-bold text-foreground">#{category.best.toLocaleString('en-IN')}</p>
                    </div>
                    <div className="rounded-md bg-muted/30 p-2.5">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Avg BSR</p>
                      <p className="text-sm font-bold text-foreground">#{category.average.toLocaleString('en-IN')}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="size-4 text-primary shrink-0" />
            <h2 className="font-semibold text-foreground">BSR Alerts</h2>
            <Badge variant="secondary" className="ml-auto text-xs">Coming soon</Badge>
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

function MoverPanel({
  title,
  tone,
  rows,
  empty,
  onView,
}: {
  title: string
  tone: 'green' | 'red'
  rows: BsrTargetView[]
  empty: string
  onView: (target: BsrTargetView) => void
}) {
  const isGreen = tone === 'green'
  return (
    <div className={cn('rounded-xl border bg-card p-5', isGreen ? 'border-green-500/20' : 'border-red-500/20')}>
      <div className="flex items-center gap-2 mb-4">
        <div className={cn('size-6 rounded-full flex items-center justify-center', isGreen ? 'bg-green-500/15' : 'bg-red-500/15')}>
          {isGreen ? <TrendingUp className="size-3.5 text-green-400" /> : <TrendingDown className="size-3.5 text-red-400" />}
        </div>
        <h2 className="font-semibold text-foreground">{title}</h2>
        <Badge variant="secondary" className={cn('ml-auto text-[10px] border', isGreen ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20')}>
          {rows.length} targets
        </Badge>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.slice(0, 8).map(target => (
            <div key={targetKey(target.targetType, target.sourceId)} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5', isGreen ? 'bg-green-500/5 border-green-500/10' : 'bg-red-500/5 border-red-500/10')}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{target.label}</p>
                <span className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded px-1">{target.asin}</span>
              </div>
              <div className="text-right shrink-0">
                <p className={cn('text-sm font-bold', isGreen ? 'text-green-400' : 'text-red-400')}>
                  {target.currentRank !== null ? `#${target.currentRank.toLocaleString('en-IN')}` : '-'}
                </p>
                <MovementChip movement={target.movement} />
              </div>
              <button type="button" onClick={() => onView(target)} className="text-muted-foreground hover:text-foreground transition-colors">
                <Eye className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
