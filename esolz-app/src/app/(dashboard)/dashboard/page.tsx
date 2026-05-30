'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { getWorkspaceId, getAsinLimit, getTrackedAsins } from '@/lib/supabase/asins'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { InsightFeed } from '@/components/dashboard/InsightFeed'
import { Button } from '@/components/ui/button'
import { ProductSnapshot, Insight } from '@/types'
import {
  Package, TrendingUp, Star, Hash, Target,
  ShieldCheck, Activity, MapPin, RefreshCw, Plus, Loader2,
  CheckCircle2, Circle, ClipboardList,
} from 'lucide-react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ─── Data shape ───────────────────────────────────────────────────────────────

interface DashboardStats {
  asins:             ProductSnapshot[]
  asinLimit:         number
  planName:          string
  keywordCount:      number
  page1Keywords:     number
  buyBoxWon:         number
  pincodeChecksUsed: number
  productRefreshRuns: number
  buyboxChecks:      number
  pincodeChecks:     number
  keywordRefreshRuns: number
  amazonConnected:   boolean
  amazonListingsCount: number | null
  actionPlan:        ActionPlanItem[]
  recentActivity:    Insight[]
  lastChecked:       string | null
}

interface ActionPlanItem {
  id: string
  title: string
  description: string
  href: string
  ctaLabel: string
}

// ─── Data loader ─────────────────────────────────────────────────────────────

