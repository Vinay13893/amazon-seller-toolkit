import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 10

// Read-only with respect to Amazon: this route only ever writes our own
// amazon_ads_profiles rows (which profile Brahmastra report sync is allowed
// to use). It never calls an Amazon Ads API endpoint.

type Action = 'enable' | 'disable' | 'set_primary' | 'rename'
const VALID_ACTIONS: Action[] = ['enable', 'disable', 'set_primary', 'rename']

async function resolveWorkspace() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: NextResponse.json({ success: false, errorCode: 'unauthorized', message: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) {
    return { error: NextResponse.json({ success: false, errorCode: 'workspace_not_found', message: 'No workspace found for authenticated user.' }, { status: 404 }) }
  }

  return { workspaceId: member.workspace_id as string }
}

export async function PATCH(request: NextRequest) {
  const workspace = await resolveWorkspace()
  if (workspace.error) return workspace.error

  let body: { profileId?: unknown; action?: unknown; displayName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, errorCode: 'invalid_body', message: 'Invalid JSON body.' }, { status: 400 })
  }

  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : ''
  const action = typeof body.action === 'string' ? body.action as Action : null

  if (!profileId) {
    return NextResponse.json({ success: false, errorCode: 'missing_profile_id', message: 'profileId is required.' }, { status: 400 })
  }
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ success: false, errorCode: 'invalid_action', message: `action must be one of ${VALID_ACTIONS.join(', ')}.` }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: existing, error: existingError } = await admin
    .from('amazon_ads_profiles')
    .select('profile_id')
    .eq('workspace_id', workspace.workspaceId)
    .eq('profile_id', profileId)
    .maybeSingle()

  if (existingError || !existing) {
    return NextResponse.json({ success: false, errorCode: 'profile_not_found', message: 'Amazon Ads profile not found for this workspace.' }, { status: 404 })
  }

  const now = new Date().toISOString()

  if (action === 'enable') {
    const { error } = await admin
      .from('amazon_ads_profiles')
      .update({ brahmastra_sync_enabled: true, updated_at: now })
      .eq('workspace_id', workspace.workspaceId)
      .eq('profile_id', profileId)
    if (error) {
      return NextResponse.json({ success: false, errorCode: 'update_failed', message: 'Could not enable profile for Brahmastra sync.' }, { status: 500 })
    }
  } else if (action === 'disable') {
    const { error } = await admin
      .from('amazon_ads_profiles')
      .update({ brahmastra_sync_enabled: false, is_primary: false, updated_at: now })
      .eq('workspace_id', workspace.workspaceId)
      .eq('profile_id', profileId)
    if (error) {
      return NextResponse.json({ success: false, errorCode: 'update_failed', message: 'Could not disable profile.' }, { status: 500 })
    }
  } else if (action === 'set_primary') {
    // Clear any existing primary first — the unique partial index only
    // allows one is_primary=true row per workspace, so this must run before
    // setting the new one.
    const { error: clearError } = await admin
      .from('amazon_ads_profiles')
      .update({ is_primary: false, updated_at: now })
      .eq('workspace_id', workspace.workspaceId)
      .eq('is_primary', true)
    if (clearError) {
      return NextResponse.json({ success: false, errorCode: 'update_failed', message: 'Could not clear previous primary profile.' }, { status: 500 })
    }

    const { error } = await admin
      .from('amazon_ads_profiles')
      .update({ is_primary: true, brahmastra_sync_enabled: true, updated_at: now })
      .eq('workspace_id', workspace.workspaceId)
      .eq('profile_id', profileId)
    if (error) {
      return NextResponse.json({ success: false, errorCode: 'update_failed', message: 'Could not set primary profile.' }, { status: 500 })
    }
  } else if (action === 'rename') {
    const displayNameRaw = typeof body.displayName === 'string' ? body.displayName.trim() : ''
    const displayName = displayNameRaw.length > 0 ? displayNameRaw.slice(0, 80) : null
    const { error } = await admin
      .from('amazon_ads_profiles')
      .update({ display_name: displayName, updated_at: now })
      .eq('workspace_id', workspace.workspaceId)
      .eq('profile_id', profileId)
    if (error) {
      return NextResponse.json({ success: false, errorCode: 'update_failed', message: 'Could not rename profile.' }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}
