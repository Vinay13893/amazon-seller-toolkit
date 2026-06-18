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

const ENRICHMENT_TIMEOUT_MS = 40_000

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

function isFakeExternalTitle(value: string | null): boolean {
  return /^external asin [a-z0-9]{10}$/i.test(value?.trim() ?? '')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('enrichment_timeout')), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as RequestBody | null
  const asin = optionalText(body?.asin, 10)?.toUpperCase() ?? ''
  const marketplace = optionalText(body?.marketplace, 2)?.toUpperCase() ?? ''
  const sourceType = body?.sourceType === 'competitor' ? 'competitor' : 'external'
  const suppliedTitleRaw = optionalText(body?.title, 500)
  const suppliedTitle = isFakeExternalTitle(suppliedTitleRaw) ? null : suppliedTitleRaw
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
  const { data: existingTracked } = await admin
    .from('tracked_asins')
    .select('id, product_title, brand, image_url')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin)
    .eq('marketplace', marketplace)
    .neq('status', 'archived')
    .maybeSingle()

  if (!existingTracked) {
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
  }

  let trackedId = existingTracked?.id as string | undefined
  if (!trackedId) {
    const { data: created, error } = await admin
      .from('tracked_asins')
      .insert({
        workspace_id: workspaceId,
        asin,
        marketplace,
        product_title: suppliedTitle,
        brand: suppliedBrand,
        category: sourceType === 'competitor' ? 'Competitor ASIN' : 'External ASIN',
        image_url: null,
        status: 'active',
      })
      .select('id')
      .single()

    if (error || !created) {
      return NextResponse.json({ error: 'Unable to track this ASIN right now.' }, { status: 500 })
    }
    trackedId = created.id
  }

  const productUrl = `https://${PRODUCT_HOSTS[marketplace]}/dp/${asin}`
  const pendingTitle = suppliedTitle
    ?? (isFakeExternalTitle(existingTracked?.product_title ?? null) ? null : existingTracked?.product_title)
    ?? null
  const pendingBrand = suppliedBrand ?? existingTracked?.brand ?? null
  const pendingImage = existingTracked?.image_url ?? null

  const { error: pendingError } = await admin
    .from('competitor_asins')
    .upsert({
      workspace_id: workspaceId,
      tracked_asin_id: trackedId,
      competitor_asin: asin,
      product_title: pendingTitle,
      brand: pendingBrand,
      marketplace,
      image_url: pendingImage,
      product_url: productUrl,
      source_type: sourceType,
      metadata_status: 'pending',
      last_enriched_at: null,
      error_code: null,
      error_message: null,
    }, {
      onConflict: 'workspace_id,competitor_asin,marketplace',
    })

  if (pendingError) {
    return NextResponse.json(
      { error: 'Product metadata schema is not ready.', errorCode: 'metadata_schema_unavailable' },
      { status: 503 },
    )
  }

  try {
    const { data: connection } = await admin
      .from('amazon_connections')
      .select('status, refresh_token_encrypted')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
      throw new Error('catalog_connection_unavailable')
    }

    const catalog = await withTimeout((async () => {
      const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted))
      return getCatalogItemForAsin({
        accessToken: token.access_token,
        marketplaceId: MARKETPLACE_IDS[marketplace],
        asin,
      })
    })(), ENRICHMENT_TIMEOUT_MS)
    const title = catalog.title ?? pendingTitle
    const brand = catalog.brand ?? pendingBrand
    const imageUrl = catalog.image_url ?? pendingImage
    const metadataStatus = title || brand || imageUrl ? 'found' : 'not_found'
    const checkedAt = new Date().toISOString()

    const [metadataUpdate, trackedUpdate] = await Promise.all([
      admin
        .from('competitor_asins')
        .update({
          product_title: title,
          brand,
          category: catalog.category,
          image_url: imageUrl,
          metadata_status: metadataStatus,
          last_enriched_at: checkedAt,
          error_code: null,
          error_message: null,
        })
        .eq('workspace_id', workspaceId)
        .eq('competitor_asin', asin)
        .eq('marketplace', marketplace),
      admin
        .from('tracked_asins')
        .update({
          product_title: title,
          brand,
          image_url: imageUrl,
          ...(catalog.category ? { category: catalog.category } : {}),
        })
        .eq('id', trackedId)
        .eq('workspace_id', workspaceId),
    ])
    if (metadataUpdate.error || trackedUpdate.error) {
      throw new Error('metadata_finalize_failed')
    }

    return NextResponse.json({
      tracked: true,
      alreadyTracked: Boolean(existingTracked),
      metadataStatus,
      product: { title, brand, imageUrl },
    })
  } catch {
    const checkedAt = new Date().toISOString()
    const { error: finalError } = await admin
      .from('competitor_asins')
      .update({
        metadata_status: 'error',
        last_enriched_at: checkedAt,
        error_code: 'catalog_unavailable',
        error_message: 'Product details are not available yet.',
      })
      .eq('workspace_id', workspaceId)
      .eq('competitor_asin', asin)
      .eq('marketplace', marketplace)

    if (finalError) {
      return NextResponse.json(
        {
          tracked: true,
          alreadyTracked: Boolean(existingTracked),
          metadataStatus: 'error',
          errorCode: 'metadata_finalize_failed',
          errorMessage: 'Product details are not available yet.',
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      tracked: true,
      alreadyTracked: Boolean(existingTracked),
      metadataStatus: 'error',
      errorCode: 'catalog_unavailable',
      errorMessage: 'Product details are not available yet.',
    })
  }
}
