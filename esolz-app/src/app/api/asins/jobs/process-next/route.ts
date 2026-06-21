import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'
import { getItemOffersForAsin, type BuyBoxOfferStatus } from '@/lib/amazon/pricing'

export const runtime = 'nodejs'
export const maxDuration = 120

const JOB_TYPE = 'product_page_snapshot'
const BATCH_SIZE = 5
const RETRY_DELAY_MINUTES = 30
const WORKER_ID = 'nextjs-app'

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

function safeErrorMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
}

function availabilityScoreFor(status: BuyBoxOfferStatus | 'unavailable'): number | null {
  if (status === 'won' || status === 'lost') return 100
  if (status === 'no_buybox') return 0
  if (status === 'unknown' || status === 'partial_success') return 50
  return null
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id
  const admin = createAdminClient()

  const connection = await admin
    .from('amazon_connections')
    .select('id, status, marketplace_id, selling_partner_id, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (connection.error || !connection.data || connection.data.status !== 'active' || !connection.data.refresh_token_encrypted) {
    return NextResponse.json({
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      message: 'Amazon connection is not active for this workspace. Connect Amazon to run product checks.',
    })
  }

  let accessToken: string
  try {
    const refreshToken = decryptToken(connection.data.refresh_token_encrypted)
    const tokenResult = await refreshAccessToken(refreshToken)
    accessToken = tokenResult.access_token

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
  } catch {
    return NextResponse.json({
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      message: 'Amazon access token could not be refreshed. Reconnect Amazon to run product checks.',
    })
  }

  let claimed = 0
  let completed = 0
  let retried = 0
  let failed = 0

  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const { data: dueJob, error: dueError } = await admin
      .from('background_jobs')
      .select('id, workspace_id, target_type, target_id, marketplace_id, attempt_count, max_attempts, payload_json')
      .eq('workspace_id', workspaceId)
      .eq('job_type', JOB_TYPE)
      .eq('status', 'queued')
      .lte('run_after', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (dueError || !dueJob) break

    const job = dueJob as BackgroundJobRow
    const lockedAt = new Date().toISOString()
    const { data: lockedRows } = await admin
      .from('background_jobs')
      .update({
        status: 'running',
        locked_at: lockedAt,
        locked_by: WORKER_ID,
        attempt_count: job.attempt_count + 1,
      })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')

    if (!lockedRows || lockedRows.length === 0) continue
    claimed += 1

    const asin = job.payload_json?.asin
    const marketplaceId = connection.data.marketplace_id ?? job.marketplace_id ?? 'A21TJRUUN4KGV'

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

    let catalogResult: Awaited<ReturnType<typeof getCatalogItemForAsin>> | null = null
    let offersResult: Awaited<ReturnType<typeof getItemOffersForAsin>> | null = null
    let catalogError: string | null = null
    let offersError: string | null = null

    try {
      catalogResult = await getCatalogItemForAsin({ accessToken, marketplaceId, asin })
    } catch (error) {
      catalogError = safeErrorMessage(error)
    }

    try {
      offersResult = await getItemOffersForAsin({
        accessToken,
        marketplaceId,
        asin,
        itemCondition: 'New',
        sellingPartnerId: connection.data.selling_partner_id,
      })
    } catch (error) {
      offersError = safeErrorMessage(error)
    }

    const checkedAt = new Date().toISOString()

    if (!catalogResult && !offersResult) {
      const canRetry = job.attempt_count + 1 < job.max_attempts
      const nextStatus = canRetry ? 'queued' : 'failed'
      await admin
        .from('background_jobs')
        .update({
          status: nextStatus,
          last_error_safe: catalogError ?? offersError ?? 'Product page snapshot failed safely.',
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

    const buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'
    const scrapeStatus: 'success' | 'partial_success' | 'failed' = catalogResult && offersResult
      ? 'success'
      : catalogResult || offersResult
        ? 'partial_success'
        : 'failed'

    const snapshotPayload = {
      workspace_id: workspaceId,
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
        last_error_safe: catalogError ?? offersError ?? null,
        locked_at: null,
        locked_by: null,
        completed_at: checkedAt,
      })
      .eq('id', job.id)
    completed += 1
  }

  return NextResponse.json({
    jobType: JOB_TYPE,
    claimed,
    completed,
    retried,
    failed,
  })
}
