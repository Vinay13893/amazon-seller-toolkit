import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logInfo, logError } from '@/lib/observability/logger'

export const runtime     = 'nodejs'
export const maxDuration = 10

// Safe fields returned to the frontend — token columns are deliberately absent
interface AmazonConnectionRow {
  status:                   string
  selling_partner_id:       string | null
  marketplace_id:           string | null
  marketplace_name:         string | null
  brand_analytics_eligible: boolean
  brand_registry_enrolled:  boolean
  last_sync_at:             string | null
  error_message:            string | null
}

/**
 * GET /api/amazon/connect/status
 *
 * Returns the Amazon SP-API connection status for the caller's workspace.
 *
 * SECURITY: refresh_token_encrypted and access_token_encrypted are
 * intentionally excluded from the SELECT projection and never returned.
 *
 * Safe fields returned:
 *   connected, status, selling_partner_id, marketplace_id, marketplace_name,
 *   brand_analytics_eligible, brand_registry_enrolled, last_sync_at, error_message
 */
export async function GET() {
  logInfo('amazon-status', 'GET /api/amazon/connect/status')

  const supabase = await createClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    logError('amazon-status', 'FAIL auth')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  logInfo('amazon-status', `OK user`, { userId: user.id })

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    logError('amazon-status', 'FAIL workspace', memberErr ?? new Error('no row'))
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  logInfo('amazon-status', `OK workspace`, { workspaceId: member.workspace_id })

  // ── Connection row ────────────────────────────────────────────────────────
  // Explicitly select only safe fields — token columns are intentionally omitted.
  // Cast to AmazonConnectionRow: table is not yet in the generated Supabase types
  // (migration 006 pending application to the project).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: connRaw, error: connErr } = await (supabase as any)
    .from('amazon_connections')
    .select(
      'status, selling_partner_id, marketplace_id, marketplace_name, ' +
      'brand_analytics_eligible, brand_registry_enrolled, last_sync_at, error_message'
    )
    .eq('workspace_id', member.workspace_id)
    .maybeSingle()

  const conn = connRaw as AmazonConnectionRow | null

  if (connErr) {
    logError('amazon-status', 'FAIL fetch connection', connErr)
    return NextResponse.json({ error: 'Failed to fetch connection status' }, { status: 500 })
  }

  // No row yet — workspace has never started the OAuth flow
  if (!conn) {
    logInfo('amazon-status', 'no connection row found → not_connected')
    return NextResponse.json({
      configured:               !!process.env.SPAPI_APPLICATION_ID,
      connected:                false,
      status:                   'not_connected',
      selling_partner_id:       null,
      marketplace_id:           null,
      marketplace_name:         null,
      brand_analytics_eligible: false,
      brand_registry_enrolled:  false,
      last_sync_at:             null,
      error_message:            null,
    })
  }

  logInfo('amazon-status', `OK status`, { status: conn.status })

  return NextResponse.json({
    configured:               !!process.env.SPAPI_APPLICATION_ID,
    connected:                conn.status === 'active',
    status:                   conn.status,
    selling_partner_id:       conn.selling_partner_id,
    marketplace_id:           conn.marketplace_id,
    marketplace_name:         conn.marketplace_name,
    brand_analytics_eligible: conn.brand_analytics_eligible,
    brand_registry_enrolled:  conn.brand_registry_enrolled,
    last_sync_at:             conn.last_sync_at,
    error_message:            conn.error_message,
  })
}

/**
 * DELETE /api/amazon/connect/status
 *
 * Disconnects the Amazon SP-API account for the caller's workspace.
 * Deletes the connection row and writes an audit log entry.
 */
export async function DELETE() {
  const supabase = await createClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: deleteErr } = await (admin as any)
    .from('amazon_connections')
    .delete()
    .eq('workspace_id', member.workspace_id)

  if (deleteErr) {
    console.error('[amazon-disconnect] DB delete error:', deleteErr.message)
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_audit_logs')
    .insert({
      workspace_id: member.workspace_id,
      user_id:      user.id,
      event_type:   'oauth_disconnect',
      details:      {},
    })

  console.log(`[amazon-disconnect] workspace=${member.workspace_id} disconnected by user=${user.id}`)
  return NextResponse.json({ success: true })
}
