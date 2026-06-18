import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const maxDuration = 10

const STATE_COOKIE = 'amazon_ads_oauth_state'
const STATE_TTL_SEC = 10 * 60
const ADS_AUTH_URL = 'https://www.amazon.com/ap/oa'
const ADS_SCOPE = 'advertising::campaign_management'

const REQUIRED_ENV_NAMES = [
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
] as const

function missingEnvNames() {
  return REQUIRED_ENV_NAMES.filter(name => !process.env[name])
}

export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  const missing = missingEnvNames()

  if (missing.length > 0) {
    return NextResponse.json({
      success: false,
      errorCode: 'ads_connection_not_configured',
      message: 'Amazon Ads OAuth is not configured yet.',
      missingEnvNames: missing,
    }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.redirect(`${origin}/login`)
  }

  const state = randomBytes(32).toString('hex')
  const params = new URLSearchParams({
    client_id: process.env.AMAZON_ADS_CLIENT_ID ?? '',
    scope: ADS_SCOPE,
    response_type: 'code',
    redirect_uri: process.env.AMAZON_ADS_REDIRECT_URI ?? '',
    state,
  })

  const response = NextResponse.redirect(`${ADS_AUTH_URL}?${params}`)
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_SEC,
    path: '/',
  })

  return response
}
