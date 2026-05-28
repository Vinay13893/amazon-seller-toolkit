import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptToken } from '@/lib/amazon/crypto'

export const runtime     = 'nodejs'
export const maxDuration = 30

const STATE_COOKIE            = 'spapi_oauth_state'
const LWA_TOKEN_URL           = 'https://api.amazon.com/auth/o2/token'
const INDIA_MARKETPLACE_ID    = 'A21TJRUUN4KGV'
const INDIA_MARKETPLACE_NAME  = 'Amazon India'

interface LWATokenResponse {
  access_token:  string
  refresh_token: string
  token_type:    string
  expires_in:    number
}

/**
 * GET /api/amazon/connect/callback
 *
 * Handles the Amazon SP-API OAuth redirect after seller consent.
 *
 * Amazon sends: ?spapi_oauth_code=...&selling_partner_id=...&state=...
 *
 * Flow:
 *  1. Validate CSRF state against httpOnly cookie
 *  2. Exchange spapi_oauth_code for LWA access_token + refresh_token
 *  3. Encrypt both tokens with AES-256-GCM
 *  4. Upsert into amazon_connections (service-role, one row per workspace)
 *  5. Write audit log entry
 *  6. Redirect to /dashboard/settings?amazon=connected
 *
 * SECURITY: refresh_token and access_token are encrypted before storage
 * and are never returned to the frontend.
 */
export async function GET(request: NextRequest) {
  // Derive the settings redirect base from SPAPI_REDIRECT_URI env so the
  // callback always redirects back to the correct Vercel domain, regardless
  // of how Next.js resolves request.url internally.
  const redirectUri  = process.env.SPAPI_REDIRECT_URI
  const origin       = redirectUri
    ? new URL(redirectUri).origin
    : new URL(request.url).origin
  const settingsBase = `${origin}/dashboard/settings`
  const { searchParams } = new URL(request.url)

  const code             = searchParams.get('spapi_oauth_code')
  const sellingPartnerId = searchParams.get('selling_partner_id')
  const state            = searchParams.get('state')
  const amazonError      = searchParams.get('error')

  // ── Read + consume CSRF state cookie immediately ───────────────────────────
  const cookieStore = await cookies()
  const storedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  // ── Handle explicit Amazon error response ─────────────────────────────────
  if (amazonError) {
    console.error('[amazon-callback] Amazon returned error:', amazonError)
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=${encodeURIComponent(amazonError)}`)
  }

  // ── Validate required params ───────────────────────────────────────────────
  if (!code || !state || !sellingPartnerId) {
    console.error('[amazon-callback] Missing required query params')
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=missing_params`)
  }

  // ── CSRF check ────────────────────────────────────────────────────────────
  if (!storedState || storedState !== state) {
    console.error('[amazon-callback] CSRF state mismatch — possible replay or session expiry')
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=state_mismatch`)
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.redirect(`${origin}/auth/login`)
  }

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    console.error('[amazon-callback] No workspace for user:', user.id)
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=no_workspace`)
  }

  // ── Exchange code for LWA tokens ───────────────────────────────────────────
  let tokens: LWATokenResponse
  try {
    const res = await fetch(LWA_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.SPAPI_REDIRECT_URI        ?? '',
        client_id:     process.env.SPAPI_LWA_CLIENT_ID        ?? '',
        client_secret: process.env.SPAPI_LWA_CLIENT_SECRET    ?? '',
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[amazon-callback] LWA token exchange failed:', res.status, body)
      return NextResponse.redirect(`${settingsBase}?amazon=error&reason=token_exchange`)
    }

    tokens = await res.json() as LWATokenResponse
  } catch (err) {
    console.error('[amazon-callback] LWA fetch error:', err)
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=token_exchange`)
  }

  // ── Encrypt tokens (AES-256-GCM, server-only) ─────────────────────────────
  let refreshTokenEncrypted: string
  let accessTokenEncrypted: string
  try {
    refreshTokenEncrypted = encryptToken(tokens.refresh_token)
    accessTokenEncrypted  = encryptToken(tokens.access_token)
  } catch (err) {
    console.error('[amazon-callback] Encryption error:', err)
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=encryption`)
  }

  const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const now                  = new Date().toISOString()

  // ── Upsert connection row ─────────────────────────────────────────────────
  const admin = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertErr } = await (admin as any)
    .from('amazon_connections')
    .upsert({
      workspace_id:            member.workspace_id,
      selling_partner_id:      sellingPartnerId,
      marketplace_id:          INDIA_MARKETPLACE_ID,
      marketplace_name:        INDIA_MARKETPLACE_NAME,
      refresh_token_encrypted: refreshTokenEncrypted,
      access_token_encrypted:  accessTokenEncrypted,
      access_token_expires_at: accessTokenExpiresAt,
      status:                  'active',
      connected_by_user_id:    user.id,
      connected_at:            now,
      updated_at:              now,
      error_message:           null,
    }, { onConflict: 'workspace_id' })

  if (upsertErr) {
    console.error('[amazon-callback] DB upsert error:', upsertErr.message)
    return NextResponse.redirect(`${settingsBase}?amazon=error&reason=db_error`)
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_audit_logs')
    .insert({
      workspace_id: member.workspace_id,
      user_id:      user.id,
      event_type:   'oauth_connect',
      details: {
        selling_partner_id: sellingPartnerId,
        marketplace_id:     INDIA_MARKETPLACE_ID,
      },
    })

  console.log(`[amazon-callback] SUCCESS workspace=${member.workspace_id} seller=${sellingPartnerId}`)
  return NextResponse.redirect(`${settingsBase}?amazon=connected`)
}
