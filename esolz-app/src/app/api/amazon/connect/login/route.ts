import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const maxDuration = 10

const STATE_COOKIE = 'spapi_oauth_state'

/**
 * GET /api/amazon/connect/login
 *
 * Step 2 of Amazon SP-API OAuth — the "OAuth Login URI".
 *
 * After the seller clicks Authorize on the Amazon consent page, Amazon calls
 * THIS route first (before the final callback). Amazon sends:
 *
 *   ?amazon_callback_uri=<url>&amazon_state=<state>&selling_partner_id=<id>&version=beta
 *
 * This route must:
 *  1. Confirm the user is still logged into our SaaS app.
 *  2. Read our CSRF state from the cookie set by /api/amazon/connect/start.
 *  3. Redirect the browser to amazon_callback_uri with amazon_state + our state.
 *
 * Amazon will then redirect the browser to our /api/amazon/connect/callback
 * with spapi_oauth_code, selling_partner_id, and state.
 *
 * This route must be registered as the "OAuth Login URI" in your Amazon
 * Developer Central app settings.
 */
export async function GET(request: NextRequest) {
  const origin           = new URL(request.url).origin
  const { searchParams } = new URL(request.url)

  const amazonCallbackUri = searchParams.get('amazon_callback_uri')
  const amazonState       = searchParams.get('amazon_state')
  const sellingPartnerId  = searchParams.get('selling_partner_id')

  if (process.env.NODE_ENV !== 'production') {
    console.log('[amazon-login] params received:', {
      amazon_callback_uri: amazonCallbackUri ? '(present)' : '(missing)',
      amazon_state:        amazonState        ? '(present)' : '(missing)',
      selling_partner_id:  sellingPartnerId   ? '(present)' : '(missing)',
    })
  }

  // ── Validate required params ───────────────────────────────────────────────
  if (!amazonCallbackUri || !amazonState) {
    console.error('[amazon-login] Missing amazon_callback_uri or amazon_state')
    return NextResponse.redirect(
      `${origin}/dashboard/settings?amazon=error&reason=login_missing_params`
    )
  }

  // ── Auth: user must still be logged into our SaaS ─────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    // Not logged in — send to login, Amazon redirect will be lost (expected)
    console.error('[amazon-login] User not authenticated during Amazon login callback')
    return NextResponse.redirect(`${origin}/auth/login`)
  }

  // ── Read our CSRF state from cookie (set in /start) ───────────────────────
  const cookieStore = await cookies()
  const ourState    = cookieStore.get(STATE_COOKIE)?.value

  if (!ourState) {
    // Cookie expired or missing — the /start flow was never run or expired
    console.error('[amazon-login] CSRF state cookie missing — flow may have expired')
    return NextResponse.redirect(
      `${origin}/dashboard/settings?amazon=error&reason=session_expired`
    )
  }

  // ── Build redirect back to Amazon ─────────────────────────────────────────
  // We pass amazon_state back to Amazon plus our own state.
  // Amazon will then call our /callback with spapi_oauth_code + our state.
  // Use SPAPI_REDIRECT_URI from env so it always matches what was registered
  // in Amazon Developer Central — never construct it from the request origin.
  const redirectUri = process.env.SPAPI_REDIRECT_URI ?? `${origin}/api/amazon/connect/callback`
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[amazon-login] redirect_uri: ${redirectUri}`)
  }

  const redirectParams = new URLSearchParams({
    amazon_state:  amazonState,
    state:         ourState,
    redirect_uri:  redirectUri,
    version:       'beta',
  })

  const amazonRedirectUrl = `${amazonCallbackUri}?${redirectParams}`

  console.log(`[amazon-login] user=${user.id} seller=${sellingPartnerId ?? 'unknown'} → continuing Amazon consent flow`)
  return NextResponse.redirect(amazonRedirectUrl)
}
