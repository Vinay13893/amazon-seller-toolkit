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
 * Resolves the single "selected" profile (the one the dashboards read from),
 * or a safe block reason. Report SYNC must not use this: it collapses several
 * enabled profiles down to one and blocks the whole workspace when none is
 * primary. Sync uses resolveBrahmastraSyncProfiles() below.
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

export type BrahmastraSyncProfilesSelection =
  | { ok: true; profileIds: string[] }
  | { ok: false; reason: 'no_profile_selected'; message: string }

/**
 * Resolves every profile report sync should cover: all profiles explicitly
 * opted in via brahmastra_sync_enabled (Settings -> Amazon Ads). It is still an
 * explicit opt-in list and never falls back to "every profile on the
 * connection", but unlike resolveBrahmastraProfile() it does not collapse
 * several enabled profiles to one, so enabling another brand no longer
 * silently starves it of data. The primary profile is synced first so it is
 * the one that completes if a run is cut short.
 */
export function resolveBrahmastraSyncProfiles(profiles: BrahmastraProfileCandidate[]): BrahmastraSyncProfilesSelection {
  const enabled = profiles.filter(p => p.brahmastraSyncEnabled)
  if (enabled.length === 0) {
    return { ok: false, reason: 'no_profile_selected', message: NO_PROFILE_SELECTED_MESSAGE }
  }
  const ordered = [...enabled].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  return { ok: true, profileIds: ordered.map(p => p.profileId) }
}
