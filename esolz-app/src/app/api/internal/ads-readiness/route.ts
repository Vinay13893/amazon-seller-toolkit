import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createClient } from '@/lib/supabase/server'
import { resolveSelectedProfileForWorkspace } from '@/lib/internal/brahmastra-selected-profile'
import { profileDay, reconciliationGate, RECONCILIATION_SOURCE, type EvidenceRun } from '@/lib/internal/ads-reconciliation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const supabase = await createClient()
  const selection = await resolveSelectedProfileForWorkspace(supabase, access.workspaceId)
  if (!selection.ok) return NextResponse.json({ error: 'Select an Ads profile first.' }, { status: 409 })
  const [profile, evidence] = await Promise.all([
    supabase.from('amazon_ads_profiles').select('timezone').eq('workspace_id', access.workspaceId).eq('profile_id', selection.profileId).single(),
    supabase.from('internal_data_refresh_runs').select('status,finished_at,report_options').eq('workspace_id', access.workspaceId).eq('profile_id', selection.profileId).eq('source', RECONCILIATION_SOURCE).order('started_at', { ascending: false }).order('id', { ascending: false }).limit(200),
  ])
  if (profile.error || evidence.error || !profile.data?.timezone) return NextResponse.json({ error: 'Reconciliation evidence is unavailable.' }, { status: 503 })
  try {
    return NextResponse.json(reconciliationGate(evidence.data as EvidenceRun[], profileDay(new Date(), profile.data.timezone), Date.now()), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'Ads timezone needs review.' }, { status: 503 })
  }
}
