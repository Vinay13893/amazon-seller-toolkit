/**
 * Server-side only — NEVER import from client components.
 *
 * Fetches real Supabase data and returns CSV-ready headers + rows
 * for each supported report type.
 */
import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReportType =
  | 'asin-performance'
  | 'bsr-movement'
  | 'pincode-availability'
  | 'buybox-health'
  | 'keyword-ranking'
  | 'alerts-summary'

export interface ReportData {
  headers:    string[]
  rows:       string[][]
  reportName: string
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function toCsv(headers: string[], rows: string[][]): string {
  return [
    headers.map(esc).join(','),
    ...rows.map(r => r.map(esc).join(',')),
  ].join('\r\n')
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateReportData(
  workspaceId: string,
  reportType:  ReportType,
): Promise<ReportData> {
  switch (reportType) {
    case 'asin-performance':   return asinPerformance(workspaceId)
    case 'bsr-movement':       return bsrMovement(workspaceId)
    case 'pincode-availability': return pincodeAvailability(workspaceId)
    case 'buybox-health':      return buyboxHealth(workspaceId)
    case 'keyword-ranking':    return keywordRanking(workspaceId)
    case 'alerts-summary':     return alertsSummary(workspaceId)
    default: {
      const _: never = reportType
      void _
      throw new Error(`Unknown report type: ${reportType}`)
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function fmtNum(n: number | null | undefined): string {
  return n != null ? String(n) : '—'
}

function fmtPrice(n: number | null | undefined): string {
  return n != null ? `₹${Number(n).toFixed(2)}` : '—'
}

// ─── A. ASIN Performance ──────────────────────────────────────────────────────

async function asinPerformance(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: asins } = await admin
    .from('tracked_asins')
    .select('id, asin, product_title, marketplace')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .order('asin')

  const headers = [
    'Product Title', 'ASIN', 'Marketplace',
    'Latest BSR', 'Price (₹)', 'Rating', 'Reviews',
    'Buy Box Seller', 'Buy Box Status', 'Availability Score', 'Last Checked',
  ]

  if (!asins?.length) return { headers, rows: [], reportName: 'ASIN Performance' }

  const asinIds = asins.map((a: { id: string }) => a.id)

  const { data: snaps } = await admin
    .from('asin_snapshots')
    .select('tracked_asin_id, bsr, price, rating, review_count, buy_box_owner, buy_box_status, availability_score, checked_at')
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })

  type Snap = {
    tracked_asin_id: string; bsr: number | null; price: number | null
    rating: number | null; review_count: number | null
    buy_box_owner: string | null; buy_box_status: string | null
    availability_score: number | null; checked_at: string
  }
  const latestSnap = new Map<string, Snap>()
  for (const s of ((snaps ?? []) as Snap[])) {
    if (!latestSnap.has(s.tracked_asin_id)) latestSnap.set(s.tracked_asin_id, s)
  }

  const rows = (asins as { id: string; asin: string; product_title: string | null; marketplace: string | null }[]).map(a => {
    const s = latestSnap.get(a.id)
    return [
      a.product_title ?? '',
      a.asin,
      a.marketplace ?? 'IN',
      fmtNum(s?.bsr),
      fmtPrice(s?.price),
      fmtNum(s?.rating),
      fmtNum(s?.review_count),
      s?.buy_box_owner ?? '—',
      s?.buy_box_status ?? '—',
      s?.availability_score != null ? `${s.availability_score}%` : '—',
      s ? fmtDate(s.checked_at) : 'Never',
    ]
  })

  return { headers, rows, reportName: 'ASIN Performance' }
}

// ─── B. BSR Movement ──────────────────────────────────────────────────────────

async function bsrMovement(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: asins } = await admin
    .from('tracked_asins')
    .select('id, asin, product_title, marketplace')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  const headers = [
    'ASIN', 'Product Title', 'Marketplace',
    'Current BSR', 'Previous BSR', 'Movement', '% Change', 'Checked At',
  ]

  if (!asins?.length) return { headers, rows: [], reportName: 'BSR Movement' }

  const asinIds = asins.map((a: { id: string }) => a.id)
  const asinById = new Map(
    (asins as { id: string; asin: string; product_title: string | null; marketplace: string | null }[]).map(a => [a.id, a])
  )

  const { data: snaps } = await admin
    .from('asin_snapshots')
    .select('tracked_asin_id, bsr, checked_at')
    .in('tracked_asin_id', asinIds)
    .not('bsr', 'is', null)
    .order('checked_at', { ascending: false })

  type BsrSnap = { tracked_asin_id: string; bsr: number; checked_at: string }
  const byAsin = new Map<string, BsrSnap[]>()
  for (const s of ((snaps ?? []) as BsrSnap[])) {
    const list = byAsin.get(s.tracked_asin_id) ?? []
    if (list.length < 2) {
      list.push(s)
      byAsin.set(s.tracked_asin_id, list)
    }
  }

  const rows: string[][] = []
  for (const [asinId, snapList] of byAsin.entries()) {
    const a = asinById.get(asinId)
    if (!a) continue
    const [latest, prev] = snapList
    const movement = prev ? latest.bsr - prev.bsr : 0
    const pctChange = prev ? ((movement / prev.bsr) * 100).toFixed(1) + '%' : '—'
    const movStr = prev
      ? (movement > 0 ? `+${movement}` : String(movement))
      : '—'
    rows.push([
      a.asin,
      a.product_title ?? '',
      a.marketplace ?? 'IN',
      fmtNum(latest.bsr),
      prev ? fmtNum(prev.bsr) : '—',
      movStr,
      pctChange,
      fmtDate(latest.checked_at),
    ])
  }

  // Include ASINs with no snapshot data
  for (const a of (asins as { id: string; asin: string; product_title: string | null; marketplace: string | null }[])) {
    if (!byAsin.has(a.id)) {
      rows.push([a.asin, a.product_title ?? '', a.marketplace ?? 'IN', '—', '—', '—', '—', 'Never'])
    }
  }

  return { headers, rows, reportName: 'BSR Movement' }
}

// ─── C. Pincode Availability ──────────────────────────────────────────────────

async function pincodeAvailability(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: asins } = await admin
    .from('tracked_asins')
    .select('id, asin, product_title')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  const headers = [
    'ASIN', 'Product Title', 'Pincode', 'City',
    'Available', 'Delivery Promise', 'Price (₹)', 'Buy Box Seller',
    'Fulfillment Type', 'Checked At',
  ]

