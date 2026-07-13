import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveJobsAuth } from '@/lib/internal/background-worker-auth'

export const runtime = 'nodejs'
export const maxDuration = 60

const JOB_TYPE = 'product_page_snapshot'
const DEFAULT_CADENCE_HOURS = 24
const MAX_TOTAL_PER_RUN = 200
const MAX_MY_PRODUCTS_PER_RUN = 100
const MAX_COMPETITORS_PER_RUN = 100
const MAX_WORKSPACES_PER_SYSTEM_RUN = 25
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
// Jobs completed with a pricing rate-limit/cooldown reason become eligible
// for re-enqueue only after this delay (R11.1b: was 30 min, which caused
// ~1,000 catalog-only checks/day while Pricing stayed throttled).
const PRICING_COOLDOWN_RETRY_MINUTES = 4 * 60
const REPEATED_PRICING_COOLDOWN_RETRY_MINUTES = 24 * 60
const REPEATED_COOLDOWN_LOOKBACK_HOURS = 24
const REPEATED_COOLDOWN_THRESHOLD = 3
const RATE_LIMIT_REASONS = new Set([
  'amazon_pricing_rate_limited',
  'amazon_pricing_cooldown_active',
  'SP-API pricing call failed with HTTP 429',
])

type RecentJobRow = {
  target_type: string
  target_id: string
  status: string
  completed_at: string | null
  last_error_safe: string | null
}

type RecentSnapshotRow = {
  amazon_listing_item_id: string | null
  tracked_asin_id: string | null
  scrape_status: string | null
  checked_at: string
}

function isCooldownReason(reason: string | null | undefined): boolean {
  return RATE_LIMIT_REASONS.has(String(reason ?? ''))
}

function isRepeatedCooldown(rows: RecentJobRow[], nowMs: number): boolean {
  const lookbackCutoff = nowMs - REPEATED_COOLDOWN_LOOKBACK_HOURS * 60 * 60 * 1000
  const recent = rows
    .filter(row => row.completed_at && new Date(row.completed_at).getTime() >= lookbackCutoff)
    .sort((a, b) => new Date(b.completed_at ?? 0).getTime() - new Date(a.completed_at ?? 0).getTime())
    .slice(0, REPEATED_COOLDOWN_THRESHOLD)

  return recent.length >= REPEATED_COOLDOWN_THRESHOLD &&
    recent.every(row => isCooldownReason(row.last_error_safe))
}

function snapshotKey(row: RecentSnapshotRow): string | null {
  if (row.amazon_listing_item_id) return `my_product:${row.amazon_listing_item_id}`
  if (row.tracked_asin_id) return `competitor_asin:${row.tracked_asin_id}`
  return null
}

function snapshotCooldownBackoff(rows: RecentSnapshotRow[], nowMs: number): { checkedAt: number; repeated: boolean } | null {
  const lookbackCutoff = nowMs - REPEATED_COOLDOWN_LOOKBACK_HOURS * 60 * 60 * 1000
  const recent = rows
    .filter(row => row.checked_at && new Date(row.checked_at).getTime() >= lookbackCutoff)
    .sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime())
    .slice(0, REPEATED_COOLDOWN_THRESHOLD)

  if (recent.length === 0 || recent[0].scrape_status !== 'partial_pricing_rate_limited') return null

  return {
    checkedAt: new Date(recent[0].checked_at).getTime(),
    repeated: recent.length >= REPEATED_COOLDOWN_THRESHOLD &&
      recent.every(row => row.scrape_status === 'partial_pricing_rate_limited'),
  }
}

const MARKETPLACE_ID_BY_MARKETPLACE: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
}

type NewJobRow = {
  workspace_id: string
  job_type: string
  target_type: 'my_product' | 'competitor_asin'
  target_id: string
  marketplace_id: string
  payload_json: { asin: string }
}

type AdminClient = ReturnType<typeof createAdminClient>

type WorkspaceCandidates = {
  candidates: NewJobRow[]
  totalActiveMyProducts: number
  totalActiveCompetitors: number
}

