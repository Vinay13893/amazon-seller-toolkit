import { createClient } from '@/lib/supabase/client'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { incrementAsinCounter } from '@/lib/supabase/usage'
import { ProductSnapshot, Marketplace } from '@/types'

// ── Shared input type (used by dialog + page) ─────────────────────────────
export interface AddAsinInput {
  asin:         string
  productTitle: string
  marketplace:  Marketplace
  brand:        string
  category:     string
  imageUrl:     string
}

function currencyForMarketplace(mp: string): string {
  if (mp === 'US') return 'USD'
  if (mp === 'UK') return 'GBP'
  if (mp === 'DE') return 'EUR'
  return 'INR'
}

function availabilityFromScore(score: number | null) {
  if (score === null) return null
  if (score >= 70) return 'in_stock' as const
  if (score >= 30) return 'limited' as const
  return 'out_of_stock' as const
}

type WorkspaceMemberRow = {
  workspace_id: string
  created_at: string | null
}

type WorkspaceSubscriptionRow = {
  workspace_id: string
  status: string | null
}

async function resolveWorkspaceIdForUser(userId: string): Promise<string | null> {
  const supabase = createClient()
  const { data: members } = await supabase
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  const memberRows = (members ?? []) as WorkspaceMemberRow[]
  if (memberRows.length === 0) return null

  const orderedWorkspaceIds = Array.from(new Set(memberRows.map(m => m.workspace_id).filter(Boolean)))
  if (orderedWorkspaceIds.length === 1) return orderedWorkspaceIds[0]

  const { data: subscriptions } = await supabase
    .from('workspace_subscriptions')
    .select('workspace_id, status')
    .in('workspace_id', orderedWorkspaceIds)

  const subByWorkspace = new Map<string, WorkspaceSubscriptionRow>()
  ;((subscriptions ?? []) as WorkspaceSubscriptionRow[]).forEach(sub => {
    if (sub.workspace_id) subByWorkspace.set(sub.workspace_id, sub)
  })

  const statusRank = (status: string | null): number => {
    if (status === 'active' || status === 'trialing') return 3
    if (status === 'past_due') return 2
    if (status === 'canceled' || status === 'inactive') return 1
    return 0
  }

  const sorted = [...orderedWorkspaceIds].sort((a, b) => {
    const rankDiff = statusRank(subByWorkspace.get(b)?.status ?? null) - statusRank(subByWorkspace.get(a)?.status ?? null)
    if (rankDiff !== 0) return rankDiff
    return orderedWorkspaceIds.indexOf(a) - orderedWorkspaceIds.indexOf(b)
  })

  return sorted[0] ?? null
}

export async function getWorkspaceId(): Promise<string | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return resolveWorkspaceIdForUser(user.id)
}

export async function getAsinLimit(workspaceId: string): Promise<number> {
  const entitlement = await getCurrentEntitlement(workspaceId)
  return entitlement.asinLimit
}

export interface CurrentEntitlement {
  planName: string
  asinLimit: number
  internalTest: boolean
}

export async function getCurrentEntitlement(workspaceId?: string): Promise<CurrentEntitlement> {
  try {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
    const response = await fetch(`/api/entitlements${query}`, {
      method: 'GET',
      cache: 'no-store',
    })
    if (response.ok) {
      return await response.json() as CurrentEntitlement
    }
  } catch {
    // Fall back to the standard Free entitlement.
  }

  return { planName: 'Free', asinLimit: 5, internalTest: false }
}

