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

function safeReasonFor(errorClass: PricingErrorClass | null, fallback: string | null): string | null {
  if (errorClass === 'rate_limited') return 'amazon_pricing_rate_limited'
  if (errorClass === 'unavailable') return 'amazon_pricing_unavailable'
  return fallback
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
  let partial = 0
  let deferredRateLimited = 0
  let retried = 0
  let failed = 0
  let skippedNoConnection = 0

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

    try {
      catalogResult = await getCatalogItemForAsin({ accessToken: connection.accessToken, marketplaceId, asin })
    } catch (error) {
      catalogError = safeErrorMessage(error)
    }

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
    }

    const checkedAt = new Date().toISOString()
    const catalogErrorClass = classifyPricingError(catalogError)
    const offersErrorClass = classifyPricingError(offersError)
    const worstErrorClass: PricingErrorClass | null = offersErrorClass === 'rate_limited' || catalogErrorClass === 'rate_limited'
      ? 'rate_limited'
      : offersErrorClass ?? catalogErrorClass

    if (!catalogResult && !offersResult) {
      const isRateLimited = worstErrorClass === 'rate_limited'
      const isUnavailable = worstErrorClass === 'unavailable'
      const canRetry = job.attempt_count + 1 < job.max_attempts
      const nextStatus = canRetry ? 'queued' : 'failed'
      const retryDelayMinutes = isRateLimited
        ? PRICING_RATE_LIMITED_RETRY_MINUTES
        : isUnavailable
          ? PRICING_UNAVAILABLE_RETRY_MINUTES
          : RETRY_DELAY_MINUTES

      await admin
        .from('background_jobs')
        .update({
          status: nextStatus,
          last_error_safe: safeReasonFor(worstErrorClass, catalogError ?? offersError ?? 'Product page snapshot failed safely.'),
          run_after: canRetry
            ? new Date(Date.now() + retryDelayMinutes * 60 * 1000).toISOString()
            : undefined,
          locked_at: null,
          locked_by: null,
          completed_at: canRetry ? null : checkedAt,
        })
        .eq('id', job.id)

      if (isRateLimited) deferredRateLimited += 1
      else if (canRetry) retried += 1
      else failed += 1

      // A rate-limit hit means the quota is exhausted right now — stop this
      // batch instead of immediately hammering Amazon Pricing again.
      if (isRateLimited) break
      continue
    }

    const buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'
    const scrapeStatus: 'success' | 'partial_pricing_unavailable' | 'partial_catalog_unavailable' | 'failed' = catalogResult && offersResult
      ? 'success'
      : catalogResult
        ? 'partial_pricing_unavailable'
        : offersResult
          ? 'partial_catalog_unavailable'
          : 'failed'

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

    await admin
      .from('background_jobs')
      .update({
        status: 'completed',
        last_error_safe: scrapeStatus === 'success' ? null : safeReasonFor(worstErrorClass, catalogError ?? offersError ?? null),
        locked_at: null,
        locked_by: null,
        completed_at: checkedAt,
      })
      .eq('id', job.id)

    if (scrapeStatus === 'success') completed += 1
    else partial += 1

    // A rate-limit hit on pricing (even with a partial catalog-only save)
    // means the quota is currently exhausted — stop this batch.
    if (worstErrorClass === 'rate_limited') break
  }

  const summary = {
    jobType: JOB_TYPE,
    mode: auth.mode,
    processed: claimed,
    completed,
    partial,
    deferredRateLimited,
    retried,
    failed,
    skippedNoConnection,
  }
  console.log(JSON.stringify(summary))
  return NextResponse.json(summary)
}
