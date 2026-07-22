/**
 * POST /api/pincode-monitoring/products
 *
 * PRODUCT_SPEC.md sec11: bulk-or-single enrollment, quota-checked,
 * all-or-nothing, via `enroll_pincode_monitored_products` -- never split
 * into per-product calls (that would defeat the RPC's own atomicity).
 *
 * Correction 1 (PR #55 review round): every distinct 'other'-source ASIN
 * is confirmed server-side via `confirmOtherProductAsins` BEFORE the RPC
 * ever runs -- the RPC itself has no SP-API access and cannot verify
 * anything, and a caller reaching this route directly (skipping a prior
 * lookup-asin call) must not be able to enroll a blind, unconfirmed ASIN.
 * Confirmed title/brand/image overwrite any client-supplied snapshot for
 * 'other'-source products -- a client-supplied snapshot is never trusted
 * for them (requirement 7).
 */
import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { getPincodeMonitoringConfig } from '@/lib/pincode-monitoring/config'
import { jsonError } from '@/lib/pincode-monitoring/responses'
import { mapEnrollResult, type EnrollRpcResult } from '@/lib/pincode-monitoring/responses'
import { enrollProducts, type EnrollProductInput, PincodeRpcTransportError } from '@/lib/pincode-monitoring/rpc'
import { confirmOtherProductAsins } from '@/lib/pincode-monitoring/other-product-confirmation'
import { isValidAsin, isValidMarketplaceId, isValidUuid, normalizePincodeList, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

// Request-shape ceilings -- mirror enroll_pincode_monitored_products' own
// hard ceilings (063 migration) so a malformed/abusive request gets a
// clean 400 from this route rather than an RPC round-trip only to be
// rejected there (Correction 7).
const MAX_PRODUCTS = 200
const MAX_PINCODES_PER_PRODUCT = 100
const MAX_TOTAL_COMBINATIONS = 2000
const MAX_SNAPSHOT_LEN = 500

interface RequestProduct {
  asin?: unknown
  productSource?: unknown
  amazonListingItemId?: unknown
  trackedAsinId?: unknown
  pincodes?: unknown
  titleSnapshot?: unknown
  imageUrlSnapshot?: unknown
  brandSnapshot?: unknown
}

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  products?: unknown
}

function toOptionalBoundedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.slice(0, maxLen)
}

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId) || !Array.isArray(body.products)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId, marketplaceId, and a non-empty products array are required.')
  }
  if (body.products.length === 0) {
    return jsonError(400, 'invalid_parameters', 'At least one product is required.')
  }
  if (body.products.length > MAX_PRODUCTS) {
    return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_PRODUCTS} products is supported per request.`)
  }

  const products: EnrollProductInput[] = []
  let totalCombinations = 0
  for (const raw of body.products as RequestProduct[]) {
    const asin = typeof raw?.asin === 'string' ? raw.asin.toUpperCase() : ''
    const productSource = raw?.productSource
    const pincodes = normalizePincodeList(raw?.pincodes)
    const listingId = toOptionalBoundedString(raw?.amazonListingItemId, 100)
    const trackedAsinId = toOptionalBoundedString(raw?.trackedAsinId, 100)

    if (!isValidAsin(asin) || (productSource !== 'owned' && productSource !== 'other') || !pincodes) {
      return jsonError(400, 'invalid_parameters', 'Each product requires a valid ASIN, productSource ("owned"|"other"), and a non-empty pincodes array.', { asin: raw?.asin })
    }
    if (pincodes.length > MAX_PINCODES_PER_PRODUCT) {
      return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_PINCODES_PER_PRODUCT} pincodes is supported per product.`, { asin })
    }
    if (listingId !== null && !isValidUuid(listingId)) {
      return jsonError(400, 'invalid_parameters', 'amazonListingItemId must be a valid UUID when provided.', { asin })
    }
    if (trackedAsinId !== null && !isValidUuid(trackedAsinId)) {
      return jsonError(400, 'invalid_parameters', 'trackedAsinId must be a valid UUID when provided.', { asin })
    }
    totalCombinations += pincodes.length

    products.push({
      asin,
      product_source: productSource,
      amazon_listing_item_id: listingId,
      tracked_asin_id: trackedAsinId,
      pincodes,
      title_snapshot: toOptionalBoundedString(raw?.titleSnapshot, MAX_SNAPSHOT_LEN),
      image_url_snapshot: toOptionalBoundedString(raw?.imageUrlSnapshot, MAX_SNAPSHOT_LEN),
      brand_snapshot: toOptionalBoundedString(raw?.brandSnapshot, MAX_SNAPSHOT_LEN),
    })
  }
  if (totalCombinations > MAX_TOTAL_COMBINATIONS) {
    return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_TOTAL_COMBINATIONS} total (product, pincode) combinations is supported per request.`)
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  // Correction 1: confirm every distinct 'other'-source ASIN server-side,
  // before the RPC ever runs. Never a partial enrollment of the remaining
  // products if any Other Product fails to confirm.
  const distinctOtherAsins = Array.from(new Set(products.filter(p => p.product_source === 'other').map(p => p.asin)))
  if (distinctOtherAsins.length > 0) {
    const confirmation = await confirmOtherProductAsins(access.context.workspaceId, access.context.marketplaceId, distinctOtherAsins)

    if (confirmation.outcome === 'connection_query_failed') {
      return jsonError(500, 'catalog_connection_query_failed', 'Could not verify the Amazon connection right now — try again.')
    }
    if (confirmation.outcome === 'connection_unavailable') {
      return jsonError(503, 'catalog_connection_unavailable', 'Amazon connection required before enrolling an Other Product.')
    }
    if (confirmation.outcome === 'rejected') {
      return jsonError(422, 'other_product_unconfirmed', 'One or more Other Products could not be confirmed by Amazon — no products were enrolled.', {
        failures: confirmation.failures,
      })
    }

    // Requirement 6/7: only Amazon-confirmed metadata is ever written for
    // an 'other'-source product -- overwrite whatever the client supplied.
    for (const product of products) {
      if (product.product_source !== 'other') continue
      const meta = confirmation.confirmed.get(product.asin)
      product.title_snapshot = meta?.title ?? null
      product.brand_snapshot = meta?.brand ?? null
      product.image_url_snapshot = meta?.imageUrl ?? null
    }
  }

  const config = getPincodeMonitoringConfig()
  const admin = createAdminClient()

  try {
    const rpcResult = await enrollProducts(admin, {
      workspaceId: access.context.workspaceId,
      marketplaceId: access.context.marketplaceId,
      products,
      quotaLimit: config.quotaPerWorkspaceMarketplace,
    })
    return mapEnrollResult(rpcResult as EnrollRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', 'Enrollment could not be processed right now.')
    }
    throw error
  }
}
