/**
 * src/lib/amazon/buy-box-status.ts
 *
 * Pure decision logic for what to write to asin_snapshots.buy_box_status.
 * No Next.js/server-only dependencies -- safe to import from both the
 * process-next route handler and from plain test scripts (unlike the route
 * handler itself, which pulls in `server-only` transitively and cannot be
 * imported outside a Next.js build).
 */
import type { BuyBoxOfferStatus } from './pricing'

/**
 * What to write to asin_snapshots.buy_box_status for this check.
 *
 * offersBuyBoxStatus is undefined/null when the Pricing API call itself
 * never happened or never returned (rate-limited/skipped/unavailable) -- in
 * that case this returns null, never the string 'unknown'. A genuine
 * successful call that itself classified as 'unknown' (ambiguous winner) is
 * still stored as-is -- this only fixes the "no data at all" case, which
 * used to masquerade as if it were real (if ambiguous) data. See
 * BRAHMASTRA_MASTER_TRACKER.md sec19 for the bug this fixes: because the
 * read path coalesces the most recent NON-NULL value, writing a fake
 * 'unknown' string on every rate-limited check permanently hid any older
 * confirmed 'won'/'lost' snapshot. Writing null instead lets the read path
 * correctly skip these rows and keep surfacing the last real result.
 */
export function resolveBuyBoxStatusToStore(
  offersBuyBoxStatus: BuyBoxOfferStatus | null | undefined,
): BuyBoxOfferStatus | null {
  return offersBuyBoxStatus ?? null
}
