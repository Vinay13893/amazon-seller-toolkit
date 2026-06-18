import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getCatalogItemForAsin } from '@/lib/amazon/catalog'
import {
  INTERNAL_TEST_ASIN_LIMIT,
  isInternalTestAccount,
} from '@/lib/internal-test-entitlement'

export const runtime = 'nodejs'
export const maxDuration = 60

const MARKETPLACE_IDS: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
}

const PRODUCT_HOSTS: Record<string, string> = {
  IN: 'www.amazon.in',
  US: 'www.amazon.com',
}

type RequestBody = {
  asin?: unknown
  marketplace?: unknown
  sourceType?: unknown
  title?: unknown
  brand?: unknown
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as RequestBody | null
  const asin = optionalText(body?.asin, 10)?.toUpperCase() ?? ''
  const marketplace = optionalText(body?.marketplace, 2)?.toUpperCase() ?? ''
  const sourceType = body?.sourceType === 'competitor' ? 'competitor' : 'external'
  const suppliedTitle = optionalText(body?.title, 500)
  const suppliedBrand = optionalText(body?.brand, 200)

  if (!/^[A-Z0-9]{10}$/.test(asin) || !MARKETPLACE_IDS[marketplace]) {
    return NextResponse.json({ error: 'Invalid ASIN or marketplace.' }, { status: 400 })
  }

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found.' }, { status: 404 })
  }

  const workspaceId = membership.workspace_id
  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('tracked_asins')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin)
    .eq('marketplace', marketplace)
    .neq('status', 'archived')
    .maybeSingle()

  if (existing?.id) {
    return NextResponse.json({ tracked: true, alreadyTracked: true })
  }

  let asinLimit = 5
  if (isInternalTestAccount(user.email)) {
    asinLimit = INTERNAL_TEST_ASIN_LIMIT
  } else {
    const { data: subscription } = await admin
      .from('workspace_subscriptions')
      .select('subscription_plans(asin_limit)')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const embeddedPlan = subscription?.subscription_plans
    const plan = Array.isArray(embeddedPlan) ? embeddedPlan[0] : embeddedPlan
    asinLimit = plan?.asin_limit ?? 5
  }

  const { count } = await admin
    .from('tracked_asins')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  if ((count ?? 0) >= asinLimit) {
    return NextResponse.json({ error: 'You have reached your ASIN limit for this plan.' }, { status: 403 })
  }

  let title = suppliedTitle
  let brand = suppliedBrand
  let imageUrl: string | null = null
  let category: string | null = null
  let metadataStatus: 'found' | 'not_found' | 'error' = suppliedTitle || suppliedBrand ? 'found' : 'not_found'
  let errorCode: string | null = null
  let errorMessage: string | null = null

  try {
    const { data: connection } = await admin
      .from('amazon_connections')
      .select('status, refresh_token_encrypted')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
      throw new Error('catalog_connection_unavailable')
    }

    const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted))
    const catalog = await getCatalogItemForAsin({
      accessToken: token.access_token,
      marketplaceId: MARKETPLACE_IDS[marketplace],
      asin,
    })

    title = catalog.title ?? title
    brand = catalog.brand ?? brand
    imageUrl = catalog.image_url
    category = catalog.category
    metadataStatus = title || brand || imageUrl ? 'found' : 'not_found'
  } catch {
    metadataStatus = title || brand ? 'found' : 'error'
    errorCode = 'catalog_unavailable'
    errorMessage = 'Product details are not available yet.'
  }

  const productUrl = `https://${PRODUCT_HOSTS[marketplace]}/dp/${asin}`
  const { data: tracked, error: trackedError } = await admin
    .from('tracked_asins')
    .insert({
      workspace_id: workspaceId,
      asin,
      marketplace,
      product_title: title,
      brand,
      category: category ?? (sourceType === 'competitor' ? 'Competitor ASIN' : 'External ASIN'),
      image_url: imageUrl,
      status: 'active',
    })
    .select('id')
    .single()

  if (trackedError || !tracked) {
    return NextResponse.json({ error: 'Unable to track this ASIN right now.' }, { status: 500 })
  }

  const { error: metadataError } = await admin
    .from('competitor_asins')
    .upsert({
      workspace_id: workspaceId,
      tracked_asin_id: tracked.id,
      competitor_asin: asin,
      product_title: title,
      brand,
      marketplace,
      category,
      image_url: imageUrl,
      product_url: productUrl,
      source_type: sourceType,
      metadata_status: metadataStatus,
      last_enriched_at: new Date().toISOString(),
      error_code: errorCode,
      error_message: errorMessage,
    }, {
      onConflict: 'workspace_id,competitor_asin,marketplace',
    })

  if (metadataError) {
    await admin.from('tracked_asins').delete().eq('id', tracked.id).eq('workspace_id', workspaceId)
    return NextResponse.json({ error: 'Unable to save product details right now.' }, { status: 500 })
  }

  return NextResponse.json({
    tracked: true,
    alreadyTracked: false,
    metadataStatus,
  })
}
