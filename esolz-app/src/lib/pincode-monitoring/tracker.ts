/**
 * Pincode Monitoring P0-B — tracker read data-access.
 *
 * `deriveAvailabilityState`, `deriveProductTrackerState`, and
 * `deriveFreshnessState` are pure functions (no I/O), exercised directly by
 * `__tests__/tracker.test.ts` -- all three implement locked or documented
 * derivation rules (PRODUCT_SPEC.md sec7/sec8, and this round's freshness
 * model), not ad hoc guesses. Never fabricate: a missing/never-checked
 * target is `not_confirmed`/`never_checked`, never coerced into a negative
 * result (sec9's data-truth rules).
 *
 * Correction 4 (PR #55 review round): `fetchTrackerPage` previously fetched
 * EVERY historical `pincode_availability_results` row for a page's targets
 * and picked the latest client-side in TypeScript -- unbounded, and
 * silently wrong beyond PostgREST's default row cap (a target with >1000
 * result rows could have its "latest" picked from a truncated page, not
 * the real latest). Replaced with one call to `get_pincode_target_results`
 * (064 migration), a bounded, indexed, database-side read that returns
 * exactly two facts per target: the latest attempt of any kind, and the
 * last CONFIRMED (available/unavailable) result -- these are now surfaced
 * as two explicitly separate objects (`latestAttempt` /
 * `lastConfirmedAvailability`), never conflated. The prior `isLastConfirmed
 * Result: latest !== null` field is REMOVED -- it conflated "a result row
 * exists at all" with "that result was a confirmed availability reading,"
 * which is not the same fact (a `failed`/`blocked` latest attempt is a
 * result row too, but confirms nothing about availability).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getTargetResults } from './rpc'

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
 * Paused/Failed/Partially active are always computed here from CONFIGURED
 * child `pincode_tracking_targets.status` values only (Correction 2, PR
 * #55 review round: an unconfigured target is not part of "what the
 * seller is currently tracking" and must not skew this derivation --
 * callers pass only is_configured=true target statuses here).
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

export type FreshnessState = 'never_checked' | 'checking' | 'current' | 'overdue' | 'unscheduled'

/**
 * Correction 4 (PR #55 review round): a documented, truthful freshness
 * model -- `next_check_at IS NULL` is never rendered as "fresh," it is
 * `unscheduled` (a paused, failed, or unconfigured target has no next
 * check at all, which is a fact distinct from "was just checked and is
 * current"). `nowIso` is a parameter, not `new Date()` read internally, so
 * this function stays pure and deterministic for tests.
 *
 * Final review round: `nextCheckAt <= nowIso` was a raw ISO-string
 * comparison, not a chronological one -- it only agrees with epoch order
 * when both timestamps share the exact same textual form (e.g. both `Z`,
 * both millisecond-precision). Two valid, equal instants written with
 * different offsets (`...Z` vs `...+00:00`, or a non-zero offset like
 * `+05:30`) compare incorrectly as strings. Both timestamps are now parsed
 * to epoch milliseconds and compared numerically. A malformed/unparseable
 * timestamp on either side is never treated as "current" -- it falls back
 * to the conservative `unscheduled` state, the same state used for a
 * genuinely absent `next_check_at`.
 */
export function deriveFreshnessState(
  targetStatus: string,
  lastCheckedAt: string | null,
  nextCheckAt: string | null,
  nowIso: string,
): FreshnessState {
  if (targetStatus === 'checking') return 'checking'
  if (lastCheckedAt === null) return 'never_checked'
  if (nextCheckAt === null) return 'unscheduled'

  const nextCheckAtMs = Date.parse(nextCheckAt)
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nextCheckAtMs) || Number.isNaN(nowMs)) return 'unscheduled'

  return nextCheckAtMs <= nowMs ? 'overdue' : 'current'
}

export interface ConfirmedAvailability {
  availabilityStatus: 'available' | 'unavailable'
  checkedAt: string
  deliveryMessage: string | null
}

