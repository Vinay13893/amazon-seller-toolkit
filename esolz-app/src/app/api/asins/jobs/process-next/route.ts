import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'
import { getItemOffersForAsin, type BuyBoxOfferStatus } from '@/lib/amazon/pricing'
import { resolveJobsAuth } from '@/lib/internal/background-worker-auth'

export const runtime = 'nodejs'
export const maxDuration = 120

const JOB_TYPE = 'product_page_snapshot'
const SESSION_BATCH_SIZE = 5
const SYSTEM_BATCH_SIZE = 5
const RETRY_DELAY_MINUTES = 30
const PRICING_RATE_LIMITED_RETRY_MINUTES = 30
const PRICING_UNAVAILABLE_RETRY_MINUTES = 24 * 60
const CATALOG_NOT_FOUND_RETRY_MINUTES = 24 * 60
const WORKER_ID_SESSION = 'nextjs-app-manual'
const WORKER_ID_SYSTEM = 'nextjs-app-automation'

type BackgroundJobRow = {
  id: string
  workspace_id: string
  target_type: 'my_product' | 'competitor_asin'
  target_id: string
  marketplace_id: string | null
  attempt_count: number
  max_attempts: number
  payload_json: { asin?: string } | null
}

type WorkspaceConnection = {
  accessToken: string
  marketplaceId: string | null
  sellingPartnerId: string | null
}

function safeErrorMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
}

type PricingErrorClass = 'rate_limited' | 'unavailable' | 'other'

function classifyPricingError(message: string | null): PricingErrorClass | null {
  if (!message) return null
  if (message.includes('429')) return 'rate_limited'
  if (message.includes('400')) return 'unavailable'
  return 'other'
}

const RATE_LIMIT_REASON = 'amazon_pricing_rate_limited'
const COOLDOWN_ACTIVE_REASON = 'amazon_pricing_cooldown_active'

/**
 * Amazon Pricing throttling is account/app-wide, not per-ASIN. Rather than
 * adding a new table, reuse background_jobs as the cooldown signal: if any
 * product_page_snapshot job recently recorded a REAL 429 (RATE_LIMIT_REASON),
 * treat Pricing as cooling down for this whole call (and skip further
 * Pricing calls within it) instead of immediately retrying on the next
 * job/ASIN. Jobs that merely skipped Pricing because cooldown was already
 * active are tagged with COOLDOWN_ACTIVE_REASON instead, so they never
 * count as fresh evidence and the cooldown window can actually expire.
 */
async function isPricingCoolingDown(admin: ReturnType<typeof createAdminClient>): Promise<boolean> {
  const cutoff = new Date(Date.now() - PRICING_RATE_LIMITED_RETRY_MINUTES * 60 * 1000).toISOString()
  const { data } = await admin
    .from('background_jobs')
    .select('id')
    .eq('job_type', JOB_TYPE)
    .eq('last_error_safe', RATE_LIMIT_REASON)
    .gte('updated_at', cutoff)
    .limit(1)
    .maybeSingle()
  return Boolean(data)
}

function availabilityScoreFor(status: BuyBoxOfferStatus | 'unavailable'): number | null {
  if (status === 'won' || status === 'lost') return 100
  if (status === 'no_buybox') return 0
  if (status === 'unknown' || status === 'partial_success') return 50
  return null
}

