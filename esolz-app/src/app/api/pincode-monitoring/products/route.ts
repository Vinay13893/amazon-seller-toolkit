/**
 * POST /api/pincode-monitoring/products
 *
 * PRODUCT_SPEC.md sec11: bulk-or-single enrollment, quota-checked,
 * all-or-nothing, via `enroll_pincode_monitored_products` -- never split
 * into per-product calls (that would defeat the RPC's own atomicity).
 */
import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { getPincodeMonitoringConfig } from '@/lib/pincode-monitoring/config'
import { jsonError } from '@/lib/pincode-monitoring/responses'
import { mapEnrollResult, type EnrollRpcResult } from '@/lib/pincode-monitoring/responses'
import { enrollProducts, type EnrollProductInput, PincodeRpcTransportError } from '@/lib/pincode-monitoring/rpc'
import { isValidAsin, isValidMarketplaceId, isValidUuid, normalizePincodeList, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

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

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId) || !Array.isArray(body.products)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId, marketplaceId, and a non-empty products array are required.')
  }

  const products: EnrollProductInput[] = []
  for (const raw of body.products as RequestProduct[]) {
    const asin = typeof raw?.asin === 'string' ? raw.asin.toUpperCase() : ''
    const productSource = raw?.productSource
    const pincodes = normalizePincodeList(raw?.pincodes)
    const listingId = toOptionalString(raw?.amazonListingItemId)
    const trackedAsinId = toOptionalString(raw?.trackedAsinId)

    if (!isValidAsin(asin) || (productSource !== 'owned' && productSource !== 'other') || !pincodes) {
      return jsonError(400, 'invalid_parameters', 'Each product requires a valid ASIN, productSource ("owned"|"other"), and a non-empty pincodes array.', { asin: raw?.asin })
    }
    if (listingId !== null && !isValidUuid(listingId)) {
      return jsonError(400, 'invalid_parameters', 'amazonListingItemId must be a valid UUID when provided.', { asin })
    }
    if (trackedAsinId !== null && !isValidUuid(trackedAsinId)) {
      return jsonError(400, 'invalid_parameters', 'trackedAsinId must be a valid UUID when provided.', { asin })
    }

    products.push({
      asin,
      product_source: productSource,
      amazon_listing_item_id: listingId,
      tracked_asin_id: trackedAsinId,
      pincodes,
      title_snapshot: toOptionalString(raw?.titleSnapshot),
      image_url_snapshot: toOptionalString(raw?.imageUrlSnapshot),
      brand_snapshot: toOptionalString(raw?.brandSnapshot),
    })
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

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
