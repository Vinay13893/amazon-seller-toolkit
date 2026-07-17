/**
 * src/lib/review-requests/order-ingestion.ts
 *
 * Daily order-ingestion phase for the Amazon India EasyHOME Review Request
 * Automation (see REVIEW_REQUEST_AUTOMATION_SPEC.md and
 * BRAHMASTRA_MASTER_TRACKER.md sec18). Split out of the former combined
 * daily-run.ts after the 2026-07-17 production timeout finding: this phase
 * only discovers/upserts orders via a rolling overlap window -- it never
 * claims, checks eligibility, or sends. See ./eligibility-processor.ts for
 * the separate, bounded processing phase on its own schedule/budget.
 *
 * Fetches Amazon India shipped orders using a rolling overlap window
 * (default 3 days) so a failed/delayed run never has a gap --
 * upsertDiscoveredOrder() is idempotent by (workspace_id, marketplace_id,
 * amazon_order_id), so re-fetching the same order on every run for 3 days
 * never creates a duplicate row and never resets an order's solicitation
 * progress. Deliberately never attempts to process the resulting
 * eligibility backlog -- an unbounded combined ingest+process workflow is
 * exactly what caused the 280s production timeout this split fixes.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import { listOrders, type ListOrdersResult } from '@/lib/amazon/spapi-client'
import { upsertDiscoveredOrder } from './repository'
import { recordApiError } from './policy'

type AdminClient = ReturnType<typeof createAdminClient>

export const DEFAULT_ROLLING_OVERLAP_DAYS = 3
const ORDERS_PAGE_SIZE = 100
// Safety cap on pagination, same rationale as the former daily-run.ts /
// scripts/review-requests-catchup.ts: defensive ceiling, not an expected
// limit at ~100-150 orders/day.
const MAX_ORDERS_PAGES = 50

export interface OrderIngestionDeps {
  admin: AdminClient
  listOrdersFn: typeof listOrders
  nowFn: () => Date
}

export interface OrderIngestionParams {
  workspaceId: string
  marketplaceId: string
  accessToken: string
  overlapDays: number
  maxPages?: number
}

export interface OrderIngestionReport {
  fetchWindowDays: number
  fetchWindowStart: string
  fetchWindowEnd: string
  ordersApiPagesFetched: number
  ordersFetched: number
  ordersInserted: number
  ordersUpdated: number
  duplicatesPrevented: number
  amazonErrorsByCode: Record<string, number>
  durationMs: number
}

export async function runOrderIngestion(
  deps: OrderIngestionDeps,
  params: OrderIngestionParams,
): Promise<OrderIngestionReport> {
  const { admin, listOrdersFn, nowFn } = deps
  const startedAt = nowFn().getTime()

  const overlapDays = Math.max(params.overlapDays, 1)
  const windowEnd = new Date(startedAt)
  const windowStart = new Date(startedAt - overlapDays * 24 * 60 * 60 * 1000)
  const createdAfter = windowStart.toISOString()

  const amazonErrorsByCode: Record<string, number> = {}

  let nextToken: string | undefined
  let pagesFetched = 0
  let ordersFetched = 0
  let ordersInserted = 0
  let ordersUpdated = 0

  do {
    const page: ListOrdersResult = await listOrdersFn(params.accessToken, {
      marketplaceId: params.marketplaceId,
      createdAfter,
      maxResultsPerPage: ORDERS_PAGE_SIZE,
      nextToken,
    })
    pagesFetched += 1

    if (!page.ok) {
      recordApiError(amazonErrorsByCode, page.statusCode, page.amazonErrorCode)
      break
    }

    ordersFetched += page.orders.length
    for (const order of page.orders) {
      const result = await upsertDiscoveredOrder(admin, {
        workspaceId: params.workspaceId,
        marketplaceId: params.marketplaceId,
        amazonOrderId: order.amazonOrderId,
        orderStatus: order.orderStatus,
        purchaseDate: order.purchaseDate,
        amazonLastUpdatedAt: order.lastUpdateDate,
      }, nowFn().toISOString())
      if (result.inserted) ordersInserted += 1
      else ordersUpdated += 1
    }

    nextToken = page.nextToken ?? undefined
  } while (nextToken && pagesFetched < (params.maxPages ?? MAX_ORDERS_PAGES))

  return {
    fetchWindowDays: overlapDays,
    fetchWindowStart: windowStart.toISOString(),
    fetchWindowEnd: windowEnd.toISOString(),
    ordersApiPagesFetched: pagesFetched,
    ordersFetched,
    ordersInserted,
    ordersUpdated,
    duplicatesPrevented: ordersUpdated,
    amazonErrorsByCode,
    durationMs: nowFn().getTime() - startedAt,
  }
}
