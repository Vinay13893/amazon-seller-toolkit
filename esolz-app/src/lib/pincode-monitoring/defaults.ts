/**
 * Pincode Monitoring P0-B — workspace default-pincode data access.
 *
 * `workspace_default_pincodes` is not one of the six trusted RPCs (DATA_
 * MODEL.md sec2a/sec3a/sec3b only cover enrollment/pause-resume/removal of
 * MONITORED PRODUCTS) -- its own mutation path is "authenticated server
 * route -> role check -> service-role write" directly against the table
 * (DATA_MODEL.md sec6), same as every other server-role write in this
 * codebase. `is_active` is used for soft removal (never a hard DELETE),
 * matching the table's own documented design (DATA_MODEL.md sec1).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { PINCODE_RE } from './validation'

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

export interface ReplaceDefaultsInput {
  pincode: string
  displayOrder: number
}

/**
 * Replaces the full active default-pincode list for (workspace, marketplace)
 * in one call: upserts every pincode in `pincodes` as active with its given
 * display order, and deactivates (never deletes) any currently-active row
 * whose pincode is not in the new list. Every pincode must already be
 * regex-validated by the caller (the route) -- this function re-asserts the
 * invariant defensively (throws rather than silently upserting a malformed
 * row) but is not the primary validation point.
 */
export async function replaceActiveDefaults(
  workspaceId: string,
  marketplaceId: string,
  pincodes: ReplaceDefaultsInput[],
): Promise<DefaultPincodeRow[]> {
  const admin = createAdminClient()

  for (const p of pincodes) {
    if (!PINCODE_RE.test(p.pincode)) {
      throw new Error(`invalid_pincode_reached_data_access: ${p.pincode}`)
    }
  }

  if (pincodes.length > 0) {
    const { error: upsertError } = await admin
      .from('workspace_default_pincodes')
      .upsert(
        pincodes.map(p => ({
          workspace_id: workspaceId,
          marketplace_id: marketplaceId,
          pincode: p.pincode,
          display_order: p.displayOrder,
          is_active: true,
        })),
        { onConflict: 'workspace_id,marketplace_id,pincode' },
      )

    if (upsertError) throw new Error(`defaults_upsert_failed: ${upsertError.message}`)
  }

  const keepPincodes = pincodes.map(p => p.pincode)
  let deactivateQuery = admin
    .from('workspace_default_pincodes')
    .update({ is_active: false })
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('is_active', true)

  if (keepPincodes.length > 0) {
    deactivateQuery = deactivateQuery.not('pincode', 'in', `(${keepPincodes.join(',')})`)
  }

  const { error: deactivateError } = await deactivateQuery
  if (deactivateError) throw new Error(`defaults_deactivate_failed: ${deactivateError.message}`)

  return fetchActiveDefaults(workspaceId, marketplaceId)
}
