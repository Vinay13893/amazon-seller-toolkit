import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptToken } from '@/lib/amazon/crypto'

export const runtime = 'nodejs'
export const maxDuration = 30

const STATE_COOKIE = 'amazon_ads_oauth_state'
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
const DEFAULT_REGION = 'eu'

const REQUIRED_ENV_NAMES = [
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
] as const

type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

function missingEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => !process.env[name])
}

function settingsRedirect(request: NextRequest, reason: string) {
  const redirectUri = process.env.AMAZON_ADS_REDIRECT_URI
  const origin = redirectUri ? new URL(redirectUri).origin : new URL(request.url).origin
  return NextResponse.redirect(`${origin}/dashboard/settings?amazon_ads=error&reason=${encodeURIComponent(reason)}`)
}

export async function GET(request: NextRequest) {
  const redirectUri = process.env.AMAZON_ADS_REDIRECT_URI
  const origin = redirectUri ? new URL(redirectUri).origin : new URL(request.url).origin
  const settingsBase = `${origin}/dashboard/settings`
  const { searchParams } = new URL(request.url)

  const missing = missingEnvNames()
  if (missing.length > 0) {
    return settingsRedirect(request, 'ads_connection_not_configured')
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const amazonError = searchParams.get('error')

  const cookieStore = await cookies()
  const storedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  if (amazonError) {
    return settingsRedirect(request, 'amazon_ads_oauth_error')
  }

  if (!code || !state) {
    return settingsRedirect(request, 'missing_params')
  }

  if (!storedState || storedState !== state) {
    return settingsRedirect(request, 'state_mismatch')
  }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.redirect(`${origin}/login`)
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) {
    return settingsRedirect(request, 'workspace_not_found')
  }

  let tokens: TokenResponse
  try {
    const res = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.AMAZON_ADS_REDIRECT_URI ?? '',
        client_id: process.env.AMAZON_ADS_CLIENT_ID ?? '',
        client_secret: process.env.AMAZON_ADS_CLIENT_SECRET ?? '',
      }),
    })

    if (!res.ok) {
      return settingsRedirect(request, 'token_exchange_failed')
    }

    tokens = await res.json() as TokenResponse
  } catch {
    return settingsRedirect(request, 'token_exchange_failed')
  }

  let refreshTokenEncrypted: string
  let accessTokenEncrypted: string
  try {
    refreshTokenEncrypted = encryptToken(tokens.refresh_token)
    accessTokenEncrypted = encryptToken(tokens.access_token)
  } catch {
    return settingsRedirect(request, 'token_encryption_failed')
  }

  const now = new Date().toISOString()
  const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const admin = createAdminClient()

  const { error: upsertError } = await admin
    .from('amazon_ads_connections')
    .upsert({
      workspace_id: member.workspace_id,
      region: DEFAULT_REGION,
      status: 'active',
      refresh_token_encrypted: refreshTokenEncrypted,
      access_token_encrypted: accessTokenEncrypted,
      access_token_expires_at: accessTokenExpiresAt,
      connected_by_user_id: user.id,
      connected_at: now,
      error_code: null,
      error_message: null,
      updated_at: now,
    }, { onConflict: 'workspace_id' })

  if (upsertError) {
    return settingsRedirect(request, 'ads_connection_store_failed')
  }

  return NextResponse.redirect(`${settingsBase}?amazon_ads=connected`)
}
