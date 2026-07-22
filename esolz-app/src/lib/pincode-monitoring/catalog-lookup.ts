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
 *
 * Final review round: the `amazon_connections` query's own `error` was
 * previously ignored -- a database/infrastructure failure fell through the
 * `!connection` branch and was reported as `connection_unavailable`
 * ("connect your Amazon account"), which is a false and unactionable
 * instruction when the real problem is a query failure. `connection_query_
 * failed` is now a distinct outcome. Likewise, `decryptToken`/
 * `refreshAccessToken` are now wrapped so a failure there (corrupted
 * ciphertext, revoked/expired refresh token, LWA outage) resolves to the
 * stable `token_refresh_failed` outcome instead of throwing out of this
 * function uncaught -- no raw Supabase error, decrypted token material, or
 * Amazon token-endpoint error body ever leaves this module.
 *
 * `resolveCatalogLookup` is the pure(-ish) core -- every dependency
 * (the connection query, decrypt, refresh, and catalog call) is injected as
 * a function rather than called directly -- for the same reason `other-
 * product-confirmation.ts` splits `confirmAsinsWithLookup` from
 * `confirmOtherProductAsins`: it lets `__tests__/catalog-lookup.test.ts`
 * exercise the full outcome-selection state machine (query failure vs. no
 * connection vs. token failure vs. each catalog outcome) with fake
 * dependencies, no real network/database call anywhere. `lookupAsin` is the
 * thin I/O wrapper that supplies the real ones.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getCatalogItemForAsin, type CatalogItemNormalized } from '@/lib/amazon/catalog'

const ENRICHMENT_TIMEOUT_MS = 10_000

export type CatalogLookupResult =
  | { outcome: 'connection_query_failed' }
  | { outcome: 'connection_unavailable' }
  | { outcome: 'token_refresh_failed' }
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

export interface CatalogConnectionRow {
  status: string
  refresh_token_encrypted: string | null
}

export interface CatalogLookupDeps {
  queryConnection: () => Promise<{ data: CatalogConnectionRow | null; error: unknown }>
  decryptToken: (encrypted: string) => string
  refreshAccessToken: (refreshToken: string) => Promise<{ access_token: string }>
  getCatalogItem: (args: { accessToken: string; marketplaceId: string; asin: string; signal: AbortSignal }) => Promise<CatalogItemNormalized>
}

export async function resolveCatalogLookup(deps: CatalogLookupDeps, marketplaceId: string, asin: string): Promise<CatalogLookupResult> {
  const { data: connection, error: connectionError } = await deps.queryConnection()

  // A query failure is an infrastructure fact, distinct from "no Amazon
  // connection exists" -- never presented to the seller as "connect your
  // account" (that instruction would be false and would not fix anything).
  if (connectionError) {
    return { outcome: 'connection_query_failed' }
  }
  if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
    return { outcome: 'connection_unavailable' }
  }

  let accessToken: string
  try {
    const token = await deps.refreshAccessToken(deps.decryptToken(connection.refresh_token_encrypted))
    accessToken = token.access_token
  } catch {
    // decryptToken/refreshAccessToken failures (corrupted ciphertext,
    // revoked/expired refresh token, LWA outage) must not escape as an
    // uncontrolled exception, and must not be reported as the unrelated
    // catalog-lookup "unavailable" outcome -- the token layer failed
    // before any catalog call was even attempted.
    return { outcome: 'token_refresh_failed' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENRICHMENT_TIMEOUT_MS)
  try {
    const item = await deps.getCatalogItem({ accessToken, marketplaceId, asin, signal: controller.signal })
    return { outcome: 'found', item }
  } catch (error) {
    return { outcome: classifyCatalogLookupError(error) }
  } finally {
    clearTimeout(timeout)
  }
}

export async function lookupAsin(workspaceId: string, marketplaceId: string, asin: string): Promise<CatalogLookupResult> {
  const admin = createAdminClient()
  return resolveCatalogLookup(
    {
      queryConnection: async () => {
        const { data, error } = await admin
          .from('amazon_connections')
          .select('status, refresh_token_encrypted')
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        return { data: data as CatalogConnectionRow | null, error }
      },
      decryptToken,
      refreshAccessToken,
      getCatalogItem: getCatalogItemForAsin,
    },
    marketplaceId,
    asin,
  )
}
