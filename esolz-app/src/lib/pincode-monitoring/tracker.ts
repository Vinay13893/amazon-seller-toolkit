/**
 * Pincode Monitoring P0-B — tracker read data-access.
 *
 * `deriveAvailabilityState` and `deriveProductTrackerState` are pure
 * functions (no I/O), exercised directly by `__tests__/tracker.test.ts` --
 * both implement locked derivation rules from PRODUCT_SPEC.md sec7/sec8,
 * not this PR's own invention. Never fabricate: a missing/never-checked
 * target is `not_confirmed`, never coerced to `unavailable` (sec9's
 * data-truth rules).
 *
 * `fetchTrackerPage` is the I/O half: one paginated `pincode_monitored_
 * products` query, then two follow-up `.in()` queries (targets for the
 * page's products, latest result per target) -- the same "fan-out by IDs
 * from page 1" pattern already used by `api/asins/listings/route.ts` for
 * attaching child data to a paginated parent list, not a new pattern.
 * `pincode_availability_results` has no per-target "latest" column, so
 * "latest per target" is resolved client-side after fetching every result
 * row for the page's target IDs ordered by `checked_at DESC` -- correct and
 * fine at this scale because the page size bounds the target-ID count, and
 * the query itself already leans on `pincode_availability_results_
 * tracking_target_idx (tracking_target_id, checked_at DESC)` (062
 * migration) to avoid a sort.
 */
import { createAdminClient } from '@/lib/supabase/admin'

export type AvailabilityState = 'available' | 'unavailable' | 'blocked' | 'check_failed' | 'not_confirmed'

/** PRODUCT_SPEC.md sec8's five-state vocabulary, derived from the two orthogonal columns DATA_MODEL.md sec4 defines -- never collapsed into a boolean, never inferred from a missing row as anything but not_confirmed. */
export function deriveAvailabilityState(checkStatus: string | null, availabilityStatus: string | null): AvailabilityState {
  if (checkStatus === 'blocked') return 'blocked'
  if (checkStatus === 'failed') return 'check_failed'
  if (checkStatus === 'success') {
    if (availabilityStatus === 'available') return 'available'
    if (availabilityStatus === 'unavailable') return 'unavailable'
    return 'not_confirmed' // availability_status = 'unknown', or an unexpected value -- never guessed
  }
  return 'not_confirmed' // check_status IS NULL -- never checked yet
}

export type ProductTrackerState = 'active' | 'paused' | 'partially_active' | 'failed' | 'archived' | 'removed'

/**
 * PRODUCT_SPEC.md sec7's derivation table, evaluated in the same priority
 * order the table documents. `pincode_monitored_products.status` itself
 * only ever holds active/archived/removed (round-4 Correction 13) --
 * Paused/Failed/Partially active are always computed here from child
 * `pincode_tracking_targets.status` values, never read from a stored
 * parent-level value.
 */
export function deriveProductTrackerState(
  parentStatus: 'active' | 'archived' | 'removed',
  targetStatuses: string[],
): ProductTrackerState {
  if (parentStatus === 'archived') return 'archived'
  if (parentStatus === 'removed') return 'removed'

  if (targetStatuses.every(s => s === 'active' || s === 'checking')) return 'active'

  const nonChecking = targetStatuses.filter(s => s !== 'checking')
  if (nonChecking.length > 0 && nonChecking.every(s => s === 'paused')) return 'paused'

  const nonPaused = targetStatuses.filter(s => s !== 'paused')
  if (nonPaused.length > 0 && nonPaused.every(s => s === 'failed')) return 'failed'

  return 'partially_active'
}

export interface TrackerTargetRow {
  id: string
  pincode: string
  status: string
  lastCheckedAt: string | null
  nextCheckAt: string | null
  consecutiveFailures: number
  availabilityState: AvailabilityState
  availabilityStatus: string | null
  deliveryMessage: string | null
  checkedAt: string | null
  isLastConfirmedResult: boolean
}

export interface TrackerProductRow {
  id: string
  asin: string
  productSource: 'owned' | 'other'
  titleSnapshot: string | null
  imageUrlSnapshot: string | null
  brandSnapshot: string | null
  trackerState: ProductTrackerState
  removedAt: string | null
  removalReason: string | null
  targets: TrackerTargetRow[]
}

export type TrackerView = 'active' | 'archived' | 'removed'

/** 'active' view maps to the lifecycle status 'active' -- callers derive Paused/Failed/Partially-active client-side from `trackerState` on each row, this is only the lifecycle-level filter (DATA_MODEL.md's parent status column has just three values). */
function lifecycleStatusForView(view: TrackerView): 'active' | 'archived' | 'removed' {
  return view
}

