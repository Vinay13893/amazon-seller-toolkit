import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getPincodeMonitoringConfig, isWorkspaceAllowlisted } from '@/lib/pincode-monitoring/config'
import { getWorkspaceTrackerEntitlements } from '@/lib/subscriptions/workspace-entitlements'

export async function GET() {
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: member, error } = await db.from('workspace_members').select('workspace_id, role')
    .eq('user_id', user.id).order('workspace_id').limit(1).maybeSingle()
  if (error || !member) return NextResponse.json({ error: 'Workspace unavailable' }, { status: 403 })
  const { data: connection } = await db.from('amazon_connections').select('marketplace_id')
    .eq('workspace_id', member.workspace_id).maybeSingle()
  const config = getPincodeMonitoringConfig()
  const plan = await getWorkspaceTrackerEntitlements(member.workspace_id).catch(() => null)
  return NextResponse.json({ workspaceId: member.workspace_id, marketplaceId: connection?.marketplace_id ?? null,
    canEdit: ['owner', 'admin', 'member'].includes(member.role),
    monitoringEnabled: config.enabled && (isWorkspaceAllowlisted(config, member.workspace_id) || plan?.pincodeEnabled === true) && connection?.marketplace_id === 'A21TJRUUN4KGV',
    quota: plan?.pincodeCheckLimit ?? config.quotaPerWorkspaceMarketplace }, { headers: { 'Cache-Control': 'no-store' } })
}
