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

export async function getWorkspaceId(): Promise<string | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  return data?.workspace_id ?? null
}

export async function getAsinLimit(workspaceId: string): Promise<number> {
  const supabase = createClient()
  const { data } = await supabase
    .from('workspace_subscriptions')
    .select('subscription_plans(asin_limit)')
    .eq('workspace_id', workspaceId)
    .single()

  const plan = normalizeEmbed<{ asin_limit: number }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any)?.subscription_plans
  )
  return plan?.asin_limit ?? 5
}

export async function getTrackedAsins(workspaceId: string): Promise<ProductSnapshot[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('tracked_asins')
    .select(`
      id, asin, marketplace, product_title, category, status, created_at,
      asin_snapshots(bsr, price, rating, review_count, buy_box_owner, availability_score, checked_at)
    `)
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })

  if (error || !data) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.map((row: any) => {
    const snapshots = ((row.asin_snapshots as any[]) || []).sort(
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

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) return null
  const workspaceId = member.workspace_id

  const [subResult, countResult] = await Promise.all([
    supabase
      .from('workspace_subscriptions')
      .select('subscription_plans(name, asin_limit)')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('tracked_asins')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived'),
  ])

  const plan = normalizeEmbed<{ name: string; asin_limit: number }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (subResult.data as any)?.subscription_plans
  )
  return {
    planName:  plan?.name       ?? 'Free',
    asinLimit: plan?.asin_limit ?? 5,
    asinCount: countResult.count ?? 0,
  }
}
