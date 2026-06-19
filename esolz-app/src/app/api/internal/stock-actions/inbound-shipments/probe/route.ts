import { NextResponse } from 'next/server'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { probeInboundShipmentsAccess } from '@/lib/amazon/spapi-client'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

type ErrorCategory =
  | 'no_connection'
  | 'token_refresh_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'spapi_error'
  | 'network_error'

type ProbeResponse = {
  ok: boolean
  permissionLikelyAvailable: boolean
  statusCode: number | null
  errorCategory?: ErrorCategory
  shipmentCount?: number
  message: string
}

function categoryForStatus(statusCode: number): ErrorCategory {
  if (statusCode === 401) return 'unauthorized'
  if (statusCode === 403) return 'forbidden'
  if (statusCode === 404) return 'not_found'
  if (statusCode === 429) return 'rate_limited'
  return 'spapi_error'
}

function messageForCategory(category: ErrorCategory): string {
  switch (category) {
    case 'no_connection':
      return 'No active Amazon connection is configured for this workspace.'
    case 'token_refresh_failed':
      return 'Amazon connection token could not be refreshed.'
    case 'unauthorized':
      return 'Amazon rejected the access token for this call.'
    case 'forbidden':
      return 'Amazon Fulfillment role may not be granted for this app authorization.'
    case 'not_found':
      return 'Inbound shipment endpoint or resource was not found.'
    case 'rate_limited':
      return 'Amazon rate-limited this call; result is inconclusive.'
    case 'spapi_error':
      return 'SP-API returned an error for this call.'
    case 'network_error':
      return 'The inbound shipment probe call failed unexpectedly.'
    default:
      return 'Unknown error.'
  }
}

export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const admin = createAdminClient()
  const { data: connection } = await admin
    .from('amazon_connections')
    .select('status, marketplace_id, refresh_token_encrypted')
    .eq('workspace_id', access.workspaceId)
    .maybeSingle()

  if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
    const category: ErrorCategory = 'no_connection'
    const body: ProbeResponse = {
      ok: false,
      permissionLikelyAvailable: false,
      statusCode: null,
      errorCategory: category,
      message: messageForCategory(category),
    }
    return NextResponse.json(body)
  }

  let accessToken: string
  try {
    const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted))
    accessToken = token.access_token
  } catch {
    const category: ErrorCategory = 'token_refresh_failed'
    const body: ProbeResponse = {
      ok: false,
      permissionLikelyAvailable: false,
      statusCode: null,
      errorCategory: category,
      message: messageForCategory(category),
    }
    return NextResponse.json(body)
  }

  const marketplaceId = connection.marketplace_id ?? 'A21TJRUUN4KGV'

  try {
    const result = await probeInboundShipmentsAccess(accessToken, { marketplaceId })

    if (result.ok) {
      const body: ProbeResponse = {
        ok: true,
        permissionLikelyAvailable: true,
        statusCode: result.statusCode,
        shipmentCount: result.shipmentCount ?? 0,
        message: 'Inbound shipment API responded successfully.',
      }
      return NextResponse.json(body)
    }

    const category = categoryForStatus(result.statusCode)
    const body: ProbeResponse = {
      ok: false,
      permissionLikelyAvailable: false,
      statusCode: result.statusCode,
      errorCategory: category,
      message: messageForCategory(category),
    }
    return NextResponse.json(body)
  } catch {
    const category: ErrorCategory = 'network_error'
    const body: ProbeResponse = {
      ok: false,
      permissionLikelyAvailable: false,
      statusCode: null,
      errorCategory: category,
      message: messageForCategory(category),
    }
    return NextResponse.json(body)
  }
}
