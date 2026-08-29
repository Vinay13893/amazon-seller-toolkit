import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { marketplaceFromMarketplaceId, marketplaceIdForMarketplace } from '@/lib/asins/product-separation'

export const runtime = 'nodejs'

/**
 * POST /api/asins/[asin]/keywords/track
 *
 * Saves a keyword to tracked_keywords linked to the specified ASIN.
 * My Products bind to amazon_listing_items. Competitors bind to tracked_asins.
 * Duplicate prevention is scoped to the resolved product source + keyword + marketplace.
 * Body: { keyword, marketplace?, search_volume?, cpc_estimate?, difficulty? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ asin: string }> },
) {
  const { asin } = await params
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    keyword:        string
    marketplace?:   string
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

  // ── 3. Resolve product source ─────────────────────────────────────────────
  const marketplace = (body.marketplace ?? 'IN').toUpperCase().replace('AMAZON.', '')
  const marketplaceId = marketplaceIdForMarketplace(marketplace)
  if (!marketplaceId) {
    return NextResponse.json({ error: 'Unsupported marketplace.' }, { status: 400 })
  }

  const { data: listing, error: listingError } = await supabase
    .from('amazon_listing_items')
    .select('id, marketplace_id')
    .eq('workspace_id', member.workspace_id)
    .eq('asin', asin.toUpperCase())
    .eq('marketplace_id', marketplaceId)
    .limit(1)
    .maybeSingle()

  if (listingError) {
    return NextResponse.json({ error: 'Failed to validate product ownership.' }, { status: 500 })
  }

  const amazonListingItemId = listing?.id ? listing.id as string : null
  let trackedAsinId: string | null = null
  if (!amazonListingItemId) {
    const { data: tracked, error: trackedError } = await supabase
      .from('tracked_asins')
      .select('id, marketplace')
      .eq('workspace_id', member.workspace_id)
      .eq('asin', asin.toUpperCase())
      .eq('marketplace', marketplace)
      .neq('status', 'archived')
      .maybeSingle()

    if (trackedError) {
      return NextResponse.json({ error: 'Failed to validate competitor ASIN.' }, { status: 500 })
    }
    trackedAsinId = tracked?.id ? tracked.id as string : null
  }

  const resolvedMarketplace = listing?.marketplace_id
    ? marketplaceFromMarketplaceId(listing.marketplace_id as string)
    : marketplace

  if (!amazonListingItemId && !trackedAsinId) {
    return NextResponse.json(
      { error: `ASIN ${asin} is not available in My Products or tracked as a competitor in this workspace.` },
      { status: 404 },
    )
  }

  const normalizedKeyword = body.keyword.trim()

  // ── 4. Duplicate checks ───────────────────────────────────────────────────
  let existingQuery = supabase
    .from('tracked_keywords')
    .select('id')
    .eq('workspace_id', member.workspace_id)
    .eq('keyword', normalizedKeyword)
    .eq('marketplace', resolvedMarketplace)

  existingQuery = amazonListingItemId
    ? existingQuery
        .eq('amazon_listing_item_id', amazonListingItemId)
        .is('tracked_asin_id', null)
    : existingQuery
        .eq('tracked_asin_id', trackedAsinId)
        .is('amazon_listing_item_id', null)

  const { data: existingSameAsin } = await existingQuery.maybeSingle()

  if (existingSameAsin?.id) {
    return NextResponse.json({
      keyword: { id: existingSameAsin.id },
      isNew: false,
      message: 'Keyword already tracked for this ASIN.',
    })
  }

  // ── 5. Insert ─────────────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from('tracked_keywords')
    .insert({
      workspace_id:    member.workspace_id,
      amazon_listing_item_id: amazonListingItemId,
      tracked_asin_id: trackedAsinId,
      keyword:         normalizedKeyword,
      marketplace:     resolvedMarketplace,
      search_volume:   body.search_volume ?? null,
      cpc_estimate:    body.cpc_estimate  ?? null,
      difficulty:      body.difficulty    ?? null,
    })
    .select()
    .single()

  if (error) {
    console.error('[asin_keywords.track.save_failed]')
    return NextResponse.json(
      { error: 'Failed to save keyword' },
      { status: 500 },
    )
  }

  // ── 6. Increment keyword_count ─────────────────────────────────────────────
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
    console.warn('[asin_keywords.track.usage_increment_failed]')
  }

  return NextResponse.json({ keyword: data })
}
