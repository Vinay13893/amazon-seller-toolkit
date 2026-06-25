import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const VALID_STATUSES = ['Open', 'Reviewing', 'Done', 'Ignored']

type RequestBody = { actionKey?: unknown; status?: unknown; notes?: unknown }

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({})) as RequestBody
  const actionKey = typeof body.actionKey === 'string' ? body.actionKey.trim() : ''
  const status = typeof body.status === 'string' ? body.status : ''
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null

  if (!actionKey || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'actionKey and a valid status are required.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('internal_ads_brahmastra_action_reviews')
    .upsert({
      workspace_id: access.workspaceId,
      action_key: actionKey,
      status,
      notes,
      reviewed_by: access.userEmail,
      reviewed_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,action_key' })

  if (error) {
    return NextResponse.json({ error: 'Review status could not be saved. Confirm migration 040 is applied.' }, { status: 503 })
  }

  return NextResponse.json({ written: true })
}
