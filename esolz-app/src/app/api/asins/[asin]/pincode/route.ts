import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPincode } from '@/lib/integrations/amazon-pincode-adapter'
import {
  isWorkerConfigured,
  runPincodeCheck,
  CheckerWorkerUnavailableError,
} from '@/lib/checkers/checker-worker-client'

export const runtime = 'nodejs'
export const maxDuration = 120 // 2 minutes for Playwright checks

const PINCODE_FAILURE_MESSAGE = 'Pincode checker is temporarily unavailable. The failed check was saved and can be retried later.'

/**
 * POST /api/asins/{asin}/pincode
 * 
 * Run a pincode availability check for a tracked ASIN.
 * 
 * Request body:
 *   { pincode: "110001" }
 * 
 * Response:
 *   {
 *     success: true,
 *     result: {
 *       available: true,
 *       delivery_promise: "Same-Day — FREE delivery by 9 PM",
 *       fulfillment_type: "FBA",
 *       buy_box_seller: "Seller Name",
 *       checked_at: "2026-05-26T16:00:00Z"
 *     },
 *     check: { ...full db record... }
 *   }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  const { asin } = await params

  console.log(`[pincode-check][1] ASIN received: ${asin}`)

  // ── CHECK 2: Auth ───────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()

  if (authErr || !user) {
    console.error('[pincode-check][2] FAIL auth:', authErr?.message || 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[pincode-check][2] OK   user authenticated: ${user.id}`)

  // ── CHECK 3: Get workspace ──────────────────────────────────────────────
  const { data: members, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)

  if (memberErr || !members || members.length === 0) {
    console.error('[pincode-check][3] FAIL workspace lookup:', memberErr?.message)
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const member = members[0]
  const workspaceId = member.workspace_id
  console.log(`[pincode-check][3] OK   workspace found: ${member.workspace_id}`)

  let adminClient: ReturnType<typeof createAdminClient>
  try {
    adminClient = createAdminClient()
  } catch (adminErr) {
    console.error('[pincode-check][3] FAIL admin client:', String(adminErr))
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  // ── CHECK 4: Verify ASIN is tracked ─────────────────────────────────────
  const { data: tracked, error: asinErr } = await supabase
    .from('tracked_asins')
    .select('id, asin, marketplace')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .single()

  if (asinErr || !tracked) {
    console.error('[pincode-check][4] FAIL tracked ASIN lookup:', asinErr?.message)
    return NextResponse.json({ error: 'ASIN not tracked or archived' }, { status: 404 })
  }
  const trackedAsinId = tracked.id
  console.log(`[pincode-check][4] OK   ASIN tracked: id=${tracked.id} marketplace=${tracked.marketplace}`)

  // ── CHECK 5: Parse request body ─────────────────────────────────────────
  let body: { pincode?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { pincode } = body
  if (!pincode || typeof pincode !== 'string') {
    return NextResponse.json({ error: 'Missing or invalid pincode' }, { status: 400 })
  }

  // Basic validation for Indian pincodes (6 digits)
  if (tracked.marketplace === 'IN' && !/^\d{6}$/.test(pincode)) {
    return NextResponse.json({ error: 'Invalid pincode format (expected 6 digits)' }, { status: 400 })
  }
  const normalizedPincode = pincode.trim()

  console.log(`[pincode-check][5] OK   pincode: ${pincode}`)

  async function insertFailedCheck(failureReason?: string) {
    const { data, error } = await adminClient
      .from('pincode_checks')
      .insert({
        workspace_id: workspaceId,
        tracked_asin_id: trackedAsinId,
        pincode: normalizedPincode,
        city: null,
        available: null,
        delivery_promise: `Check failed: ${(failureReason ?? 'checker unavailable').slice(0, 180)}`,
        price: null,
        buy_box_seller: null,
        fulfillment_type: null,
        checked_at: new Date().toISOString(),
      })
      .select()
      .single()

    return { data, error }
  }

  // ── Run pincode check: try worker first, then local Python (dev only) ───
  console.log(`[pincode-check][6] running checker for ${asin} / ${pincode} / ${tracked.marketplace}`)
  let result
  try {
    if (isWorkerConfigured()) {
      console.log(`[pincode-check][6] calling checker worker`)
      const workerRes = await runPincodeCheck({
        workspace_id:    workspaceId,
        tracked_asin_id: trackedAsinId,
        asin:            asin.toUpperCase(),
        marketplace:     tracked.marketplace,
        pincode:         normalizedPincode,
      })
      result = {
        is_buyable:      workerRes.available ?? false,
        delivery_type:   workerRes.delivery_promise ?? null,
        delivery_text:   workerRes.delivery_promise ?? null,
        merchant_text:   workerRes.seller ?? null,
        amazon_fulfilled: false,
        checked_at:      new Date().toISOString(),
        pincode:         normalizedPincode,
      }
    } else {
      result = await checkPincode(asin.toUpperCase(), pincode, tracked.marketplace)
    }
  } catch (err) {
    console.error('[pincode-check][6] FAIL checker:', String(err))

    const { data: failedCheck, error: failedInsertErr } = await insertFailedCheck(
      err instanceof CheckerWorkerUnavailableError
        ? 'checker unavailable'
        : (err instanceof Error ? err.message : String(err))
    )
    if (failedInsertErr) {
      console.error('[pincode-check][6] FAIL insert failed check:', failedInsertErr.message)
    }

    return NextResponse.json(
      {
        error: PINCODE_FAILURE_MESSAGE,
        check: failedCheck ?? null,
      },
      { status: 502 },
    )
  }
  console.log(`[pincode-check][6] OK   checker: buyable=${result.is_buyable} delivery=${result.delivery_type}`)
  console.log(`[pincode-check][6] full result: ${JSON.stringify(result, null, 2)}`)

  // ── CHECK 7: Map and insert to pincode_checks ───────────────────────────
  // Parse raw delivery_text (pipe-separated Amazon DOM elements) into clean options
  function parseDeliveryOptions(raw: string): string[] {
    if (!raw) return []
    // Split on " | " (safe_text joins multiple elements with this)
    const parts = raw.split(' | ')
    const opts: string[] = []
    for (const part of parts) {
      // Each part may contain " Or " joining two options
      const subParts = part.split(/ or /i)
      for (const sub of subParts) {
        // Remove trailing ". Details" or " Details"
        const cleaned = sub
          .replace(/\.?\s*Details\s*$/i, '')
          .replace(/\s+/g, ' ')
          .trim()
        // Skip fragments that look like bare dates (e.g. "Saturday, 30 May")
        if (cleaned && !/^[A-Za-z]+,\s+\d+\s+[A-Za-z]+$/.test(cleaned)) {
          opts.push(cleaned)
        }
      }
    }
    // Deduplicate preserving order
    return [...new Map(opts.map(o => [o.toLowerCase(), o])).values()]
  }

  const deliveryOptions = parseDeliveryOptions(result.delivery_text || '')
  const deliveryPromise = deliveryOptions.length > 0 ? deliveryOptions.join('\n') : null

  // Extract seller name from merchant_text
  let buyBoxSeller: string | null = null
  if (result.merchant_text) {
    const soldByMatch = result.merchant_text.match(/Sold by\s+([^|]+)/i)
    if (soldByMatch) {
      buyBoxSeller = soldByMatch[1].trim()
    } else {
      const shipsMatch = result.merchant_text.match(/Ships from\s+([^|]+)/i)
      if (shipsMatch) {
        buyBoxSeller = shipsMatch[1].trim()
      } else {
        buyBoxSeller = result.merchant_text.trim().slice(0, 100)
      }
    }
  }

  // Map fulfillment type
  const fulfillmentType = result.amazon_fulfilled ? 'FBA' : 'FBM'

  const insertPayload = {
    workspace_id:     workspaceId,
    tracked_asin_id:  trackedAsinId,
    pincode:          result.pincode,
    city:             null, // Not extracted by tool
    available:        result.is_buyable,
    delivery_promise: deliveryPromise || null,
    price:            null, // Not extracted by tool
    buy_box_seller:   buyBoxSeller,
    fulfillment_type: fulfillmentType,
    checked_at:       result.checked_at,
  }

  console.log(`[pincode-check][7] insert payload:`, JSON.stringify(insertPayload, null, 2))

  const { data: check, error: insertErr } = await adminClient
    .from('pincode_checks')
    .insert(insertPayload)
    .select()
    .single()

  if (insertErr) {
    console.error('[pincode-check][7] FAIL insert:', insertErr.code, insertErr.message)
    return NextResponse.json({ error: insertErr.message, detail: insertErr.code }, { status: 500 })
  }
  console.log(`[pincode-check][7] OK   check inserted: id=${check?.id}`)

  // ── Response ────────────────────────────────────────────────────────────
  return NextResponse.json({
    success: true,
    result: {
      available:        check.available,
      delivery_promise: check.delivery_promise,
      fulfillment_type: check.fulfillment_type,
      buy_box_seller:   check.buy_box_seller,
      checked_at:       check.checked_at,
    },
    check, // Full record for debugging
  })
}
