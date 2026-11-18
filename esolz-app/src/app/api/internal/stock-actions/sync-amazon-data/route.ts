import { NextResponse } from 'next/server'
import {
  advanceStockSyncJob,
  startStockSyncJob,
} from '@/lib/amazon/internal-stock-sync-runner'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 45

type RequestBody = {
  jobId?: unknown
  days?: unknown
}

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({})) as RequestBody
  const admin = createAdminClient()

  const { data: connection } = await admin
    .from('amazon_connections')
    .select('id, status, selling_partner_id, marketplace_id, refresh_token_encrypted')
    .eq('workspace_id', access.workspaceId)
    .maybeSingle()

  if (
    !connection
    || connection.status !== 'active'
    || !connection.selling_partner_id
    || !connection.refresh_token_encrypted
  ) {
    return NextResponse.json(
      { error: 'An active Amazon connection is required.' },
      { status: 409 },
    )
  }

  const params = {
    workspaceId: access.workspaceId,
    connection: {
      id: connection.id as string,
      selling_partner_id: connection.selling_partner_id as string,
      marketplace_id: (connection.marketplace_id as string | null) ?? null,
      refresh_token_encrypted: connection.refresh_token_encrypted as string,
    },
  }
  const outcome = typeof body.jobId !== 'string' || !body.jobId
    ? await startStockSyncJob(admin, { ...params, days: body.days })
    : await advanceStockSyncJob(admin, { ...params, jobId: body.jobId })

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  return NextResponse.json(outcome.body)
}