async function loadWorkspaceConnection(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<WorkspaceConnection | null> {
  const connection = await admin
    .from('amazon_connections')
    .select('id, status, marketplace_id, selling_partner_id, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (connection.error || !connection.data || connection.data.status !== 'active' || !connection.data.refresh_token_encrypted) {
    return null
  }

  try {
    const refreshToken = decryptToken(connection.data.refresh_token_encrypted)
    const tokenResult = await refreshAccessToken(refreshToken)

    try {
      await admin
        .from('amazon_connections')
        .update({
          access_token_encrypted: encryptToken(tokenResult.access_token),
          access_token_expires_at: new Date(Date.now() + tokenResult.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
    } catch {
      // Non-fatal: token refresh succeeded even if persisting it failed.
    }

    return {
      accessToken: tokenResult.access_token,
      marketplaceId: connection.data.marketplace_id,
      sellingPartnerId: connection.data.selling_partner_id,
    }
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const auth = await resolveJobsAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const isSystem = auth.mode === 'system'
  const batchSize = isSystem ? SYSTEM_BATCH_SIZE : SESSION_BATCH_SIZE
  const workerId = isSystem ? WORKER_ID_SYSTEM : WORKER_ID_SESSION

  const connectionCache = new Map<string, WorkspaceConnection | null>()
  async function connectionFor(workspaceId: string): Promise<WorkspaceConnection | null> {
    if (!connectionCache.has(workspaceId)) {
      connectionCache.set(workspaceId, await loadWorkspaceConnection(admin, workspaceId))
    }
    return connectionCache.get(workspaceId) ?? null
  }

  let claimed = 0
  let completed = 0
  let partialCatalogOnly = 0
  let pricingSkippedCooldown = 0
  let pricingRateLimited = 0
  let pricingUnavailable = 0
  let catalogNotFound = 0
  let retried = 0
  let failed = 0
  let skippedNoConnection = 0
  let pricingCooldownActive = await isPricingCoolingDown(admin)

  for (let i = 0; i < batchSize; i += 1) {
    let dueQuery = admin
      .from('background_jobs')
      .select('id, workspace_id, target_type, target_id, marketplace_id, attempt_count, max_attempts, payload_json')
      .eq('job_type', JOB_TYPE)
      .eq('status', 'queued')
      .lte('run_after', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)

    if (auth.mode === 'session') {
      dueQuery = dueQuery.eq('workspace_id', auth.workspaceId)
    }

    const { data: dueJob, error: dueError } = await dueQuery.maybeSingle()
    if (dueError || !dueJob) break

    const job = dueJob as BackgroundJobRow
    const { data: lockedRows } = await admin
      .from('background_jobs')
      .update({
        status: 'running',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
        attempt_count: job.attempt_count + 1,
      })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')

    if (!lockedRows || lockedRows.length === 0) continue
    claimed += 1

    const asin = job.payload_json?.asin
    const connection = await connectionFor(job.workspace_id)

    if (!connection) {
      skippedNoConnection += 1
      const canRetry = job.attempt_count + 1 < job.max_attempts
      await admin
        .from('background_jobs')
        .update({
          status: canRetry ? 'queued' : 'failed',
          last_error_safe: 'Amazon connection is not active for this workspace.',
          run_after: canRetry
            ? new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString()
            : undefined,
          locked_at: null,
          locked_by: null,
          completed_at: canRetry ? null : new Date().toISOString(),
        })
        .eq('id', job.id)
      if (canRetry) retried += 1
      else failed += 1
      continue
    }

    if (!asin) {
      await admin
        .from('background_jobs')
        .update({
          status: 'failed',
          last_error_safe: 'Job payload was missing an ASIN.',
          locked_at: null,
          locked_by: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      failed += 1
      continue
    }

    const marketplaceId = connection.marketplaceId ?? job.marketplace_id ?? 'A21TJRUUN4KGV'

    let catalogResult: Awaited<ReturnType<typeof getCatalogItemForAsin>> | null = null
    let offersResult: Awaited<ReturnType<typeof getItemOffersForAsin>> | null = null
    let catalogError: string | null = null
    let offersError: string | null = null
    const pricingSkippedThisJob = pricingCooldownActive

    try {
      catalogResult = await getCatalogItemForAsin({ accessToken: connection.accessToken, marketplaceId, asin })
    } catch (error) {
      catalogError = safeErrorMessage(error)
    }

    if (!pricingSkippedThisJob) {
      try {
        offersResult = await getItemOffersForAsin({
          accessToken: connection.accessToken,
          marketplaceId,
          asin,
          itemCondition: 'New',
          sellingPartnerId: connection.sellingPartnerId,
        })
      } catch (error) {
        offersError = safeErrorMessage(error)
        if (classifyPricingError(offersError) === 'rate_limited') pricingCooldownActive = true
      }
    }

    const checkedAt = new Date().toISOString()
    const offersErrorClass = classifyPricingError(offersError)
    const offersIsRateLimited = !pricingSkippedThisJob && offersErrorClass === 'rate_limited'
    const offersIsUnavailable = !pricingSkippedThisJob && offersErrorClass === 'unavailable'

    const catalogIsNotFound = catalogError === 'catalog_not_found'

    if (!catalogResult && !offersResult) {
      const canRetry = job.attempt_count + 1 < job.max_attempts
      const nextStatus = canRetry ? 'queued' : 'failed'
      const retryDelayMinutes = offersIsRateLimited
        ? PRICING_RATE_LIMITED_RETRY_MINUTES
        : offersIsUnavailable
          ? PRICING_UNAVAILABLE_RETRY_MINUTES
          : catalogIsNotFound
            ? CATALOG_NOT_FOUND_RETRY_MINUTES
            : RETRY_DELAY_MINUTES
      const reasonSafe = offersIsRateLimited
        ? RATE_LIMIT_REASON
        : offersIsUnavailable
          ? 'amazon_pricing_unavailable'
          : (catalogError ?? offersError ?? 'Product page snapshot failed safely.')

      await admin
        .from('background_jobs')
        .update({
          status: nextStatus,
          last_error_safe: reasonSafe,
          run_after: canRetry
            ? new Date(Date.now() + retryDelayMinutes * 60 * 1000).toISOString()
            : undefined,
          locked_at: null,
          locked_by: null,
          completed_at: canRetry ? null : checkedAt,
        })
        .eq('id', job.id)

      if (offersIsRateLimited) pricingRateLimited += 1
      else if (offersIsUnavailable) pricingUnavailable += 1
      else if (catalogIsNotFound) catalogNotFound += 1
      else if (canRetry) retried += 1
      else failed += 1
      continue
    }

    const buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'
    const scrapeStatus: 'success' | 'partial_pricing_rate_limited' | 'partial_pricing_unavailable' | 'partial_catalog_unavailable' =
      catalogResult && offersResult
        ? 'success'
        : catalogResult && (pricingSkippedThisJob || offersIsRateLimited)
          ? 'partial_pricing_rate_limited'
          : catalogResult
            ? 'partial_pricing_unavailable'
            : 'partial_catalog_unavailable'

    const snapshotPayload = {
      workspace_id: job.workspace_id,
      tracked_asin_id: job.target_type === 'competitor_asin' ? job.target_id : null,
      amazon_listing_item_id: job.target_type === 'my_product' ? job.target_id : null,
      bsr: catalogResult?.bsr ?? null,
      price: offersResult?.buy_box_price ?? offersResult?.your_offer_price ?? null,
      rating: null,
      review_count: null,
      buy_box_owner: offersResult?.buy_box_owner ?? null,
      buy_box_status: buyBoxStatus,
      availability_score: availabilityScoreFor(buyBoxStatus),
      scrape_status: scrapeStatus,
      checked_at: checkedAt,
    }

    const insertResult = await admin.from('asin_snapshots').insert(snapshotPayload)
    if (insertResult.error) {
      const canRetry = job.attempt_count + 1 < job.max_attempts
      const nextStatus = canRetry ? 'queued' : 'failed'
      await admin
        .from('background_jobs')
        .update({
          status: nextStatus,
          last_error_safe: 'Snapshot could not be saved.',
          run_after: canRetry
            ? new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString()
            : undefined,
          locked_at: null,
          locked_by: null,
          completed_at: canRetry ? null : checkedAt,
        })
        .eq('id', job.id)
      if (canRetry) retried += 1
      else failed += 1
      continue
    }

    const completedReasonSafe = scrapeStatus === 'success'
      ? null
      : scrapeStatus === 'partial_pricing_rate_limited'
        ? (pricingSkippedThisJob ? COOLDOWN_ACTIVE_REASON : RATE_LIMIT_REASON)
        : scrapeStatus === 'partial_pricing_unavailable'
          ? 'amazon_pricing_unavailable'
          : (catalogError ?? null)

    await admin
      .from('background_jobs')
      .update({
        status: 'completed',
        last_error_safe: completedReasonSafe,
        locked_at: null,
        locked_by: null,
        completed_at: checkedAt,
      })
      .eq('id', job.id)

    if (scrapeStatus === 'success') {
      completed += 1
    } else {
      partialCatalogOnly += 1
      if (pricingSkippedThisJob) pricingSkippedCooldown += 1
      else if (offersIsRateLimited) pricingRateLimited += 1
      else if (offersIsUnavailable) pricingUnavailable += 1
    }
  }

  const summary = {
    jobType: JOB_TYPE,
    mode: auth.mode,
    processed: claimed,
    completed,
    partialCatalogOnly,
    pricingSkippedCooldown,
    pricingRateLimited,
    pricingUnavailable,
    catalogNotFound,
    retried,
    failed,
    skippedNoConnection,
  }
  console.log(JSON.stringify(summary))
  return NextResponse.json(summary)
}
