import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptToken, decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getMarketplaceParticipations } from '@/lib/amazon/spapi-client'

export const runtime     = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/amazon/sync/basic
 *
 * Refreshes the LWA access token and calls getMarketplaceParticipations
 * to verify the SP-API connection and update stored marketplace metadata.
 *
 * Flow:
 *  1. Auth check
 *  2. Workspace membership check (owner / admin only)
 *  3. Fetch amazon_connections row (service-role — includes encrypted tokens)
 *  4. Decrypt refresh_token_encrypted → call refreshAccessToken
 *  5. Encrypt + persist new access_token
 *  6. Call getMarketplaceParticipations with fresh token
 *  7. Update connection row (status, marketplace fields, last_sync_at)
 *  8. Insert audit log event
 *
 * SECURITY: Encrypted tokens are never returned to the frontend.
 *           Never log access_token, refresh_token, or client_secret.
 */
export async function POST() {
  try {
    return await handlePost()
  } catch (err) {
    // Catch-all: ensure we always return JSON, never an HTML 500 page.
    // This reveals the real error in the toast instead of "Network error".
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[amazon-sync-basic] UNHANDLED ERROR:', msg)
    return NextResponse.json({ error: `Unexpected server error: ${msg}` }, { status: 500 })
  }
}

async function handlePost() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[amazon-sync-basic][1] POST /api/amazon/sync/basic started')
  }

  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Workspace + role check ──────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  if (member.role !== 'owner' && member.role !== 'admin') {
    return NextResponse.json({ error: 'Insufficient permissions — owner or admin required' }, { status: 403 })
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[amazon-sync-basic][2] workspace: ${member.workspace_id}`)
  }

  // ── 3. Fetch connection row ────────────────────────────────────────────────
  const admin = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: conn, error: connErr } = await (admin as any)
    .from('amazon_connections')
    .select('id, status, selling_partner_id, refresh_token_encrypted')
    .eq('workspace_id', member.workspace_id)
    .maybeSingle()

  if (connErr) {
    console.error('[amazon-sync-basic] DB fetch error:', connErr.message)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (!conn) {
    return NextResponse.json({ error: 'No Amazon connection found. Please connect first.' }, { status: 404 })
  }

  if (conn.status === 'revoked') {
    return NextResponse.json({ error: 'Connection has been revoked. Please reconnect your account.' }, { status: 409 })
  }

  // ── 4. Decrypt refresh token + refresh access token ───────────────────────
  let refreshToken: string
  try {
    refreshToken = decryptToken(conn.refresh_token_encrypted)
  } catch {
    console.error('[amazon-sync-basic] Failed to decrypt refresh token')
    return NextResponse.json({ error: 'Failed to decrypt stored token — check SPAPI_ENCRYPTION_KEY' }, { status: 500 })
  }

  let newAccessToken: string
  let expiresIn: number
  try {
    const result   = await refreshAccessToken(refreshToken)
    newAccessToken = result.access_token
    expiresIn      = result.expires_in
    if (process.env.NODE_ENV !== 'production') {
      console.log('[amazon-sync-basic][3] Token refresh success')
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'token_refresh_failed'
    console.error('[amazon-sync-basic] Token refresh failed:', reason)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await (admin as any).from('amazon_audit_logs').insert({
      workspace_id: member.workspace_id,
      user_id:      user.id,
      event_type:   'basic_sync_failed',
      details:      { reason: 'token_refresh_failed' },
    }) } catch { /* non-fatal */ }

    return NextResponse.json({ error: `Token refresh failed: ${reason}` }, { status: 502 })
  }

  // ── 5. Encrypt + persist new access token ─────────────────────────────────
  const accessTokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  try {
    const accessTokenEncrypted = encryptToken(newAccessToken)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_connections')
      .update({
        access_token_encrypted:  accessTokenEncrypted,
        access_token_expires_at: accessTokenExpiresAt,
        updated_at:              new Date().toISOString(),
      })
      .eq('workspace_id', member.workspace_id)
  } catch {
    // Non-fatal: we still have a valid in-memory token. Log and continue.
    console.error('[amazon-sync-basic] Failed to persist refreshed access token')
  }

  // ── 6. Call SP-API: getMarketplaceParticipations ───────────────────────────
  let marketplaceId:   string | null = null
  let marketplaceName: string | null = null
  let syncSuccess = false

  try {
    const result       = await getMarketplaceParticipations(newAccessToken)
    const participations = result.payload ?? []

    // Use the first marketplace the seller is actively participating in
    const active = participations.find(p => p.participation.isParticipating)
    if (active) {
      marketplaceId   = active.marketplace.id
      marketplaceName = active.marketplace.name
    }
    syncSuccess = true

    if (process.env.NODE_ENV !== 'production') {
      console.log('[amazon-sync-basic][4] SP-API success, marketplace:', marketplaceId)
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[amazon-sync-basic][4] SP-API call failed:', err instanceof Error ? err.message : err)
    }
    // syncSuccess remains false — handled below
  }

  const now = new Date().toISOString()

  if (syncSuccess) {
    // ── 7. Update connection row ─────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_connections')
      .update({
        status:          'active',
        ...(marketplaceId   && { marketplace_id:   marketplaceId }),
        ...(marketplaceName && { marketplace_name: marketplaceName }),
        last_sync_at:    now,
        error_message:   null,
        updated_at:      now,
      })
      .eq('workspace_id', member.workspace_id)

    // ── 8. Audit log ─────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await (admin as any).from('amazon_audit_logs').insert({
      workspace_id: member.workspace_id,
      user_id:      user.id,
      event_type:   'basic_sync_success',
      details: {
        selling_partner_id: conn.selling_partner_id,
        marketplace_id:     marketplaceId,
      },
    }) } catch { /* non-fatal */ }

    return NextResponse.json({
      ok:               true,
      marketplace_id:   marketplaceId,
      marketplace_name: marketplaceName,
    })
  } else {
    // Token refresh succeeded but SP-API call failed
    // Keep connection active but record the error for surfacing in the UI
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_connections')
      .update({
        error_message: 'Marketplace sync failed. Token is valid — will retry on next sync.',
        updated_at:    now,
      })
      .eq('workspace_id', member.workspace_id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await (admin as any).from('amazon_audit_logs').insert({
      workspace_id: member.workspace_id,
      user_id:      user.id,
      event_type:   'basic_sync_failed',
      details:      { reason: 'spapi_call_failed' },
    }) } catch { /* non-fatal */ }

    return NextResponse.json(
      { error: 'SP-API marketplace call failed. Token was refreshed successfully — try again in a moment.' },
      { status: 502 },
    )
  }
}
