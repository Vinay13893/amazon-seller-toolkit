import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'

export const runtime = 'nodejs'
export const maxDuration = 30

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
const ADS_API_BASE_BY_REGION: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
}

const REQUIRED_ENV_NAMES = [
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
] as const

function missingEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => !process.env[name])
}

function sanitizeErrorMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Amazon Ads profile sync failed.'
  return value.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
}

type AdsConnectionRow = {
  id: string
  workspace_id: string
  region: string | null
  refresh_token_encrypted: string | null
}

type TokenResponse = {
  access_token: string
  expires_in: number
}

type AmazonAdsProfile = {
  profileId?: string | number
  countryCode?: string
  currencyCode?: string
  timezone?: string
  accountInfo?: {
    id?: string | number
    marketplaceStringId?: string
    type?: string
    name?: string
  }
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

  const admin = createAdminClient()

  const { data: connectionRow, error: connectionError } = await admin
    .from('amazon_ads_connections')
    .select('id, workspace_id, region, refresh_token_encrypted')
    .eq('workspace_id', workspace.workspaceId)
    .eq('status', 'active')
    .maybeSingle()

  if (connectionError) {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_connection_read_failed',
      message: 'Unable to read Amazon Ads connection.',
      profilesSynced: 0,
    }, { status: 500 })
  }

  const connection = connectionRow as AdsConnectionRow | null
  if (!connection?.refresh_token_encrypted) {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_connection_not_connected',
      message: 'Connect Amazon Ads before syncing profiles.',
      profilesSynced: 0,
    }, { status: 409 })
  }

  let refreshToken: string
  try {
    refreshToken = decryptToken(connection.refresh_token_encrypted)
  } catch {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_token_decrypt_failed',
      message: 'Stored Amazon Ads credential could not be decrypted.',
      profilesSynced: 0,
    }, { status: 500 })
  }

  let accessToken: string
  let expiresIn = 3600
  try {
    const tokenRes = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.AMAZON_ADS_CLIENT_ID ?? '',
        client_secret: process.env.AMAZON_ADS_CLIENT_SECRET ?? '',
      }),
    })

    if (!tokenRes.ok) {
      return NextResponse.json({
        success: false,
        errorCode: 'ads_token_refresh_failed',
        message: 'Amazon Ads token refresh failed.',
        profilesSynced: 0,
      }, { status: 502 })
    }

    const tokenJson = await tokenRes.json() as TokenResponse
    accessToken = tokenJson.access_token
    expiresIn = tokenJson.expires_in ?? expiresIn
  } catch {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_token_refresh_failed',
      message: 'Amazon Ads token refresh failed.',
      profilesSynced: 0,
    }, { status: 502 })
  }

  const region = connection.region ?? 'eu'
  const apiBase = ADS_API_BASE_BY_REGION[region] ?? ADS_API_BASE_BY_REGION.eu

  let profiles: AmazonAdsProfile[]
  try {
    const profilesRes = await fetch(`${apiBase}/v2/profiles`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': process.env.AMAZON_ADS_CLIENT_ID ?? '',
        Accept: 'application/json',
      },
    })

    if (!profilesRes.ok) {
      return NextResponse.json({
        success: false,
        errorCode: 'ads_profiles_fetch_failed',
        message: 'Amazon Ads profiles fetch failed.',
        profilesSynced: 0,
      }, { status: 502 })
    }

    const profileJson = await profilesRes.json()
    profiles = Array.isArray(profileJson) ? profileJson as AmazonAdsProfile[] : []
  } catch {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_profiles_fetch_failed',
      message: 'Amazon Ads profiles fetch failed.',
      profilesSynced: 0,
    }, { status: 502 })
  }

  const now = new Date().toISOString()
  const rows = profiles
    .filter(profile => profile.profileId !== undefined && profile.profileId !== null)
    .map(profile => ({
      workspace_id: workspace.workspaceId,
      amazon_ads_connection_id: connection.id,
      profile_id: String(profile.profileId),
      marketplace_id: profile.accountInfo?.marketplaceStringId ?? null,
      country_code: profile.countryCode ?? null,
      currency_code: profile.currencyCode ?? null,
      timezone: profile.timezone ?? null,
      account_name: profile.accountInfo?.name ?? null,
      account_id: profile.accountInfo?.id !== undefined && profile.accountInfo?.id !== null
        ? String(profile.accountInfo.id)
        : null,
      profile_type: profile.accountInfo?.type ?? null,
      status: 'active',
      last_synced_at: now,
      error_code: null,
      error_message: null,
      updated_at: now,
    }))

  if (rows.length > 0) {
    const { error: upsertError } = await admin
      .from('amazon_ads_profiles')
      .upsert(rows, { onConflict: 'workspace_id,profile_id' })

    if (upsertError) {
      return NextResponse.json({
        success: false,
        errorCode: 'ads_profiles_store_failed',
        message: sanitizeErrorMessage(upsertError.message),
        profilesSynced: 0,
      }, { status: 500 })
    }
  }

  let accessTokenEncrypted: string | null = null
  try {
    accessTokenEncrypted = encryptToken(accessToken)
  } catch {
    accessTokenEncrypted = null
  }

  await admin
    .from('amazon_ads_connections')
    .update({
      access_token_encrypted: accessTokenEncrypted,
      access_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      last_profile_sync_at: now,
      error_code: null,
      error_message: null,
      updated_at: now,
    })
    .eq('id', connection.id)
    .eq('workspace_id', workspace.workspaceId)

  return NextResponse.json({
    success: true,
    profilesSynced: rows.length,
    lastSyncAt: now,
  })
}
