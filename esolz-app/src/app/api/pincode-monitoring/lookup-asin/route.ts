/**
 * POST /api/pincode-monitoring/lookup-asin
 *
 * PRODUCT_SPEC.md sec6/sec11: the Other Products ASIN resolve/preview path.
 * A real, SP-API-confirmed lookup only -- never a blind unverified ASIN,
 * never a Seller Central scrape, never a user cookie. Nothing is written to
 * `tracked_asins` or any Pincode table as a side effect of this route --
 * it is read-only preview, enrollment is a separate, explicit action via
 * `POST /api/pincode-monitoring/products`.
 */
import { NextRequest } from 'next/server'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { jsonError, jsonOk } from '@/lib/pincode-monitoring/responses'
import { normalizeAsin, isValidMarketplaceId, parseJsonBody } from '@/lib/pincode-monitoring/validation'
import { lookupAsin } from '@/lib/pincode-monitoring/catalog-lookup'

export const runtime = 'nodejs'

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  asin?: unknown
}

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId are required.')
  }
  const asin = normalizeAsin(body.asin)
  if (!asin) {
    return jsonError(400, 'invalid_parameters', 'A valid 10-character ASIN is required.')
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: false, // lookup/preview is read-only; enrollment (the write) is its own route
  })
  if (!access.ok) return access.response

  const result = await lookupAsin(access.context.workspaceId, access.context.marketplaceId, asin)

  switch (result.outcome) {
    case 'connection_query_failed':
      // Infrastructure/query failure -- distinct from "no connection
      // exists" (final review round): never tell the seller to connect an
      // account they may already have connected.
      return jsonError(500, 'catalog_connection_query_failed', 'Could not verify the Amazon connection right now — try again.')
    case 'connection_unavailable':
      return jsonError(503, 'catalog_connection_unavailable', 'Amazon connection required before looking up a product.')
    case 'token_refresh_failed':
      // Transient, distinct from both connection-fact cases above -- the
      // connection exists but the token could not be refreshed right now.
      return jsonError(502, 'catalog_token_refresh_failed', 'Could not refresh the Amazon connection right now — try again.')
    case 'not_found':
      // Honest, confirmed-nonexistent state -- PRODUCT_SPEC.md sec6: "if
      // Amazon cannot confirm the ASIN, do not enroll it as a valid
      // product." There is no override that skips this.
      return jsonError(404, 'catalog_not_found', 'Amazon could not confirm this ASIN — check the ASIN and try again.')
    case 'timeout':
      return jsonError(502, 'catalog_timeout', 'Lookup timed out — try again.')
    case 'unavailable':
      // Transient failure, distinct from the confirmed-not-found case above
      // (PRODUCT_SPEC.md sec6) -- retryable, still not enrollable.
      return jsonError(502, 'catalog_unavailable', 'Lookup failed — try again.')
    case 'found':
      return jsonOk({
        asin: result.item.asin,
        title: result.item.title,
        brand: result.item.brand,
        imageUrl: result.item.image_url,
        category: result.item.category,
      })
  }
}
