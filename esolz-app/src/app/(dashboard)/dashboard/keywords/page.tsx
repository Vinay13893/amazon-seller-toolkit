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
import { DataFreshnessBadge } from '@/components/dashboard/DataFreshnessBadge'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Hash,
  Search,
  TrendingUp,
  TrendingDown,
  BarChart2,
  CheckCircle2,
  ExternalLink,
  Plus,
  Tag,
  RefreshCw,
  Minus,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { addTrackedAsin, getAsinLimit, incrementAsinUsage, type AddAsinInput } from '@/lib/supabase/asins'
import { Marketplace } from '@/types'
import { toast } from 'sonner'

interface KeywordSnapshotRow {
  tracked_keyword_id: string
  organic_rank: number | null
  sponsored_rank: number | null
  page_status: string | null
  checked_at: string
  page: number | null
  found: boolean | null
  scrape_status: string | null
  error_message: string | null
}

interface TrackedKeywordRow {
  id: string
  keyword: string
  asin: string
  product_name: string
  organic_rank: number | null
  prev_organic_rank: number | null
  sponsored_rank: number | null
  page_status: 'page_1' | 'page_2' | 'page_3' | 'not_ranking'
  search_volume: number
  last_checked: string | null
  found: boolean
  scrape_status: 'never_checked' | 'success' | 'failed'
  error_message: string | null
  page: number | null
}

interface KeywordHistoryPoint {
  date: string
  rank: number | null
  checked_at: string
  page: number | null
  found: boolean
  scrape_status: string
  error_message: string | null
}

interface ProductOption {
  key: string
  asin: string
  marketplace: Marketplace
  title: string
  sku: string | null
  brand: string | null
  productType: string | null
  imageUrl: string | null
  source: 'tracked' | 'listing' | 'external'
  trackedAsinId: string | null
}

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

function marketplaceFromMarketplaceId(marketplaceId: string): Marketplace {
  const map: Record<string, Marketplace> = {
    A21TJRUUN4KGV: 'IN',
    ATVPDKIKX0DER: 'US',
    A1F83G8C2ARO7P: 'UK',
    A1PA6795UKMFR9: 'DE',
  }
  return map[marketplaceId] ?? 'IN'
}

function buildProductKey(asin: string, marketplace: Marketplace): string {
  return `${asin.toUpperCase()}|${marketplace}`
}

function toMarketplace(marketplace: string): Marketplace {
  if (marketplace === 'US' || marketplace === 'UK' || marketplace === 'DE') return marketplace
  return 'IN'
}

function sourceLabel(product: ProductOption): string {
  const category = (product.productType ?? '').toLowerCase()
  const title = product.title.toLowerCase()
  if (product.source === 'external') {
    if (category.includes('competitor') || category.includes('external') || title.includes('competitor')) {
      return 'Competitor / External'
    }
    return 'External ASIN'
  }
  return product.source === 'tracked' ? 'Tracked ASIN' : 'Amazon Listing'
}

function getKeywordSeedSuggestions(product: ProductOption | null): string[] {
  if (!product) return []

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'your', 'this', 'that', 'pack', 'set', 'of', 'in', 'to', 'on', 'by',
  ])
  const titleWords = product.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))

  const productTypeWords = (product.productType ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))

  const brandWord = (product.brand ?? '').toLowerCase().trim()

  const seeds = new Set<string>()
  for (let i = 0; i < Math.min(titleWords.length - 1, 4); i += 1) {
    seeds.add(`${titleWords[i]} ${titleWords[i + 1]}`)
  }
  if (titleWords[0] && productTypeWords[0]) seeds.add(`${titleWords[0]} ${productTypeWords[0]}`)
  if (titleWords[1] && productTypeWords[0]) seeds.add(`${titleWords[1]} ${productTypeWords[0]}`)
  if (brandWord && titleWords[0]) seeds.add(`${brandWord} ${titleWords[0]}`)
  if (brandWord && productTypeWords[0]) seeds.add(`${brandWord} ${productTypeWords[0]}`)

  return [...seeds].slice(0, 8)
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