async function buildCandidatesForWorkspace(
  admin: AdminClient,
  workspaceId: string,
  remainingMyProducts: number,
  remainingCompetitors: number,
  forceRefresh: boolean,
): Promise<WorkspaceCandidates | null> {
  const repeatedLookbackIso = new Date(Date.now() - REPEATED_COOLDOWN_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const [listingsResult, trackedResult, activeJobsResult, recentSnapshotsResult] = await Promise.all([
    admin
      .from('amazon_listing_items')
      .select('id, asin, marketplace_id')
      .eq('workspace_id', workspaceId)
      .not('asin', 'is', null)
      .limit(1000),
    admin
      .from('tracked_asins')
      .select('id, asin, marketplace')
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .limit(1000),
    admin
      .from('background_jobs')
      .select('target_type, target_id, status, completed_at, last_error_safe')
      .eq('workspace_id', workspaceId)
      .eq('job_type', JOB_TYPE)
      .or(`status.in.(queued,running),and(status.in.(completed,failed),completed_at.gte.${new Date(Date.now() - DEFAULT_CADENCE_HOURS * 60 * 60 * 1000).toISOString()})`)
      .limit(2000),
    admin
      .from('asin_snapshots')
      .select('amazon_listing_item_id, tracked_asin_id, scrape_status, checked_at')
      .eq('workspace_id', workspaceId)
      .eq('scrape_status', 'partial_pricing_rate_limited')
      .gte('checked_at', repeatedLookbackIso)
      .order('checked_at', { ascending: false })
      .limit(5000),
  ])

  if (listingsResult.error || trackedResult.error || activeJobsResult.error || recentSnapshotsResult.error) return null

  const nowMs = Date.now()
  const cadenceCutoff = nowMs - DEFAULT_CADENCE_HOURS * 60 * 60 * 1000
  const rateLimitCutoff = nowMs - PRICING_COOLDOWN_RETRY_MINUTES * 60 * 1000
  const repeatedRateLimitCutoff = nowMs - REPEATED_PRICING_COOLDOWN_RETRY_MINUTES * 60 * 1000
  const skipKeys = new Set<string>()
  const terminalJobsByKey = new Map<string, RecentJobRow[]>()
  const snapshotsByKey = new Map<string, RecentSnapshotRow[]>()
  for (const snapshot of (recentSnapshotsResult.data ?? []) as RecentSnapshotRow[]) {
    const key = snapshotKey(snapshot)
    if (!key) continue
    const rows = snapshotsByKey.get(key) ?? []
    rows.push(snapshot)
    snapshotsByKey.set(key, rows)
  }
  for (const job of (activeJobsResult.data ?? []) as RecentJobRow[]) {
    const key = `${job.target_type}:${job.target_id}`
    if (job.status === 'queued' || job.status === 'running') {
      skipKeys.add(key)
      continue
    }
    if (forceRefresh) continue
    if ((job.status === 'completed' || job.status === 'failed') && job.completed_at) {
      const rows = terminalJobsByKey.get(key) ?? []
      rows.push(job)
      terminalJobsByKey.set(key, rows)
    }
  }

  if (!forceRefresh) {
    for (const [key, rows] of terminalJobsByKey.entries()) {
      const sorted = rows.sort((a, b) => new Date(b.completed_at ?? 0).getTime() - new Date(a.completed_at ?? 0).getTime())
      const latest = sorted[0]
      if (!latest?.completed_at) continue
      const completedAt = new Date(latest.completed_at).getTime()
      const cutoff = isCooldownReason(latest.last_error_safe)
        ? isRepeatedCooldown(sorted, nowMs)
          ? repeatedRateLimitCutoff
          : rateLimitCutoff
        : cadenceCutoff
      if (completedAt > cutoff) skipKeys.add(key)
    }

    for (const [key, rows] of snapshotsByKey.entries()) {
      if (skipKeys.has(key)) continue
      const backoff = snapshotCooldownBackoff(rows, nowMs)
      if (!backoff) continue
      const cutoff = backoff.repeated ? repeatedRateLimitCutoff : rateLimitCutoff
      if (backoff.checkedAt > cutoff) skipKeys.add(key)
    }
  }

  const candidates: NewJobRow[] = []
  let totalActiveMyProducts = 0
  for (const listing of listingsResult.data ?? []) {
    if (!listing.asin) continue
    totalActiveMyProducts += 1
    if (candidates.filter(c => c.target_type === 'my_product').length >= remainingMyProducts) continue
    const key = `my_product:${listing.id}`
    if (skipKeys.has(key)) continue
    candidates.push({
      workspace_id: workspaceId,
      job_type: JOB_TYPE,
      target_type: 'my_product',
      target_id: listing.id as string,
      marketplace_id: (listing.marketplace_id as string | null) ?? DEFAULT_MARKETPLACE_ID,
      payload_json: { asin: (listing.asin as string).toUpperCase() },
    })
  }

  let totalActiveCompetitors = 0
  for (const tracked of trackedResult.data ?? []) {
    totalActiveCompetitors += 1
    if (candidates.filter(c => c.target_type === 'competitor_asin').length >= remainingCompetitors) continue
    const key = `competitor_asin:${tracked.id}`
    if (skipKeys.has(key)) continue
    const marketplaceId = MARKETPLACE_ID_BY_MARKETPLACE[String(tracked.marketplace).toUpperCase()] ?? DEFAULT_MARKETPLACE_ID
    candidates.push({
      workspace_id: workspaceId,
      job_type: JOB_TYPE,
      target_type: 'competitor_asin',
      target_id: tracked.id as string,
      marketplace_id: marketplaceId,
      payload_json: { asin: String(tracked.asin).toUpperCase() },
    })
  }

  return { candidates, totalActiveMyProducts, totalActiveCompetitors }
}

export async function POST(request: Request) {
  const auth = await resolveJobsAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const url = new URL(request.url)
  const requestedLimit = await request.json().catch(() => null) as { limit?: unknown; force?: unknown } | null
  const queryLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limitInput = typeof requestedLimit?.limit === 'number' && Number.isFinite(requestedLimit.limit)
    ? requestedLimit.limit
    : Number.isFinite(queryLimit)
      ? queryLimit
      : MAX_TOTAL_PER_RUN
  const manualLimit = Number.isFinite(limitInput)
    ? Math.max(1, Math.min(MAX_TOTAL_PER_RUN, Math.floor(limitInput)))
    : MAX_TOTAL_PER_RUN
  const forceRefresh = requestedLimit?.force === true || url.searchParams.get('force') === '1'

  const workspaceIds: string[] = []
  if (auth.mode === 'session') {
    workspaceIds.push(auth.workspaceId)
  } else {
    const { data: connections, error: connectionsError } = await admin
      .from('amazon_connections')
      .select('workspace_id')
      .eq('status', 'active')
      .limit(MAX_WORKSPACES_PER_SYSTEM_RUN)

    if (connectionsError) {
      return NextResponse.json({ error: 'Unable to read eligible workspaces.' }, { status: 503 })
    }
    for (const row of connections ?? []) {
      if (row.workspace_id) workspaceIds.push(row.workspace_id as string)
    }
  }

  let totalActiveMyProducts = 0
  let totalActiveCompetitors = 0
  const allCandidates: NewJobRow[] = []
  let remainingMyProducts = MAX_MY_PRODUCTS_PER_RUN
  let remainingCompetitors = MAX_COMPETITORS_PER_RUN

  for (const workspaceId of workspaceIds) {
    if (remainingMyProducts <= 0 && remainingCompetitors <= 0) break
    const result = await buildCandidatesForWorkspace(admin, workspaceId, remainingMyProducts, remainingCompetitors, forceRefresh)
    if (!result) continue

    totalActiveMyProducts += result.totalActiveMyProducts
    totalActiveCompetitors += result.totalActiveCompetitors
    for (const candidate of result.candidates) {
      allCandidates.push(candidate)
      if (candidate.target_type === 'my_product') remainingMyProducts -= 1
      else remainingCompetitors -= 1
    }
  }

  const jobsToInsert = allCandidates.slice(0, manualLimit)
  let insertedCount = 0
  let insertWarning: string | null = null
  if (jobsToInsert.length > 0) {
    const { data: inserted, error: insertError } = await admin
      .from('background_jobs')
      .insert(jobsToInsert)
      .select('id')

    if (insertError) {
      console.warn('[asin-jobs-enqueue] insert failed', {
        code: insertError.code,
        workspaceCount: workspaceIds.length,
        candidateCount: allCandidates.length,
        requestedJobCount: jobsToInsert.length,
      })
      if (insertError.code === '23505') {
        insertWarning = 'Some checks were already queued; duplicates were skipped.'
      } else {
        return NextResponse.json(
          {
            error: 'Unable to enqueue checker jobs.',
            detail: 'Queue insert failed safely. Try again shortly or contact support with the current time.',
          },
          { status: 503 },
        )
      }
    }
    insertedCount = inserted?.length ?? 0
  }

  const enqueuedMyProducts = jobsToInsert.filter(job => job.target_type === 'my_product').length
  const enqueuedCompetitors = jobsToInsert.filter(job => job.target_type === 'competitor_asin').length

  return NextResponse.json({
    jobType: JOB_TYPE,
    mode: auth.mode,
    workspacesChecked: workspaceIds.length,
    totalActiveMyProducts,
    totalActiveCompetitors,
    enqueuedMyProducts,
    enqueuedCompetitors,
    insertedCount,
    warning: insertWarning,
    candidatesExceedingCap: Math.max(0, allCandidates.length - jobsToInsert.length),
  })
}
