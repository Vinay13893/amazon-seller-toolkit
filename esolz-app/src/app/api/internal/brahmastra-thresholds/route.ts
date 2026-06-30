import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createClient } from '@/lib/supabase/server'
import { SYSTEM_DEFAULT_THRESHOLDS, BRAHMASTRA_PORTFOLIOS, mergeWithSystemDefaults, type ThresholdValues } from '@/lib/internal/brahmastra-thresholds'

type DbRow = Partial<ThresholdValues> & { portfolio: string; is_active?: boolean; updated_at?: string }

function toNumbers(row: Record<string, unknown> & { portfolio: string; is_active?: boolean; updated_at?: string }): DbRow {
  const numFields: Array<keyof ThresholdValues> = [
    'waste_spend_min', 'waste_roas_max', 'min_clicks_for_waste',
    'high_acos_pct', 'high_acos_spend_min',
    'high_spend_low_roas_spend_min', 'high_spend_low_roas_max',
    'protect_roas_min', 'protect_acos_max', 'protect_spend_min',
    'high_tacos_pct', 'high_tacos_min_ordered_sales',
    'refund_rate_min_pct', 'refund_min_amount',
    'good_roas_min', 'good_acos_max',
  ]
  const out: DbRow = { portfolio: row.portfolio, is_active: row.is_active, updated_at: row.updated_at }
  for (const f of numFields) {
    const v = row[f]
    if (v != null) out[f] = Number(v)
  }
  return out
}

/** GET — return all threshold rows for the workspace, with system-default fill for missing portfolios. */
export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createClient()
  let dbRows: DbRow[] = []
  try {
    const { data } = await supabase
      .from('internal_brahmastra_thresholds')
      .select('portfolio, waste_spend_min, waste_roas_max, min_clicks_for_waste, high_acos_pct, high_acos_spend_min, high_spend_low_roas_spend_min, high_spend_low_roas_max, protect_roas_min, protect_acos_max, protect_spend_min, high_tacos_pct, high_tacos_min_ordered_sales, refund_rate_min_pct, refund_min_amount, good_roas_min, good_acos_max, is_active, updated_at')
      .eq('workspace_id', access.workspaceId)
    if (data) dbRows = data.map(r => toNumbers(r as Record<string, unknown> & { portfolio: string }))
  } catch {
    // Table not yet migrated — return system defaults
  }

  const byPortfolio = new Map(dbRows.map(r => [r.portfolio, r]))
  const thresholds = BRAHMASTRA_PORTFOLIOS.map(portfolio => {
    const saved = byPortfolio.get(portfolio)
    const values = mergeWithSystemDefaults(saved)
    return {
      portfolio,
      ...values,
      is_active: saved?.is_active ?? true,
      updated_at: saved?.updated_at ?? null,
      source: saved ? 'saved' as const : 'system_default' as const,
    }
  })

  return NextResponse.json({ thresholds, systemDefaults: SYSTEM_DEFAULT_THRESHOLDS })
}

/** POST — upsert threshold row for one portfolio. */
export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const portfolio = body.portfolio
  if (typeof portfolio !== 'string' || !portfolio) {
    return NextResponse.json({ error: 'portfolio field required.' }, { status: 400 })
  }

  const numFields: Array<keyof ThresholdValues> = [
    'waste_spend_min', 'waste_roas_max', 'min_clicks_for_waste',
    'high_acos_pct', 'high_acos_spend_min',
    'high_spend_low_roas_spend_min', 'high_spend_low_roas_max',
    'protect_roas_min', 'protect_acos_max', 'protect_spend_min',
    'high_tacos_pct', 'high_tacos_min_ordered_sales',
    'refund_rate_min_pct', 'refund_min_amount',
    'good_roas_min', 'good_acos_max',
  ]

  const upsertData: Record<string, unknown> = {
    workspace_id: access.workspaceId,
    portfolio,
    is_active: body.is_active ?? true,
  }
  for (const f of numFields) {
    if (body[f] !== undefined && body[f] !== null) {
      const v = Number(body[f])
      if (!isNaN(v)) upsertData[f] = v
    }
  }

  const supabase = await createClient()
  const { error: upsertError } = await supabase
    .from('internal_brahmastra_thresholds')
    .upsert(upsertData, { onConflict: 'workspace_id,portfolio' })

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, portfolio })
}