export async function fetchTrackerPage(args: {
  workspaceId: string
  marketplaceId: string
  view: TrackerView
  offset: number
  limit: number
}) {
  const admin = createAdminClient()

  const { data: products, count, error: productsError } = await admin
    .from('pincode_monitored_products')
    .select('id, asin, product_source, title_snapshot, image_url_snapshot, brand_snapshot, status, removed_at, removal_reason', { count: 'exact' })
    .eq('workspace_id', args.workspaceId)
    .eq('marketplace_id', args.marketplaceId)
    .eq('status', lifecycleStatusForView(args.view))
    .order('asin', { ascending: true })
    .range(args.offset, args.offset + args.limit - 1)

  if (productsError) throw new Error(`tracker_products_query_failed: ${productsError.message}`)

  const productIds = (products ?? []).map(p => p.id as string)
  const targetsByProduct = new Map<string, TrackerTargetRow[]>()

  if (productIds.length > 0) {
    const { data: targets, error: targetsError } = await admin
      .from('pincode_tracking_targets')
      .select('id, monitored_product_id, pincode, status, last_checked_at, next_check_at, consecutive_failures')
      .in('monitored_product_id', productIds)
      .order('pincode', { ascending: true })

    if (targetsError) throw new Error(`tracker_targets_query_failed: ${targetsError.message}`)

    const targetIds = (targets ?? []).map(t => t.id as string)
    const latestResultByTarget = new Map<string, { availability_status: string | null; check_status: string | null; delivery_message: string | null; checked_at: string }>()

    if (targetIds.length > 0) {
      const { data: results, error: resultsError } = await admin
        .from('pincode_availability_results')
        .select('tracking_target_id, availability_status, check_status, delivery_message, checked_at')
        .in('tracking_target_id', targetIds)
        .order('checked_at', { ascending: false })

      if (resultsError) throw new Error(`tracker_results_query_failed: ${resultsError.message}`)

      // Results are ordered newest-first, so the first row seen per
      // tracking_target_id is the latest -- never overwritten by an older
      // one (isLastConfirmedResult is always true for the row surfaced
      // here, by construction).
      for (const row of results ?? []) {
        const targetId = row.tracking_target_id as string
        if (!latestResultByTarget.has(targetId)) {
          latestResultByTarget.set(targetId, {
            availability_status: row.availability_status as string | null,
            check_status: row.check_status as string | null,
            delivery_message: row.delivery_message as string | null,
            checked_at: row.checked_at as string,
          })
        }
      }
    }

    for (const t of targets ?? []) {
      const productId = t.monitored_product_id as string
      const latest = latestResultByTarget.get(t.id as string) ?? null
      const row: TrackerTargetRow = {
        id: t.id as string,
        pincode: t.pincode as string,
        status: t.status as string,
        lastCheckedAt: (t.last_checked_at as string | null) ?? null,
        nextCheckAt: (t.next_check_at as string | null) ?? null,
        consecutiveFailures: t.consecutive_failures as number,
        availabilityState: deriveAvailabilityState(latest?.check_status ?? null, latest?.availability_status ?? null),
        availabilityStatus: latest?.availability_status ?? null,
        deliveryMessage: latest?.delivery_message ?? null,
        checkedAt: latest?.checked_at ?? null,
        isLastConfirmedResult: latest !== null,
      }
      if (!targetsByProduct.has(productId)) targetsByProduct.set(productId, [])
      targetsByProduct.get(productId)!.push(row)
    }
  }

  const rows: TrackerProductRow[] = (products ?? []).map(p => {
    const targets = targetsByProduct.get(p.id as string) ?? []
    return {
      id: p.id as string,
      asin: p.asin as string,
      productSource: p.product_source as 'owned' | 'other',
      titleSnapshot: (p.title_snapshot as string | null) ?? null,
      imageUrlSnapshot: (p.image_url_snapshot as string | null) ?? null,
      brandSnapshot: (p.brand_snapshot as string | null) ?? null,
      trackerState: deriveProductTrackerState(p.status as 'active' | 'archived' | 'removed', targets.map(t => t.status)),
      removedAt: (p.removed_at as string | null) ?? null,
      removalReason: (p.removal_reason as string | null) ?? null,
      targets,
    }
  })

  return {
    items: rows,
    total: count ?? 0,
    offset: args.offset,
    limit: args.limit,
    hasMore: args.offset + rows.length < (count ?? 0),
  }
}
