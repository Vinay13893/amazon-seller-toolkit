import { createAdminClient } from '@/lib/supabase/admin'
import { runPincodeCheck, toWorkerMarketplace } from '@/lib/checkers/checker-worker-client'

export const runtime = 'nodejs'
export const maxDuration = 280

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.CHECKER_WORKER_URL || !process.env.CHECKER_WORKER_SECRET)
    return Response.json({ error: 'worker_not_configured' }, { status: 503 })

  const admin = createAdminClient()
  const { data: products, error: productsError } = await admin
    .from('pincode_monitored_products')
    .select('id,workspace_id,asin,marketplace_id,tracked_asin_id')
    .eq('status', 'active').limit(1001)
  if (productsError || !products || products.length > 1000)
    return Response.json({ error: 'product_scope_unavailable' }, { status: 503 })
  const workspaces = [...new Set(products.map(product => product.workspace_id))]
  if (workspaces.length === 0) return Response.json({ claimed: 0, checked: 0 })

  // A terminated invocation must not leave a target in `checking` forever.
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: stale, error: staleError } = await admin
    .from('pincode_tracking_targets')
    .select('claim_token')
    .in('workspace_id', workspaces)
    .eq('status', 'checking')
    .lt('claimed_at', staleBefore)
    .limit(25)
  if (staleError) return Response.json({ error: 'stale_claim_read_failed' }, { status: 500 })
  for (const row of stale ?? []) {
    if (!row.claim_token) continue
    const { error } = await admin.rpc('finalize_pincode_check', {
      p_claim_token: row.claim_token,
      p_check_status: 'failed',
      p_availability_status: null,
      p_delivery_message: null,
      p_error_code: 'check_interrupted',
      p_error_message: null,
    })
    if (error) return Response.json({ error: 'stale_claim_finalize_failed' }, { status: 500 })
  }

  const { data: claimed, error: claimError } = await admin.rpc('claim_due_pincode_targets', {
    p_limit: 2,
    p_invocation_id: `vercel-pincode-${crypto.randomUUID()}`,
    p_excluded_workspace_ids: [],
    p_allowed_workspace_ids: workspaces,
  })
  if (claimError) return Response.json({ error: 'claim_failed' }, { status: 500 })

  let checked = 0
  let failed = 0
  for (const target of claimed ?? []) {
    const product = products.find(row => row.id === target.monitored_product_id && row.workspace_id === target.workspace_id)
    let result: { status: string; available: boolean | null; delivery_promise: string | null } | null = null
    try {
      if (!product) throw new Error('product_missing')
      result = await runPincodeCheck({
        workspace_id: target.workspace_id,
        tracked_asin_id: product.tracked_asin_id ?? product.id,
        asin: product.asin,
        marketplace: product.marketplace_id === 'A21TJRUUN4KGV'
          ? 'amazon.in' : toWorkerMarketplace(product.marketplace_id),
        pincode: target.pincode,
      })
    } catch { /* A failed check is recorded as unknown, never unavailable. */ }

    const success = result?.status === 'success' || result?.status === 'unavailable'
    const blocked = result?.status === 'blocked'
    const { error: finalizeError } = await admin.rpc('finalize_pincode_check', {
      p_claim_token: target.claim_token,
      p_check_status: success ? 'success' : blocked ? 'blocked' : 'failed',
      p_availability_status: success
        ? result?.available === true ? 'available' : result?.available === false ? 'unavailable' : 'unknown'
        : null,
      p_delivery_message: success ? result?.delivery_promise?.slice(0, 200) ?? null : null,
      p_error_code: success ? null : blocked ? 'checker_blocked' : 'checker_failed',
      p_error_message: null,
    })
    if (finalizeError) failed += 1
    else checked += 1
  }
  return Response.json({ claimed: (claimed ?? []).length, checked, failed }, { status: failed ? 500 : 200 })
}
