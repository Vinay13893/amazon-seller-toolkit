/**
 * Pincode Monitoring P0-B — workspace default-pincode data access.
 *
 * Correction 3 (PR #55 review round): `replaceActiveDefaults` previously
 * issued two separate PostgREST write requests (an insert-or-update-on-
 * conflict call, then a separate deactivate call) -- not atomic; a crash/
 * timeout between the two could leave
 * the active default set inconsistent with what the caller asked for.
 * Replacement is now exactly one call to `replace_workspace_default_
 * pincodes` (064 migration), a single-transaction, service-role-only RPC.
 * `fetchActiveDefaults` remains a plain read (no atomicity concern for a
 * SELECT) -- `workspace_default_pincodes` is not one of the six original
 * trusted RPCs' tables, so reads still go direct, only WRITES go through
 * the new RPC.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { replaceWorkspaceDefaultPincodes, PincodeRpcTransportError, type DefaultPincodeInput } from './rpc'
import type { ReplaceDefaultsRpcResult } from './responses'

export interface DefaultPincodeRow {
  id: string
  pincode: string
  displayOrder: number
  isActive: boolean
}

export async function fetchActiveDefaults(workspaceId: string, marketplaceId: string): Promise<DefaultPincodeRow[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('workspace_default_pincodes')
    .select('id, pincode, display_order, is_active')
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('is_active', true)
    .order('display_order', { ascending: true })

  if (error) throw new Error(`defaults_query_failed: ${error.message}`)

  return (data ?? []).map(row => ({
    id: row.id as string,
    pincode: row.pincode as string,
    displayOrder: row.display_order as number,
    isActive: row.is_active as boolean,
  }))
}

export type ReplaceDefaultsResult =
  | { ok: true; defaults: DefaultPincodeRow[] }
  | { ok: false; rpcResult: ReplaceDefaultsRpcResult }

/**
 * Atomically replaces the full active default-pincode list for (workspace,
 * marketplace) via one RPC call. Every pincode must already be regex-
 * validated by the caller (the route) -- the RPC re-validates defensively
 * (rejects the whole call, never a partial write) but is not the primary
 * validation surface for user-facing error messages.
 */
export async function replaceActiveDefaults(
  workspaceId: string,
  marketplaceId: string,
  pincodes: DefaultPincodeInput[],
): Promise<ReplaceDefaultsResult> {
  const admin = createAdminClient()

  let rpcResult: ReplaceDefaultsRpcResult
  try {
    rpcResult = await replaceWorkspaceDefaultPincodes(admin, { workspaceId, marketplaceId, pincodes }) as ReplaceDefaultsRpcResult
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      throw new Error(`defaults_replace_failed: ${error.message}`)
    }
    throw error
  }

  if (rpcResult.result === 'success') {
    return {
      ok: true,
      defaults: rpcResult.defaults.map(d => ({ id: d.id, pincode: d.pincode, displayOrder: d.displayOrder, isActive: true })),
    }
  }
  return { ok: false, rpcResult }
}