async function loadDashboardStats(workspaceId: string): Promise<DashboardStats> {
  const supabase = createClient()

  // 1. Tracked ASINs with latest snapshot + plan ASIN limit
  const [asins, asinLimit] = await Promise.all([
    getTrackedAsins(workspaceId),
    getAsinLimit(workspaceId),
  ])

  // 2. Plan name
  const { data: subRaw } = await supabase
    .from('workspace_subscriptions')
    .select('subscription_plans(name)')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planName = normalizeEmbed<{ name: string }>((subRaw as any)?.subscription_plans)?.name ?? 'Free'

  // Pincode usage this month
  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const { data: usageRow } = await supabase
    .from('usage_counters')
    .select('pincode_checks_used')
    .eq('workspace_id', workspaceId)
    .gte('period_start', periodStart)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  const pincodeChecksUsed = (usageRow?.pincode_checks_used as number) ?? 0

  // MVP onboarding progress stats
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anySupabase = supabase as any
  const [
    asinRefreshCountRes,
    buyboxCountRes,
    pincodeCountRes,
    connectionRes,
    listingCountRes,
    keywordSnapCountRes,
  ] = await Promise.all([
    anySupabase
      .from('asin_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    anySupabase
      .from('buybox_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    anySupabase
      .from('pincode_checks')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    anySupabase
      .from('amazon_connections')
      .select('status')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    anySupabase
      .from('amazon_listing_items')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    anySupabase
      .from('keyword_rank_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
  ])

  const connectionStatus = connectionRes?.data?.status as string | undefined
  const amazonConnected = connectionStatus === 'active' || connectionStatus === 'expired'
  const amazonListingsCount = listingCountRes?.error ? null : ((listingCountRes?.count as number | null) ?? 0)
  const keywordRefreshRuns = keywordSnapCountRes?.count ?? 0

  const empty: DashboardStats = {
    asins: [], asinLimit, planName,
    keywordCount: 0, page1Keywords: 0, buyBoxWon: 0,
    productRefreshRuns: asinRefreshCountRes.count ?? 0,
    buyboxChecks: buyboxCountRes.count ?? 0,
    pincodeChecks: pincodeCountRes.count ?? 0,
    keywordRefreshRuns,
    amazonConnected,
    amazonListingsCount,
    actionPlan: [],
    pincodeChecksUsed,
    recentActivity: [], lastChecked: null,
  }
  if (asins.length === 0) return empty

  const asinIds = asins.map(a => a.id)
  const labelMap: Record<string, string> = Object.fromEntries(asins.map(a => [a.id, a.label]))

  // 3. Total tracked keywords for this workspace
  const { count: keywordCount } = await supabase
    .from('tracked_keywords')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)

  // 4. Page 1 keyword count — latest snapshot per keyword_id
  const { data: kwSnaps } = await supabase
    .from('keyword_rank_snapshots')
    .select('tracked_keyword_id, page_status, checked_at')
    .eq('workspace_id', workspaceId)
    .order('checked_at', { ascending: false })

  const latestKwStatus = new Map<string, string>()
  for (const row of kwSnaps ?? []) {
    if (!latestKwStatus.has(row.tracked_keyword_id)) {
      latestKwStatus.set(row.tracked_keyword_id, row.page_status as string)
    }
  }
  const page1Keywords = [...latestKwStatus.values()].filter(s => s === 'page_1').length

  // 5. Buy Box won — latest buybox_snapshot per ASIN
  const { data: bbSnaps } = await supabase
    .from('buybox_snapshots')
    .select('tracked_asin_id, buy_box_status, checked_at')
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })

  const latestBbStatus = new Map<string, string>()
  for (const row of bbSnaps ?? []) {
    if (!latestBbStatus.has(row.tracked_asin_id)) {
      latestBbStatus.set(row.tracked_asin_id, (row.buy_box_status as string) ?? '')
    }
  }
  const buyBoxWon = [...latestBbStatus.values()].filter(s => s === 'won').length

  // 6. Today action plan signals
  const actionPlan: ActionPlanItem[] = []
  const now = Date.now()
  const oneDayMs = 24 * 60 * 60 * 1000

  const neverRefreshedAsins = asins.filter(a => !a.captured_at)
  if (neverRefreshedAsins.length > 0) {
    actionPlan.push({
      id: 'never-refreshed',
      title: `${neverRefreshedAsins.length} ASIN${neverRefreshedAsins.length === 1 ? '' : 's'} never refreshed`,
      description: 'Run your first product refresh to populate BSR and pricing data.',
      href: '/dashboard/asins',
      ctaLabel: 'Refresh ASINs',
    })
  }

  const staleAsins = asins.filter(a => a.captured_at && (now - new Date(a.captured_at).getTime()) > oneDayMs)
  if (staleAsins.length > 0) {
    actionPlan.push({
      id: 'stale-asins',
      title: `${staleAsins.length} ASIN${staleAsins.length === 1 ? '' : 's'} stale (>24h)`,
      description: 'Update stale ASINs so decisions are based on current marketplace data.',
      href: '/dashboard/asins',
      ctaLabel: 'Update Stale Data',
    })
  }

  const { data: buyboxRows } = await supabase
    .from('buybox_snapshots')
    .select('tracked_asin_id, buy_box_status, checked_at')
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })
    .limit(500)

  const latestBuyboxStatusByAsin = new Map<string, string>()
  for (const row of buyboxRows ?? []) {
    const asinId = row.tracked_asin_id as string
    if (!latestBuyboxStatusByAsin.has(asinId)) {
      latestBuyboxStatusByAsin.set(asinId, (row.buy_box_status as string) ?? '')
    }
  }
  const buyboxLostCount = [...latestBuyboxStatusByAsin.values()].filter(v => v === 'lost').length
  if (buyboxLostCount > 0) {
    actionPlan.push({
      id: 'buybox-lost',
      title: `${buyboxLostCount} ASIN${buyboxLostCount === 1 ? '' : 's'} lost Buy Box`,
      description: 'Review pricing and fulfillment to recover Buy Box ownership.',
      href: '/dashboard/buybox',
      ctaLabel: 'Review Buy Box',
    })
  }

  const { data: pincodeRows } = await supabase
    .from('pincode_checks')
    .select('tracked_asin_id, available, checked_at')
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })
    .limit(800)

  const pincodeByAsin = new Map<string, { available: boolean }[]>()
  for (const row of pincodeRows ?? []) {
    const asinId = row.tracked_asin_id as string
    const list = pincodeByAsin.get(asinId) ?? []
    if (list.length < 10) {
      list.push({ available: !!row.available })
      pincodeByAsin.set(asinId, list)
    }
  }
  const lowAvailabilityCount = [...pincodeByAsin.values()].filter(rows => {
    if (rows.length < 3) return false
    const pct = Math.round((rows.filter(r => r.available).length / rows.length) * 100)
    return pct < 50
  }).length
  if (lowAvailabilityCount > 0) {
    actionPlan.push({
      id: 'low-pincode',
      title: `${lowAvailabilityCount} ASIN${lowAvailabilityCount === 1 ? '' : 's'} low pincode availability`,
      description: 'These products are unavailable in many checked pincodes.',
      href: '/dashboard/pincode',
      ctaLabel: 'Check Pincodes',
    })
  }

  const { data: trackedKeywords } = await supabase
    .from('tracked_keywords')
    .select('id')
    .eq('workspace_id', workspaceId)

  const trackedKeywordIds = (trackedKeywords ?? []).map(k => k.id as string)
  let keywordIssueCount = 0
  if (trackedKeywordIds.length > 0) {
    const { data: keywordSnaps } = await supabase
      .from('keyword_rank_snapshots')
      .select('tracked_keyword_id, organic_rank, page_status, checked_at')
      .in('tracked_keyword_id', trackedKeywordIds)
      .order('checked_at', { ascending: false })
      .limit(1200)

    const latestByKeyword = new Map<string, { organic_rank: number | null; page_status: string | null }>()
    for (const row of keywordSnaps ?? []) {
      const kwId = row.tracked_keyword_id as string
      if (!latestByKeyword.has(kwId)) {
        latestByKeyword.set(kwId, {
          organic_rank: (row.organic_rank as number | null) ?? null,
          page_status: (row.page_status as string | null) ?? null,
        })
      }
    }

    keywordIssueCount = trackedKeywordIds.filter(kwId => {
      const latest = latestByKeyword.get(kwId)
      if (!latest) return true
      return latest.page_status === 'not_ranking' || latest.organic_rank === null
    }).length
  }

  if (keywordIssueCount > 0) {
    actionPlan.push({
      id: 'keyword-issues',
      title: `${keywordIssueCount} keyword${keywordIssueCount === 1 ? '' : 's'} not ranking or never checked`,
      description: 'Refresh keyword ranks and optimize low-visibility terms.',
      href: '/dashboard/keywords',
      ctaLabel: 'Fix Keywords',
    })
  }

  // 7. Recent activity — latest events across all snapshot tables (run in parallel)
  const [bsrEvts, bbEvts, pinEvts, kwRankEvts, addedEvts] = await Promise.all([
    supabase
      .from('asin_snapshots')
      .select('tracked_asin_id, checked_at')
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })
      .limit(5),
    supabase
      .from('buybox_snapshots')
      .select('tracked_asin_id, buy_box_status, checked_at')
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })
      .limit(5),
    supabase
      .from('pincode_checks')
      .select('tracked_asin_id, pincode, available, checked_at')
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })
      .limit(5),
    supabase
      .from('keyword_rank_snapshots')
      .select('tracked_keyword_id, page_status, checked_at, tracked_keywords(keyword)')
      .eq('workspace_id', workspaceId)
      .order('checked_at', { ascending: false })
      .limit(5),
    supabase
      .from('tracked_asins')
      .select('id, asin, product_title, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activityRaw: Insight[] = [
    ...(bsrEvts.data ?? []).map((e, i) => ({
      id: `bsr-${i}`,
      type: 'scrape_complete' as const,
      title: 'BSR Refreshed',
      description: `Updated data for ${labelMap[e.tracked_asin_id] ?? e.tracked_asin_id}`,
      timestamp: e.checked_at as string,
      severity: 'info' as const,
    })),
    ...(bbEvts.data ?? []).map((e, i) => ({
      id: `bb-${i}`,
      type: 'bsr_change' as const,
      title: e.buy_box_status === 'won' ? 'Buy Box Won ✓' : 'Buy Box Checked',
      description: `Status: ${(e.buy_box_status as string) ?? '—'} — ${labelMap[e.tracked_asin_id] ?? e.tracked_asin_id}`,
      timestamp: e.checked_at as string,
      severity: (e.buy_box_status === 'won' ? 'success' : 'info') as Insight['severity'],
    })),
    ...(pinEvts.data ?? []).map((e, i) => ({
      id: `pin-${i}`,
      type: 'scrape_complete' as const,
      title: 'Pincode Checked',
      description: `${e.pincode as string}: ${e.available ? 'Available ✓' : 'Not available'} — ${labelMap[e.tracked_asin_id] ?? ''}`,
      timestamp: e.checked_at as string,
      severity: (e.available ? 'success' : 'warning') as Insight['severity'],
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(kwRankEvts.data ?? []).map((e: any, i: number) => {
      const kw = normalizeEmbed<{ keyword: string }>(e.tracked_keywords)
      return {
        id: `kw-${i}`,
        type: 'scrape_complete' as const,
        title: 'Keyword Rank Refreshed',
        description: `"${kw?.keyword ?? '—'}" — ${(e.page_status as string)?.replace('_', ' ') ?? 'checked'}`,
        timestamp: e.checked_at as string,
        severity: (e.page_status === 'page_1' ? 'success' : 'info') as Insight['severity'],
      }
    }),
    ...(addedEvts.data ?? []).map((e, i) => ({
      id: `add-${i}`,
      type: 'new_asin' as const,
      title: 'ASIN Added',
      description: `${(e.product_title as string) ?? e.asin} is now being tracked`,
      timestamp: e.created_at as string,
      severity: 'info' as const,
    })),
  ]

  const recentActivity = activityRaw
    .filter(e => Boolean(e.timestamp))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10)

  // Most recent check timestamp
  const allTs = [
    ...(bsrEvts.data ?? []).map(e => e.checked_at as string),
    ...(bbEvts.data ?? []).map(e => e.checked_at as string),
    ...(pinEvts.data ?? []).map(e => e.checked_at as string),
  ].filter(Boolean).sort()
  const lastChecked = allTs.length > 0 ? allTs[allTs.length - 1] : null

  return {
    asins, asinLimit, planName,
    keywordCount: keywordCount ?? 0,
    page1Keywords, buyBoxWon, pincodeChecksUsed,
    productRefreshRuns: asinRefreshCountRes.count ?? 0,
    buyboxChecks: buyboxCountRes.count ?? 0,
    pincodeChecks: pincodeCountRes.count ?? 0,
    keywordRefreshRuns,
    amazonConnected,
    amazonListingsCount,
    actionPlan: actionPlan.slice(0, 5),
    recentActivity, lastChecked,
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [stats, setStats]   = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const wsId = await getWorkspaceId()
    if (!wsId) { setLoading(false); return }
    const data = await loadDashboardStats(wsId)
    setStats(data)
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const asins        = stats?.asins ?? []
  const hasSnapshots = asins.some(a => a.captured_at !== null)

  // Computed summary stats from fetched ASIN data
  const ranked = asins.filter(a => a.bsr_rank !== null)
  const avgBsr = ranked.length > 0
    ? Math.round(ranked.reduce((s, a) => s + (a.bsr_rank ?? 0), 0) / ranked.length)
    : null

  const ratedAsins = asins.filter(a => a.rating !== null)
  const avgRating  = ratedAsins.length > 0
    ? (ratedAsins.reduce((s, a) => s + (a.rating ?? 0), 0) / ratedAsins.length).toFixed(1)
    : null

  const scoredAsins    = asins.filter(a => a.availability_score !== null)
  const avgAvailability = scoredAsins.length > 0
    ? Math.round(scoredAsins.reduce((s, a) => s + (a.availability_score ?? 0), 0) / scoredAsins.length)
    : null

  const isFreePlan = !stats?.planName || stats.planName === 'Free'

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading dashboard…</span>
      </div>
    )
  }

  // ── Empty state: no ASINs yet ─────────────────────────────────────────────
  if (asins.length === 0) {
    return (
      <div className="space-y-6 max-w-7xl">
        <div className="bg-card border border-border rounded-xl flex flex-col items-center justify-center py-20 text-center gap-4">
          <Package className="w-12 h-12 text-muted-foreground/40" />
          <div>
            <p className="font-semibold text-lg">No ASINs tracked yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add your first ASIN to start tracking BSR, keywords, and availability.
            </p>
          </div>
          <Button render={<Link href="/dashboard/asins" />} className="mt-2">
            <Plus className="w-4 h-4 mr-1.5" /> Add your first ASIN
          </Button>
        </div>
        <OnboardingChecklist stats={stats} asinsCount={asins.length} />
        <UpgradeBanner planName={stats?.planName ?? 'Free'} />
      </div>
    )
  }

  // ── Full dashboard ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-7xl">

      <div className="rounded-xl border border-border bg-card px-5 py-4">
        <p className="text-sm text-muted-foreground">
          See your Amazon performance at a glance, then follow the checklist and action plan to get your first wins fast. Data source: tracked_asins, snapshots, alerts and Amazon connection tables.
        </p>
      </div>

      {/* KPI Row 1 — ASIN & performance */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Tracked ASINs"
          value={asins.length}
          sub={`${asins.length} of ${stats?.asinLimit ?? 5} used`}
          icon={Package}
        />
        <KpiCard
          label="Avg BSR Rank"
          value={avgBsr !== null ? `#${avgBsr.toLocaleString('en-IN')}` : '—'}
          sub={avgBsr !== null ? `across ${ranked.length} ASINs with data` : 'Refresh an ASIN to see BSR'}
          icon={TrendingUp}
        />
        <KpiCard
          label="Avg Rating"
          value={avgRating !== null ? `${avgRating} ★` : '—'}
          sub={avgRating !== null ? `from ${ratedAsins.length} ASINs` : 'No rating data yet'}
          icon={Star}
        />
        <KpiCard
          label="Avg Availability"
          value={avgAvailability !== null ? `${avgAvailability}%` : '—'}
          sub={avgAvailability !== null ? `across ${scoredAsins.length} ASINs` : 'No availability data yet'}
          icon={Activity}
        />
      </div>

      {/* KPI Row 2 — Keywords, Buy Box, Pincodes */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Tracked Keywords"
          value={stats?.keywordCount ?? 0}
          sub="across all ASINs"
          icon={Hash}
        />
        <KpiCard
          label="Page 1 Keywords"
          value={stats?.page1Keywords ?? 0}
          sub={stats?.keywordCount ? `of ${stats.keywordCount} tracked` : 'No rank data yet'}
          icon={Target}
        />
        <KpiCard
          label="Buy Box Won"
          value={stats?.buyBoxWon ?? 0}
          sub={`of ${asins.length} ASINs (latest check)`}
          icon={ShieldCheck}
        />
        <KpiCard
          label="Pincode Checks"
          value={stats?.pincodeChecksUsed ?? 0}
          sub="used this month"
          icon={MapPin}
        />
      </div>

      <OnboardingChecklist stats={stats} asinsCount={asins.length} />

      <TodayActionPlan items={stats?.actionPlan ?? []} />

      {/* ASIN Performance table + Recent Activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ASIN Performance */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="font-bold">ASIN Performance</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()} className="h-8 gap-1.5 text-xs">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Button>
              <Button size="sm" render={<Link href="/dashboard/asins" />} className="h-8 gap-1.5 text-xs">
                <Plus className="w-3.5 h-3.5" /> Add ASIN
              </Button>
            </div>
          </div>

          {!hasSnapshots ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-2">
              <RefreshCw className="w-8 h-8 opacity-30" />
              <p className="text-sm font-medium">No snapshot data yet</p>
              <p className="text-xs">Open an ASIN and click Refresh to see performance metrics.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border/60">
                    <th className="text-left px-5 py-3 font-semibold uppercase tracking-wider">ASIN</th>
                    <th className="text-left px-3 py-3 font-semibold uppercase tracking-wider">Product</th>
                    <th className="text-right px-3 py-3 font-semibold uppercase tracking-wider">BSR</th>
                    <th className="text-right px-3 py-3 font-semibold uppercase tracking-wider hidden sm:table-cell">Price</th>
                    <th className="text-right px-3 py-3 font-semibold uppercase tracking-wider hidden md:table-cell">Rating</th>
                    <th className="text-right px-5 py-3 font-semibold uppercase tracking-wider hidden lg:table-cell">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {asins.map((asin, i) => (
                    <tr
                      key={asin.id}
                      className={`hover:bg-muted/20 transition-colors ${
                        i < asins.length - 1 ? 'border-b border-border/40' : ''
                      }`}
                    >
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/asins/${asin.asin}`}
                          className="font-mono text-xs text-blue-400 hover:underline"
                        >
                          {asin.asin}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-sm max-w-[180px] truncate">{asin.label}</td>
                      <td className="px-3 py-3 text-right font-bold">
                        {asin.bsr_rank !== null
                          ? `#${asin.bsr_rank.toLocaleString('en-IN')}`
                          : <span className="text-muted-foreground font-normal text-xs">—</span>
                        }
                      </td>
                      <td className="px-3 py-3 text-right text-sm hidden sm:table-cell">
                        {asin.price !== null
                          ? `₹${asin.price.toLocaleString('en-IN')}`
                          : <span className="text-muted-foreground text-xs">—</span>
                        }
                      </td>
                      <td className="px-3 py-3 text-right text-sm hidden md:table-cell">
                        {asin.rating !== null
                          ? `${asin.rating} ★`
                          : <span className="text-muted-foreground text-xs">—</span>
                        }
                      </td>
                      <td className="px-5 py-3 text-right text-xs text-muted-foreground hidden lg:table-cell">
                        {asin.captured_at ? timeAgo(asin.captured_at) : 'Never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="px-5 py-3 border-t border-border/60">
            <Link href="/dashboard/asins" className="text-xs text-primary hover:underline">
              Manage all ASINs →
            </Link>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="font-bold">Recent Activity</h2>
          </div>
          <div className="p-3">
            <InsightFeed insights={stats?.recentActivity ?? []} />
          </div>
        </div>

      </div>

      {/* Upgrade banner — only shown on Free plan */}
      {isFreePlan && <UpgradeBanner planName={stats?.planName ?? 'Free'} />}

    </div>
  )
}

function TodayActionPlan({ items }: { items: ActionPlanItem[] }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <ClipboardList className="w-4 h-4 text-primary" />
        <div>
          <h2 className="font-bold">Today&apos;s Action Plan</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Top actions from current data signals (max 5).</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No urgent actions right now</p>
          <p className="text-xs text-muted-foreground mt-1">
            Great start. Keep refreshing ASIN, Buy Box, pincode, and keyword data to maintain visibility.
          </p>
        </div>
      ) : (
        <div className="px-5 py-4 flex flex-col gap-2.5">
          {items.map(item => (
            <div key={item.id} className="rounded-lg border border-border px-3 py-2.5 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
              </div>
              <Button size="sm" variant="outline" render={<Link href={item.href} />}>
                {item.ctaLabel}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OnboardingChecklist({ stats, asinsCount }: { stats: DashboardStats | null; asinsCount: number }) {
  const listingsCount = stats?.amazonListingsCount

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="font-bold">Onboarding Checklist</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Complete these steps to get your first insights running.
        </p>
      </div>
      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <ChecklistItem
          done={asinsCount > 0}
          label="Add or import your first ASIN"
          hint={`${asinsCount} tracked${(listingsCount ?? 0) > 0 ? ` · ${listingsCount} listing import available` : ''}`}
          href="/dashboard/asins"
          ctaLabel="Go to ASINs"
        />
        <ChecklistItem
          done={(stats?.productRefreshRuns ?? 0) > 0}
          label="Run product refresh"
          hint={`${stats?.productRefreshRuns ?? 0} refresh snapshot${(stats?.productRefreshRuns ?? 0) === 1 ? '' : 's'}`}
          href="/dashboard/asins"
          ctaLabel="Refresh Products"
        />
        <ChecklistItem
          done={(stats?.buyboxChecks ?? 0) > 0}
          label="Run Buy Box check"
          hint={`${stats?.buyboxChecks ?? 0} Buy Box check${(stats?.buyboxChecks ?? 0) === 1 ? '' : 's'}`}
          href="/dashboard/buybox"
          ctaLabel="Check Buy Box"
        />
        <ChecklistItem
          done={(stats?.pincodeChecks ?? 0) > 0}
          label="Run Pincode check"
          hint={`${stats?.pincodeChecks ?? 0} pincode check${(stats?.pincodeChecks ?? 0) === 1 ? '' : 's'}`}
          href="/dashboard/pincode"
          ctaLabel="Check Pincodes"
        />
        <ChecklistItem
          done={(stats?.keywordCount ?? 0) > 0 && (stats?.keywordRefreshRuns ?? 0) > 0}
          label="Add/refresh keyword"
          hint={`${stats?.keywordCount ?? 0} tracked · ${stats?.keywordRefreshRuns ?? 0} rank snapshot${(stats?.keywordRefreshRuns ?? 0) === 1 ? '' : 's'}`}
          href="/dashboard/keywords"
          ctaLabel="Track Keywords"
        />
        <ChecklistItem
          done={!!stats?.amazonConnected}
          optional
          label="Connect Amazon account"
          hint={stats?.amazonConnected ? 'Connected' : 'Not connected'}
          href="/dashboard/settings"
          ctaLabel="Connect Amazon"
        />
        <ChecklistItem
          done={(listingsCount ?? 0) > 0}
          optional
          label="Sync Amazon listings"
          hint={
            listingsCount === null || listingsCount === undefined
              ? 'Listing table not available yet'
              : `${listingsCount} listing${listingsCount === 1 ? '' : 's'} synced`
          }
          href="/dashboard/settings"
          ctaLabel="Sync Listings"
        />
      </div>
    </div>
  )
}

function ChecklistItem({
  done,
  label,
  hint,
  href,
  ctaLabel,
  optional = false,
}: {
  done: boolean
  label: string
  hint: string
  href: string
  ctaLabel: string
  optional?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        {done ? (
          <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5" />
        ) : (
          <Circle className="w-4 h-4 text-muted-foreground mt-0.5" />
        )}
        <div>
          <p className="text-sm font-medium text-foreground">
            {label}
            {optional && <span className="ml-1 text-xs text-muted-foreground font-normal">(Optional)</span>}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
        </div>
      </div>
      {done ? (
        <span className="text-[11px] text-green-600 font-medium mt-0.5">Done</span>
      ) : (
        <Button size="sm" variant="outline" render={<Link href={href} />}>
          {ctaLabel}
        </Button>
      )}
    </div>
  )
}

// ─── Upgrade Banner ───────────────────────────────────────────────────────────

function UpgradeBanner({ planName }: { planName: string }) {
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-xl px-5 py-4 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
      <div>
        <p className="font-semibold text-sm">You&apos;re on the {planName} plan</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Upgrade to track more ASINs, unlock faster refreshes, and access all tools.
        </p>
      </div>
      <Button size="sm" render={<Link href="/dashboard/billing" />} className="flex-shrink-0">
        Upgrade Now
      </Button>
    </div>
  )
}
