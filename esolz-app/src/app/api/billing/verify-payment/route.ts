import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime     = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/billing/verify-payment
 *
 * Verifies the Razorpay HMAC signature server-side, then upgrades
 * the workspace subscription in workspace_subscriptions.
 *
 * Body: {
 *   razorpay_order_id, razorpay_payment_id, razorpay_signature,
 *   plan_id
 * }
 * Returns: { success: true }
 */
export async function POST(req: NextRequest) {
  console.log('[billing-verify-payment][1] POST /api/billing/verify-payment')

  const supabase = await createClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    console.error('[billing-verify-payment][2] FAIL auth:', authErr?.message ?? 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[billing-verify-payment][2] OK   user: ${user.id}`)

  // ── Workspace + role ──────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    console.error('[billing-verify-payment][3] FAIL workspace:', memberErr?.message ?? 'no row')
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  if (!['owner', 'admin'].includes(member.role as string)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }
  console.log(`[billing-verify-payment][3] OK   workspace: ${member.workspace_id}`)

  // ── Validate body ─────────────────────────────────────────────────────────
  let body: {
    razorpay_order_id?:   string
    razorpay_payment_id?: string
    razorpay_signature?:  string
    plan_id?:             string
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = body
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !plan_id) {
    return NextResponse.json({ error: 'Missing required payment fields' }, { status: 400 })
  }

  // ── Verify Razorpay HMAC signature ────────────────────────────────────────
  if (!process.env.RAZORPAY_KEY_SECRET) {
    console.error('[billing-verify-payment][4] FAIL Razorpay key not configured')
    return NextResponse.json({ error: 'Payment gateway not configured' }, { status: 500 })
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex')

  if (expectedSignature !== razorpay_signature) {
    console.error('[billing-verify-payment][4] FAIL signature mismatch')
    return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 })
  }
  console.log('[billing-verify-payment][4] OK   signature verified')

  // ── Re-validate plan server-side ──────────────────────────────────────────
  const admin = createAdminClient()
  const { data: plan, error: planErr } = await admin
    .from('subscription_plans')
    .select('id, price_monthly')
    .eq('id', plan_id)
    .single()

  if (planErr || !plan || (plan.price_monthly as number) <= 0) {
    console.error('[billing-verify-payment][5] FAIL plan:', planErr?.message ?? 'invalid')
    return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  }
  console.log(`[billing-verify-payment][5] OK   plan: ${plan.id}`)

  // ── Update workspace_subscriptions ────────────────────────────────────────
  const now       = new Date()
  const periodEnd = new Date(now)
  periodEnd.setMonth(periodEnd.getMonth() + 1)

  const { error: upsertErr } = await admin
    .from('workspace_subscriptions')
    .upsert(
      {
        workspace_id:          member.workspace_id,
        plan_id:               plan.id,
        status:                'active',
        current_period_start:  now.toISOString(),
        current_period_end:    periodEnd.toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  if (upsertErr) {
    console.error('[billing-verify-payment][6] FAIL upsert:', upsertErr.message)
    return NextResponse.json({ error: 'Failed to update subscription' }, { status: 500 })
  }
  console.log(`[billing-verify-payment][6] OK   subscription updated for workspace: ${member.workspace_id}`)

  return NextResponse.json({ success: true })
}
