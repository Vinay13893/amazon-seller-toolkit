import 'server-only'

import { getInternalAccessContext } from '@/lib/internal-access'
import { createClient } from '@/lib/supabase/server'
import {
  canAccessStockIntelligence,
  EASYHOME_STOCK_WORKSPACE_ID,
} from './access-policy'

export type StockIntelligenceAccessContext = {
  authorized: boolean
  workspaceId: string | null
}

const DENIED: StockIntelligenceAccessContext = { authorized: false, workspaceId: null }

export async function getStockIntelligenceAccessContext(): Promise<StockIntelligenceAccessContext> {
  try {
    const internalAccess = await getInternalAccessContext()
    if (!internalAccess.authorized) return DENIED

    const supabase = await createClient()
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData.user) return DENIED

    const { data: membership, error: membershipError } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userData.user.id)
      .eq('workspace_id', EASYHOME_STOCK_WORKSPACE_ID)
      .limit(1)
      .maybeSingle()

    const authorized = canAccessStockIntelligence({
      authenticated: true,
      internalAuthorized: true,
      membershipWorkspaceId: membership?.workspace_id ?? null,
      lookupFailed: Boolean(membershipError),
    })

    return authorized
      ? { authorized: true, workspaceId: EASYHOME_STOCK_WORKSPACE_ID }
      : DENIED
  } catch {
    return DENIED
  }
}
