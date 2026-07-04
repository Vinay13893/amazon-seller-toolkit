// scripts/process-asin-checker-jobs.ts
// Render cron command: npx tsx scripts/process-asin-checker-jobs.ts --workspace-id=<uuid> --limit=10 --max-runtime-ms=240000
// Render cron schedule: 0 STAR/4 * * *  (every 4 hours while Pricing API stays throttled)
// --workspace-id scopes enqueue + processing + stuck cleanup + cooldown check to one
// workspace. Omit it (manual admin use) to run across all active workspaces.
//
// Phases per run:
//   1. Reset stale "running" jobs (stuck > STUCK_JOB_TIMEOUT_MINUTES)
//   2. Enqueue new/overdue jobs for all workspaces with active Amazon connections
//   3. Process up to --limit jobs; stops immediately on Pricing API 429
//
// Safety: read-only from Amazon. Does not touch Brahmastra Ads, Business Reports, payments.

import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'
import { getItemOffersForAsin, type BuyBoxOfferStatus } from '@/lib/amazon/pricing'

// ── Constants (mirrored from process-next/route.ts) ──────────────────────────

const JOB_TYPE = 'product_page_snapshot'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const DEFAULT_CADENCE_HOURS = 24
// Fresh-429-evidence window for the global Pricing cooldown gate (short so
// pricing attempts resume regularly).
const PRICING_COOLDOWN_WINDOW_MINUTES = 30
// Retry/re-enqueue delay for jobs that hit or were skipped by Pricing
// cooldown (R11.1b: was 30 min → caused catalog-only churn).
const PRICING_COOLDOWN_RETRY_MINUTES = 4 * 60
const PRICING_UNAVAILABLE_RETRY_MINUTES = 24 * 60
const CATALOG_NOT_FOUND_RETRY_MINUTES = 24 * 60
const RETRY_DELAY_MINUTES = 30
const STUCK_JOB_TIMEOUT_MINUTES = 10
const MAX_WORKSPACES = 25
const RATE_LIMIT_REASON = 'amazon_pricing_rate_limited'
const COOLDOWN_ACTIVE_REASON = 'amazon_pricing_cooldown_active'
const RATE_LIMIT_REASONS = new Set([
  'amazon_pricing_rate_limited',
  'amazon_pricing_cooldown_active',
  'SP-API pricing call failed with HTTP 429',
])
const MARKETPLACE_ID_BY_MARKETPLACE: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getIntArg(name: string, defaultVal: number): number {
  const prefix = `--${name}=`
  const found = args.find(a => a.startsWith(prefix))
  if (!found) return defaultVal
  const parsed = parseInt(found.slice(prefix.length), 10)
  return Number.isFinite(parsed) ? parsed : defaultVal
}

function getStrArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = args.find(a => a.startsWith(prefix))
  const value = found ? found.slice(prefix.length).trim() : ''
  return value.length > 0 ? value : null
}

const LIMIT = getIntArg('limit', 10)
const MAX_RUNTIME_MS = getIntArg('max-runtime-ms', 240000)
const WORKSPACE_ID = getStrArg('workspace-id')

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const admin = createAdminClient()

function safeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
}

function classifyPricingError(message: string | null): 'rate_limited' | 'unavailable' | 'other' | null {
  if (!message) return null
  if (message.includes('429')) return 'rate_limited'
  if (message.includes('400')) return 'unavailable'
  return 'other'
}

function availabilityScore(status: BuyBoxOfferStatus | 'unavailable'): number | null {
  if (status === 'won' || status === 'lost') return 100
  if (status === 'no_buybox') return 0
  if (status === 'unknown' || status === 'partial_success') return 50
  return null
}

// ── Phase 1: Reset stuck jobs ─────────────────────────────────────────────────

