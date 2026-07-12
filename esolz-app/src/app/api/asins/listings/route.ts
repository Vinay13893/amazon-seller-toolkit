import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { timeAgo } from '@/lib/format'

export const runtime = 'nodejs'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const JOB_TYPE = 'product_page_snapshot'
const PRICING_RATE_LIMITED_RETRY_MINUTES = 30

const RATE_LIMIT_REASONS = new Set([
  'amazon_pricing_rate_limited',
  'amazon_pricing_cooldown_active',
  'SP-API pricing call failed with HTTP 429',
])

function safeSearch(value: string | null): string {
  return (value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .slice(0, 100)
}

export type ListingSnapshotRow = {
  amazon_listing_item_id: string | null
  price: number | null
  bsr: number | null
  buy_box_owner: string | null
  buy_box_status: string | null
  availability_score: number | null
  scrape_status: string | null
  checked_at: string
}

type CheckerJobRow = {
  target_id: string
  status: string
  run_after: string | null
  updated_at: string | null
  completed_at: string | null
  last_error_safe: string | null
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString()
}

function pricingStatusLabel(latest: ListingSnapshotRow | null, priceSnapshot: ListingSnapshotRow | null): string {
  if (!latest) return 'Not checked yet'
  if (latest.scrape_status === 'partial_pricing_rate_limited') {
    return priceSnapshot?.price != null ? 'Latest attempt rate-limited; showing last successful price' : 'Pricing rate-limited'
  }
  if (latest.scrape_status === 'partial_pricing_unavailable') return 'Pricing unavailable from SP-API'
  if (priceSnapshot?.price != null) return 'SP-API Product Pricing'
  return 'No price from Pricing source'
}

function catalogStatusLabel(latest: ListingSnapshotRow | null, bsrSnapshot: ListingSnapshotRow | null): string {
  if (!latest) return 'Not checked yet'
  if (bsrSnapshot?.bsr != null) {
    return latest.bsr == null && latest.checked_at !== bsrSnapshot.checked_at
      ? 'Latest Catalog attempt had no BSR; showing last successful BSR'
      : 'SP-API Catalog salesRanks'
  }
  if (latest.scrape_status === 'partial_catalog_unavailable') return 'Catalog source unavailable'
  return 'BSR unavailable from Catalog source'
}

/**
 * Only ever called with a snapshot whose buy_box_status is 'won' or 'lost'
 * (see confirmedBuyBoxSnapshot below) -- never an 'unknown'/'no_buybox'/
 * 'partial_success' status, and never a rate-limited/unavailable attempt
 * (those now write null, not a fake status string -- see
 * BRAHMASTRA_MASTER_TRACKER.md sec19). This function never infers a loss
 * from an unconfirmed/unknown result; absence of a confirmed snapshot always
 * returns 'Not confirmed', never 'Lost'.
 */
export function findPriceSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot => snapshot.price !== null) ?? null
}

export function findBsrSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot => snapshot.bsr !== null) ?? null
}

export function findPricingSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot =>
    snapshot.price !== null ||
    snapshot.buy_box_owner !== null ||
    snapshot.buy_box_status !== null ||
    snapshot.availability_score !== null
  ) ?? null
}

/**
 * Buy Box display fix (BRAHMASTRA_MASTER_TRACKER.md sec19): coalesce ONLY a
 * genuinely confirmed 'won'/'lost' snapshot -- ignore null (rate-limited/
 * unavailable, now written correctly by resolveBuyBoxStatusToStore in
 * process-next/route.ts) and ignore 'unknown'/'no_buybox'/'partial_success'
 * too. Deliberately narrower than findPricingSnapshot above, which still
 * feeds Price and Availability unchanged.
 */
export function findConfirmedBuyBoxSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(
    snapshot => snapshot.buy_box_status === 'won' || snapshot.buy_box_status === 'lost'
  ) ?? null
}

export function buyBoxStatusLabel(latest: ListingSnapshotRow | null, confirmedSnapshot: ListingSnapshotRow | null): string {
  if (!latest) return 'Not checked yet'
  if (!confirmedSnapshot) return 'Not confirmed'
  const label = confirmedSnapshot.buy_box_status === 'won' ? 'Won' : 'Lost'
  const isFresh = confirmedSnapshot.checked_at === latest.checked_at
  return isFresh ? label : `${label} — last confirmed ${timeAgo(confirmedSnapshot.checked_at)}`
}

function availabilityStatusLabel(latest: ListingSnapshotRow | null, pricingSnapshot: ListingSnapshotRow | null): string {
  if (!latest) return 'Not checked yet'
  if (latest.scrape_status === 'partial_pricing_rate_limited') {
    return pricingSnapshot?.availability_score != null ? 'Latest attempt rate-limited; showing last offer availability signal' : 'Availability source rate-limited'
  }
  if (pricingSnapshot?.availability_score != null) return 'Offer availability signal from Pricing source'
  return 'Availability unavailable from current source'
}