export interface TrackerTargetRow {
  id: string
  pincode: string
  status: string
  isConfigured: boolean
  unconfiguredAt: string | null
  lastCheckedAt: string | null
  nextCheckAt: string | null
  consecutiveFailures: number
  checkStatus: string | null
  availabilityStatus: string | null
  availabilityState: AvailabilityState
  errorCode: string | null
  errorMessage: string | null
  checkedAt: string | null
  deliveryMessage: string | null
  lastConfirmedAvailability: ConfirmedAvailability | null
  freshnessState: FreshnessState
  /** Denormalized from the parent product -- 'owned' (My Products) or 'other' (Other Products). No richer per-check provenance (e.g. manual vs. scheduled) is persisted anywhere in this schema today. */
  source: 'owned' | 'other'
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
  const nowIso = new Date().toISOString()

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
  const productSourceById = new Map<string, 'owned' | 'other'>((products ?? []).map(p => [p.id as string, p.product_source as 'owned' | 'other']))
  const targetsByProduct = new Map<string, TrackerTargetRow[]>()

  if (productIds.length > 0) {
    // Correction 2 (PR #55 review round): the tracker's normal list
    // includes only CONFIGURED targets -- an unconfigured one is not part
    // of what the seller is currently tracking. Its history is still
    // preserved in the database (never deleted), just not surfaced by
    // this default view.
    const { data: targets, error: targetsError } = await admin
      .from('pincode_tracking_targets')
      .select('id, monitored_product_id, pincode, status, is_configured, unconfigured_at, last_checked_at, next_check_at, consecutive_failures')
      .in('monitored_product_id', productIds)
      .eq('is_configured', true)
      .order('pincode', { ascending: true })

    if (targetsError) throw new Error(`tracker_targets_query_failed: ${targetsError.message}`)

    const targetIds = (targets ?? []).map(t => t.id as string)
    const resultsByTarget = new Map<string, {
      latest_check_status: string | null
      latest_availability_status: string | null
      latest_checked_at: string | null
      latest_delivery_message: string | null
      latest_error_code: string | null
      latest_error_message: string | null
      confirmed_availability_status: string | null
      confirmed_checked_at: string | null
      confirmed_delivery_message: string | null
    }>()

    if (targetIds.length > 0) {
      // Correction 4: bounded, database-side read -- never "fetch every
      // historical row, deduplicate client-side."
      const rows = await getTargetResults(admin, { workspaceId: args.workspaceId, targetIds }) as Array<{
        tracking_target_id: string
        latest_check_status: string | null
        latest_availability_status: string | null
        latest_checked_at: string | null
        latest_delivery_message: string | null
        latest_error_code: string | null
        latest_error_message: string | null
        confirmed_availability_status: string | null
        confirmed_checked_at: string | null
        confirmed_delivery_message: string | null
      }>
      for (const row of rows) {
        resultsByTarget.set(row.tracking_target_id, row)
      }
    }

    for (const t of targets ?? []) {
      const productId = t.monitored_product_id as string
      const result = resultsByTarget.get(t.id as string) ?? null
      const status = t.status as string
      const lastCheckedAt = (t.last_checked_at as string | null) ?? null
      const nextCheckAt = (t.next_check_at as string | null) ?? null

      const row: TrackerTargetRow = {
        id: t.id as string,
        pincode: t.pincode as string,
        status,
        isConfigured: t.is_configured as boolean,
        unconfiguredAt: (t.unconfigured_at as string | null) ?? null,
        lastCheckedAt,
        nextCheckAt,
        consecutiveFailures: t.consecutive_failures as number,
        checkStatus: result?.latest_check_status ?? null,
        availabilityStatus: result?.latest_availability_status ?? null,
        availabilityState: deriveAvailabilityState(result?.latest_check_status ?? null, result?.latest_availability_status ?? null),
        errorCode: result?.latest_error_code ?? null,
        errorMessage: result?.latest_error_message ?? null,
        checkedAt: result?.latest_checked_at ?? null,
        deliveryMessage: result?.latest_delivery_message ?? null,
        lastConfirmedAvailability: result?.confirmed_availability_status
          ? {
              availabilityStatus: result.confirmed_availability_status as 'available' | 'unavailable',
              checkedAt: result.confirmed_checked_at as string,
              deliveryMessage: result.confirmed_delivery_message,
            }
          : null,
        freshnessState: deriveFreshnessState(status, lastCheckedAt, nextCheckAt, nowIso),
        source: productSourceById.get(productId) ?? 'other',
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
