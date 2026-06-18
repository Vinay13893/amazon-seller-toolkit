import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  INTERNAL_TEST_ASIN_LIMIT,
  INTERNAL_TEST_PLAN_NAME,
  isInternalTestAccount,
} from '@/lib/internal-test-entitlement'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isInternalTestAccount(user.email)) {
    return NextResponse.json({
      planName: INTERNAL_TEST_PLAN_NAME,
      asinLimit: INTERNAL_TEST_ASIN_LIMIT,
      internalTest: true,
    })
  }

  const requestedWorkspaceId = new URL(request.url).searchParams.get('workspaceId')
  let membershipQuery = supabase
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (requestedWorkspaceId) {
    membershipQuery = membershipQuery.eq('workspace_id', requestedWorkspaceId)
  }

  const { data: memberships } = await membershipQuery
  const workspaceIds = Array.from(new Set((memberships ?? []).map(row => row.workspace_id).filter(Boolean)))
  if (workspaceIds.length === 0) {
    if (requestedWorkspaceId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({ planName: 'Free', asinLimit: 5, internalTest: false })
  }

  const { data: subscriptions } = await supabase
    .from('workspace_subscriptions')
    .select('workspace_id, status, subscription_plans(name, asin_limit)')
    .in('workspace_id', workspaceIds)

  const activeSubscription = requestedWorkspaceId
    ? subscriptions?.find(subscription => subscription.workspace_id === requestedWorkspaceId)
    : (subscriptions ?? []).find(
        subscription => subscription.status === 'active' || subscription.status === 'trialing',
      ) ?? subscriptions?.[0]

  const embeddedPlan = activeSubscription?.subscription_plans
  const plan = Array.isArray(embeddedPlan) ? embeddedPlan[0] : embeddedPlan

  return NextResponse.json({
    planName: plan?.name ?? 'Free',
    asinLimit: plan?.asin_limit ?? 5,
    internalTest: false,
  })
}
