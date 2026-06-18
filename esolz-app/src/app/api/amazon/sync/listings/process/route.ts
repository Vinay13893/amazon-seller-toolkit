import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { searchListingsItems, extractNextPageToken, type ListingItem } from '@/lib/amazon/spapi-client'

export const runtime     = 'nodejs'
export const maxDuration = 25   // one page (~20 SKUs) is well within 25 s

/**
 * POST /api/amazon/sync/listings/process
 * Body: { job_id: string }
 *
 * Processes ONE page of listings for the given job, updates job.metadata,
 * and returns the current progress. The frontend calls this in a loop until
 * status === 'completed' or has_more === false.
 */
export async function POST(req: NextRequest) {
  try {
    return await handlePost(req)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ─── Upsert row type ─────────────────────────────────────────────────────────
interface ListingRow {
  workspace_id:   string
  connection_id:  string
  asin:           string | null
  sku:            string
  marketplace_id: string
  item_name:      string | null
  brand:          string | null
  product_type:   string | null
  status:         string | null
  image_url:      string | null
  raw_data:       Record<string, never>
  last_synced_at: string
  updated_at:     string
}

async function handlePost(req: NextRequest) {
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: { job_id?: string } = {}
  try { body = await req.json() } catch { /* empty body */ }
  const jobId = body.job_id
  if (!jobId) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  // ── 3. Workspace ───────────────────────────────────────────────────────────
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  if (member.role !== 'owner' && member.role !== 'admin') {
    return NextResponse.json({ error: 'Owner or admin required' }, { status: 403 })
  }

  const admin = createAdminClient()

  // ── 4. Load job (verify it belongs to this workspace) ─────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job } = await (admin as any)
    .from('amazon_sync_jobs')
    .select('id, workspace_id, connection_id, status, metadata')
    .eq('id', jobId)
    .maybeSingle()

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  if (job.workspace_id !== member.workspace_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (job.status !== 'running') {
    // Already completed/failed/cancelled — return current state safely
    const meta = (job.metadata ?? {}) as Record<string, unknown>
    return NextResponse.json({
      ok:             true,
      job_id:         jobId,
      status:         job.status as string,
      pages:          (meta.pages ?? 0) as number,
      items_fetched:  (meta.items_fetched ?? 0) as number,
      items_upserted: (meta.items_upserted ?? 0) as number,
      has_more:       false,
    })
  }

  // ── 5. Load connection ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: conn } = await (admin as any)
    .from('amazon_connections')
    .select('id, status, selling_partner_id, marketplace_id, refresh_token_encrypted')
    .eq('id', job.connection_id)
    .maybeSingle()

  if (!conn || conn.status === 'revoked') {
    await failJob(admin, jobId, member.workspace_id, user.id, 'connection_unavailable')
    return NextResponse.json({ error: 'Amazon connection unavailable' }, { status: 409 })
  }

  const marketplaceId = (conn.marketplace_id as string | null) ?? 'A21TJRUUN4KGV'

  // ── 6. Refresh access token ────────────────────────────────────────────────
  let accessToken: string
  try {
    const refreshToken = decryptToken(conn.refresh_token_encrypted as string)
    const result       = await refreshAccessToken(refreshToken)
    accessToken        = result.access_token
    // Persist refreshed token non-fatally
    try {
      const enc = encryptToken(accessToken)
      const exp = new Date(Date.now() + result.expires_in * 1000).toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('amazon_connections').update({
        access_token_encrypted:  enc,
        access_token_expires_at: exp,
        updated_at:              new Date().toISOString(),
      }).eq('id', conn.id)
    } catch { /* non-fatal */ }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'token_refresh_failed'
    await failJob(admin, jobId, member.workspace_id, user.id, reason)
    return NextResponse.json({ error: `Token refresh failed: ${reason}` }, { status: 502 })
  }

  // ── 7. Read current progress from job metadata ─────────────────────────────
  const meta          = (job.metadata ?? {}) as Record<string, unknown>
  const pageToken     = (meta.page_token as string | null | undefined) ?? undefined
  const prevPages     = (meta.pages          as number) || 0
  const prevFetched   = (meta.items_fetched  as number) || 0
  const prevUpserted  = (meta.items_upserted as number) || 0

  // ── 8. Fetch ONE page from SP-API ──────────────────────────────────────────
  let items: ListingItem[] = []
  let nextPageToken: string | undefined

  try {
    const res = await searchListingsItems(accessToken, {
      sellerId:      conn.selling_partner_id as string,
      marketplaceId,
      pageSize:      20,
      pageToken,
    })
    items         = res.items ?? []
    nextPageToken = extractNextPageToken(res as typeof res & Record<string, unknown>)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'spapi_failed'
    await failJob(admin, jobId, member.workspace_id, user.id, reason)
    return NextResponse.json({ error: `SP-API call failed: ${reason}` }, { status: 502 })
  }

  // ── 9. Upsert this page's items ────────────────────────────────────────────
  const syncedAt   = new Date().toISOString()
  let pageUpserted = 0

  for (const item of items) {
    const sku = item.sku
    if (!sku) continue

    const summary     = item.summaries?.find(s => s.marketplaceId === marketplaceId) ?? item.summaries?.[0]
    const asin        = summary?.asin ?? null
    const itemName    = summary?.itemName ?? null
    const productType = summary?.productType ?? null
    const imageUrl    = summary?.mainImage?.link ?? null
    const statusArr   = summary?.status ?? []
    const statusStr   = statusArr.length > 0 ? statusArr[0] : null
    const brandVal    = item.attributes?.brand?.[0]?.value ?? null

    const row: ListingRow = {
      workspace_id:   member.workspace_id,
      connection_id:  conn.id,
      asin,
      sku,
      marketplace_id: marketplaceId,
      item_name:      itemName,
      brand:          brandVal,
      product_type:   productType,
      status:         statusStr,
      image_url:      imageUrl,
      raw_data:       {},
      last_synced_at: syncedAt,
      updated_at:     syncedAt,
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from('amazon_listing_items')
        .upsert(row, { onConflict: 'workspace_id,sku,marketplace_id' })
      pageUpserted++
    } catch {
      console.error('[listings/process] listing upsert failed')
    }
  }

  // ── 10. Compute new running totals ─────────────────────────────────────────
  const newPages     = prevPages    + 1
  const newFetched   = prevFetched  + items.length
  const newUpserted  = prevUpserted + pageUpserted
  const hasMore      = !!nextPageToken
  const now          = new Date().toISOString()

  // ── 11. Update job metadata ────────────────────────────────────────────────
  const newMeta: Record<string, unknown> = {
    page_token:        nextPageToken ?? null,
    pages:             newPages,
    items_fetched:     newFetched,
    items_upserted:    newUpserted,
    has_more:          hasMore,
    last_processed_at: now,
  }

  const isComplete = !hasMore

  if (isComplete) {
    // ── 12a. Finalise job ──────────────────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('amazon_sync_jobs').update({
        status:      'completed',
        finished_at: now,
        metadata:    newMeta,
      }).eq('id', jobId)
    } catch { /* non-fatal */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('amazon_connections').update({
        last_sync_at: now,
        updated_at:   now,
      }).eq('id', conn.id)
    } catch { /* non-fatal */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('amazon_audit_logs').insert({
        workspace_id: member.workspace_id,
        user_id:      user.id,
        event_type:   'listings_sync_success',
        details:      { items_fetched: newFetched, items_upserted: newUpserted, pages: newPages },
      })
    } catch { /* non-fatal */ }
  } else {
    // ── 12b. Save progress, keep running ──────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('amazon_sync_jobs').update({
        metadata: newMeta,
      }).eq('id', jobId)
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    ok:             true,
    job_id:         jobId,
    status:         isComplete ? 'completed' : 'running',
    pages:          newPages,
    items_fetched:  newFetched,
    items_upserted: newUpserted,
    has_more:       hasMore,
  })
}

// ─── Helper: mark job failed + audit log ─────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function failJob(admin: any, jobId: string, workspaceId: string, userId: string, reason: string) {
  const now = new Date().toISOString()
  try {
    await admin.from('amazon_sync_jobs').update({
      status:        'failed',
      finished_at:   now,
      error_message: reason,
    }).eq('id', jobId)
  } catch { /* non-fatal */ }
  try {
    await admin.from('amazon_audit_logs').insert({
      workspace_id: workspaceId,
      user_id:      userId,
      event_type:   'listings_sync_failed',
      details:      { reason },
    })
  } catch { /* non-fatal */ }
}
