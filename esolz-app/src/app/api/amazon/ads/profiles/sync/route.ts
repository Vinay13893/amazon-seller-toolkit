import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 10

const REQUIRED_ENV_NAMES = [
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
] as const

function missingEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => !process.env[name])
}

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

  return { workspaceId: member.workspace_id }
}

export async function POST() {
  const workspace = await resolveWorkspace()
  if (workspace.error) return workspace.error

  const missing = missingEnvNames()
  if (missing.length > 0) {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_connection_not_configured',
      message: 'Amazon Ads OAuth is not configured yet.',
      missingEnvNames: missing,
      profilesSynced: 0,
    }, { status: 501 })
  }

  return NextResponse.json({
    success: false,
    errorCode: 'ads_oauth_deferred',
    message: 'Amazon Ads profile sync is deferred until Ads OAuth is implemented.',
    profilesSynced: 0,
  }, { status: 501 })
}
