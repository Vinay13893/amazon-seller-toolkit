import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createClient } from '@/lib/supabase/server'
import { buildBrahmastraDataHealth } from '@/lib/internal/brahmastra-data-health'

export const runtime = 'nodejs'

/** GET — read-only Sync Health snapshot for the workspace. No writes, no Amazon API calls. */
export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createClient()
  const health = await buildBrahmastraDataHealth(supabase, access.workspaceId)
  return NextResponse.json(health)
}
