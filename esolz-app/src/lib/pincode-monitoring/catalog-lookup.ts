/**
 * Pincode Monitoring P0-B — Other Products ASIN lookup.
 *
 * PRODUCT_SPEC.md sec6: reuses `getCatalogItemForAsin` verbatim, the same
 * amazon_connections -> refreshAccessToken(decryptToken(...)) ->
 * AbortController-timeout pattern already used by `keywords/products/
 * route.ts`, `asins/jobs/process-next/route.ts`, `asins/[asin]/refresh/
 * route.ts` -- no new SP-API integration code. `ENRICHMENT_TIMEOUT_MS`
 * (10s) is copied from `keywords/products/route.ts:25`, the exact constant
 * PRODUCT_SPEC.md sec6 says to confirm and reuse rather than invent a new
 * one.
 *
 * Unlike those three existing call sites (which are background-enrichment
 * routes that swallow a lookup failure into a stored `metadata_status`
 * field and still return 200), this is a synchronous preview/lookup route
 * -- PRODUCT_SPEC.md sec6 requires an honest, distinguishable outcome the
 * caller can render immediately, so `lookupAsin` returns a typed result
 * variant instead of throwing, and the route (not this module) decides the
 * HTTP status per variant.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getCatalogItemForAsin, type CatalogItemNormalized } from '@/lib/amazon/catalog'

const ENRICHMENT_TIMEOUT_MS = 10_000

export type CatalogLookupResult =
  | { outcome: 'connection_unavailable' }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable' }
  | { outcome: 'timeout' }
  | { outcome: 'found'; item: CatalogItemNormalized }

/**
 * Pure classification of whatever `getCatalogItemForAsin` throws (see its
 * own doc comment: it always throws, never returns null) into one of the
 * three honest failure outcomes PRODUCT_SPEC.md sec6 requires be rendered
 * distinctly. Extracted as its own function so `__tests__/catalog-
 * lookup.test.ts` can assert this branch logic directly against real Error
 * objects, without mocking the network call itself.
 */
export function classifyCatalogLookupError(error: unknown): 'not_found' | 'timeout' | 'unavailable' {
  if (error instanceof Error && error.message === 'catalog_not_found') return 'not_found'
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  return 'unavailable'
}

export async function lookupAsin(workspaceId: string, marketplaceId: string, asin: string): Promise<CatalogLookupResult> {
  const admin = createAdminClient()

  const { data: connection } = await admin
    .from('amazon_connections')
    .select('status, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
    return { outcome: 'connection_unavailable' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENRICHMENT_TIMEOUT_MS)
  try {
    const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted as string))
    const item = await getCatalogItemForAsin({
      accessToken: token.access_token,
      marketplaceId,
      asin,
      signal: controller.signal,
    })
    return { outcome: 'found', item }
  } catch (error) {
    return { outcome: classifyCatalogLookupError(error) }
  } finally {
    clearTimeout(timeout)
  }
}