function FoundStatusBadge({ kw }: { kw: TrackedKeywordRow }) {
  if (kw.scrape_status === 'never_checked') {
    return <Badge className="text-xs bg-muted text-muted-foreground border-border">Never checked</Badge>
  }
  if (kw.scrape_status === 'failed') {
    return <Badge className="text-xs bg-red-500/15 text-red-400 border-red-500/20">Last check failed</Badge>
  }
  return kw.found
    ? <Badge className="text-xs bg-green-500/15 text-green-400 border-green-500/20">Found</Badge>
    : <Badge className="text-xs bg-yellow-500/15 text-yellow-400 border-yellow-500/20">Not found</Badge>
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

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function KeywordsPage() {
  const [seedKeyword, setSeedKeyword] = useState('')
  const [marketplace, setMarketplace] = useState<'amazon.in' | 'amazon.com'>('amazon.in')
  const [category, setCategory] = useState('all')
  const [isResearching, setIsResearching] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [productsLoading, setProductsLoading] = useState(false)
  const [productOptions, setProductOptions] = useState<ProductOption[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [selectedProductKey, setSelectedProductKey] = useState('')
  const [trackingAsinKey, setTrackingAsinKey] = useState<string | null>(null)
  const [trackingExternalAsin, setTrackingExternalAsin] = useState(false)
  const [externalMarketplace, setExternalMarketplace] = useState<Marketplace>('IN')
  const [externalTitle, setExternalTitle] = useState('')
  const [externalBrand, setExternalBrand] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [bulkKeywordInput, setBulkKeywordInput] = useState('')
  const [addingKeyword, setAddingKeyword] = useState(false)
  const [researchResults, setResearchResults] = useState<ApiResearchResult[] | null>(null)
  const [trackedData, setTrackedData] = useState<TrackedKeywordRow[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [tracked, setTracked] = useState<Set<string>>(new Set())
  const [trackingKw, setTrackingKw] = useState<string | null>(null)
  const [selectedKeywordId, setSelectedKeywordId] = useState<string>('')
  const [historyMap, setHistoryMap] = useState<Record<string, KeywordHistoryPoint[]>>({})
  const [chartRange, setChartRange] = useState<7 | 14 | 30>(7)
  const [isMounted, setIsMounted] = useState(false)
  const researchRef = useRef<HTMLDivElement>(null)

  const selectedProduct = productOptions.find(p => p.key === selectedProductKey) ?? null
  const suggestedSeeds = getKeywordSeedSuggestions(selectedProduct)
  const normalizedSearch = productSearch.trim().toUpperCase().replace(/\s+/g, '')
  const isValidAsinInput = /^[A-Z0-9]{10}$/.test(normalizedSearch)
  const isAsinLikeInput = normalizedSearch.length > 0 && /^[A-Z0-9]+$/.test(normalizedSearch)
  const hasMatchingAsin = isValidAsinInput && productOptions.some(p => p.asin === normalizedSearch)
  const showExternalAsinCard = isValidAsinInput && !hasMatchingAsin
  const showInvalidAsinHint = productSearch.trim().length > 0 && isAsinLikeInput && !isValidAsinInput

  const filteredProducts = productOptions.filter(p => {
    const q = productSearch.trim().toLowerCase()
    if (!q) return true
    return (
      p.asin.toLowerCase().includes(q) ||
      p.title.toLowerCase().includes(q) ||
      (p.sku ?? '').toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q)
    )
  })
  const visibleProducts = filteredProducts.slice(0, 8)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // ── Load workspace + tracked keywords ─────────────────────────────────────────────
  const loadProductOptions = useCallback(async (wsId: string) => {
    setProductsLoading(true)
    const supabase = createClient()
    try {
      const [trackedAsinsRes, listingItemsRes] = await Promise.all([
        supabase
          .from('tracked_asins')
          .select('id, asin, marketplace, product_title, brand, category, image_url, status')
          .eq('workspace_id', wsId)
          .neq('status', 'archived')
          .order('created_at', { ascending: false }),
        supabase
          .from('amazon_listing_items')
          .select('id, sku, asin, marketplace_id, item_name, brand, product_type, image_url, status')
          .eq('workspace_id', wsId)
          .not('asin', 'is', null)
          .order('item_name', { ascending: true })
          .limit(300),
      ])

      const map = new Map<string, ProductOption>()

      for (const row of trackedAsinsRes.data ?? []) {
        const mp = toMarketplace(row.marketplace as string)
        const key = buildProductKey(row.asin as string, mp)
        const category = (row.category as string | null) ?? null
        const title = (row.product_title as string | null) ?? (row.asin as string)
        const externalByContent =
          (category ?? '').toLowerCase().includes('external') ||
          (category ?? '').toLowerCase().includes('competitor') ||
          title.toLowerCase().startsWith('external asin ')
        map.set(key, {
          key,
          asin: (row.asin as string).toUpperCase(),
          marketplace: mp,
          title,
          sku: null,
          brand: (row.brand as string | null) ?? null,
          productType: category,
          imageUrl: (row.image_url as string | null) ?? null,
          source: externalByContent ? 'external' : 'tracked',
          trackedAsinId: row.id as string,
        })
      }

      for (const row of listingItemsRes.data ?? []) {
        const asin = (row.asin as string | null)?.toUpperCase()
        if (!asin) continue
        const mp = marketplaceFromMarketplaceId(row.marketplace_id as string)
        const key = buildProductKey(asin, mp)
        if (map.has(key)) continue
        map.set(key, {
          key,
          asin,
          marketplace: mp,
          title: (row.item_name as string | null) ?? asin,
          sku: (row.sku as string | null) ?? null,
          brand: (row.brand as string | null) ?? null,
          productType: (row.product_type as string | null) ?? null,
          imageUrl: (row.image_url as string | null) ?? null,
          source: 'listing',
          trackedAsinId: null,
        })
      }

      const merged = [...map.values()].sort((a, b) => a.title.localeCompare(b.title))
      setProductOptions(merged)
      setSelectedProductKey(prev => (merged.find(p => p.key === prev) ? prev : ''))
    } finally {
      setProductsLoading(false)
    }
  }, [])

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
      .select('tracked_keyword_id, organic_rank, sponsored_rank, page_status, checked_at, page, found, scrape_status, error_message')
      .in('tracked_keyword_id', kws.map(k => k.id))
      .order('checked_at', { ascending: false })

    const snapsByKw: Record<string, KeywordSnapshotRow[]> = {}
    for (const s of snaps ?? []) {
      if (!snapsByKw[s.tracked_keyword_id]) snapsByKw[s.tracked_keyword_id] = []
      snapsByKw[s.tracked_keyword_id].push(s as KeywordSnapshotRow)
    }

    const mapped: TrackedKeywordRow[] = kws.map(kw => {
      const kwSnaps = snapsByKw[kw.id] ?? []
      const latest  = kwSnaps[0]
      const prev    = kwSnaps[1]
      const latestFound = latest
        ? (latest.found ?? latest.organic_rank !== null)
        : false
      const scrapeStatus = latest
        ? ((latest.scrape_status as 'success' | 'failed' | null) ?? 'success')
        : 'never_checked'
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
        page_status:       (latest?.page_status    ?? 'not_ranking') as TrackedKeywordRow['page_status'],
        search_volume:     kw.search_volume        ?? 0,
        last_checked:      latest?.checked_at      ?? null,
        found:             latestFound,
        scrape_status:     scrapeStatus,
        error_message:     latest?.error_message ?? null,
        page:              latest?.page ?? null,
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
      .select('organic_rank, checked_at, page, found, scrape_status, error_message')
      .eq('tracked_keyword_id', kwId)
      .order('checked_at', { ascending: true })
      .limit(90)
    if (data && data.length > 0) {
      const history: KeywordHistoryPoint[] = data.map(s => ({
        date: new Date(s.checked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        rank: s.organic_rank,
        checked_at: s.checked_at,
        page: s.page ?? null,
        found: s.found ?? s.organic_rank !== null,
        scrape_status: s.scrape_status ?? 'success',
        error_message: s.error_message ?? null,
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
            loadProductOptions(member.workspace_id)
            loadTrackedKeywords(member.workspace_id)
          }
        })
    })
  }, [loadProductOptions, loadTrackedKeywords])

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
    if (trackedData.length === 0) {
      toast.warning('Add at least one keyword first.')
      return
    }
    setIsRefreshing(true)
    try {
      const res = await fetch('/api/keywords/refresh', { method: 'POST' })
      const data = await res.json() as { checked?: number; message?: string; error?: string; ok?: boolean; status?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Refresh failed')
      } else if (data.status === 'failed') {
        toast.info('Keyword checker is temporarily unavailable. Your keyword was saved and will be checked later.')
        if (workspaceId) await loadTrackedKeywords(workspaceId)
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

  async function handleTrackSelectedAsin(product: ProductOption) {
    if (!workspaceId) return

    if (product.trackedAsinId) {
      setSelectedProductKey(product.key)
      return
    }

    setTrackingAsinKey(product.key)
    try {
      const supabase = createClient()
      const [asinLimit, trackedCountRes] = await Promise.all([
        getAsinLimit(workspaceId),
        supabase
          .from('tracked_asins')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('status', 'archived'),
      ])
      const trackedCount = trackedCountRes.count ?? 0
      if (trackedCount >= asinLimit) {
        toast.error('You have reached your ASIN limit for this plan.')
        return
      }

      const payload: AddAsinInput = {
        asin: product.asin,
        productTitle: product.title,
        marketplace: product.marketplace,
        brand: product.brand ?? '',
        category: product.productType ?? '',
        imageUrl: product.imageUrl ?? '',
      }
      const created = await addTrackedAsin(workspaceId, payload)
      if (!created) {
        await loadProductOptions(workspaceId)
        setSelectedProductKey(product.key)
        toast.info('ASIN already tracked. Selected existing product.')
        return
      }

      await incrementAsinUsage(workspaceId)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('asin:usage-changed'))
      }
      toast.success('ASIN tracked. Add your first keyword now.')
      await loadProductOptions(workspaceId)
      setSelectedProductKey(buildProductKey(product.asin, product.marketplace))
    } finally {
      setTrackingAsinKey(null)
    }
  }

  async function handleTrackExternalAsin() {
    if (!workspaceId || !showExternalAsinCard) return

    const asin = normalizedSearch
    const targetKey = buildProductKey(asin, externalMarketplace)
    const existingTracked = productOptions.find(p => p.key === targetKey && p.trackedAsinId)
    if (existingTracked) {
      setSelectedProductKey(existingTracked.key)
      toast.info('ASIN already tracked. Selected existing product.')
      return
    }

    setTrackingExternalAsin(true)
    try {
      const supabase = createClient()
      const [asinLimit, trackedCountRes] = await Promise.all([
        getAsinLimit(workspaceId),
        supabase
          .from('tracked_asins')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('status', 'archived'),
      ])
      const trackedCount = trackedCountRes.count ?? 0
      if (trackedCount >= asinLimit) {
        toast.error('You have reached your ASIN limit for this plan.')
        return
      }

      const created = await addTrackedAsin(workspaceId, {
        asin,
        marketplace: externalMarketplace,
        productTitle: externalTitle.trim() || `External ASIN ${asin}`,
        brand: externalBrand.trim(),
        category: 'External / Competitor',
        imageUrl: '',
      })

      if (!created) {
        const { data: existing } = await supabase
          .from('tracked_asins')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('asin', asin)
          .eq('marketplace', externalMarketplace)
          .neq('status', 'archived')
          .maybeSingle()

        await loadProductOptions(workspaceId)
        const trackedNow = Boolean(existing?.id)
        if (trackedNow) {
          setSelectedProductKey(targetKey)
          toast.info('ASIN already tracked. Selected existing product.')
          return
        }
        toast.error('Unable to track this ASIN right now. Please try again.')
        return
      }

      await incrementAsinUsage(workspaceId)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('asin:usage-changed'))
      }

      await loadProductOptions(workspaceId)
      setSelectedProductKey(targetKey)
      setExternalTitle('')
      setExternalBrand('')
      toast.success('ASIN tracked. Add your first keyword now.')
    } finally {
      setTrackingExternalAsin(false)
    }
  }

  async function handleTrackKeywords(mode: 'single' | 'bulk') {
    if (!selectedProduct) {
      toast.warning('Select a product first.')
      return
    }
    if (!selectedProduct.trackedAsinId) {
      toast.warning('Track ASIN first to enable keyword tracking.')
      return
    }

    const rawKeywords = mode === 'single'
      ? [keywordInput]
      : bulkKeywordInput.split(/\r?\n/g)

    const uniqueKeywords = [...new Set(rawKeywords.map(k => k.trim()).filter(Boolean))]
    if (uniqueKeywords.length === 0) {
      toast.warning('Enter at least one keyword.')
      return
    }

    setAddingKeyword(true)
    try {
      let added = 0
      for (const keyword of uniqueKeywords) {
        const res = await fetch(`/api/asins/${selectedProduct.asin}/keywords/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword,
            marketplace: selectedProduct.marketplace,
          }),
        })
        const data = await res.json() as { error?: string }
        if (res.ok) {
          added += 1
          continue
        }
        if (res.status !== 409) {
          toast.error(data.error ?? `Failed to track keyword: ${keyword}`)
        }
      }

      if (added > 0) {
        toast.success('Keyword added. Run refresh to check rank.')
      } else {
        toast.info('No new keywords added (duplicates may already exist).')
      }
      setKeywordInput('')
      if (mode === 'bulk') setBulkKeywordInput('')
      if (workspaceId) await loadTrackedKeywords(workspaceId)
    } finally {
      setAddingKeyword(false)
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
  const selectedProductKeywordCount = selectedProduct
    ? trackedData.filter(k => k.asin === selectedProduct.asin).length
    : 0

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Keyword Tracker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Research keywords and monitor ranking movement for tracked ASINs. Next: add a seed keyword and track it, then refresh ranks. Data source: tracked_keywords and keyword_rank_snapshots.
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

      {/* ── 4. Choose product ─────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Choose a product to track keywords</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Select one of your tracked ASINs or synced Amazon listings.
          </p>
        </div>

        {productsLoading ? (
          <p className="text-xs text-muted-foreground">Loading products…</p>
        ) : (
          <>
            <div>
              <Label htmlFor="product-search">Search or paste ASIN</Label>
              <Input
                id="product-search"
                placeholder="Search by product title, ASIN, SKU, brand — or paste any Amazon ASIN"
                value={productSearch}
                onChange={e => setProductSearch(e.target.value)}
              />
            </div>

            {showExternalAsinCard && (
              <div className="rounded-lg border border-primary/25 bg-primary/5 p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">ASIN not found in your products</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Track {normalizedSearch} to start monitoring keyword rank for this product.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="external-marketplace">Marketplace</Label>
                    <select
                      id="external-marketplace"
                      value={externalMarketplace}
                      onChange={e => setExternalMarketplace(e.target.value as Marketplace)}
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="IN">Amazon India</option>
                      <option value="US">Amazon US</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="external-title">Product title (optional)</Label>
                    <Input
                      id="external-title"
                      value={externalTitle}
                      onChange={e => setExternalTitle(e.target.value)}
                      placeholder="Optional title"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="external-brand">Brand (optional)</Label>
                    <Input
                      id="external-brand"
                      value={externalBrand}
                      onChange={e => setExternalBrand(e.target.value)}
                      placeholder="Optional brand"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Button type="button" onClick={handleTrackExternalAsin} disabled={trackingExternalAsin}>
                    {trackingExternalAsin ? 'Tracking…' : 'Track this ASIN'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setProductSearch('')
                      setExternalTitle('')
                      setExternalBrand('')
                    }}
                    disabled={trackingExternalAsin}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            )}

            {showInvalidAsinHint && (
              <div className="rounded-lg border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">Enter a valid 10-character Amazon ASIN.</p>
              </div>
            )}

            {filteredProducts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                {productSearch.trim().length === 0 ? (
                  <>
                    <p className="text-sm text-foreground">Search or paste an ASIN to start keyword tracking.</p>
                    <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
                      <Button type="button" variant="outline" render={<Link href="/dashboard/asins" />}>
                        Go to ASINs
                      </Button>
                      <Button type="button" variant="outline" render={<Link href="/dashboard/settings" />}>
                        Sync Amazon Listings
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No products match your search.</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {visibleProducts.map(product => {
                  const isSelected = selectedProductKey === product.key
                  const isTracked = Boolean(product.trackedAsinId)
                  const isTracking = trackingAsinKey === product.key
                  return (
                    <div
                      key={product.key}
                      className={cn(
                        'rounded-lg border p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3',
                        isSelected ? 'border-primary/40 bg-primary/5' : 'border-border',
                      )}
                    >
                      {product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt={product.title}
                          className="h-14 w-14 rounded-md object-cover border border-border"
                        />
                      ) : (
                        <div className="h-14 w-14 rounded-md border border-border bg-muted/30 flex items-center justify-center text-[10px] text-muted-foreground">
                          No image
                        </div>
                      )}

                      <div className="flex-1 min-w-0 space-y-1.5">
                        <p className="text-sm font-medium text-foreground line-clamp-2">{product.title}</p>
                        <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                          <span className="font-mono">{product.asin}</span>
                          {product.sku && <span>SKU: {product.sku}</span>}
                          {product.brand && <span>Brand: {product.brand}</span>}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="text-[10px]">{product.marketplace}</Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {sourceLabel(product)}
                          </Badge>
                          <Badge className={cn('text-[10px]', isTracked
                            ? 'bg-green-500/15 text-green-400 border-green-500/20'
                            : 'bg-yellow-500/15 text-yellow-300 border-yellow-500/20')}>
                            {isTracked ? 'Ready for keywords' : 'Track ASIN first'}
                          </Badge>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {isTracked ? (
                          <Button
                            type="button"
                            variant={isSelected ? 'default' : 'outline'}
                            onClick={() => setSelectedProductKey(product.key)}
                          >
                            {isSelected ? 'Selected' : 'Select Product'}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => handleTrackSelectedAsin(product)}
                            disabled={isTracking}
                          >
                            {isTracking ? 'Tracking…' : 'Track ASIN First'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {filteredProducts.length > 8 && (
              <p className="text-xs text-muted-foreground">
                Showing 8 of {filteredProducts.length} products. Use search to narrow results.
              </p>
            )}

            {!selectedProduct && filteredProducts.length > 0 && (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="text-sm text-muted-foreground">Select a product above to start tracking keywords.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 5. Selected product + add keywords ───────────────────────────── */}
      {selectedProduct && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <div className="rounded-lg border border-border p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            {selectedProduct.imageUrl ? (
              <img
                src={selectedProduct.imageUrl}
                alt={selectedProduct.title}
                className="h-14 w-14 rounded-md object-cover border border-border"
              />
            ) : (
              <div className="h-14 w-14 rounded-md border border-border bg-muted/30 flex items-center justify-center text-[10px] text-muted-foreground">
                No image
              </div>
            )}

            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="text-sm font-medium text-foreground line-clamp-2">{selectedProduct.title}</p>
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                <span className="font-mono">{selectedProduct.asin}</span>
                {selectedProduct.sku && <span>SKU: {selectedProduct.sku}</span>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]">{selectedProduct.marketplace}</Badge>
                <Badge variant="outline" className="text-[10px]">
                  {sourceLabel(selectedProduct)}
                </Badge>
              </div>
            </div>

            <Button type="button" variant="outline" onClick={() => setSelectedProductKey('')}>
              Change product
            </Button>
          </div>

          {!selectedProduct.trackedAsinId ? (
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-yellow-300">Track ASIN first to enable keyword tracking.</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleTrackSelectedAsin(selectedProduct)}
                disabled={trackingAsinKey === selectedProduct.key}
              >
                {trackingAsinKey === selectedProduct.key ? 'Tracking…' : 'Track ASIN First'}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedProductKeywordCount === 0 && (
                <p className="text-sm text-muted-foreground">Add your first keyword for this ASIN.</p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="keyword-single">Add keyword</Label>
                  <div className="flex gap-2">
                    <Input
                      id="keyword-single"
                      placeholder="e.g. anti slip kitchen mat"
                      value={keywordInput}
                      onChange={e => setKeywordInput(e.target.value)}
                    />
                    <Button type="button" onClick={() => handleTrackKeywords('single')} disabled={addingKeyword}>
                      Track Keyword
                    </Button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="keyword-bulk">Bulk keywords (one per line)</Label>
                  <textarea
                    id="keyword-bulk"
                    rows={3}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                    placeholder={'anti slip mat\nkitchen mat\neasy home mat'}
                    value={bulkKeywordInput}
                    onChange={e => setBulkKeywordInput(e.target.value)}
                  />
                  <div className="mt-2">
                    <Button type="button" variant="outline" onClick={() => handleTrackKeywords('bulk')} disabled={addingKeyword || !bulkKeywordInput.trim()}>
                      Track Multiple Keywords
                    </Button>
                  </div>
                </div>
              </div>

              {suggestedSeeds.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Suggested keyword seeds</p>
                  <div className="flex flex-wrap gap-2">
                    {suggestedSeeds.map(seed => (
                      <button
                        key={seed}
                        type="button"
                        onClick={() => setKeywordInput(seed)}
                        className="text-xs rounded-full border border-border bg-muted/30 px-2.5 py-1 hover:bg-muted/50"
                      >
                        {seed}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 6. Rank tracking table ────────────────────────────────────────── */}
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

        {trackedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 gap-3 text-center">
            <Tag className="size-8 text-muted-foreground/30" />
            {productOptions.length === 0 ? (
              <>
                <p className="text-sm font-medium text-foreground">Add an ASIN or sync Amazon listings to start keyword tracking.</p>
                <div className="flex items-center gap-2 flex-wrap justify-center">
                  <Button type="button" variant="outline" render={<Link href="/dashboard/asins" />}>
                    Go to ASINs
                  </Button>
                  <Button type="button" variant="outline" render={<Link href="/dashboard/settings" />}>
                    Sync Amazon Listings
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">Select a product above and add your first keyword to start tracking Amazon search rank.</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Tracked keywords will appear here even before the first rank check.
                </p>
              </>
            )}
          </div>
        ) : (
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
                <th className="text-center px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Checked</th>
                <th className="text-left px-4 py-3">Freshness</th>
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
                    <span className="text-xs text-muted-foreground">{kw.page ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="inline-flex flex-col items-center gap-1">
                      <FoundStatusBadge kw={kw} />
                      {kw.scrape_status === 'failed' && kw.error_message && (
                        <span className="text-[10px] text-red-400 max-w-[180px] truncate" title={kw.error_message}>
                          {kw.error_message}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {kw.last_checked ? timeAgo(kw.last_checked) : 'Never'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <DataFreshnessBadge checkedAt={kw.last_checked} />
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
        )}
        <p className="px-6 py-3 text-[10px] text-muted-foreground border-t border-border">
          Click a row to view its rank trend chart below
        </p>
      </div>

      {/* ── 7. Rank trend chart ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6">
        {trackedData.length === 0 ? (
          <div className="h-[240px] flex flex-col items-center justify-center gap-2 text-center">
            <BarChart2 className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No rank trend yet</p>
            <p className="text-xs text-muted-foreground/60 max-w-xs">
              Track at least one keyword and run Refresh Ranks to generate this chart.
            </p>
          </div>
        ) : (
        <>
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

        {selectedKeywordId && chartHistory.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Check History
            </h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">
                    <th className="text-left px-3 py-2">Checked At</th>
                    <th className="text-right px-3 py-2">Organic Rank</th>
                    <th className="text-center px-3 py-2">Page</th>
                    <th className="text-center px-3 py-2">Found</th>
                    <th className="text-left px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...chartHistory].reverse().slice(0, 15).map((row, idx) => (
                    <tr key={`${row.checked_at}-${idx}`}>
                      <td className="px-3 py-2 text-xs text-foreground">
                        {new Date(row.checked_at).toLocaleString('en-IN')}
                      </td>
                      <td className="px-3 py-2 text-xs text-right font-mono text-foreground">
                        {row.rank != null ? `#${row.rank}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-center text-muted-foreground">
                        {row.page ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-center text-muted-foreground">
                        {row.found ? 'Found' : 'Not found'}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.scrape_status === 'failed' ? 'Failed' : 'Success'}
                        {row.scrape_status === 'failed' && row.error_message ? `: ${row.error_message}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {/* ── 8. Keyword research section ───────────────────────────────────── */}
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

    </div>
  )
}