async function cleanupStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_JOB_TIMEOUT_MINUTES * 60 * 1000).toISOString()
  let stuckQuery = admin
    .from('background_jobs')
    .select('id, attempt_count, max_attempts')
    .eq('job_type', JOB_TYPE)
    .eq('status', 'running')
    .lt('locked_at', cutoff)
  if (WORKSPACE_ID) stuckQuery = stuckQuery.eq('workspace_id', WORKSPACE_ID)
  const { data: stuck } = await stuckQuery.limit(50)

  if (!stuck || stuck.length === 0) return 0

  const now = new Date().toISOString()
  const runAfter = new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString()
  let reset = 0
  for (const job of stuck) {
    const canRetry = (job.attempt_count as number) < (job.max_attempts as number)
    await admin
      .from('background_jobs')
      .update({
        status: canRetry ? 'queued' : 'failed',
        last_error_safe: 'stale processing reset',
        locked_at: null,
        locked_by: null,
        run_after: canRetry ? runAfter : null,
        completed_at: canRetry ? null : now,
      })
      .eq('id', job.id as string)
    reset++
  }
  return reset
}

// ── Phase 2: Enqueue new / overdue jobs ───────────────────────────────────────

async function enqueueNewJobs(): Promise<{ enqueued: number; workspaces: number }> {
  let connectionsQuery = admin
    .from('amazon_connections')
    .select('workspace_id')
    .eq('status', 'active')
  if (WORKSPACE_ID) connectionsQuery = connectionsQuery.eq('workspace_id', WORKSPACE_ID)
  const { data: connections } = await connectionsQuery.limit(MAX_WORKSPACES)

  if (!connections || connections.length === 0) return { enqueued: 0, workspaces: 0 }

  const cadenceCutoff = new Date(Date.now() - DEFAULT_CADENCE_HOURS * 60 * 60 * 1000).toISOString()
  const rateLimitCutoff = new Date(Date.now() - PRICING_COOLDOWN_RETRY_MINUTES * 60 * 1000).toISOString()

  type NewJob = {
    workspace_id: string
    job_type: string
    target_type: 'my_product' | 'competitor_asin'
    target_id: string
    marketplace_id: string
    payload_json: { asin: string }
  }

  const allCandidates: NewJob[] = []

  for (const conn of connections) {
    const workspaceId = conn.workspace_id as string

    const [listingsResult, trackedResult, activeJobsResult] = await Promise.all([
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
        .or(`status.in.(queued,running),and(status.in.(completed,failed),completed_at.gte.${cadenceCutoff})`)
        .limit(2000),
    ])

    const skipKeys = new Set<string>()
    for (const job of activeJobsResult.data ?? []) {
      const key = `${job.target_type}:${job.target_id}`
      if (job.status === 'queued' || job.status === 'running') {
        skipKeys.add(key)
        continue
      }
      if ((job.status === 'completed' || job.status === 'failed') && job.completed_at) {
        const cutoff = RATE_LIMIT_REASONS.has(String(job.last_error_safe ?? '')) ? rateLimitCutoff : cadenceCutoff
        if ((job.completed_at as string) > cutoff) skipKeys.add(key)
      }
    }

    for (const listing of listingsResult.data ?? []) {
      if (!listing.asin) continue
      const key = `my_product:${listing.id}`
      if (skipKeys.has(key)) continue
      allCandidates.push({
        workspace_id: workspaceId,
        job_type: JOB_TYPE,
        target_type: 'my_product',
        target_id: listing.id as string,
        marketplace_id: (listing.marketplace_id as string | null) ?? DEFAULT_MARKETPLACE_ID,
        payload_json: { asin: (listing.asin as string).toUpperCase() },
      })
    }

    for (const tracked of trackedResult.data ?? []) {
      const key = `competitor_asin:${tracked.id}`
      if (skipKeys.has(key)) continue
      const mktId = MARKETPLACE_ID_BY_MARKETPLACE[String(tracked.marketplace).toUpperCase()] ?? DEFAULT_MARKETPLACE_ID
      allCandidates.push({
        workspace_id: workspaceId,
        job_type: JOB_TYPE,
        target_type: 'competitor_asin',
        target_id: tracked.id as string,
        marketplace_id: mktId,
        payload_json: { asin: String(tracked.asin).toUpperCase() },
      })
    }
  }

  if (allCandidates.length === 0) return { enqueued: 0, workspaces: connections.length }

  const { data: inserted, error: insertError } = await admin
    .from('background_jobs')
    .insert(allCandidates)
    .select('id')

  if (insertError && insertError.code !== '23505') {
    console.warn('[asin-checker] Enqueue insert error:', insertError.code, insertError.message)
  }

  return { enqueued: inserted?.length ?? 0, workspaces: connections.length }
}

