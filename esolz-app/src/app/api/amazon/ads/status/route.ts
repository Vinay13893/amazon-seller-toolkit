import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 10

const REQUIRED_ENV_NAMES = [
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
] as const

type AdsConnectionRow = {
  id: string
  status: string
  marketplace_id: string | null
  region: string | null
  last_profile_sync_at: string | null
  error_code: string | null
  error_message: string | null
}

type AdsProfileRow = {
  profile_id: string
  marketplace_id: string | null
  country_code: string | null
  currency_code: string | null
  timezone: string | null
  profile_type: string | null
  status: string | null
  last_synced_at: string | null
}

function configuredEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => Boolean(process.env[name]))
}

function missingEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => !process.env[name])
}

function sanitizeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
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

export async function GET() {
  const workspace = await resolveWorkspace()
  if (workspace.error) return workspace.error

  const configured = missingEnvNames().length === 0
  const envPresence = {
    configuredEnvNames: configuredEnvNames(),
    missingEnvNames: missingEnvNames(),
  }

  let connection: AdsConnectionRow | null = null
  let profiles: AdsProfileRow[] = []

  try {
    const admin = createAdminClient()

    const { data: connectionRow, error: connectionError } = await admin
      .from('amazon_ads_connections')
      .select('id, status, marketplace_id, region, last_profile_sync_at, error_code, error_message')
      .eq('workspace_id', workspace.workspaceId)
      .maybeSingle()

    if (connectionError) {
      return NextResponse.json({
        success: false,
        errorCode: 'ads_foundation_unavailable',
        message: 'Amazon Ads foundation tables are not available yet.',
        configured,
        envPresence,
        connection: null,
        profiles: [],
      }, { status: 200 })
    }

    connection = connectionRow as AdsConnectionRow | null

    if (connection?.id) {
      const { data: profileRows } = await admin
        .from('amazon_ads_profiles')
        .select('profile_id, marketplace_id, country_code, currency_code, timezone, profile_type, status, last_synced_at')
        .eq('workspace_id', workspace.workspaceId)
        .eq('amazon_ads_connection_id', connection.id)
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(20)

      profiles = (profileRows ?? []) as AdsProfileRow[]
    }
  } catch {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_status_failed',
      message: 'Unable to read Amazon Ads status.',
      configured,
      envPresence,
      connection: null,
      profiles: [],
    }, { status: 200 })
  }

  if (!configured) {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_connection_not_configured',
      message: 'Amazon Ads OAuth is not configured yet.',
      configured,
      envPresence,
      connection: connection ? {
        status: connection.status,
        marketplaceId: connection.marketplace_id,
        region: connection.region,
        lastProfileSyncAt: connection.last_profile_sync_at,
        errorCode: connection.error_code,
        errorMessage: sanitizeErrorMessage(connection.error_message),
      } : null,
      profiles,
      lastSyncAt: connection?.last_profile_sync_at ?? null,
    }, { status: 200 })
  }

  return NextResponse.json({
    success: true,
    configured,
    envPresence,
    connection: connection ? {
      status: connection.status,
      marketplaceId: connection.marketplace_id,
      region: connection.region,
      lastProfileSyncAt: connection.last_profile_sync_at,
      errorCode: connection.error_code,
      errorMessage: sanitizeErrorMessage(connection.error_message),
    } : {
      status: 'not_connected',
      marketplaceId: null,
      region: null,
      lastProfileSyncAt: null,
      errorCode: null,
      errorMessage: null,
    },
    profiles,
    lastSyncAt: connection?.last_profile_sync_at ?? null,
  })
}
