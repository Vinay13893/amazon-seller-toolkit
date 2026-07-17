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
 *
 * 2026-07-17 (later) review finding: even split out on its own, a purely
 * sequential upsert loop is itself close to the platform limit -- the first
 * natural run did 483 order upserts (and only 20 eligibility checks) before
 * the 280s kill, and a normal 3-day/100-150-orders-per-day window can still
 * be 300-450 orders. The PRIMARY fix here is bounded-concurrency upserts
 * (default 8 at once -- see processInBoundedChunks below), which makes a
 * normal window fast enough that the runtime guard below should rarely, if
 * ever, actually trip. The runtime guard exists only as a backstop, not as
 * the primary correctness mechanism -- this deliberately does NOT add a
 * persisted pagination cursor (which would let a stopped run resume exactly
 * where it left off next time): that is real added complexity/risk for a
 * problem bounded concurrency should already make rare, and per instruction
 * an unsafe partial-ingestion design is worse than reporting honestly when
 * (rarely) the guard does trip -- see paginationComplete/partialIngestionNote
 * below.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import { listOrders, type ListOrdersResult, type OrderSummary } from '@/lib/amazon/spapi-client'
import { upsertDiscoveredOrder } from './repository'
import { recordApiError } from './policy'

type AdminClient = ReturnType<typeof createAdminClient>

export const DEFAULT_ROLLING_OVERLAP_DAYS = 3
export const DEFAULT_INGEST_CONCURRENCY = 8
export const DEFAULT_INGESTION_RUNTIME_BUDGET_MS = 220_000
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
  concurrency: number
  runtimeBudgetMs: number
  maxPages?: number
}

export interface OrderIngestionReport {
  fetchWindowDays: number
  fetchWindowStart: string
  fetchWindowEnd: string
  ordersApiPagesFetched: number
  /** A page counts as completed only once every order it returned has been attempted (success or failure). */
  pagesCompleted: number
  /** True only if pagination reached a natural end (Amazon returned no further nextToken) without the runtime guard stopping early. */
  paginationComplete: boolean
  ordersFetched: number
  /** Orders actually attempted (upsertDiscoveredOrder called) to a resolved outcome -- inserted + updated + failed. May be less than ordersFetched if the runtime guard stopped mid-page. */
  ordersCompleted: number
  ordersInserted: number
  ordersUpdated: number
  /** One failed upsert never aborts the run -- it is caught, counted here, and processing continues. Never includes an order id. */
  ordersFailed: number
  duplicatesPrevented: number
  stoppedDueToRuntimeBudget: boolean
  /** Set only when paginationComplete is false -- a human-readable explanation of the partial-run risk, no PII. */
  partialIngestionNote: string | null
  amazonErrorsByCode: Record<string, number>
  durationMs: number
}

/**
 * Runs `fn` over `items` in fixed-size chunks of at most `concurrency` at a
 * time -- never a single unbounded Promise.all over the whole list. Each
 * chunk's items run concurrently via Promise.all, but the next chunk never
 * starts until the current one fully settles, so at most `concurrency`
 * upserts are ever in flight simultaneously. `fn` must not throw (catch and
 * count failures internally) -- this helper does not swallow rejections.
 */
async function processInBoundedChunks<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    await Promise.all(chunk.map(fn))
  }
}

export async function runOrderIngestion(
  deps: OrderIngestionDeps,
  params: OrderIngestionParams,
): Promise<OrderIngestionReport> {
  const { admin, listOrdersFn, nowFn } = deps
  const startedAt = nowFn().getTime()
  const budgetDeadline = startedAt + Math.max(params.runtimeBudgetMs, 0)
  const concurrency = Math.max(params.concurrency, 1)

  const overlapDays = Math.max(params.overlapDays, 1)
  const windowEnd = new Date(startedAt)
  const windowStart = new Date(startedAt - overlapDays * 24 * 60 * 60 * 1000)
  const createdAfter = windowStart.toISOString()

  const amazonErrorsByCode: Record<string, number> = {}

  let nextToken: string | undefined
  let pagesFetched = 0
  let pagesCompleted = 0
  let ordersFetched = 0
  let ordersCompleted = 0
  let ordersInserted = 0
  let ordersUpdated = 0
  let ordersFailed = 0
  let stoppedDueToRuntimeBudget = false
  let paginationComplete = false

  pageLoop: for (;;) {
    // Checked before fetching each new page -- never mid-page.
    if (nowFn().getTime() >= budgetDeadline) {
      stoppedDueToRuntimeBudget = true
      break
    }

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

    // Process this page's orders in bounded-concurrency chunks, checking
    // the budget before each chunk (never mid-chunk -- a chunk's orders
    // always finish together as a unit).
    let remaining: OrderSummary[] = page.orders
    while (remaining.length > 0) {
      if (nowFn().getTime() >= budgetDeadline) {
        stoppedDueToRuntimeBudget = true
        break pageLoop
      }
      const chunk = remaining.slice(0, concurrency)
      remaining = remaining.slice(concurrency)

      await processInBoundedChunks(chunk, concurrency, async order => {
        try {
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
        } catch {
          // One failed upsert must not abort the run or expose an order id --
          // counted only, never logged with identifying detail here.
          ordersFailed += 1
        } finally {
          ordersCompleted += 1
        }
      })
    }

    pagesCompleted += 1
    nextToken = page.nextToken ?? undefined
    if (!nextToken) {
      paginationComplete = true
      break
    }
    if (pagesFetched >= (params.maxPages ?? MAX_ORDERS_PAGES)) break
  }

  const partialIngestionNote = paginationComplete
    ? null
    : 'Ingestion stopped before reaching the end of this rolling window (runtime guard or an Amazon API error). ' +
      'Every daily run re-starts pagination from page 1 with a fresh rolling window rather than a persisted cursor, ' +
      'so if this recurs on consecutive days, later pages could be repeatedly under-served -- check ingestion ' +
      'latency, concurrency, or the runtime budget if paginationComplete stays false across multiple runs.'

  return {
    fetchWindowDays: overlapDays,
    fetchWindowStart: windowStart.toISOString(),
    fetchWindowEnd: windowEnd.toISOString(),
    ordersApiPagesFetched: pagesFetched,
    pagesCompleted,
    paginationComplete,
    ordersFetched,
    ordersCompleted,
    ordersInserted,
    ordersUpdated,
    ordersFailed,
    duplicatesPrevented: ordersUpdated,
    stoppedDueToRuntimeBudget,
    partialIngestionNote,
    amazonErrorsByCode,
    durationMs: nowFn().getTime() - startedAt,
  }
}