  if (!asins?.length) return { headers, rows: [], reportName: 'Pincode Availability' }

  const asinIds = asins.map((a: { id: string }) => a.id)
  const asinById = new Map(
    (asins as { id: string; asin: string; product_title: string | null }[]).map(a => [a.id, a])
  )

  const { data: checks } = await admin
    .from('pincode_checks')
    .select('tracked_asin_id, pincode, city, available, delivery_promise, price, buy_box_seller, fulfillment_type, checked_at')
    .eq('workspace_id', workspaceId)
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })

  // Latest per (asin, pincode)
  type PRow = {
    tracked_asin_id: string; pincode: string; city: string | null
    available: boolean | null; delivery_promise: string | null; price: number | null
    buy_box_seller: string | null; fulfillment_type: string | null; checked_at: string
  }
  const seen  = new Set<string>()
  const dedup: PRow[] = []
  for (const r of ((checks ?? []) as PRow[])) {
    if (!r.tracked_asin_id) continue
    const k = `${r.tracked_asin_id}|${r.pincode}`
    if (!seen.has(k)) { seen.add(k); dedup.push(r) }
  }

  const rows = dedup.map(r => {
    const a = asinById.get(r.tracked_asin_id)
    return [
      a?.asin ?? '—',
      a?.product_title ?? '—',
      r.pincode,
      r.city ?? '—',
      r.available === true ? 'Yes' : r.available === false ? 'No' : '—',
      r.delivery_promise ?? '—',
      fmtPrice(r.price),
      r.buy_box_seller ?? '—',
      r.fulfillment_type ?? '—',
      fmtDate(r.checked_at),
    ]
  })

  if (!rows.length) {
    // Empty but with headers
    return { headers, rows: [], reportName: 'Pincode Availability' }
  }

  return { headers, rows, reportName: 'Pincode Availability' }
}

// ─── D. Buy Box Health ────────────────────────────────────────────────────────

async function buyboxHealth(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: asins } = await admin
    .from('tracked_asins')
    .select('id, asin, product_title')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  const headers = [
    'ASIN', 'Product Title', 'Buy Box Seller', 'Buy Box Status',
    'Buy Box Price (₹)', 'Your Price (₹)', 'Price Gap (₹)',
    'Fulfillment Type', 'Checked At',
  ]

  if (!asins?.length) return { headers, rows: [], reportName: 'Buy Box Health' }

  const asinIds = asins.map((a: { id: string }) => a.id)
  const asinById = new Map(
    (asins as { id: string; asin: string; product_title: string | null }[]).map(a => [a.id, a])
  )

  const { data: snaps } = await admin
    .from('buybox_snapshots')
    .select('tracked_asin_id, buy_box_owner, buy_box_status, buy_box_price, your_price, price_gap, fulfillment_type, checked_at')
    .in('tracked_asin_id', asinIds)
    .order('checked_at', { ascending: false })

  type BbRow = {
    tracked_asin_id: string; buy_box_owner: string | null; buy_box_status: string | null
    buy_box_price: number | null; your_price: number | null; price_gap: number | null
    fulfillment_type: string | null; checked_at: string
  }
  // Latest per ASIN
  const latestSnap = new Map<string, BbRow>()
  for (const s of ((snaps ?? []) as BbRow[])) {
    if (!latestSnap.has(s.tracked_asin_id)) latestSnap.set(s.tracked_asin_id, s)
  }

  const rows = (asins as { id: string; asin: string; product_title: string | null }[]).map(a => {
    const s = latestSnap.get(a.id)
    return [
      a.asin,
      a.product_title ?? '',
      s?.buy_box_owner  ?? '—',
      s?.buy_box_status ?? '—',
      fmtPrice(s?.buy_box_price),
      fmtPrice(s?.your_price),
      fmtPrice(s?.price_gap),
      s?.fulfillment_type ?? '—',
      s ? fmtDate(s.checked_at) : 'Never',
    ]
  })

  return { headers, rows, reportName: 'Buy Box Health' }
}

