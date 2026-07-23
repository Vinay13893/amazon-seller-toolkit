/**
 * SKU Performance P1-B — row drill-down daily-series data-access.
 *
 * Thin real-I/O wrapper around `rpc.ts`'s `getSkuPerformanceDaily` — no
 * additional client-side computation (Correction 6): every day cell's
 * coverage state, value, and ACOS/TACOS are already fully resolved by the
 * RPC.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getSkuPerformanceDaily as callDailyRpc, type GetDailyArgs } from './rpc'
import type { SkuPerformanceDailyResult } from './types'

export async function fetchSkuPerformanceDaily(args: GetDailyArgs): Promise<SkuPerformanceDailyResult> {
  const admin = createAdminClient()
  return callDailyRpc(admin, args)
}
