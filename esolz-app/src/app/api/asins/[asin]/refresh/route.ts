import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { scrapeAsinBsr } from '@/lib/integrations/amazon-bsr-adapter'

// Ensure Node.js runtime — child_process is not available in Edge
export const runtime    = 'nodejs'
export const maxDuration = 120   // 2 min (respected on Vercel Pro+)

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
  console.log(`[bsr-refresh][3] OK   workspace: ${member.workspace_id}`)

  // ── CHECK 4: tracked_asins row ──────────────────────────────────────────
  const { data: tracked, error: trackErr } = await supabase
    .from('tracked_asins')
    .select('id, marketplace')
    .eq('workspace_id', member.workspace_id)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  if (trackErr || !tracked) {
    console.error('[bsr-refresh][4] FAIL tracked_asins:', trackErr?.message ?? 'no row',
      '| workspace:', member.workspace_id, '| asin:', asin.toUpperCase())
    return NextResponse.json(
      { error: 'ASIN not tracked in this workspace' },
      { status: 404 },
    )
  }
  console.log(`[bsr-refresh][4] OK   tracked_asin: id=${tracked.id} marketplace=${tracked.marketplace}`)

  // ── CHECK 5–6: Run scraper ──────────────────────────────────────────────
  console.log(`[bsr-refresh][5] spawning scraper for ${asin} / ${tracked.marketplace}`)
  let result
  try {
    result = await scrapeAsinBsr(asin.toUpperCase(), tracked.marketplace)
  } catch (err) {
    console.error('[bsr-refresh][5] FAIL scraper:', String(err))
    return NextResponse.json(
      { error: 'Scrape failed' },
      { status: 502 },
    )
  }
  console.log(`[bsr-refresh][6] OK   scraper: bsr=${result.bsr} price=${result.price} status=${result.scrape_status}`)
  console.log(`[bsr-refresh][6] full result: ${JSON.stringify(result, null, 2)}`)

  // Fail fast if scraper returned nothing useful
  if (result.bsr === null && result.price === null) {
    console.error('[bsr-refresh][6] FAIL no data: scrape_status=', result.scrape_status)
    return NextResponse.json(
      { error: 'No data scraped', scrape_status: result.scrape_status },
      { status: 422 },
    )
  }

  // ── CHECK 7: Insert asin_snapshots ──────────────────────────────────────
  // Use the service-role (admin) client so the INSERT is not subject to RLS.
  // We already verified above that the user owns this workspace + ASIN, so
  // bypassing RLS here is intentional and safe.
  console.log(`[bsr-refresh][7] inserting snapshot: workspace=${member.workspace_id} tracked_asin=${tracked.id}`)
  const insertPayload = {
    workspace_id:       member.workspace_id,
    tracked_asin_id:    tracked.id,
    bsr:                result.bsr,
    price:              result.price,
    rating:             result.rating,
    review_count:       result.review_count,
    buy_box_owner:      result.buy_box_owner,
    buy_box_status:     result.buy_box_status,
    availability_score: result.availability_score,
    checked_at:         result.checked_at,
  }

  console.log(`[bsr-refresh][7] insert payload:`, JSON.stringify(insertPayload, null, 2))

  let adminClient
  try {
    adminClient = createAdminClient()
  } catch (adminErr) {
    console.error('[bsr-refresh][7] FAIL admin client:', String(adminErr))
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  const { data: snapshot, error: insertErr } = await adminClient
    .from('asin_snapshots')
    .insert(insertPayload)
    .select()
    .single()

  if (insertErr) {
    console.error('[bsr-refresh][7] FAIL insert:', insertErr.code, insertErr.message, '| payload:', JSON.stringify(insertPayload))
    return NextResponse.json({ error: insertErr.message, detail: insertErr.code }, { status: 500 })
  }
  console.log(`[bsr-refresh][7] OK   snapshot inserted: id=${snapshot?.id} bsr=${snapshot?.bsr}`)

  return NextResponse.json({
    success:       true,
    scrape_status: result.scrape_status,
    bsr:           snapshot?.bsr,
    price:         snapshot?.price,
    rating:        snapshot?.rating,
    review_count:  snapshot?.review_count,
    snapshot,
  })
}