// ─── E. Keyword Ranking ───────────────────────────────────────────────────────

async function keywordRanking(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: kws } = await admin
    .from('tracked_keywords')
    .select('id, keyword, tracked_asin_id, marketplace')
    .eq('workspace_id', workspaceId)

  const headers = [
    'ASIN', 'Product Title', 'Keyword', 'Marketplace',
    'Organic Rank', 'Sponsored Rank', 'Page Status', 'Checked At',
  ]

  if (!kws?.length) return { headers, rows: [], reportName: 'Keyword Ranking' }

  // Get ASIN info for keywords that have a linked ASIN
  const linkedAsinIds = [...new Set(
    (kws as { tracked_asin_id: string | null }[])
      .map(k => k.tracked_asin_id)
      .filter(Boolean) as string[]
  )]

  const asinById = new Map<string, { asin: string; product_title: string | null }>()
  if (linkedAsinIds.length > 0) {
    const { data: asins } = await admin
      .from('tracked_asins')
      .select('id, asin, product_title')
      .in('id', linkedAsinIds)
    for (const a of (asins ?? [])) {
      asinById.set(a.id, { asin: a.asin, product_title: a.product_title })
    }
  }

  const kwIds = (kws as { id: string }[]).map(k => k.id)

  const { data: rankSnaps } = await admin
    .from('keyword_rank_snapshots')
    .select('tracked_keyword_id, organic_rank, sponsored_rank, page_status, checked_at')
    .in('tracked_keyword_id', kwIds)
    .order('checked_at', { ascending: false })

  type RankRow = {
    tracked_keyword_id: string; organic_rank: number | null
    sponsored_rank: number | null; page_status: string | null; checked_at: string
  }
  const latestRank = new Map<string, RankRow>()
  for (const r of ((rankSnaps ?? []) as RankRow[])) {
    if (!latestRank.has(r.tracked_keyword_id)) latestRank.set(r.tracked_keyword_id, r)
  }

  type KwRow = { id: string; keyword: string; tracked_asin_id: string | null; marketplace: string }
  const rows = (kws as KwRow[]).map(k => {
    const rank = latestRank.get(k.id)
    const asn  = k.tracked_asin_id ? asinById.get(k.tracked_asin_id) : null
    return [
      asn?.asin ?? '—',
      asn?.product_title ?? '—',
      k.keyword,
      k.marketplace ?? 'IN',
      fmtNum(rank?.organic_rank),
      fmtNum(rank?.sponsored_rank),
      rank?.page_status ?? '—',
      rank ? fmtDate(rank.checked_at) : 'Never',
    ]
  })

  return { headers, rows, reportName: 'Keyword Ranking' }
}

// ─── F. Alerts Summary ────────────────────────────────────────────────────────

async function alertsSummary(workspaceId: string): Promise<ReportData> {
  const admin = createAdminClient()

  const { data: rows } = await admin
    .from('alerts')
    .select('title, description, severity, module, status, recommended_action, created_at, tracked_asins(asin, product_title)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(500)

  const headers = [
    'Alert Title', 'ASIN', 'Product Title', 'Module', 'Severity',
    'Status', 'Description', 'Recommended Action', 'Created At',
  ]

  if (!rows?.length) return { headers, rows: [], reportName: 'Alerts Summary' }

  type AlertRow = {
    title: string; description: string | null; severity: string; module: string
    status: string; recommended_action: string | null; created_at: string
    tracked_asins: { asin: string; product_title: string | null } | null
  }
  const csvRows = (rows as unknown as AlertRow[]).map(r => {
    const asn = r.tracked_asins
    return [
      r.title,
      asn?.asin ?? '—',
      asn?.product_title ?? '—',
      r.module,
      r.severity,
      r.status,
      r.description ?? '—',
      r.recommended_action ?? '—',
      fmtDate(r.created_at),
    ]
  })

  return { headers, rows: csvRows, reportName: 'Alerts Summary' }
}
