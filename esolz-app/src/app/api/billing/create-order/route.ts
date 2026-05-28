import { NextRequest, NextResponse } from 'next/server'
import Razorpay from 'razorpay'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime     = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/billing/create-order
 *
 * Creates a Razorpay order for a plan upgrade.
 * Plan price is always fetched server-side — never trusted from the client.
 *
 * Body:  { plan_id: string }
 * Returns: { order_id, amount, currency, key_id, plan_name }
 */
export async function POST(req: NextRequest) {
  console.log('[billing-create-order][1] POST /api/billing/create-order')

  const supabase = await createClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    console.error('[billing-create-order][2] FAIL auth:', authErr?.message ?? 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[billing-create-order][2] OK   user: ${user.id}`)

  // ── Workspace + role ──────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    console.error('[billing-create-order][3] FAIL workspace:', memberErr?.message ?? 'no row')
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  if (!['owner', 'admin'].includes(member.role as string)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can upgrade plans' },
      { status: 403 }
    )
  }
  console.log(`[billing-create-order][3] OK   workspace: ${member.workspace_id} role: ${member.role}`)

  // ── Validate body ─────────────────────────────────────────────────────────
  let body: { plan_id?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { plan_id } = body
  if (!plan_id) return NextResponse.json({ error: 'plan_id is required' }, { status: 400 })

  // ── Fetch plan server-side (never trust client price) ─────────────────────
  const admin = createAdminClient()
  const { data: plan, error: planErr } = await admin
    .from('subscription_plans')
    .select('id, name, price_monthly')
    .eq('id', plan_id)
    .single()

  if (planErr || !plan) {
    console.error('[billing-create-order][4] FAIL plan:', planErr?.message ?? 'not found')
    return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
  }
  if ((plan.price_monthly as number) <= 0) {
    return NextResponse.json({ error: 'The Free plan cannot be purchased' }, { status: 400 })
  }
  if ((plan.name as string) === 'Agency') {
    return NextResponse.json({ error: 'Contact sales for the Agency plan' }, { status: 400 })
  }
  console.log(`[billing-create-order][4] OK   plan: ${plan.name} ₹${plan.price_monthly}`)

  // ── Razorpay keys check ───────────────────────────────────────────────────
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('[billing-create-order][5] FAIL Razorpay keys not configured')
    return NextResponse.json({ error: 'Payment gateway not configured' }, { status: 500 })
  }

  // ── Create Razorpay order ─────────────────────────────────────────────────
  try {
    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })

    const order = await razorpay.orders.create({
      amount:   (plan.price_monthly as number) * 100,  // INR → paise
      currency: 'INR',
      receipt:  `ws_${(member.workspace_id as string).slice(0, 8)}_${Date.now()}`,
      notes: {
        workspace_id: member.workspace_id as string,
        plan_id:      plan.id as string,
        plan_name:    plan.name as string,
      },
    })

    console.log(`[billing-create-order][5] OK   order: ${order.id}`)

    return NextResponse.json({
      order_id:  order.id,
      amount:    order.amount,
      currency:  order.currency,
      key_id:    process.env.RAZORPAY_KEY_ID,
      plan_name: plan.name,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[billing-create-order][5] FAIL Razorpay:', msg)
    return NextResponse.json({ error: 'Failed to create payment order' }, { status: 500 })
  }
}
