import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createClient } from '@/lib/supabase/server'
import { resolveSelectedProfileForWorkspace } from '@/lib/internal/brahmastra-selected-profile'

export const dynamic = 'force-dynamic'
const sources = [
  ['ads_campaign_daily', 'Sponsored Products'],
  ['ads_sd_campaign_daily', 'Sponsored Display'],
  ['ads_sb_campaign_daily', 'Sponsored Brands'],
  ['ads_advertised_product', 'Advertised products'],
  ['ads_targeting', 'Targets'],
  ['ads_search_term', 'Search terms'],
  ['business_report_sp_api', 'Sales & Traffic'],
  ['finance_transactions_sp_api', 'Finance transactions'],
] as const

export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const db = await createClient()
  const [profile, connection] = await Promise.all([
    resolveSelectedProfileForWorkspace(db, access.workspaceId),
    db.from('amazon_connections').select('marketplace_id').eq('workspace_id', access.workspaceId).eq('status', 'active').maybeSingle(),
  ])
  if (connection.error) return NextResponse.json({ error: 'Could not read Amazon connection status.' }, { status: 503 })
  try {
    const results = await Promise.all(sources.map(async ([source, label]) => {
      const ads = source.startsWith('ads_')
      if ((ads && !profile.ok) || (!ads && !connection.data?.marketplace_id)) {
        return { source, label, status: 'connection_required', dateThrough: null, finishedAt: null }
      }
      let query = db.from('internal_data_refresh_runs')
        .select('status,date_to,finished_at').eq('workspace_id', access.workspaceId!).eq('source', source)
      if (ads && profile.ok) query = query.eq('profile_id', profile.profileId)
      else query = query.eq('marketplace_id', connection.data!.marketplace_id)
      const latest = await query.order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle()
      if (latest.error) throw new Error('status unavailable')
      return {
        source, label, status: latest.data?.status ?? 'not_started',
        // This is last-run coverage, not a claim that every date in history is complete.
        dateThrough: latest.data?.status === 'success' ? latest.data.date_to : null,
        finishedAt: latest.data?.finished_at ?? null,
      }
    }))
    return NextResponse.json({ sources: results }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'Amazon sync status is temporarily unavailable.' }, { status: 503 })
  }
}