// ── Phase 3: Load Amazon connection ───────────────────────────────────────────

async function loadConnection(workspaceId: string): Promise<WorkspaceConnection | null> {
  const { data: conn, error } = await admin
    .from('amazon_connections')
    .select('status, marketplace_id, selling_partner_id, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error || !conn || conn.status !== 'active' || !conn.refresh_token_encrypted) return null

  try {
    const refreshToken = decryptToken(conn.refresh_token_encrypted as string)
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
    } catch { /* non-fatal */ }
    return {
      accessToken: tokenResult.access_token,
      marketplaceId: conn.marketplace_id as string | null,
      sellingPartnerId: conn.selling_partner_id as string | null,
    }
  } catch {
    return null
  }
}

async function isPricingCoolingDown(): Promise<boolean> {
  const cutoff = new Date(Date.now() - PRICING_COOLDOWN_WINDOW_MINUTES * 60 * 1000).toISOString()
  let cooldownQuery = admin
    .from('background_jobs')
    .select('id')
    .eq('job_type', JOB_TYPE)
    .eq('last_error_safe', RATE_LIMIT_REASON)
    .gte('updated_at', cutoff)
  if (WORKSPACE_ID) cooldownQuery = cooldownQuery.eq('workspace_id', WORKSPACE_ID)
  const { data } = await cooldownQuery.limit(1).maybeSingle()
  return Boolean(data)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now()
  console.log(`[asin-checker] Starting — limit=${LIMIT} max-runtime=${MAX_RUNTIME_MS}ms workspaceScoped=${Boolean(WORKSPACE_ID)}`)

  // Phase 1
  const stuckReset = await cleanupStuckJobs()
  if (stuckReset > 0) console.log(`[asin-checker] Stuck reset: ${stuckReset}`)

  // Phase 2
  const { enqueued, workspaces } = await enqueueNewJobs()
  console.log(`[asin-checker] Enqueued ${enqueued} new jobs across ${workspaces} workspaces`)

  // Phase 3
  const connectionCache = new Map<string, WorkspaceConnection | null>()
  async function connectionFor(wsId: string): Promise<WorkspaceConnection | null> {
    if (!connectionCache.has(wsId)) connectionCache.set(wsId, await loadConnection(wsId))
    return connectionCache.get(wsId) ?? null
  }

  let pricingCooldownActive = await isPricingCoolingDown()
  if (pricingCooldownActive) {
    console.log('[asin-checker] Pricing cooldown already active — skipping processing this run')
    console.log(JSON.stringify({ stuckReset, enqueued, workspaces, processed: 0, pricingCooldownActiveAtStart: true, elapsedMs: Date.now() - startTime }))
    return
  }

  let processed = 0
  let completed = 0
  let partialCatalog = 0
  let pricingRateLimited = 0
  let pricingUnavailable = 0
  let catalogNotFound = 0
  let retried = 0
  let failed = 0
  let skippedNoConn = 0

  for (let i = 0; i < LIMIT; i++) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.log('[asin-checker] Max runtime reached')
      break
    }

    let dueQuery = admin
      .from('background_jobs')
      .select('id, workspace_id, target_type, target_id, marketplace_id, attempt_count, max_attempts, payload_json')
      .eq('job_type', JOB_TYPE)
      .eq('status', 'queued')
      .lte('run_after', new Date().toISOString())
    if (WORKSPACE_ID) dueQuery = dueQuery.eq('workspace_id', WORKSPACE_ID)
    const { data: dueJob, error: dueError } = await dueQuery
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (dueError || !dueJob) break

    const job = dueJob as BackgroundJobRow

    const { data: locked } = await admin
      .from('background_jobs')
      .update({ status: 'running', locked_at: new Date().toISOString(), locked_by: 'render-cron', attempt_count: job.attempt_count + 1 })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')

    if (!locked || locked.length === 0) continue
    processed++

    const asin = job.payload_json?.asin
    const connection = await connectionFor(job.workspace_id)

    if (!connection) {
      skippedNoConn++
      const canRetry = job.attempt_count + 1 < job.max_attempts
      await admin.from('background_jobs').update({
        status: canRetry ? 'queued' : 'failed',
        last_error_safe: 'Amazon connection is not active for this workspace.',
        run_after: canRetry ? new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString() : null,
        locked_at: null, locked_by: null,
        completed_at: canRetry ? null : new Date().toISOString(),
      }).eq('id', job.id)
      if (canRetry) retried++; else failed++
      continue
    }

    if (!asin) {
      await admin.from('background_jobs').update({
        status: 'failed', last_error_safe: 'Job payload missing ASIN.',
        locked_at: null, locked_by: null, completed_at: new Date().toISOString(),
      }).eq('id', job.id)
      failed++
      continue
    }

    const marketplaceId = connection.marketplaceId ?? job.marketplace_id ?? DEFAULT_MARKETPLACE_ID

    let catalogResult: Awaited<ReturnType<typeof getCatalogItemForAsin>> | null = null
    let offersResult: Awaited<ReturnType<typeof getItemOffersForAsin>> | null = null
    let catalogError: string | null = null
    let offersError: string | null = null

    try {
      catalogResult = await getCatalogItemForAsin({ accessToken: connection.accessToken, marketplaceId, asin })
    } catch (err) {
      catalogError = safeError(err)
    }

    try {
      offersResult = await getItemOffersForAsin({
        accessToken: connection.accessToken,
        marketplaceId,
        asin,
        itemCondition: 'New',
        sellingPartnerId: connection.sellingPartnerId,
      })
    } catch (err) {
      offersError = safeError(err)
      if (classifyPricingError(offersError) === 'rate_limited') pricingCooldownActive = true
    }

    const checkedAt = new Date().toISOString()
    const offersErrorClass = classifyPricingError(offersError)
    const offersIsRateLimited = offersErrorClass === 'rate_limited'
    const offersIsUnavailable = offersErrorClass === 'unavailable'
    const catalogIsNotFound = catalogError === 'catalog_not_found'

    if (!catalogResult && !offersResult) {
      const canRetry = job.attempt_count + 1 < job.max_attempts
      const retryDelay = offersIsRateLimited ? PRICING_COOLDOWN_RETRY_MINUTES
        : offersIsUnavailable ? PRICING_UNAVAILABLE_RETRY_MINUTES
        : catalogIsNotFound ? CATALOG_NOT_FOUND_RETRY_MINUTES
        : RETRY_DELAY_MINUTES
      const reason = offersIsRateLimited ? RATE_LIMIT_REASON
        : offersIsUnavailable ? 'amazon_pricing_unavailable'
        : (catalogError ?? offersError ?? 'Product page snapshot failed safely.')

      await admin.from('background_jobs').update({
        status: canRetry ? 'queued' : 'failed',
        last_error_safe: reason,
        run_after: canRetry ? new Date(Date.now() + retryDelay * 60 * 1000).toISOString() : null,
        locked_at: null, locked_by: null,
        completed_at: canRetry ? null : checkedAt,
      }).eq('id', job.id)

      if (offersIsRateLimited) { pricingRateLimited++; break }
      else if (offersIsUnavailable) pricingUnavailable++
      else if (catalogIsNotFound) catalogNotFound++
      else if (canRetry) retried++
      else failed++
      continue
    }

    const buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'
    const scrapeStatus =
      catalogResult && offersResult ? 'success'
      : catalogResult && offersIsRateLimited ? 'partial_pricing_rate_limited'
      : catalogResult ? 'partial_pricing_unavailable'
      : 'partial_catalog_unavailable'

    // R11.2: BSR from Catalog (primary) with Pricing Summary.SalesRankings as
    // official fallback; discount signal from Summary.ListPrice vs live price.
    const pricingRankings = offersResult?.sales_rankings ?? []
    const catalogRanks = catalogResult?.bsr_ranks ?? []
    const bsrValue = catalogResult?.bsr ?? pricingRankings[0]?.rank ?? null
    const bsrCategory = catalogResult?.bsr_category ?? pricingRankings[0]?.category_id ?? null
    const bsrSource = catalogResult?.bsr != null
      ? 'spapi_catalog'
      : pricingRankings.length > 0
        ? 'spapi_pricing_summary'
        : null
    const bsrRanksJson = catalogRanks.length > 0
      ? catalogRanks
      : pricingRankings.length > 0
        ? pricingRankings
        : null
    const livePrice = offersResult?.buy_box_price ?? offersResult?.your_offer_price ?? null
    const listPrice = offersResult?.list_price ?? null
    const discountPercent = listPrice !== null && livePrice !== null && listPrice > 0 && livePrice < listPrice
      ? Math.round(((listPrice - livePrice) / listPrice) * 1000) / 10
      : null

    const snapshotPayload = {
      workspace_id: job.workspace_id,
      tracked_asin_id: job.target_type === 'competitor_asin' ? job.target_id : null,
      amazon_listing_item_id: job.target_type === 'my_product' ? job.target_id : null,
      bsr: bsrValue,
      bsr_category: bsrCategory,
      bsr_source: bsrSource,
      bsr_ranks: bsrRanksJson,
      price: livePrice,
      list_price: listPrice,
      discount_percent: discountPercent,
      rating: null,
      review_count: null,
      buy_box_owner: offersResult?.buy_box_owner ?? null,
      buy_box_status: buyBoxStatus,
      availability_score: availabilityScore(buyBoxStatus),
      scrape_status: scrapeStatus,
      checked_at: checkedAt,
    }

    const { error: insertErr } = await admin.from('asin_snapshots').insert(snapshotPayload)
    if (insertErr) {
      const canRetry = job.attempt_count + 1 < job.max_attempts
      await admin.from('background_jobs').update({
        status: canRetry ? 'queued' : 'failed',
        last_error_safe: 'Snapshot could not be saved.',
        run_after: canRetry ? new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString() : null,
        locked_at: null, locked_by: null,
        completed_at: canRetry ? null : checkedAt,
      }).eq('id', job.id)
      if (canRetry) retried++; else failed++
      continue
    }

    const completedReason = scrapeStatus === 'success' ? null
      : scrapeStatus === 'partial_pricing_rate_limited' ? RATE_LIMIT_REASON
      : scrapeStatus === 'partial_pricing_unavailable' ? 'amazon_pricing_unavailable'
      : (catalogError ?? null)

    await admin.from('background_jobs').update({
      status: 'completed', last_error_safe: completedReason,
      locked_at: null, locked_by: null, completed_at: checkedAt,
    }).eq('id', job.id)

    if (scrapeStatus === 'success') {
      completed++
    } else {
      partialCatalog++
      if (offersIsRateLimited) { pricingRateLimited++; break }
    }
  }

  const summary = {
    stuckReset, enqueued, workspaces,
    processed, completed, partialCatalog,
    pricingRateLimited, pricingUnavailable, catalogNotFound,
    retried, failed, skippedNoConn,
    workspaceScoped: Boolean(WORKSPACE_ID),
    pricingCooldownActiveAtEnd: pricingCooldownActive,
    elapsedMs: Date.now() - startTime,
  }
  console.log(JSON.stringify(summary))
}

main().catch(err => {
  console.error('[asin-checker] Fatal:', safeError(err))
  process.exit(1)
})
