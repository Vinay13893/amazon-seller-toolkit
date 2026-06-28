import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrahmastraProfile, type BrahmastraProfileSelection } from './brahmastra-ads-profile-selection'

/**
 * Reads amazon_ads_profiles for the workspace and resolves the single
 * profile Brahmastra is allowed to read/write Ads data for. Shared by every
 * write path (sync script, manual CSV import routes) and the dashboard read
 * path, so they can never disagree about which profile is "selected."
 */
export async function resolveSelectedProfileForWorkspace(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<BrahmastraProfileSelection> {
  const { data, error } = await admin
    .from('amazon_ads_profiles')
    .select('profile_id, brahmastra_sync_enabled, is_primary')
    .eq('workspace_id', workspaceId)

  if (error || !data) {
    return { ok: false, reason: 'no_profile_selected', message: 'BLOCKED: could not read Amazon Ads profile selection for Brahmastra.' }
  }

  return resolveBrahmastraProfile(data.map(row => ({
    profileId: row.profile_id as string,
    brahmastraSyncEnabled: row.brahmastra_sync_enabled as boolean,
    isPrimary: row.is_primary as boolean,
  })))
}
