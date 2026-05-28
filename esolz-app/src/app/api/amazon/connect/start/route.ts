import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { randomBytes } from 'crypto'

export const runtime     = 'nodejs'
export const maxDuration = 10

const STATE_COOKIE  = 'spapi_oauth_state'
const STATE_TTL_SEC = 10 * 60  // 10 minutes
const CONSENT_URL   = 'https://sellercentral.amazon.in/apps/authorize/consent'

/**
 * GET /api/amazon/connect/start
 *
 * Step 1 of Amazon SP-API OAuth.
 * Generates CSRF state, stores in httpOnly cookie, redirects to Amazon consent.
 *
 * IMPORTANT: application_id in the consent URL must be the SP-API Application ID
 * (amzn1.sp.solution.xxx). This is NOT the LWA Client ID.
 *
 * Amazon OAuth only runs on the deployed Vercel domain.
 * Localhost requests are rejected with a clear error — configure SPAPI_REDIRECT_URI
 * with your Vercel URL and open the app there to connect.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin

  // ── Localhost guard ────────────────────────────────────────────────────────
  // Amazon SP-API OAuth requires HTTPS and a registered callback domain.
  // It cannot run from localhost. Redirect URI must point to the Vercel URL.
  const redirectUri = process.env.SPAPI_REDIRECT_URI ?? ''
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
    const isRedirectLocal = redirectUri.startsWith('http://localhost') || redirectUri.startsWith('http://127.0.0.1')
    if (!isRedirectLocal) {
      console.warn('[amazon-start] OAuth unavailable on localhost — SPAPI_REDIRECT_URI points to production')
      return NextResponse.json(
        { error: 'Amazon OAuth is available only on the deployed Vercel URL. Open the app there to connect.' },
        { status: 403 }
      )
    }
  }

  const supabase = await createClient()

  // ── Env check ─────────────────────────────────────────────────────────────
  const applicationId = process.env.SPAPI_APPLICATION_ID
  if (!applicationId) {
    console.error('[amazon-start] SPAPI_APPLICATION_ID not configured')
    return NextResponse.json(
      { error: 'Amazon SP-API Application ID not configured on this server.' },
      { status: 503 }
    )
  }

  // ── Auth check ────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.redirect(`${origin}/auth/login`)
  }

  // ── CSRF state ────────────────────────────────────────────────────────────
  const state = randomBytes(32).toString('hex')

  // ── Build consent URL ─────────────────────────────────────────────────────
  // application_id = your SP-API Application ID from Developer Central.
  // version=beta   = required while app is in Draft/Development status.
  //                  Remove once Amazon approves the app for production.
  const params = new URLSearchParams({
    application_id: applicationId,
    state,
    version: 'beta',
  })
  const consentUrl = `${CONSENT_URL}?${params}`

  // ── Set state cookie on the redirect response ─────────────────────────────
  const response = NextResponse.redirect(consentUrl)
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   STATE_TTL_SEC,
    path:     '/',
  })

  console.log(`[amazon-start] user=${user.id} → redirecting to Amazon consent`)
  return response
}
