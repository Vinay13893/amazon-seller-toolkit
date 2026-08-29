import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { marketplaceFromMarketplaceId, marketplaceIdForMarketplace } from '@/lib/asins/product-separation'

export const runtime = 'nodejs'

/**
 * POST /api/keywords/track
 *
 * Saves a keyword to tracked_keywords for the user's workspace.
 *
 * Product-bound keywords should use stable source identity:
 * - targetType: 'my_product', sourceId: amazon_listing_items.id
 * - targetType: 'competitor_asin', sourceId: tracked_asins.id
 *
 * If targetType/sourceId are omitted, the keyword is saved as unassigned
 * research only and cannot be refreshed until attached to a product.
 *
 * Body: { keyword, marketplace?, targetType?, sourceId?, search_volume?, cpc_estimate?, difficulty? }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    keyword:        string
    marketplace?:   string
    targetType?:     'my_product' | 'competitor_asin'
    sourceId?:       string
    search_volume?: number | null
    cpc_estimate?:  number | null
    difficulty?:    number | null
  }
  if (!body.keyword?.trim()) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 })
  }

  // ── 2. Workspace ───────────────────────────────────────────────────────────
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    return NextResponse.json(
      { error: 'No workspace found' },
      { status: 404 },
    )
  }

  let marketplace = (body.marketplace ?? 'IN').toUpperCase().replace('AMAZON.', '')
  let amazonListingItemId: string | null = null
  let trackedAsinId: string | null = null

  if (body.targetType || body.sourceId) {
    if (
      (body.targetType !== 'my_product' && body.targetType !== 'competitor_asin')
      || !body.sourceId
    ) {
      return NextResponse.json({ error: 'Valid targetType and sourceId are required.' }, { status: 400 })
    }

    if (body.targetType === 'my_product') {
      const { data: listing, error: listingError } = await supabase
        .from('amazon_listing_items')
        .select('id, asin, marketplace_id')
        .eq('workspace_id', member.workspace_id)
        .eq('id', body.sourceId)
        .maybeSingle()

      if (listingError) {
        return NextResponse.json({ error: 'Failed to validate product ownership.' }, { status: 500 })
      }
      if (!listing?.id || !listing.asin || !listing.marketplace_id) {
        return NextResponse.json({ error: 'My Product not found in this workspace.' }, { status: 404 })
      }

      amazonListingItemId = listing.id as string
      trackedAsinId = null
      marketplace = marketplaceFromMarketplaceId(listing.marketplace_id as string)
    } else {
      const { data: tracked, error: trackedError } = await supabase
        .from('tracked_asins')
        .select('id, asin, marketplace, status')
        .eq('workspace_id', member.workspace_id)
        .eq('id', body.sourceId)
        .neq('status', 'archived')
        .maybeSingle()

      if (trackedError) {
        return NextResponse.json({ error: 'Failed to validate competitor ASIN.' }, { status: 500 })
      }
      if (!tracked?.id || !tracked.asin || !tracked.marketplace) {
        return NextResponse.json({ error: 'Competitor ASIN not found in this workspace.' }, { status: 404 })
      }

      const marketplaceId = marketplaceIdForMarketplace(tracked.marketplace as string)
      if (!marketplaceId) {
        return NextResponse.json({ error: 'Unsupported competitor marketplace.' }, { status: 400 })
      }

      const { data: ownListing, error: ownListingError } = await supabase
        .from('amazon_listing_items')
        .select('id')
        .eq('workspace_id', member.workspace_id)
        .eq('asin', (tracked.asin as string).toUpperCase())
        .eq('marketplace_id', marketplaceId)
        .limit(1)
        .maybeSingle()

      if (ownListingError) {
        return NextResponse.json({ error: 'Failed to validate product ownership.' }, { status: 500 })
      }
      if (ownListing?.id) {
        return NextResponse.json(
          { error: 'This ASIN belongs to My Products and cannot be tracked as a competitor.' },
          { status: 409 },
        )
      }

      amazonListingItemId = null
      trackedAsinId = tracked.id as string
      marketplace = (tracked.marketplace as string).toUpperCase()
    }
  }

  // ── 3. Check if already exists (to decide whether to increment keyword_count) ─
  let existingQuery = supabase
    .from('tracked_keywords')
    .select('id')
    .eq('workspace_id', member.workspace_id)
    .eq('keyword', body.keyword.trim())
    .eq('marketplace', marketplace)

  if (amazonListingItemId) {
    existingQuery = existingQuery
      .eq('amazon_listing_item_id', amazonListingItemId)
      .is('tracked_asin_id', null)
  } else if (trackedAsinId) {
    existingQuery = existingQuery
      .eq('tracked_asin_id', trackedAsinId)
      .is('amazon_listing_item_id', null)
  } else {
    existingQuery = existingQuery
      .is('tracked_asin_id', null)
      .is('amazon_listing_item_id', null)
  }

  const { data: existing } = await existingQuery.maybeSingle()

  // ── 4. Insert only when this unassigned keyword does not already exist ───
  const insertResult = existing
    ? { data: null, error: null }
    : await supabase
      .from('tracked_keywords')
      .insert({
        workspace_id:    member.workspace_id,
        keyword:         body.keyword.trim(),
        marketplace,
        search_volume:   body.search_volume  ?? null,
        cpc_estimate:    body.cpc_estimate   ?? null,
        difficulty:      body.difficulty     ?? null,
        amazon_listing_item_id: amazonListingItemId,
        tracked_asin_id: trackedAsinId,
      })
      .select()
      .single()
  const { data, error } = insertResult

  if (error) {
    console.error('[keywords.track.save_failed]')
    return NextResponse.json(
      { error: 'Failed to save keyword' },
      { status: 500 },
    )
  }

  const savedRow = data ?? existing

  // ── 5. Increment keyword_count only if this was a new keyword ─────────────
  if (!existing) {
    try {
      const admin = createAdminClient()
      const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
      const { data: counter } = await admin
        .from('usage_counters')
        .select('id, keyword_count')
        .eq('workspace_id', member.workspace_id)
        .gte('period_start', periodStart)
        .limit(1)
        .maybeSingle()
      if (counter) {
        await admin
          .from('usage_counters')
          .update({ keyword_count: counter.keyword_count + 1, updated_at: new Date().toISOString() })
          .eq('id', counter.id)
      }
    } catch {
      console.warn('[keywords.track.usage_increment_failed]')
    }
  }

  return NextResponse.json({ keyword: savedRow, isNew: !existing })
}
