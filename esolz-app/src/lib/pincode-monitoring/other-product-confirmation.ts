/**
 * Pincode Monitoring P0-B — Correction 1 (PR #55 review round).
 *
 * Server-side authoritative confirmation for every Other Product ASIN
 * before enrollment. `enroll_pincode_monitored_products` (063 migration)
 * assumes the caller already verified an 'other'-source ASIN is real — it
 * has no SP-API access of its own and cannot verify anything. The browser/
 * UI flow (a prior lookup-asin call before the user clicks "Track") is not
 * a security boundary: a caller can hit `POST /api/pincode-monitoring/
 * products` directly with any syntactically-valid ASIN and productSource:
 * 'other', skipping the lookup entirely. This module is what actually
 * closes that gap, called from the enroll route itself, not merely trusted
 * to have been called earlier.
 *
 * `confirmAsinsWithLookup` is the pure(-ish) core -- ASINs in, a lookup
 * FUNCTION injected rather than called directly -- deliberately separated
 * from `confirmOtherProductAsins`'s I/O (loading/decrypting the connection,
 * refreshing the token) for the same reason `access.ts` splits
 * `decidePincodeAccess` from `resolvePincodeAccess`: it lets
 * `__tests__/other-product-confirmation.test.ts` exercise the whole-batch-
 * rejection and bounded-concurrency behavior with a fake lookup function,
 * no real network/database call anywhere.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'
import { classifyCatalogLookupError } from './catalog-lookup'

const ENRICHMENT_TIMEOUT_MS = 10_000
export const LOOKUP_CONCURRENCY = 3

export interface ConfirmedProductMetadata {
  title: string | null
  brand: string | null
  imageUrl: string | null
}

export type AsinLookupOutcome =
  | { ok: true; metadata: ConfirmedProductMetadata }
  | { ok: false; reason: 'not_found' | 'timeout' | 'unavailable' }

export type OtherProductConfirmationResult =
  | { outcome: 'connection_query_failed' }
  | { outcome: 'connection_unavailable' }
  | { outcome: 'rejected'; failures: { asin: string; reason: 'not_found' | 'timeout' | 'unavailable' }[] }
  | { outcome: 'confirmed'; confirmed: Map<string, ConfirmedProductMetadata> }

/** Runs `fn` over `items` with at most `limit` in flight at once — no new dependency, just a small worker-pool loop. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  async function worker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * Requirement 5/7: rejects the ENTIRE bulk request (returns which ASINs
 * failed and why, never a partial list) if any ASIN is not found,
 * unavailable, or timed out. `lookupAsin` is injected so this core logic
 * (the whole-batch-rejection rule and the bounded-concurrency behavior)
 * can be tested against a fake, deterministic function.
 */
export async function confirmAsinsWithLookup(
  distinctAsins: string[],
  lookupAsin: (asin: string) => Promise<AsinLookupOutcome>,
  concurrencyLimit: number = LOOKUP_CONCURRENCY,
): Promise<Extract<OtherProductConfirmationResult, { outcome: 'rejected' | 'confirmed' }>> {
  const failures: { asin: string; reason: 'not_found' | 'timeout' | 'unavailable' }[] = []
  const confirmed = new Map<string, ConfirmedProductMetadata>()

  await mapWithConcurrency(distinctAsins, concurrencyLimit, async asin => {
    const outcome = await lookupAsin(asin)
    if (outcome.ok) {
      confirmed.set(asin, outcome.metadata)
    } else {
      failures.push({ asin, reason: outcome.reason })
    }
  })

  if (failures.length > 0) {
    return { outcome: 'rejected', failures }
  }
  return { outcome: 'confirmed', confirmed }
}

/**
 * Requirement 1-4/8: resolves every DISTINCT 'other'-source ASIN through
 * the approved Catalog Items helper, loading/refreshing the Amazon
 * connection token exactly once for the whole request (not once per ASIN).
 * Nothing is written to `tracked_asins` here or anywhere in this module
 * (requirement 8) — this is a read-only confirmation pass.
 */
export async function confirmOtherProductAsins(
  workspaceId: string,
  marketplaceId: string,
  distinctAsins: string[],
): Promise<OtherProductConfirmationResult> {
  if (distinctAsins.length === 0) {
    return { outcome: 'confirmed', confirmed: new Map() }
  }

  const admin = createAdminClient()

  const { data: connection, error: connectionError } = await admin
    .from('amazon_connections')
    .select('status, refresh_token_encrypted')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  // Requirement: a database/infrastructure error must never be presented
  // as "connect your Amazon account" — those are different facts with
  // different remediations.
  if (connectionError) {
    return { outcome: 'connection_query_failed' }
  }
  if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
    return { outcome: 'connection_unavailable' }
  }

  const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted as string))

  return confirmAsinsWithLookup(distinctAsins, async asin => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ENRICHMENT_TIMEOUT_MS)
    try {
      const item = await getCatalogItemForAsin({ accessToken: token.access_token, marketplaceId, asin, signal: controller.signal })
      return { ok: true, metadata: { title: item.title, brand: item.brand, imageUrl: item.image_url } }
    } catch (error) {
      return { ok: false, reason: classifyCatalogLookupError(error) }
    } finally {
      clearTimeout(timeout)
    }
  })
}
