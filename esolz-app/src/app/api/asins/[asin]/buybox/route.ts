import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { getItemOffersForAsin, type BuyBoxOfferStatus } from '@/lib/amazon/pricing'

export const runtime    = 'nodejs'
export const maxDuration = 120

const BUYBOX_FAILURE_MESSAGE = 'Buy Box data was not available from Amazon right now. The failed check was saved and can be retried later.'

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

function resultMessageFor(status: BuyBoxOfferStatus): string {
  if (status === 'won') return 'Buy Box ownership confirmed for your seller.'
  if (status === 'lost') return 'Buy Box ownership is currently with another seller.'
  if (status === 'no_buybox') return 'No active Buy Box is available for this ASIN right now.'
  if (status === 'partial_success') return 'Amazon returned partial offer data; ownership could not be confirmed.'
  if (status === 'unknown') return 'Offer data was fetched, but ownership could not be confirmed safely.'
  return BUYBOX_FAILURE_MESSAGE
}

/**
 * POST /api/asins/{asin}/buybox
 *
 * Run a Buy Box check for a tracked ASIN.
 * Scrapes the Amazon offer listing page and saves the result.
 *
 * Response:
 *   {
 *     success: true,
 *     result: {
 *       buy_box_owner:   "Seller Name",
 *       buy_box_price:   2964.00,
 *       buy_box_status:  "active",
 *       fulfillment_type: "FBA",
 *       total_sellers:   3,
 *       all_offers:      [...],
 *       checked_at:      "2026-05-26T16:30:00Z"
 *     },
 *     snap: { ...db record... }
 *   }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  const { asin } = await params

  console.log(`[buybox-check][1] ASIN received: ${asin}`)

  // ── Auth ────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()

  if (authErr || !user) {
    console.error('[buybox-check][2] FAIL auth:', authErr?.message || 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[buybox-check][2] OK   user: ${user.id}`)

  // ── Workspace ───────────────────────────────────────────────────────────
  const { data: members, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)

  if (memberErr || !members?.length) {
    console.error('[buybox-check][3] FAIL workspace:', memberErr?.message)
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = members[0].workspace_id
  console.log(`[buybox-check][3] OK   workspace: ${workspaceId}`)

  const adminClient = createAdminClient()

  // ── Verify tracked ASIN ─────────────────────────────────────────────────
  const { data: tracked, error: asinErr } = await supabase
    .from('tracked_asins')
    .select('id, asin, marketplace')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .single()

  if (asinErr || !tracked) {
    console.error('[buybox-check][4] FAIL tracked ASIN:', asinErr?.message)
    return NextResponse.json({ error: 'ASIN not tracked or archived' }, { status: 404 })
  }
  const trackedAsinId = tracked.id
  console.log(`[buybox-check][4] OK   tracked id=${tracked.id} mp=${tracked.marketplace}`)

  async function insertSnapshot(params: {
    buyBoxOwner: string | null
    buyBoxStatus: BuyBoxOfferStatus
    buyBoxPrice: number | null
    yourPrice: number | null
    priceGap: number | null
    fulfillmentType: string | null
    checkedAt: string
    numberOfOffers?: number | null
    numberOfBuyBoxEligibleOffers?: number | null
    buyBoxCurrency?: string | null
    lowestPrice?: number | null
    lowestPriceCurrency?: string | null
    rawSummary?: Record<string, unknown> | null
    rawOffers?: unknown[]
  }) {
    const payload = {
      workspace_id:     workspaceId,
      tracked_asin_id:  trackedAsinId,
      buy_box_owner:    params.buyBoxOwner,
      buy_box_status:   params.buyBoxStatus,
      buy_box_price:    params.buyBoxPrice,
      your_price:       params.yourPrice,
      price_gap:        params.priceGap,
      fulfillment_type: params.fulfillmentType,
      checked_at:       params.checkedAt,

      // Optional columns for richer Product Pricing payloads.
      number_of_offers: params.numberOfOffers ?? null,
      number_of_buybox_eligible_offers: params.numberOfBuyBoxEligibleOffers ?? null,
      buy_box_currency: params.buyBoxCurrency ?? null,
      lowest_price: params.lowestPrice ?? null,
      lowest_price_currency: params.lowestPriceCurrency ?? null,
      source: 'Amazon Product Pricing API',
      raw_summary: params.rawSummary ?? null,
      raw_offers: params.rawOffers ?? null,
    }

    const attempt = await adminClient
      .from('buybox_snapshots')
      .insert(payload)
      .select()
      .single()

    if (!attempt.error) return attempt

    // Fallback for older schemas that do not yet have Product Pricing fields.
    const fallback = await adminClient
      .from('buybox_snapshots')
      .insert({
        workspace_id:     workspaceId,
        tracked_asin_id:  trackedAsinId,
        buy_box_owner:    params.buyBoxOwner,
        buy_box_status:   params.buyBoxStatus === 'failed' ? 'unknown' : params.buyBoxStatus,
        buy_box_price:    params.buyBoxPrice,
        your_price:       params.yourPrice,
        price_gap:        params.priceGap,
        fulfillment_type: params.fulfillmentType,
        checked_at:       params.checkedAt,
      })
      .select()
      .single()

    return fallback
  }

  // ── Amazon Product Pricing (offers-first) ───────────────────────────────
  const checkedAt = new Date().toISOString()

  try {
    const connection = await adminClient
      .from('amazon_connections')
      .select('id, status, marketplace_id, selling_partner_id, refresh_token_encrypted')
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
      console.error('[buybox-check][5] WARN could not persist refreshed access token:', String(persistErr))
    }

    const offers = await getItemOffersForAsin({
      accessToken: tokenResult.access_token,
      marketplaceId,
      asin: tracked.asin,
      itemCondition: 'New',
      sellingPartnerId: connection.data.selling_partner_id,
    })

    const yourPrice = offers.your_offer_price
    const buyBoxPrice = offers.buy_box_price
    const priceGap =
      yourPrice !== null && buyBoxPrice !== null
        ? Number((buyBoxPrice - yourPrice).toFixed(2))
        : null

    const { data: snap, error: insertErr } = await insertSnapshot({
      buyBoxOwner: offers.buy_box_owner,
      buyBoxStatus: offers.buy_box_status,
      buyBoxPrice,
      yourPrice,
      priceGap,
      fulfillmentType: offers.buy_box_fulfillment,
      checkedAt,
      numberOfOffers: offers.number_of_offers,
      numberOfBuyBoxEligibleOffers: offers.number_of_buybox_eligible_offers,
      buyBoxCurrency: offers.buy_box_currency,
      lowestPrice: offers.lowest_price,
      lowestPriceCurrency: offers.lowest_price_currency,
      rawSummary: offers.summary_raw,
      rawOffers: offers.offers_raw,
    })

    if (insertErr) {
      console.error('[buybox-check][6] FAIL insert:', insertErr)
      return NextResponse.json({ error: 'Failed to save result' }, { status: 500 })
    }

    return NextResponse.json({
      success: offers.buy_box_status !== 'failed',
      source: 'Amazon Product Pricing API',
      message: resultMessageFor(offers.buy_box_status),
      result: {
        buy_box_owner: offers.buy_box_owner,
        buy_box_price: offers.buy_box_price,
        buy_box_currency: offers.buy_box_currency,
        buy_box_status: offers.buy_box_status,
        fulfillment_type: offers.buy_box_fulfillment,
        your_price: offers.your_offer_price,
        price_gap: priceGap,
        number_of_offers: offers.number_of_offers,
        number_of_buybox_eligible_offers: offers.number_of_buybox_eligible_offers,
        lowest_price: offers.lowest_price,
        lowest_price_currency: offers.lowest_price_currency,
        checked_at: checkedAt,
      },
      snap,
    })
  } catch (err) {
    const safeErrorMessage = err instanceof Error ? err.message : String(err)
    console.error('[buybox-check][5] FAIL:', safeErrorMessage)

    const { data: failedSnap, error: failedInsertErr } = await insertSnapshot({
      buyBoxOwner: null,
      buyBoxStatus: 'failed',
      buyBoxPrice: null,
      yourPrice: null,
      priceGap: null,
      fulfillmentType: null,
      checkedAt,
    })

    if (failedInsertErr) {
      console.error('[buybox-check][6] FAIL insert failed snapshot:', failedInsertErr.message)
      return NextResponse.json({ error: BUYBOX_FAILURE_MESSAGE }, { status: 502 })
    }

    return NextResponse.json({
      success: false,
      source: 'Amazon Product Pricing API',
      message: BUYBOX_FAILURE_MESSAGE,
      result: {
        buy_box_owner: null,
        buy_box_price: null,
        buy_box_status: 'failed',
        fulfillment_type: null,
        your_price: null,
        price_gap: null,
        number_of_offers: null,
        number_of_buybox_eligible_offers: null,
        checked_at: checkedAt,
      },
      snap: failedSnap,
    }, { status: 200 })
  }
}
