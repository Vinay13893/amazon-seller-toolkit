'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
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
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Hash,
  Search,
  TrendingUp,
  TrendingDown,
  BarChart2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  ExternalLink,
  Plus,
  Tag,
  RefreshCw,
  Bell,
  Minus,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import {
  KEYWORD_GROUPS,
  KEYWORD_ALERTS,
  type TrackedKeyword,
  type KeywordAlert,
  type KeywordGroup,
} from '@/lib/mock-keywords'
import { createClient } from '@/lib/supabase/client'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { toast } from 'sonner'

// ─── API research result type ─────────────────────────────────────────────────
// Metrics are null — no existing keyword-research tool provides volume/CPC data.
interface ApiResearchResult {
  id: string
  keyword: string
  search_volume: number | null
  cpc_estimate: number | null
  competition_score: number | null
  difficulty: number | null
  intent: string | null
  top_ranking_asin: string | null
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function IntentBadge({ intent }: { intent: 'generic' | 'long_tail' | 'competitor' | 'problem_based' }) {
  const map = {
    generic: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20',
    long_tail: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    competitor: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
    problem_based: 'bg-primary/15 text-primary border-primary/20',
  }
  const labels = {
    generic: 'Generic',
    long_tail: 'Long-tail',
    competitor: 'Competitor',
    problem_based: 'Problem',
  }
  return (
    <Badge className={cn('text-xs', map[intent])}>{labels[intent]}</Badge>
  )
}

function CompetitionBadge({ level }: { level: 'low' | 'medium' | 'high' }) {
  const map = {
    low: 'bg-green-500/15 text-green-400 border-green-500/20',
    medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
    high: 'bg-red-500/15 text-red-400 border-red-500/20',
  }
  return (
    <Badge className={cn('text-xs capitalize', map[level])}>{level}</Badge>
  )
}

function PageStatusBadge({ status }: { status: TrackedKeyword['page_status'] }) {
  const map: Record<string, string> = {
    page_1: 'bg-green-500/15 text-green-400 border-green-500/20',
    page_2: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
    page_3: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
    not_ranking: 'bg-red-500/15 text-red-400 border-red-500/20',
  }
  const labels: Record<string, string> = {
    page_1: 'Page 1',
    page_2: 'Page 2',
    page_3: 'Page 3',
    not_ranking: 'Not Ranking',
  }
  return (
    <Badge className={cn('text-xs', map[status])}>{labels[status]}</Badge>
  )
}

function MovementChip({ current, prev }: { current: number | null; prev: number | null }) {
  if (current === null || prev === null)
    return <span className="text-muted-foreground text-xs">—</span>
  const delta = prev - current // positive = rank improved (number went down)
  if (delta === 0)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" /> 0
      </span>
    )
  const improved = delta > 0
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
      {Math.abs(delta)}
    </span>
  )
}

function DifficultyBar({ score }: { score: number }) {
  const color =
    score >= 70 ? 'bg-red-500' : score >= 41 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 bg-border/50 rounded-full h-1.5">
        <div
          className={cn('h-1.5 rounded-full', color)}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{score}</span>
    </div>
  )
}

function AlertRow({ alert }: { alert: KeywordAlert }) {
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
        <p className="text-[10px] text-muted-foreground mt-1 font-mono">
          {alert.asin} · {timeAgo(alert.timestamp)}
        </p>
      </div>
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

function KwChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { value: number | null }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const rank = payload[0]?.value
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">
        {rank != null ? `Rank #${rank}` : 'Not ranking'}
      </p>
    </div>
  )
}

