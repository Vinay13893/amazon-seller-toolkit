import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const VALID_STATUSES = [
  'Not reviewed', 'Reviewing', 'Check listing first', 'Keep current bid',
  'Restore old bid manually', 'Partial bid correction manually',
  'Pause/negative review', 'Ignore', 'Done',
]

const VALID_EXPECTED_METRICS = ['sales', 'ACOS', 'spend', 'clicks', 'orders', 'conversion rate']

const CHECKLIST_FIELDS = [
  ['stockChecked', 'stock_checked'],
  ['buyBoxChecked', 'buy_box_checked'],
  ['couponChecked', 'coupon_checked'],
  ['priceChecked', 'price_checked'],
  ['reviewsChecked', 'reviews_checked'],
  ['deliveryPromiseChecked', 'delivery_promise_checked'],
  ['listingActiveChecked', 'listing_active_checked'],
  ['liveBidChecked', 'live_bid_checked'],
  ['liveStatusChecked', 'live_status_checked'],
  ['liveBudgetChecked', 'live_budget_checked'],
] as const

type RequestBody = {
  caseKey?: unknown
  status?: unknown
  owner?: unknown
  decision?: unknown
  reason?: unknown
  nextCheckDate?: unknown
  notes?: unknown
  decisionDate?: unknown
  expectedMetrics?: unknown
} & Partial<Record<typeof CHECKLIST_FIELDS[number][0], unknown>>

function toTextOrNull(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, maxLength)
  return trimmed ? trimmed : null
}

function toDateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function toBool(value: unknown): boolean {
  return value === true
}

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({})) as RequestBody
  const caseKey = typeof body.caseKey === 'string' ? body.caseKey.trim() : ''
  const status = typeof body.status === 'string' ? body.status : ''

  if (!caseKey || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'caseKey and a valid status are required.' }, { status: 400 })
  }

  // Only write fields the caller actually sent — both the Phase 1G (grouped
  // cases) and Phase 1H (execution sheet) UIs save to this same row, and
  // each only sends its own subset of fields. Omitting absent keys from the
  // upsert (rather than defaulting them to null/false) means a save from
  // one UI never clobbers fields only the other UI manages.
  const update: Record<string, unknown> = {
    workspace_id: access.workspaceId,
    case_key: caseKey,
    status,
    reviewed_by: access.userEmail,
    reviewed_at: new Date().toISOString(),
  }
  if ('owner' in body) update.owner = toTextOrNull(body.owner, 200)
  if ('decision' in body) update.decision = toTextOrNull(body.decision, 500)
  if ('reason' in body) update.reason = toTextOrNull(body.reason, 1000)
  if ('nextCheckDate' in body) update.next_check_date = toDateOrNull(body.nextCheckDate)
  if ('notes' in body) update.notes = toTextOrNull(body.notes, 2000)
  if ('decisionDate' in body) update.decision_date = toDateOrNull(body.decisionDate)
  if ('expectedMetrics' in body) {
    update.expected_metrics = Array.isArray(body.expectedMetrics)
      ? body.expectedMetrics.filter((m): m is string => typeof m === 'string' && VALID_EXPECTED_METRICS.includes(m))
      : []
  }
  for (const [camel, snake] of CHECKLIST_FIELDS) {
    if (camel in body) update[snake] = toBool(body[camel])
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('internal_ads_review_case_reviews')
    .upsert(update, { onConflict: 'workspace_id,case_key' })

  if (error) {
    return NextResponse.json({ error: 'Review case status could not be saved. Confirm migrations 043 and 044 are applied.' }, { status: 503 })
  }

  return NextResponse.json({ written: true })
}
