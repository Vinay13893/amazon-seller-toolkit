import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPincodeMonitoringConfig } from '@/lib/pincode-monitoring/config'
import { mapWorkerResult } from '@/lib/pincode-monitoring/scheduler-result'

export const runtime = 'nodejs'
export const maxDuration = 240

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const supplied = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret ?? ''}`
  if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const config = getPincodeMonitoringConfig()
  if (!config.enabled || !config.allowedWorkspaceIds.size) return NextResponse.json({ status: 'disabled' })
  if (!process.env.CHECKER_WORKER_URL || !process.env.CHECKER_WORKER_SECRET) {
    return NextResponse.json({ error: 'Checker unavailable' }, { status: 503 })
  }
  const admin = createAdminClient()
  const allowed = Array.from(config.allowedWorkspaceIds)
  let completed = 0
  let recovered = 0
  try {
    // Recover interrupted invocations through the idempotent finalize RPC.
    const { data: stale, error: staleError } = await admin.from('pincode_tracking_targets')
      .select('claim_token').in('workspace_id', allowed).eq('status', 'checking')
      .lt('claimed_at', new Date(Date.now() - 10 * 60_000).toISOString()).limit(20)
    if (staleError) throw staleError
    for (const target of stale ?? []) {
      const { error } = await admin.rpc('finalize_pincode_check', { p_claim_token: target.claim_token,
        ...mapWorkerResult(504, {}) })
      if (error) throw error
      recovered++
    }
    const started = Date.now()
    // Claims are atomic across concurrent invocations. Four bounded checks per tick.
    while (completed < 4 && Date.now() - started < 160_000) {
      const { data: targets, error } = await admin.rpc('claim_due_pincode_targets', {
        p_limit: 1, p_invocation_id: randomUUID(), p_excluded_workspace_ids: [], p_allowed_workspace_ids: allowed,
      })
      if (error) throw error
      const target = targets?.[0]
      if (!target) break
      const { data: product, error: productError } = await admin.from('pincode_monitored_products')
        .select('asin, marketplace_id').eq('id', target.monitored_product_id).eq('workspace_id', target.workspace_id).single()
      let outcome = mapWorkerResult(503, {})
      if (!productError && product?.marketplace_id === 'A21TJRUUN4KGV') {
        try {
          const response = await fetch(`${process.env.CHECKER_WORKER_URL.replace(/\/$/, '')}/pincode-availability`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-checker-secret': process.env.CHECKER_WORKER_SECRET },
            body: JSON.stringify({ workspace_id: target.workspace_id, tracked_asin_id: target.monitored_product_id,
              asin: product.asin, marketplace: 'amazon.in', pincode: target.pincode }),
            signal: AbortSignal.timeout(50_000), cache: 'no-store',
          })
          outcome = mapWorkerResult(response.status, await response.json().catch(() => ({})))
        } catch { /* Persist an honest failed attempt, never an unavailable product. */ }
      }
      const { error: finalizeError } = await admin.rpc('finalize_pincode_check', { p_claim_token: target.claim_token, ...outcome })
      if (finalizeError) throw finalizeError
      completed++
    }
    return NextResponse.json({ status: 'ok', completed, recovered })
  } catch {
    console.error('[pincode-monitoring] scheduler_failed')
    return NextResponse.json({ error: 'Scheduled check failed', completed, recovered }, { status: 503 })
  }
}
