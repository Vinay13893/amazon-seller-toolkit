/**
 * src/lib/amazon/connection.ts
 *
 * Shared, read-only-safe helper for resolving a workspace's active Amazon
 * connection and refreshing its LWA access token.
 *
 * This mirrors the existing (independently duplicated) implementations in
 * src/app/api/asins/jobs/process-next/route.ts and
 * scripts/process-asin-checker-jobs.ts byte-for-byte in behavior. Those two
 * files are intentionally NOT refactored to use this helper as part of this
 * change (out of scope — do not touch ASIN checker code paths); this is a
 * new, third, canonical copy for new callers (starting with the review
 * automation permission probe) so future new work doesn't duplicate it a
 * fourth time.
 *
 * SECURITY: accessToken must NEVER be logged or returned to the frontend.
 * Server-only.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from './lwa'
import { decryptToken, encryptToken } from './crypto'

export interface WorkspaceConnection {
  accessToken: string
  marketplaceId: string | null
  sellingPartnerId: string | null
}

/**
 * Looks up the workspace's `amazon_connections` row, requires status
 * 'active' plus a stored refresh token, exchanges it for a fresh access
 * token via LWA, and best-effort persists the refreshed access token back
 * (a persistence failure is non-fatal — the caller still gets a usable
 * token for this call).
 *
 * Returns null if there is no active, usable connection, or if the token
 * refresh itself fails.
 */
export async function loadWorkspaceConnection(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<WorkspaceConnection | null> {
  const connection = await admin
    .from('amazon_connections')
    .select('id, status, marketplace_id, selling_partner_id, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (connection.error || !connection.data || connection.data.status !== 'active' || !connection.data.refresh_token_encrypted) {
    return null
  }

  try {
    const refreshToken = decryptToken(connection.data.refresh_token_encrypted)
    const tokenResult = await refreshAccessToken(refreshToken)

    try {
      await admin
        .from('amazon_connections')
        .update({
          access_token_encrypted: encryptToken(tokenResult.access_token),
          access_token_expires_at: new Date(Date.now() + tokenResult.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
    } catch {
      // Non-fatal: token refresh succeeded even if persisting it failed.
    }

    return {
      accessToken: tokenResult.access_token,
      marketplaceId: connection.data.marketplace_id,
      sellingPartnerId: connection.data.selling_partner_id,
    }
  } catch {
    return null
  }
}
