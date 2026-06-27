// A single Amazon Ads OAuth connection can carry many advertiser profiles —
// one per seller/vendor account under the same Amazon login. Report sync
// must never default to "every profile returned by the connection": most of
// them belong to unrelated businesses sharing the same login. This module
// is the single place that decides which profile (if any) report sync is
// allowed to use, so the Settings UI and the sync script can never disagree
// about what "selected" means.

export type BrahmastraProfileCandidate = {
  profileId: string
  brahmastraSyncEnabled: boolean
  isPrimary: boolean
}

export type BrahmastraProfileSelection =
  | { ok: true; profileId: string }
  | { ok: false; reason: 'no_profile_selected' | 'multiple_enabled_no_primary'; message: string }

export const NO_PROFILE_SELECTED_MESSAGE = 'BLOCKED: no Amazon Ads profile selected for Brahmastra sync.'
export const MULTIPLE_ENABLED_NO_PRIMARY_MESSAGE = 'BLOCKED: multiple Ads profiles enabled; choose one primary profile.'

/**
 * Resolves exactly one profile to sync, or a safe block reason. Never
 * returns more than one profile — callers must not fall back to "sync all
 * enabled profiles" themselves.
 */
export function resolveBrahmastraProfile(profiles: BrahmastraProfileCandidate[]): BrahmastraProfileSelection {
  const enabled = profiles.filter(p => p.brahmastraSyncEnabled)

  if (enabled.length === 0) {
    return { ok: false, reason: 'no_profile_selected', message: NO_PROFILE_SELECTED_MESSAGE }
  }

  if (enabled.length === 1) {
    return { ok: true, profileId: enabled[0].profileId }
  }

  const primary = enabled.filter(p => p.isPrimary)
  if (primary.length === 1) {
    return { ok: true, profileId: primary[0].profileId }
  }

  return { ok: false, reason: 'multiple_enabled_no_primary', message: MULTIPLE_ENABLED_NO_PRIMARY_MESSAGE }
}
