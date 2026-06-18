import 'server-only'

import { isInternalTestAccount } from '@/lib/internal-test-entitlement'
import { createClient } from '@/lib/supabase/server'

type InternalAccessContext = {
  authorized: boolean
  workspaceId: string | null
}

type MembershipRow = {
  workspace_id: string
  created_at: string | null
}

export async function getInternalAccessContext(): Promise<InternalAccessContext> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { authorized: false, workspaceId: null }
  }

  const { data: membershipData } = await supabase
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  const memberships = (membershipData ?? []) as MembershipRow[]
  const workspaceIds = Array.from(new Set(memberships.map(row => row.workspace_id).filter(Boolean)))

  if (workspaceIds.length === 0) {
    return { authorized: false, workspaceId: null }
  }

  if (isInternalTestAccount(user.email)) {
    return { authorized: true, workspaceId: workspaceIds[0] }
  }

  const { data: subscriptionData } = await supabase
    .from('workspace_subscriptions')
    .select('workspace_id, status, subscription_plans(name)')
    .in('workspace_id', workspaceIds)

  const internalSubscription = (subscriptionData ?? []).find(row => {
    const embeddedPlan = row.subscription_plans
    const plan = Array.isArray(embeddedPlan) ? embeddedPlan[0] : embeddedPlan
    return (
      (row.status === 'active' || row.status === 'trial')
      && plan?.name === 'Internal Tester'
    )
  })

  return {
    authorized: Boolean(internalSubscription),
    workspaceId: internalSubscription?.workspace_id ?? null,
  }
}
