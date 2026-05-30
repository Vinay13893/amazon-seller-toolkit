import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { scrapeAsinBsr } from '@/lib/integrations/amazon-bsr-adapter'
import {
  isWorkerConfigured,
  runBsrFallbackCheck,
  CheckerWorkerUnavailableError,
} from '@/lib/checkers/checker-worker-client'

// Ensure Node.js runtime — child_process is not available in Edge
export const runtime    = 'nodejs'
export const maxDuration = 120   // 2 min (respected on Vercel Pro+)

const BSR_RUNTIME_FAILURE_MESSAGE = 'BSR checker failed in this deployment. Please try again later.'

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
    .select('id, marketplace')
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

  // ── CHECK 5–6: Run scraper ──────────────────────────────────────────────
  console.log(`[bsr-refresh][5] spawning scraper for ${asin} / ${tracked.marketplace}`)
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

  // ── Run BSR check: try worker first, then local Python (dev only) ────────
  let result
  try {
    if (isWorkerConfigured()) {
      console.log(`[bsr-refresh][5] calling checker worker for ${asin}`)
      const workerRes = await runBsrFallbackCheck({
        workspace_id:    workspaceId,
        tracked_asin_id: trackedAsinId,
        asin:            asin.toUpperCase(),
        marketplace:     tracked.marketplace,
      })
      // Map worker response shape to local BsrScrapeResult shape
      result = {
        bsr:               workerRes.bsr,
        price:             workerRes.price,
        rating:            workerRes.rating,
        review_count:      workerRes.review_count,
        buy_box_owner:     null,
        buy_box_status:    (workerRes.status === 'success' ? 'won' : 'unknown') as string,
        availability_score: null,
        scrape_status:     workerRes.status,
        checked_at:        new Date().toISOString(),
      }
      console.log(`[bsr-refresh][5] OK   worker: bsr=${result.bsr} price=${result.price}`)
    } else {
      // Local dev: use Python adapter
      result = await scrapeAsinBsr(asin.toUpperCase(), tracked.marketplace)
      console.log(`[bsr-refresh][6] OK   scraper: bsr=${result.bsr} price=${result.price} status=${result.scrape_status}`)
    }
    console.log(`[bsr-refresh][6] full result: ${JSON.stringify(result, null, 2)}`)
  } catch (err) {
    const checkedAt = new Date().toISOString()
    const isInfraError = err instanceof CheckerWorkerUnavailableError
    console.error('[bsr-refresh][6] FAIL scraper:', String(err))

    const { data: failedSnap, error: failedInsertErr } = await insertSnapshotWithStatus({
      bsr: null,
      price: null,
      rating: null,
      reviewCount: null,
      buyBoxOwner: null,
      buyBoxStatus: 'checker_unavailable',
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
        scrape_status: 'checker_unavailable',
        error: isInfraError ? BSR_RUNTIME_FAILURE_MESSAGE : String(err),
        snapshot: failedSnap,
      },
      { status: 502 },
    )
  }

  const partialSuccess = result.bsr === null
  const buyBoxStatusForInsert = partialSuccess ? 'partial_success' : result.buy_box_status

  console.log(`[bsr-refresh][7] inserting snapshot: workspace=${workspaceId} tracked_asin=${trackedAsinId}`)
  const { data: snapshot, error: insertErr } = await insertSnapshotWithStatus({
    bsr: result.bsr,
    price: result.price,
    rating: result.rating,
    reviewCount: result.review_count,
    buyBoxOwner: result.buy_box_owner,
    buyBoxStatus: buyBoxStatusForInsert,
    availabilityScore: result.availability_score,
    checkedAt: result.checked_at,
  })

  if (insertErr) {
    console.error('[bsr-refresh][7] FAIL insert:', insertErr.code, insertErr.message)
    return NextResponse.json({ error: insertErr.message, detail: insertErr.code }, { status: 500 })
  }
  console.log(`[bsr-refresh][7] OK   snapshot inserted: id=${snapshot?.id} bsr=${snapshot?.bsr}`)

  return NextResponse.json({
    success:       !partialSuccess,
    scrape_status: partialSuccess ? 'partial_success' : result.scrape_status,
    message:       partialSuccess ? 'BSR not found in this check. Snapshot saved.' : undefined,
    bsr:           snapshot?.bsr,
    price:         snapshot?.price,
    rating:        snapshot?.rating,
    review_count:  snapshot?.review_count,
    snapshot,
  })
}
