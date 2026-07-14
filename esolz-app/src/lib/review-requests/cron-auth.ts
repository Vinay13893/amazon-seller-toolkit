/**
 * src/lib/review-requests/cron-auth.ts
 *
 * Pure bearer-token check for the review-requests daily cron entry point
 * (src/app/api/cron/review-requests/daily-run/route.ts). Deliberately has
 * no 'server-only' or Next.js import (unlike
 * src/lib/internal/background-worker-auth.ts) so it can be unit-tested
 * directly with a plain script -- mirrors the existing pattern of
 * extracting pure logic out of a route handler for testability (see
 * src/lib/amazon/buy-box-status.ts).
 */

export function isValidCronBearer(authHeader: string | null, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false
  return authHeader === `Bearer ${expectedSecret}`
}
