import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkBuyBox } from '@/lib/integrations/amazon-buybox-adapter'

export const runtime    = 'nodejs'
export const maxDuration = 120 // 2 minutes for Playwright

const BUYBOX_FAILURE_MESSAGE = 'Buy Box checker is temporarily unavailable. The failed check was saved and can be retried later.'

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
  req: NextRequest,
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

  async function insertFailedSnapshot(message?: string) {
    const payload = {
      workspace_id:     workspaceId,
      tracked_asin_id:  trackedAsinId,
      buy_box_owner:    null,
      buy_box_status:   'failed',
      buy_box_price:    null,
      your_price:       null,
      price_gap:        null,
      fulfillment_type: null,
      checked_at:       new Date().toISOString(),
    }

    const attempt = await adminClient
      .from('buybox_snapshots')
      .insert(payload)
      .select()
      .single()

    if (!attempt.error) return attempt

    // Fallback for stricter status constraints.
    const fallback = await adminClient
      .from('buybox_snapshots')
      .insert({ ...payload, buy_box_status: 'suppressed', buy_box_owner: message ? `failed: ${message.slice(0, 120)}` : null })
      .select()
      .single()

    return fallback
  }

  // ── Run Buy Box check ───────────────────────────────────────────────────
  const isMock = process.env.NODE_ENV !== 'production' && req.nextUrl.searchParams.get('mock') === '1'
  console.log(`[buybox-check][5] Running check for ${tracked.asin} / ${tracked.marketplace} mock=${isMock}`)

  let result
  if (isMock) {
    // DEV-ONLY: skip Python scraper, return fake data to test auth+DB path
    result = {
      asin: tracked.asin, marketplace: tracked.marketplace,
      buy_box_owner: 'Mock Seller (debug)', buy_box_seller_id: 'MOCK123',
      buy_box_price: 1999.00, buy_box_status: 'active',
      fulfillment_type: 'FBA', all_offers: [], total_sellers: 1,
      captcha_seen: false, error: '', checked_at: new Date().toISOString(),
    }
    console.log('[buybox-check][5] MOCK  using fake result')
  } else {
    try {
      result = await checkBuyBox(tracked.asin, tracked.marketplace)
    } catch (err: unknown) {
      console.error('[buybox-check][5] FAIL:', err instanceof Error ? err.message : String(err))

      const { error: snapErr } = await insertFailedSnapshot()
      if (snapErr) {
        console.error('[buybox-check][5] failed snapshot insert error:', snapErr.message)
      }

      return NextResponse.json({ error: BUYBOX_FAILURE_MESSAGE }, { status: 500 })
    }
  }
  console.log(`[buybox-check][5] OK   owner=${result.buy_box_owner} price=${result.buy_box_price} sellers=${result.total_sellers}`)

  if (result.captcha_seen || result.buy_box_status === 'captcha') {
    const { error: snapErr } = await insertFailedSnapshot('captcha')
    if (snapErr) {
      console.error('[buybox-check][5] failed snapshot insert error:', snapErr.message)
    }
    return NextResponse.json(
      { error: BUYBOX_FAILURE_MESSAGE },
      { status: 503 }
    )
  }

  if (result.error && !result.buy_box_owner) {
    const { error: snapErr } = await insertFailedSnapshot(result.error)
    if (snapErr) {
      console.error('[buybox-check][5] failed snapshot insert error:', snapErr.message)
    }
    return NextResponse.json(
      { error: BUYBOX_FAILURE_MESSAGE },
      { status: 502 }
    )
  }

  // ── Insert into buybox_snapshots ────────────────────────────────────────
  const insertPayload = {
    workspace_id:    workspaceId,
    tracked_asin_id: trackedAsinId,
    buy_box_owner:   result.buy_box_owner,
    buy_box_status:  result.buy_box_status,
    buy_box_price:   result.buy_box_price,
    your_price:      null,
    price_gap:       null,
    fulfillment_type: result.fulfillment_type,
    checked_at:      result.checked_at,
  }

  console.log('[buybox-check][6] Inserting:', JSON.stringify(insertPayload))
  const { data: snap, error: insertErr } = await adminClient
    .from('buybox_snapshots')
    .insert(insertPayload)
    .select()
    .single()

  if (insertErr) {
    console.error('[buybox-check][6] FAIL insert:', insertErr)
    return NextResponse.json(
      { error: 'Failed to save result', detail: insertErr.message },
      { status: 500 }
    )
  }
  console.log(`[buybox-check][6] OK   inserted id=${snap.id}`)

  return NextResponse.json({
    success: true,
    result: {
      buy_box_owner:    result.buy_box_owner,
      buy_box_price:    result.buy_box_price,
      buy_box_status:   result.buy_box_status,
      fulfillment_type: result.fulfillment_type,
      total_sellers:    result.total_sellers,
      all_offers:       result.all_offers,
      checked_at:       result.checked_at,
    },
    snap,
  })
}
