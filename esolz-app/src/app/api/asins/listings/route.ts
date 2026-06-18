import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

function safeSearch(value: string | null): string {
  return (value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .slice(0, 100)
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const offset = Math.max(0, Number.parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0)
  const requestedLimit = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit || DEFAULT_PAGE_SIZE))
  const search = safeSearch(request.nextUrl.searchParams.get('q'))

  let query = supabase
    .from('amazon_listing_items')
    .select(
      'id, sku, asin, item_name, brand, product_type, status, marketplace_id, image_url, last_synced_at',
      { count: 'exact' },
    )
    .eq('workspace_id', membership.workspace_id)
    .order('item_name', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (search) {
    const term = `%${search}%`
    const marketplaceAliases: Record<string, string> = {
      IN: 'A21TJRUUN4KGV',
      INDIA: 'A21TJRUUN4KGV',
      US: 'ATVPDKIKX0DER',
      USA: 'ATVPDKIKX0DER',
      UK: 'A1F83G8C2ARO7P',
      DE: 'A1PA6795UKMFR9',
      GERMANY: 'A1PA6795UKMFR9',
    }
    const marketplaceId = marketplaceAliases[search.toUpperCase()]
    const filters = [
      `item_name.ilike.${term}`,
      `asin.ilike.${term}`,
      `sku.ilike.${term}`,
      `brand.ilike.${term}`,
      `marketplace_id.ilike.${term}`,
      ...(marketplaceId ? [`marketplace_id.eq.${marketplaceId}`] : []),
    ]
    query = query.or(filters.join(','))
  }

  const { data, count, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Unable to load Seller Central listings.' }, { status: 500 })
  }

  const { data: latestJob } = await supabase
    .from('amazon_sync_jobs')
    .select('status, started_at, finished_at, metadata')
    .eq('workspace_id', membership.workspace_id)
    .eq('job_type', 'listings_sync')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const metadata = (latestJob?.metadata ?? {}) as Record<string, unknown>
  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    offset,
    limit,
    hasMore: offset + (data?.length ?? 0) < (count ?? 0),
    sync: latestJob
      ? {
          status: latestJob.status,
          importedCount: Number(metadata.items_upserted ?? 0),
          hasMore: Boolean(metadata.has_more),
          lastSyncAt: latestJob.finished_at ?? latestJob.started_at,
        }
      : null,
  })
}
