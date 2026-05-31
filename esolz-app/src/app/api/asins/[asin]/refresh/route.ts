import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'

// Ensure Node.js runtime — child_process is not available in Edge
export const runtime    = 'nodejs'
export const maxDuration = 120   // 2 min (respected on Vercel Pro+)

const BSR_RUNTIME_FAILURE_MESSAGE = 'Amazon Catalog data was not available for this ASIN yet.'

const MARKETPLACE_ID_BY_MARKETPLACE: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
}

function marketplaceIdFor(marketplace: string | null | undefined): string {
  if (!marketplace) return 'A21TJRUUN4KGV'
  return MARKETPLACE_ID_BY_MARKETPLACE[marketplace.toUpperCase()] ?? 'A21TJRUUN4KGV'
}

function hasUsefulCatalogData(result: { title: string | null; brand: string | null; image_url: string | null; category: string | null; bsr: number | null }): boolean {
  return Boolean(result.title || result.brand || result.image_url || result.category || result.bsr !== null)
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ asin: string }> },
) {
  const { asin } = await params
  console.log(`[bsr-refresh][1] POST /api/asins/${asin}/refresh called`)

  const supabase  = await createClient()

  // ── CHECK 2: Auth ───────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    console.error('[bsr-refresh][2] FAIL auth:', authErr?.message ?? 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[bsr-refresh][2] OK   auth: user=${user.id}`)

  // ── CHECK 3: Workspace ──────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    console.error('[bsr-refresh][3] FAIL workspace:', memberErr?.message ?? 'no row')
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id
  console.log(`[bsr-refresh][3] OK   workspace: ${member.workspace_id}`)

  // ── CHECK 4: tracked_asins row ──────────────────────────────────────────
  const { data: tracked, error: trackErr } = await supabase
    .from('tracked_asins')
    .select('id, marketplace, product_title, brand, category, image_url, status')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  if (trackErr || !tracked) {
    console.error('[bsr-refresh][4] FAIL tracked_asins:', trackErr?.message ?? 'no row',
      '| workspace:', workspaceId, '| asin:', asin.toUpperCase())
    return NextResponse.json(
      { error: 'ASIN not tracked in this workspace' },
      { status: 404 },
    )
  }
  const trackedAsinId = tracked.id
  console.log(`[bsr-refresh][4] OK   tracked_asin: id=${tracked.id} marketplace=${tracked.marketplace}`)
  // ── CHECK 7: Insert asin_snapshots ──────────────────────────────────────
  // Use the service-role (admin) client so the INSERT is not subject to RLS.
  // We already verified above that the user owns this workspace + ASIN, so
  // bypassing RLS here is intentional and safe.
  let adminClient: ReturnType<typeof createAdminClient>
  try {
    adminClient = createAdminClient()
  } catch (adminErr) {
    console.error('[bsr-refresh][7] FAIL admin client:', String(adminErr))
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  async function insertSnapshotWithStatus(params: {
    bsr: number | null
    price: number | null
    rating: number | null
    reviewCount: number | null
    buyBoxOwner: string | null
    buyBoxStatus: string
    availabilityScore: number | null
    checkedAt: string
  }) {
    const basePayload = {
      workspace_id:       workspaceId,
      tracked_asin_id:    trackedAsinId,
      bsr:                params.bsr,
      price:              params.price,
      rating:             params.rating,
      review_count:       params.reviewCount,
      buy_box_owner:      params.buyBoxOwner,
      buy_box_status:     params.buyBoxStatus,
      availability_score: params.availabilityScore,
      checked_at:         params.checkedAt,
    }

    const firstAttempt = await adminClient
      .from('asin_snapshots')
      .insert(basePayload)
      .select()
      .single()

    if (!firstAttempt.error) return firstAttempt

    // Fallback for stricter DB constraints on buy_box_status values.
    const fallback = await adminClient
      .from('asin_snapshots')
      .insert({ ...basePayload, buy_box_status: 'unknown' })
      .select()
      .single()

    return fallback
  }

  // ── Run Amazon Catalog first, then persist the useful metadata ──────────
  const checkedAt = new Date().toISOString()
  let result: {
    bsr: number | null
    price: number | null
    rating: number | null
    review_count: number | null
    buy_box_owner: string | null
    buy_box_status: 'won' | 'lost' | 'suppressed' | 'unknown'
    availability_score: number | null
    scrape_status: 'success' | 'partial_success' | 'failed'
    checked_at: string
    source: string
    title: string | null
    brand: string | null
    image_url: string | null
    category: string | null
    bsr_category: string | null
  }

  try {
    const connection = await adminClient
      .from('amazon_connections')
      .select('id, status, marketplace_id, refresh_token_encrypted, access_token_encrypted, access_token_expires_at')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (connection.error) {
      throw new Error('Amazon connection lookup failed')
    }

    if (!connection.data || connection.data.status !== 'active' || !connection.data.refresh_token_encrypted) {
      throw new Error('Amazon connection is not active for this workspace')
    }

    const marketplaceId = connection.data.marketplace_id ?? marketplaceIdFor(tracked.marketplace)
    const refreshToken = decryptToken(connection.data.refresh_token_encrypted)
    const tokenResult = await refreshAccessToken(refreshToken)

    try {
      const encryptedToken = encryptToken(tokenResult.access_token)
      await adminClient
        .from('amazon_connections')
        .update({
          access_token_encrypted: encryptedToken,
          access_token_expires_at: new Date(Date.now() + tokenResult.expires_in * 1000).toISOString(),
          updated_at: checkedAt,
        })
        .eq('workspace_id', workspaceId)
    } catch (persistErr) {
      console.error('[bsr-refresh][5] WARN could not persist refreshed access token:', String(persistErr))
    }

    const catalog = await getCatalogItemForAsin({
      accessToken: tokenResult.access_token,
      marketplaceId,
      asin: asin.toUpperCase(),
    })

    result = {
      bsr:                catalog.bsr,
      price:              null,
      rating:             null,
      review_count:       null,
      buy_box_owner:      null,
      buy_box_status:     'unknown',
      availability_score: null,
      scrape_status:      catalog.bsr !== null ? 'success' : (hasUsefulCatalogData(catalog) ? 'partial_success' : 'failed'),
      checked_at:         checkedAt,
      source:             'Amazon Catalog API',
      title:              catalog.title,
      brand:              catalog.brand,
      image_url:          catalog.image_url,
      category:           catalog.category,
      bsr_category:       catalog.bsr_category,
    }

    console.log(`[bsr-refresh][5] OK   catalog: asin=${catalog.asin} bsr=${catalog.bsr} title=${catalog.title ?? 'null'}`)
  } catch (err) {
    const safeErrorMessage = err instanceof Error ? err.message : String(err)
    console.error('[bsr-refresh][6] FAIL catalog:', safeErrorMessage)

    const { data: failedSnap, error: failedInsertErr } = await insertSnapshotWithStatus({
      bsr: null,
      price: null,
      rating: null,
      reviewCount: null,
      buyBoxOwner: null,
      buyBoxStatus: 'unknown',
      availabilityScore: null,
      checkedAt,
    })

    if (failedInsertErr) {
      console.error('[bsr-refresh][7] FAIL insert failed snapshot:', failedInsertErr.code, failedInsertErr.message)
      return NextResponse.json(
        { error: BSR_RUNTIME_FAILURE_MESSAGE },
        { status: 502 },
      )
    }

    return NextResponse.json(
      {
        success: false,
        scrape_status: 'failed',
        error: BSR_RUNTIME_FAILURE_MESSAGE,
        snapshot: failedSnap,
      },
      { status: 200 },
    )
  }

  const partialSuccess = result.scrape_status === 'partial_success'
  const success = result.scrape_status === 'success'

  const metadataUpdate: Record<string, string> = {}
  if (result.title) metadataUpdate.product_title = result.title
  if (result.brand) metadataUpdate.brand = result.brand
  if (result.category) metadataUpdate.category = result.category
  if (result.image_url) metadataUpdate.image_url = result.image_url

  try {
    if (Object.keys(metadataUpdate).length > 0) {
      await adminClient
        .from('tracked_asins')
        .update({
          ...metadataUpdate,
          updated_at: checkedAt,
        })
        .eq('id', trackedAsinId)
    }
  } catch (updateErr) {
    console.error('[bsr-refresh][7] WARN tracked_asins update failed:', String(updateErr))
  }

  console.log(`[bsr-refresh][7] inserting snapshot: workspace=${workspaceId} tracked_asin=${trackedAsinId}`)
  const { data: snapshot, error: insertErr } = await insertSnapshotWithStatus({
    bsr: result.bsr,
    price: result.price,
    rating: result.rating,
    reviewCount: result.review_count,
    buyBoxOwner: result.buy_box_owner,
    buyBoxStatus: result.buy_box_status,
    availabilityScore: result.availability_score,
    checkedAt: result.checked_at,
  })

  if (insertErr) {
    console.error('[bsr-refresh][7] FAIL insert:', insertErr.code, insertErr.message)
    return NextResponse.json({ error: insertErr.message, detail: insertErr.code }, { status: 500 })
  }
  console.log(`[bsr-refresh][7] OK   snapshot inserted: id=${snapshot?.id} bsr=${snapshot?.bsr}`)

  return NextResponse.json({
    success,
    scrape_status: result.scrape_status,
    source:        result.source,
    message:       partialSuccess
      ? 'Product details found, but BSR was not available from Amazon.'
      : 'Amazon Catalog data saved successfully.',
    bsr:           snapshot?.bsr,
    price:         snapshot?.price,
    rating:        snapshot?.rating,
    review_count:  snapshot?.review_count,
    snapshot,
  })
}
