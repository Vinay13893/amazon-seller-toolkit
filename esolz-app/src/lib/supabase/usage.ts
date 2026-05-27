import { createClient } from '@/lib/supabase/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageCounter {
  workspace_id:        string
  period_start:        string
  period_end:          string
  asin_count:          number
  keyword_count:       number
  pincode_checks_used: number
  reports_generated:   number
  competitor_count:    number
}

// ─── Period helpers ───────────────────────────────────────────────────────────

export function currentPeriodStart(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

export function currentPeriodEnd(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
}

// ─── Core helper ─────────────────────────────────────────────────────────────

/**
 * Returns the usage_counters row for the current billing period.
 *
 * If no row exists (e.g. account created before the signup trigger was added,
 * or the trigger failed), it:
 *   1. Computes accurate counts directly from source tables.
 *   2. Returns the computed object immediately so UI renders with correct data.
 *   3. Calls POST /api/usage/init in the background to persist the row
 *      (admin client bypasses the missing INSERT RLS policy).
 */
export async function getOrCreateCurrentUsageCounter(
  workspaceId: string
): Promise<UsageCounter | null> {
  const supabase = createClient()
  const periodStart = currentPeriodStart()

  // ── 1. Try to fetch existing row ────────────────────────────────────────
  const { data: existing } = await supabase
    .from('usage_counters')
    .select(
      'workspace_id, period_start, period_end, asin_count, keyword_count, pincode_checks_used, reports_generated, competitor_count'
    )
    .eq('workspace_id', workspaceId)
    .gte('period_start', periodStart)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) return existing as UsageCounter

  // ── 2. Row missing — compute live counts from source tables ─────────────
  const [asinRes, kwRes, compRes] = await Promise.all([
    supabase
      .from('tracked_asins')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived'),

    supabase
      .from('tracked_keywords')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),

    supabase
      .from('competitor_asins')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
  ])

  const periodEnd = currentPeriodEnd()

  const computed: UsageCounter = {
    workspace_id:        workspaceId,
    period_start:        periodStart,
    period_end:          periodEnd,
    asin_count:          asinRes.count          ?? 0,
    keyword_count:       kwRes.count             ?? 0,
    pincode_checks_used: 0,
    reports_generated:   0,
    competitor_count:    compRes.count           ?? 0,
  }

  // ── 3. Persist via API route in background (admin client bypasses RLS) ──
  fetch('/api/usage/init', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(computed),
  }).catch(() => {
    // Non-critical: row will be re-created on next visit if this fails
  })

  // ── 4. Return computed values immediately so UI renders correctly ────────
  return computed
}

// ─── Increment helper (replaces direct client INSERT/UPDATE) ─────────────────

/**
 * Increments asin_count in the current period's usage_counters row.
 * Uses the API route so admin client handles the missing INSERT/UPDATE RLS.
 *
 * Call after successfully adding a tracked ASIN.
 */
export async function incrementAsinCounter(workspaceId: string): Promise<void> {
  const supabase = createClient()
  const periodStart = currentPeriodStart()

  // Read current row (may not exist)
  const { data: existing } = await supabase
    .from('usage_counters')
    .select('asin_count, keyword_count, pincode_checks_used, reports_generated, competitor_count, period_end')
    .eq('workspace_id', workspaceId)
    .gte('period_start', periodStart)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get accurate asin count from source of truth
  const { count: liveAsinCount } = await supabase
    .from('tracked_asins')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  const payload: UsageCounter = {
    workspace_id:        workspaceId,
    period_start:        periodStart,
    period_end:          existing?.period_end ?? currentPeriodEnd(),
    asin_count:          liveAsinCount        ?? (existing?.asin_count ?? 0) + 1,
    keyword_count:       existing?.keyword_count        ?? 0,
    pincode_checks_used: existing?.pincode_checks_used  ?? 0,
    reports_generated:   existing?.reports_generated    ?? 0,
    competitor_count:    existing?.competitor_count      ?? 0,
  }

  // Fire-and-forget: non-critical for the add-ASIN UX
  fetch('/api/usage/init', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(() => {})
}