export async function getTrackedAsins(workspaceId: string): Promise<ProductSnapshot[]> {
  const supabase = createClient()
  const { data: asinRows, error: asinError } = await supabase
    .from('tracked_asins')
    .select('id, asin, marketplace, product_title, category, status, created_at')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })

  if (asinError || !asinRows) return []

  const trackedAsinIds = asinRows.map(row => row.id as string).filter(Boolean)

  type SnapshotWithStatus = {
    tracked_asin_id: string
    bsr: number | null
    price: number | null
    rating: number | null
    review_count: number | null
    buy_box_owner: string | null
    availability_score: number | null
    scrape_status: ProductSnapshot['scrape_status']
    checked_at: string
  }

  type SnapshotNoStatus = Omit<SnapshotWithStatus, 'scrape_status'>

  let snapshotsByAsinId = new Map<string, SnapshotWithStatus[]>()

  if (trackedAsinIds.length > 0) {
    const withStatus = await supabase
      .from('asin_snapshots')
      .select('tracked_asin_id, bsr, price, rating, review_count, buy_box_owner, availability_score, scrape_status, checked_at')
      .in('tracked_asin_id', trackedAsinIds)
      .order('checked_at', { ascending: false })

    const withoutStatus = withStatus.error?.code === '42703'
      ? await supabase
          .from('asin_snapshots')
          .select('tracked_asin_id, bsr, price, rating, review_count, buy_box_owner, availability_score, checked_at')
          .in('tracked_asin_id', trackedAsinIds)
          .order('checked_at', { ascending: false })
      : null

    const snapshots = (withoutStatus?.data ?? withStatus.data ?? []) as Array<SnapshotWithStatus | SnapshotNoStatus>

    for (const snapshot of snapshots) {
      const trackedAsinId = snapshot.tracked_asin_id
      if (!trackedAsinId) continue
      if (!snapshotsByAsinId.has(trackedAsinId)) snapshotsByAsinId.set(trackedAsinId, [])
      const scrapeStatusRaw = 'scrape_status' in snapshot ? snapshot.scrape_status : null
      const knownScrapeStatuses: Array<ProductSnapshot['scrape_status']> = [
        'success',
        'partial_success',
        'partial_pricing_rate_limited',
        'partial_pricing_unavailable',
        'partial_catalog_unavailable',
        'failed',
      ]
      const scrapeStatus: ProductSnapshot['scrape_status'] =
        knownScrapeStatuses.includes(scrapeStatusRaw) ? scrapeStatusRaw : null

      snapshotsByAsinId.get(trackedAsinId)?.push({
        ...snapshot,
        scrape_status: scrapeStatus,
      })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return asinRows.map((row: any) => {
    const snapshots = (snapshotsByAsinId.get(row.id) ?? []).sort(
      (a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime()
    )
    const latest = snapshots[0] ?? null
    const prev   = snapshots[1] ?? null

    return {
      id:                 row.id,
      asin:               row.asin,
      label:              row.product_title || row.asin,
      marketplace:        row.marketplace as Marketplace,
      is_active:          row.status === 'active',
      created_at:         row.created_at,
      bsr_rank:           latest?.bsr           ?? null,
      bsr_rank_prev:      prev?.bsr             ?? null,
      category:           row.category          ?? null,
      sub_rank:           null,
      sub_category:       null,
      price:              latest?.price != null  ? Number(latest.price)  : null,
      price_currency:     currencyForMarketplace(row.marketplace),
      rating:             latest?.rating != null ? Number(latest.rating) : null,
      review_count:       latest?.review_count  ?? null,
      buybox_winner:      latest?.buy_box_owner ?? null,
      buybox_is_self:     null,
      availability:       availabilityFromScore(latest?.availability_score ?? null),
      availability_score: latest?.availability_score ?? null,
      scrape_status:      latest?.scrape_status ?? null,
      captured_at:        latest?.checked_at    ?? null,
    } satisfies ProductSnapshot
  })
}

export async function addTrackedAsin(
  workspaceId: string,
  input: AddAsinInput,
): Promise<ProductSnapshot | null> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('tracked_asins')
    .insert({
      workspace_id:  workspaceId,
      asin:          input.asin.toUpperCase(),
      marketplace:   input.marketplace,
      product_title: input.productTitle,
      brand:         input.brand   || null,
      category:      input.category || null,
      image_url:     input.imageUrl || null,
      status:        'active',
    })
    .select('id, asin, marketplace, product_title, category, status, created_at')
    .single()

  if (error || !data) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any
  return {
    id:                 row.id,
    asin:               row.asin,
    label:              row.product_title || row.asin,
    marketplace:        row.marketplace as Marketplace,
    is_active:          true,
    created_at:         row.created_at,
    bsr_rank:           null,
    bsr_rank_prev:      null,
    category:           row.category ?? null,
    sub_rank:           null,
    sub_category:       null,
    price:              null,
    price_currency:     currencyForMarketplace(row.marketplace),
    rating:             null,
    review_count:       null,
    buybox_winner:      null,
    buybox_is_self:     null,
    availability:       null,
    availability_score: null,
    scrape_status:      null,
    captured_at:        null,
  }
}

/** Increment asin_count in usage_counters for the current calendar month. */
export async function incrementAsinUsage(workspaceId: string): Promise<void> {
  await incrementAsinCounter(workspaceId)
}

export async function archiveTrackedAsin(id: string, workspaceId: string): Promise<boolean> {
  const supabase = createClient()
  const { error } = await supabase
    .from('tracked_asins')
    .update({ status: 'archived' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  return !error
}

// ── ASIN detail (for [asin] page) ────────────────────────────────────────
export interface AsinSnapshotRow {
  id:                 string
  bsr:                number | null
  price:              number | null
  rating:             number | null
  review_count:       number | null
  buy_box_owner:      string | null
  buy_box_status:     string | null
  availability_score: number | null
  checked_at:         string
}

export interface AsinDetailRow {
  id:            string
  asin:          string
  marketplace:   string
  product_title: string | null
  brand:         string | null
  category:      string | null
  image_url:     string | null
  status:        string
  created_at:    string
  snapshots:     AsinSnapshotRow[]
}

export async function getAsinDetail(
  workspaceId: string,
  asin: string,
): Promise<AsinDetailRow | null> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('tracked_asins')
    .select(`
      id, asin, marketplace, product_title, brand, category, image_url, status, created_at,
      asin_snapshots(id, bsr, price, rating, review_count, buy_box_owner, buy_box_status, availability_score, checked_at)
    `)
    .eq('workspace_id', workspaceId)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  if (error || !data) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any
  const snapshots: AsinSnapshotRow[] = ((row.asin_snapshots as AsinSnapshotRow[]) || [])
    .sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime())

  return {
    id:            row.id,
    asin:          row.asin,
    marketplace:   row.marketplace,
    product_title: row.product_title ?? null,
    brand:         row.brand         ?? null,
    category:      row.category      ?? null,
    image_url:     row.image_url     ?? null,
    status:        row.status,
    created_at:    row.created_at,
    snapshots,
  }
}

// ── Plan usage for sidebar card ───────────────────────────────────────────
export interface PlanUsage {
  planName:  string
  asinLimit: number
  asinCount: number
}

export async function getPlanUsage(): Promise<PlanUsage | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const entitlement = await getCurrentEntitlement()
  const workspaceId = await resolveWorkspaceIdForUser(user.id)
  if (!workspaceId) {
    return {
      planName: entitlement.planName,
      asinLimit: entitlement.asinLimit,
      asinCount: 0,
    }
  }

  const countResult = await supabase
    .from('tracked_asins')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  return {
    planName:  entitlement.planName,
    asinLimit: entitlement.asinLimit,
    asinCount: countResult.count ?? 0,
  }
}
