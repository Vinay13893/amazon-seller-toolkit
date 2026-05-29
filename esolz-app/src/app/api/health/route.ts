import { NextResponse } from 'next/server'
import { logInfo } from '@/lib/observability/logger'

export const runtime = 'nodejs'

/**
 * GET /api/health
 *
 * Returns safe operational status.
 *
 * SECURITY rules:
 * - Never returns actual env var values.
 * - Never returns secrets, tokens, keys, or DB passwords.
 * - Never writes to the database.
 * - Only reports whether required env vars are configured (boolean).
 */
export async function GET() {
  logInfo('health', 'GET /api/health')
  return NextResponse.json({
    ok:        true,
    app:       'sociomonkey-amazon-intelligence',
    runtime:   'nextjs',
    timestamp: new Date().toISOString(),
    env: {
      supabase_url_configured:          Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      supabase_anon_configured:         Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      supabase_service_configured:      Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      spapi_application_id_configured:  Boolean(process.env.SPAPI_APPLICATION_ID),
      spapi_lwa_client_id_configured:   Boolean(process.env.SPAPI_LWA_CLIENT_ID),
      spapi_lwa_secret_configured:      Boolean(process.env.SPAPI_LWA_CLIENT_SECRET),
      spapi_redirect_uri_configured:    Boolean(process.env.SPAPI_REDIRECT_URI),
    },
  })
}