function latestJobForTarget(jobs: CheckerJobRow[], targetId: string): CheckerJobRow | null {
  const rows = jobs.filter(job => job.target_id === targetId)
  return rows.sort((a, b) => new Date(b.updated_at ?? b.completed_at ?? 0).getTime() - new Date(a.updated_at ?? a.completed_at ?? 0).getTime())[0] ?? null
}

function nextRetryAt(job: CheckerJobRow | null): string | null {
  if (!job) return null
  if ((job.status === 'queued' || job.status === 'running') && job.run_after) return job.run_after
  if (job.completed_at && RATE_LIMIT_REASONS.has(job.last_error_safe ?? '')) {
    const retryAt = addMinutes(job.completed_at, PRICING_RATE_LIMITED_RETRY_MINUTES)
    // Only return future retry times — past dates mean the job is already overdue for re-enqueue
    if (retryAt > new Date().toISOString()) return retryAt
  }
  return null
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const offset = Math.max(0, Number.parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0)
  const requestedLimit = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit || DEFAULT_PAGE_SIZE))
  const search = safeSearch(request.nextUrl.searchParams.get('q'))

  let query = supabase
    .from('amazon_listing_items')
    .select(
      'id, sku, asin, item_name, brand, product_type, status, marketplace_id, image_url, last_synced_at',
      { count: 'exact' },
    )
    .eq('workspace_id', membership.workspace_id)
    .order('item_name', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (search) {
    const term = `%${search}%`
    const marketplaceAliases: Record<string, string> = {
      IN: 'A21TJRUUN4KGV',
      INDIA: 'A21TJRUUN4KGV',
      US: 'ATVPDKIKX0DER',
      USA: 'ATVPDKIKX0DER',
      UK: 'A1F83G8C2ARO7P',
      DE: 'A1PA6795UKMFR9',
      GERMANY: 'A1PA6795UKMFR9',
    }
    const marketplaceId = marketplaceAliases[search.toUpperCase()]
    const filters = [
      `item_name.ilike.${term}`,
      `asin.ilike.${term}`,
      `sku.ilike.${term}`,
      `brand.ilike.${term}`,
      `marketplace_id.ilike.${term}`,
      ...(marketplaceId ? [`marketplace_id.eq.${marketplaceId}`] : []),
    ]
    query = query.or(filters.join(','))
  }

  const { data, count, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Unable to load Seller Central listings.' }, { status: 500 })
  }

  const listingIds = (data ?? []).map(row => row.id as string)
  const snapshotsByListingId = new Map<string, ListingSnapshotRow[]>()
  let listingJobs: CheckerJobRow[] = []

  if (listingIds.length > 0) {
    const { data: snapshots } = await supabase
      .from('asin_snapshots')
      .select('amazon_listing_item_id, price, bsr, buy_box_owner, buy_box_status, availability_score, scrape_status, checked_at')
      .in('amazon_listing_item_id', listingIds)
      .order('checked_at', { ascending: false })

    for (const snapshot of snapshots ?? []) {
      const listingId = snapshot.amazon_listing_item_id as string | null
      if (!listingId) continue
      if (!snapshotsByListingId.has(listingId)) snapshotsByListingId.set(listingId, [])
      snapshotsByListingId.get(listingId)?.push({
        amazon_listing_item_id: listingId,
        price: snapshot.price as number | null,
        bsr: snapshot.bsr as number | null,
        buy_box_owner: snapshot.buy_box_owner as string | null,
        buy_box_status: snapshot.buy_box_status as string | null,
        availability_score: snapshot.availability_score as number | null,
        scrape_status: snapshot.scrape_status as string | null,
        checked_at: snapshot.checked_at as string,
      })
    }

    const { data: jobs } = await supabase
      .from('background_jobs')
      .select('target_id, status, run_after, updated_at, completed_at, last_error_safe')
      .eq('workspace_id', membership.workspace_id)
      .eq('job_type', JOB_TYPE)
      .eq('target_type', 'my_product')
      .in('target_id', listingIds)
      .order('updated_at', { ascending: false })
      .limit(1000)
    listingJobs = (jobs ?? []) as CheckerJobRow[]
  }

  const items = (data ?? []).map(row => ({
    ...row,
    snapshot: (() => {
      const listingId = row.id as string
      const snapshots = (snapshotsByListingId.get(listingId) ?? [])
        .sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime())
      const latest = snapshots[0] ?? null
      const priceSnapshot = findPriceSnapshot(snapshots)
      const bsrSnapshot = findBsrSnapshot(snapshots)
      const pricingSnapshot = findPricingSnapshot(snapshots)
      const confirmedBuyBoxSnapshot = findConfirmedBuyBoxSnapshot(snapshots)
      const job = latestJobForTarget(listingJobs, listingId)

      if (!latest && !job) return null

      return {
        price: priceSnapshot?.price ?? null,
        bsr: bsrSnapshot?.bsr ?? null,
        buy_box_owner: confirmedBuyBoxSnapshot?.buy_box_owner ?? null,
        buy_box_status: confirmedBuyBoxSnapshot?.buy_box_status ?? null,
        buy_box_confirmed_at: confirmedBuyBoxSnapshot?.checked_at ?? null,
        availability_score: pricingSnapshot?.availability_score ?? null,
        scrape_status: latest?.scrape_status ?? null,
        checked_at: latest?.checked_at ?? job?.updated_at ?? job?.completed_at ?? new Date(0).toISOString(),
        last_attempted_at: latest?.checked_at ?? job?.updated_at ?? null,
        last_successful_price_checked_at: priceSnapshot?.checked_at ?? null,
        last_successful_bsr_checked_at: bsrSnapshot?.checked_at ?? null,
        last_successful_pricing_checked_at: pricingSnapshot?.checked_at ?? null,
        latest_failure_reason: job?.last_error_safe ?? null,
        next_retry_at: nextRetryAt(job),
        price_source_status: pricingStatusLabel(latest, priceSnapshot),
        bsr_source_status: catalogStatusLabel(latest, bsrSnapshot),
        buy_box_source_status: buyBoxStatusLabel(latest, confirmedBuyBoxSnapshot),
        availability_source_status: availabilityStatusLabel(latest, pricingSnapshot),
        deal_tag_source_status: 'Deal checker not implemented yet',
        queue_status: job?.status ?? null,
      }
    })(),
  }))

  const { data: checkerJobs } = await supabase
    .from('background_jobs')
    .select('status, run_after, updated_at, completed_at, last_error_safe')
    .eq('workspace_id', membership.workspace_id)
    .eq('job_type', JOB_TYPE)
    .order('updated_at', { ascending: false })
    .limit(5000)

  const checkerNow = new Date().toISOString()
  const checkerRows = (checkerJobs ?? []) as Array<Omit<CheckerJobRow, 'target_id'>>
  const checkerSummary = checkerRows.reduce((acc, job) => {
    if (job.status === 'queued') {
      acc.queued += 1
      if (!job.run_after || job.run_after <= checkerNow) acc.queueDueNow += 1
      else acc.queueWaiting += 1
    }
    if (job.status === 'running') acc.processing += 1
    if (job.status === 'completed') acc.succeeded += 1
    if (job.status === 'failed') acc.failed += 1
    if (RATE_LIMIT_REASONS.has(job.last_error_safe ?? '')) acc.rateLimited += 1
    const attemptedAt = job.updated_at ?? job.completed_at
    if (attemptedAt && (!acc.lastAttemptedAt || attemptedAt > acc.lastAttemptedAt)) acc.lastAttemptedAt = attemptedAt
    if (job.status === 'completed' && !job.last_error_safe && job.completed_at && (!acc.lastSuccessfulAt || job.completed_at > acc.lastSuccessfulAt)) {
      acc.lastSuccessfulAt = job.completed_at
    }
    const retryAt = nextRetryAt(job as CheckerJobRow)
    if (retryAt && (!acc.nextRetryAt || retryAt < acc.nextRetryAt)) acc.nextRetryAt = retryAt
    return acc
  }, {
    queued: 0,
    queueDueNow: 0,
    queueWaiting: 0,
    processing: 0,
    succeeded: 0,
    failed: 0,
    rateLimited: 0,
    lastAttemptedAt: null as string | null,
    lastSuccessfulAt: null as string | null,
    nextRetryAt: null as string | null,
  })

  const suggestedAction = (() => {
    if (checkerSummary.processing > 0) return 'Processing active'
    if (checkerSummary.queueDueNow > 0) return 'Cron not configured — start processor to clear queue'
    if (checkerSummary.rateLimited > 0 && checkerSummary.queueWaiting > 0) return 'Pricing API cooldown active'
    if (checkerSummary.queued === 0 && checkerSummary.succeeded > 0) return 'Queue healthy'
    return null
  })()

  const { data: latestJob } = await supabase
    .from('amazon_sync_jobs')
    .select('status, started_at, finished_at, metadata')
    .eq('workspace_id', membership.workspace_id)
    .eq('job_type', 'listings_sync')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const metadata = (latestJob?.metadata ?? {}) as Record<string, unknown>
  return NextResponse.json({
    items,
    total: count ?? 0,
    offset,
    limit,
    hasMore: offset + (data?.length ?? 0) < (count ?? 0),
    checker: { ...checkerSummary, suggestedAction },
    sync: latestJob
      ? {
          status: latestJob.status,
          importedCount: Number(metadata.items_upserted ?? 0),
          hasMore: Boolean(metadata.has_more),
          lastSyncAt: latestJob.finished_at ?? latestJob.started_at,
        }
      : null,
  })
}