function GroupCard({ group }: { group: KeywordGroup }) {
  const intentColors: Record<string, string> = {
    'High Intent': 'text-primary',
    'Long-tail': 'text-blue-400',
    Competitor: 'text-purple-400',
    'Problem-based': 'text-orange-400',
    Generic: 'text-zinc-400',
  }
  const visible = group.keywords.slice(0, 3)
  const overflow = group.keywords.length - visible.length
  return (
    <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-3">
      <div>
        <p className={cn('text-xs font-bold uppercase tracking-wider', intentColors[group.name] ?? 'text-foreground')}>
          {group.name}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{group.description}</p>
      </div>
      <div className="flex gap-4 text-xs">
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground">{group.keywords.length}</span> keywords
        </span>
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground">
            {group.total_volume.toLocaleString('en-IN')}
          </span>{' '}
          vol/mo
        </span>
        <span className="text-muted-foreground">
          <span className="font-semibold text-green-400">{group.page_1_count}</span> on P1
        </span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {visible.map(kw => (
          <span
            key={kw}
            className="inline-block px-2 py-0.5 rounded-full bg-border/50 text-[11px] text-muted-foreground border border-border"
          >
            {kw}
          </span>
        ))}
        {overflow > 0 && (
          <span className="inline-block px-2 py-0.5 rounded-full bg-border/50 text-[11px] text-muted-foreground border border-border">
            +{overflow} more
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function KeywordsPage() {
  const [seedKeyword, setSeedKeyword] = useState('')
  const [marketplace, setMarketplace] = useState<'amazon.in' | 'amazon.com'>('amazon.in')
  const [category, setCategory] = useState('all')
  const [isResearching, setIsResearching] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [researchResults, setResearchResults] = useState<ApiResearchResult[] | null>(null)
  const [trackedData, setTrackedData] = useState<TrackedKeyword[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [tracked, setTracked] = useState<Set<string>>(new Set())
  const [trackingKw, setTrackingKw] = useState<string | null>(null)
  const [selectedKeywordId, setSelectedKeywordId] = useState<string>('')
  const [historyMap, setHistoryMap] = useState<Record<string, { date: string; rank: number | null }[]>>({})
  const [chartRange, setChartRange] = useState<7 | 14 | 30>(7)
  const [isMounted, setIsMounted] = useState(false)
  const researchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // ── Load workspace + tracked keywords ─────────────────────────────────────────────
  const loadTrackedKeywords = useCallback(async (wsId: string) => {
    const supabase = createClient()
    const { data: kws } = await supabase
      .from('tracked_keywords')
      .select('id, keyword, search_volume, marketplace, tracked_asins(asin, product_title)')
      .eq('workspace_id', wsId)
      .order('created_at', { ascending: false })

    if (!kws || kws.length === 0) {
      setTrackedData([])
      return
    }

    const { data: snaps } = await supabase
      .from('keyword_rank_snapshots')
      .select('tracked_keyword_id, organic_rank, sponsored_rank, page_status, checked_at')
      .in('tracked_keyword_id', kws.map(k => k.id))
      .order('checked_at', { ascending: false })

    const snapsByKw: Record<string, { organic_rank: number | null; sponsored_rank: number | null; page_status: string | null; checked_at: string }[]> = {}
    for (const s of snaps ?? []) {
      if (!snapsByKw[s.tracked_keyword_id]) snapsByKw[s.tracked_keyword_id] = []
      snapsByKw[s.tracked_keyword_id].push(s)
    }

    const mapped: TrackedKeyword[] = kws.map(kw => {
      const kwSnaps = snapsByKw[kw.id] ?? []
      const latest  = kwSnaps[0]
      const prev    = kwSnaps[1]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const asinRow = normalizeEmbed<{ asin: string; product_title: string | null }>((kw as any).tracked_asins)
      return {
        id:                kw.id,
        keyword:           kw.keyword,
        asin:              asinRow?.asin ?? '—',
        product_name:      asinRow?.product_title ?? '—',
        organic_rank:      latest?.organic_rank    ?? null,
        prev_organic_rank: prev?.organic_rank      ?? null,
        sponsored_rank:    latest?.sponsored_rank  ?? null,
        page_status:       (latest?.page_status    ?? 'not_ranking') as TrackedKeyword['page_status'],
        search_volume:     kw.search_volume        ?? 0,
        last_checked:      latest?.checked_at      ?? new Date(0).toISOString(),
      }
    })

    setTrackedData(mapped)
    setSelectedKeywordId(prev => (mapped.find(k => k.id === prev) ? prev : mapped[0]?.id ?? ''))
  }, [])

  const loadKeywordHistory = useCallback(async (kwId: string) => {
    if (!kwId) return
    const supabase = createClient()
    const { data } = await supabase
      .from('keyword_rank_snapshots')
      .select('organic_rank, checked_at')
      .eq('tracked_keyword_id', kwId)
      .order('checked_at', { ascending: true })
      .limit(90)
    if (data && data.length > 0) {
      const history = data.map(s => ({
        date: new Date(s.checked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        rank: s.organic_rank,
      }))
      setHistoryMap(prev => ({ ...prev, [kwId]: history }))
    }
  }, [])

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle()
        .then(({ data: member }) => {
          if (member?.workspace_id) {
            setWorkspaceId(member.workspace_id)
            loadTrackedKeywords(member.workspace_id)
          }
        })
    })
  }, [loadTrackedKeywords])

  useEffect(() => {
    if (selectedKeywordId && !historyMap[selectedKeywordId]) {
      loadKeywordHistory(selectedKeywordId)
    }
  }, [selectedKeywordId, historyMap, loadKeywordHistory])

  async function handleResearch(e: React.FormEvent) {
    e.preventDefault()
    if (!seedKeyword.trim()) return
    setIsResearching(true)
    setResearchResults(null)
    try {
      const res = await fetch('/api/keywords/research', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ seedKeyword: seedKeyword.trim(), marketplace, category }),
      })
      const data = await res.json() as { results?: ApiResearchResult[]; error?: string }
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Research failed')
      } else {
        const results = (data.results ?? []).map((r, i) => ({
          ...r,
          id: `r${i}-${r.keyword.slice(0, 20).replace(/\s+/g, '_')}`,
        }))
        setResearchResults(results)
      }
    } catch {
      toast.error('Failed to research keywords')
    } finally {
      setIsResearching(false)
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true)
    try {
      const res = await fetch('/api/keywords/refresh', { method: 'POST' })
      const data = await res.json() as { checked?: number; message?: string; error?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Refresh failed')
      } else if (data.message) {
        toast.info(data.message)
      } else {
        toast.success(`Refreshed ${data.checked ?? 0} keywords`)
        if (workspaceId) await loadTrackedKeywords(workspaceId)
      }
    } catch {
      toast.error('Failed to refresh keyword ranks')
    } finally {
      setIsRefreshing(false)
    }
  }

  async function toggleTrack(kw: ApiResearchResult) {
    if (tracked.has(kw.id) || trackingKw) return
    setTrackingKw(kw.id)
    try {
      const res = await fetch('/api/keywords/track', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword:      kw.keyword,
          marketplace:  marketplace === 'amazon.in' ? 'IN' : 'US',
          search_volume: kw.search_volume,
          cpc_estimate:  kw.cpc_estimate,
          difficulty:    kw.difficulty,
        }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to track keyword')
      } else {
        setTracked(prev => new Set([...prev, kw.id]))
        toast.success(`Tracking "${kw.keyword}"`)
        if (workspaceId) loadTrackedKeywords(workspaceId)
      }
    } catch {
      toast.error('Failed to track keyword')
    } finally {
      setTrackingKw(null)
    }
  }

  // KPI computations
  const page1Count = trackedData.filter(k => k.page_status === 'page_1').length
  const top10Count = trackedData.filter(
    k => k.organic_rank !== null && k.organic_rank <= 10,
  ).length
  const improvedCount = trackedData.filter(
    k =>
      k.organic_rank !== null &&
      k.prev_organic_rank !== null &&
      k.organic_rank < k.prev_organic_rank,
  ).length
  const declinedCount = trackedData.filter(
    k =>
      k.organic_rank !== null &&
      k.prev_organic_rank !== null &&
      k.organic_rank > k.prev_organic_rank,
  ).length
  const rankedItems = trackedData.filter(k => k.organic_rank !== null)
  const avgRank =
    rankedItems.length > 0
      ? Math.round(
          rankedItems.reduce((a, k) => a + (k.organic_rank as number), 0) / rankedItems.length,
        )
      : null

  // Chart data
  const chartHistory = historyMap[selectedKeywordId] ?? []
  const chartData = chartHistory.slice(-chartRange)
  const hasChartData = chartData.some(d => d.rank !== null)
  const selectedKw = trackedData.find(k => k.id === selectedKeywordId)

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Keyword Tracker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Research Amazon keywords, monitor ranking movement and track page-one visibility.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => researchRef.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <Plus className="size-4" />
          Add Keywords
        </Button>
      </div>

      {/* ── 2. KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Tracked" value={trackedData.length} icon={Tag} />
        <KpiCard label="Page 1 Keywords" value={page1Count} icon={CheckCircle2} sub="rank ≤ 16" />
        <KpiCard label="Top 10 Keywords" value={top10Count} icon={BarChart2} sub="rank ≤ 10" />
        <KpiCard
          label="Improved"
          value={improvedCount}
          icon={TrendingUp}
          sub="vs previous check"
        />
        <KpiCard
          label="Declined"
          value={declinedCount}
          icon={TrendingDown}
          sub="vs previous check"
        />
        <KpiCard
          label="Average Rank"
          value={avgRank != null ? `#${avgRank}` : '—'}
          icon={Hash}
          sub="ranked keywords"
        />
      </div>

      {/* ── 3. Keyword research section ───────────────────────────────────── */}
      <div ref={researchRef} className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Keyword Research</h2>
        <form onSubmit={handleResearch} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor="seed-kw">Seed keyword</Label>
              <Input
                id="seed-kw"
                placeholder="e.g. desi ghee"
                value={seedKeyword}
                onChange={e => setSeedKeyword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kw-marketplace">Marketplace</Label>
              <select
                id="kw-marketplace"
                value={marketplace}
                onChange={e => setMarketplace(e.target.value as 'amazon.in' | 'amazon.com')}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="amazon.in">Amazon India</option>
                <option value="amazon.com">Amazon US</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kw-category">Category</Label>
              <select
                id="kw-category"
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All Categories</option>
                <option value="grocery">Grocery & Gourmet</option>
                <option value="health">Health & Personal Care</option>
                <option value="kitchen">Kitchen & Dining</option>
                <option value="sports">Sports & Fitness</option>
              </select>
            </div>
          </div>
          <div>
            <Button type="submit" disabled={isResearching || !seedKeyword.trim()}>
              {isResearching ? (
                <>
                  <RefreshCw className="size-4 animate-spin" />
                  Researching…
                </>
              ) : (
                <>
                  <Search className="size-4" />
                  Research Keywords
                </>
              )}
            </Button>
          </div>
        </form>

        {/* Research results table */}
        {researchResults && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">
                {researchResults.length} keywords found for &ldquo;{seedKeyword}&rdquo;
              </p>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    <th className="text-left px-4 py-3">Keyword</th>
                    <th className="text-right px-4 py-3">Volume</th>
                    <th className="text-right px-4 py-3">CPC (₹)</th>
                    <th className="text-center px-4 py-3">Competition</th>
                    <th className="text-left px-4 py-3">Difficulty</th>
                    <th className="text-center px-4 py-3">Intent</th>
                    <th className="text-left px-4 py-3">Top ASIN</th>
                    <th className="text-center px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {researchResults.map(kw => (
                    <tr key={kw.id} className="hover:bg-border/20 transition-colors">
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium text-foreground">{kw.keyword}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-foreground font-semibold tabular-nums">
                          {kw.search_volume != null ? kw.search_volume.toLocaleString('en-IN') : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {kw.cpc_estimate != null ? `₹${kw.cpc_estimate.toFixed(1)}` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs text-muted-foreground">—</span>
                      </td>
                      <td className="px-4 py-3">
                        {kw.difficulty != null
                          ? <DifficultyBar score={kw.difficulty} />
                          : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs text-muted-foreground">{kw.intent ?? '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {kw.top_ranking_asin
                          ? (
                            <Link
                              href={`/dashboard/asins/${kw.top_ranking_asin}`}
                              className="font-mono text-[11px] text-primary/70 hover:text-primary hover:underline"
                            >
                              {kw.top_ranking_asin}
                            </Link>
                          )
                          : <span className="text-xs text-muted-foreground font-mono">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => toggleTrack(kw)}
                          disabled={trackingKw === kw.id}
                          className={cn(
                            'inline-flex items-center gap-1 text-xs rounded-md px-2 py-1 font-medium transition-colors border disabled:opacity-50',
                            tracked.has(kw.id)
                              ? 'bg-green-500/10 text-green-400 border-green-500/20'
                              : 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20',
                          )}
                        >
                          {trackingKw === kw.id ? (
                            <><RefreshCw className="size-3 animate-spin" /> Saving…</>
                          ) : tracked.has(kw.id) ? (
                            <><CheckCircle2 className="size-3" /> Tracking</>
                          ) : (
                            <><Plus className="size-3" /> Track</>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!researchResults && (
          <div className="mt-6 flex flex-col items-center justify-center h-24 rounded-lg border border-dashed border-border gap-2">
            <Search className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              Enter a seed keyword and click Research to discover keywords
            </p>
          </div>
        )}
      </div>

      {/* ── 4. Rank tracking table ────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-foreground">Keyword Rank Tracking</h2>
          <Button
            type="button"
            variant="outline"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? (
              <><RefreshCw className="size-4 animate-spin" /> Refreshing…</>
            ) : (
              <><RefreshCw className="size-4" /> Refresh Ranks</>
            )}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                <th className="text-left px-6 py-3">Keyword</th>
                <th className="text-left px-4 py-3">ASIN</th>
                <th className="text-right px-4 py-3">Organic</th>
                <th className="text-right px-4 py-3">Previous</th>
                <th className="text-center px-4 py-3">Move</th>
                <th className="text-right px-4 py-3">Sponsored</th>
                <th className="text-center px-4 py-3">Page</th>
                <th className="text-right px-4 py-3">Volume</th>
                <th className="text-left px-4 py-3">Checked</th>
                <th className="text-center px-4 py-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {trackedData.map(kw => (
                <tr
                  key={kw.id}
                  className={cn(
                    'hover:bg-border/20 transition-colors cursor-pointer',
                    selectedKeywordId === kw.id && 'bg-primary/5',
                  )}
                  onClick={() => setSelectedKeywordId(kw.id)}
                >
                  <td className="px-6 py-3">
                    <div>
                      <p className="text-xs font-medium text-foreground">{kw.keyword}</p>
                      <p className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                        {kw.product_name}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-[11px] text-muted-foreground">{kw.asin}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        'text-xs font-semibold tabular-nums',
                        kw.organic_rank === null
                          ? 'text-muted-foreground'
                          : kw.organic_rank <= 3
                          ? 'text-green-400'
                          : kw.organic_rank <= 10
                          ? 'text-primary'
                          : 'text-foreground',
                      )}
                    >
                      {kw.organic_rank != null ? `#${kw.organic_rank}` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {kw.prev_organic_rank != null ? `#${kw.prev_organic_rank}` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <MovementChip current={kw.organic_rank} prev={kw.prev_organic_rank} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {kw.sponsored_rank != null ? `#${kw.sponsored_rank}` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <PageStatusBadge status={kw.page_status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {kw.search_volume.toLocaleString('en-IN')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(kw.last_checked)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Link
                      href={`/dashboard/asins/${kw.asin}`}
                      onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="size-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-6 py-3 text-[10px] text-muted-foreground border-t border-border">
          Click a row to view its rank trend chart below
        </p>
      </div>

      {/* ── 5. Rank trend chart ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Rank Trend</h2>
            {selectedKw && (
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="font-medium text-foreground">
                  &ldquo;{selectedKw.keyword}&rdquo;
                </span>{' '}
                · {selectedKw.asin}
                {selectedKw.organic_rank != null && (
                  <span className="ml-2 font-semibold text-primary">
                    Current: #{selectedKw.organic_rank}
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <select
              value={selectedKeywordId}
              onChange={e => setSelectedKeywordId(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {trackedData.map(k => (
                <option key={k.id} value={k.id}>
                  {k.keyword.length > 28 ? k.keyword.slice(0, 28) + '…' : k.keyword}
                </option>
              ))}
            </select>
            <RangeToggle value={chartRange} onChange={setChartRange} />
          </div>
        </div>

        {isMounted ? (
          hasChartData ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
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
                  interval="preserveStartEnd"
                />
                <YAxis
                  reversed
                  tick={{ fontSize: 11, fill: 'oklch(0.55 0.015 265)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={v => `#${v}`}
                  width={36}
                />
                <Tooltip content={<KwChartTooltip />} />
                <Line
                  type="monotone"
                  dataKey="rank"
                  stroke="oklch(0.741 0.174 66.5)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: 'oklch(0.741 0.174 66.5)' }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[240px] flex flex-col items-center justify-center gap-2">
              <BarChart2 className="size-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                No ranking data for this keyword yet
              </p>
              <p className="text-xs text-muted-foreground/60">
                Ranking will appear once the ASIN starts indexing
              </p>
            </div>
          )
        ) : (
          <div className="h-[240px] bg-border/20 rounded-lg animate-pulse" />
        )}
      </div>

      {/* ── 6. Keyword groups ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Keyword Groups</h2>
          <span className="text-xs text-muted-foreground">
            {KEYWORD_GROUPS.length} groups ·{' '}
            {KEYWORD_GROUPS.reduce((a, g) => a + g.keywords.length, 0)} total keywords
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {KEYWORD_GROUPS.map(g => (
            <GroupCard key={g.id} group={g} />
          ))}
        </div>
      </div>

      {/* ── 7. Alerts ─────────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Bell className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Keyword Alerts</h2>
          </div>
          <div className="flex gap-2">
            <Badge className="bg-red-500/15 text-red-400 border-red-500/20 text-xs">
              {KEYWORD_ALERTS.filter(a => a.severity === 'error').length} critical
            </Badge>
            <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/20 text-xs">
              {KEYWORD_ALERTS.filter(a => a.severity === 'warning').length} warning
            </Badge>
          </div>
        </div>
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-2">
          {KEYWORD_ALERTS.map(alert => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </div>
      </div>
    </div>
  )
}
