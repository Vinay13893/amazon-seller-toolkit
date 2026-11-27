import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getInternalAccessContext } from '@/lib/internal-access'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId)
    return Response.json({ error: 'unauthorized' }, { status: 403 })
  const admin = createAdminClient()
  const [actionsResult, runsResult] = await Promise.all([
    admin.from('ads_agent_actions')
      .select('id,profile_id,action_type,reason_code,entity_type,entity_id,campaign_id,ad_group_id,current_value,proposed_value,change_percent,evidence,data_through,status,created_at')
      .eq('workspace_id', access.workspaceId).order('created_at', { ascending: false }).limit(50),
    admin.from('ads_agent_runs')
      .select('status,error_code,started_at,finished_at,data_through,evaluated_count,proposed_count')
      .eq('workspace_id', access.workspaceId).order('started_at', { ascending: false }).limit(1),
  ])
  if (actionsResult.error || runsResult.error)
    return Response.json({ error: 'review_read_failed' }, { status: 500 })
  const ids = (actionsResult.data ?? []).map(action => action.id)
  const reviewsResult = ids.length
    ? await admin.from('ads_agent_shadow_reviews').select('action_id,decision,reviewed_at')
      .eq('workspace_id', access.workspaceId).in('action_id', ids)
    : { data: [], error: null }
  if (reviewsResult.error) return Response.json({ error: 'review_read_failed' }, { status: 500 })
  return Response.json({ actions: actionsResult.data ?? [], reviews: reviewsResult.data ?? [], latestRun: runsResult.data?.[0] ?? null })
}

export async function POST(request: Request): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId)
    return Response.json({ error: 'unauthorized' }, { status: 403 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { data: member, error: memberError } = await supabase.from('workspace_members')
    .select('role').eq('workspace_id', access.workspaceId).eq('user_id', user.id).maybeSingle()
  if (memberError || !['owner', 'admin'].includes(member?.role ?? ''))
    return Response.json({ error: 'insufficient_permissions' }, { status: 403 })
  const body = await request.json().catch(() => null) as { actionId?: unknown; decision?: unknown } | null
  if (!body || typeof body.actionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.actionId)
    || !['approve', 'reject'].includes(String(body.decision)))
    return Response.json({ error: 'invalid_review' }, { status: 400 })

  const admin = createAdminClient()
  const { data: action, error: actionError } = await admin.from('ads_agent_actions')
    .select('id,status').eq('id', body.actionId).eq('workspace_id', access.workspaceId).maybeSingle()
  if (actionError || !action || action.status !== 'proposed')
    return Response.json({ error: 'action_not_reviewable' }, { status: 409 })
  const { error: writeError } = await admin.from('ads_agent_shadow_reviews').upsert({
    workspace_id: access.workspaceId,
    action_id: action.id,
    decision: body.decision,
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
  }, { onConflict: 'action_id' })
  if (writeError) return Response.json({ error: 'review_save_failed' }, { status: 500 })
  return Response.json({ saved: true, amazonWrites: 0 })
}
