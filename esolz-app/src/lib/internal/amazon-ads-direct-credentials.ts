// Phase 2C.1 fix: fallback support for a directly-configured Amazon Ads
// refresh-token credential set (client id/secret/refresh token/profile id),
// for workspaces that already have a working Ads API setup outside the
// in-app OAuth connect flow (e.g. a previously-issued refresh token). This
// module only ever reads env var NAMES/PRESENCE for reporting purposes and
// the literal values for building API requests — it never logs a value.
//
// Supports both the legacy short names (AMZN_ADS_*) and the newer in-app
// OAuth names (AMAZON_ADS_*) so an existing working credential set does not
// need to be renamed or re-entered.

export type DirectAdsCredentials = {
  clientId: string
  clientSecret: string
  refreshToken: string
  profileId: string
  region: string
  marketplace: string | null
}

const CREDENTIAL_ENV_PAIRS = {
  clientId: ['AMZN_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_ID'],
  clientSecret: ['AMZN_ADS_CLIENT_SECRET', 'AMAZON_ADS_CLIENT_SECRET'],
  refreshToken: ['AMZN_ADS_REFRESH_TOKEN', 'AMAZON_ADS_REFRESH_TOKEN'],
  profileId: ['AMZN_ADS_PROFILE_ID', 'AMAZON_ADS_PROFILE_ID'],
  region: ['AMZN_ADS_REGION', 'AMAZON_ADS_REGION'],
  marketplace: ['AMZN_ADS_MARKETPLACE', 'AMAZON_ADS_MARKETPLACE'],
} as const

function firstPresentEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return null
}

/** Names only (never values) of every direct-credential env var that is currently set. Safe to log/return in API responses. */
export function presentDirectAdsCredentialEnvNames(): string[] {
  const present: string[] = []
  for (const names of Object.values(CREDENTIAL_ENV_PAIRS)) {
    for (const name of names) {
      if (process.env[name] && process.env[name]!.trim()) present.push(name)
    }
  }
  return present
}

/**
 * Resolves a usable direct Ads credential set from env vars, or null if any
 * required field (client id/secret/refresh token/profile id) is missing.
 * Region defaults to 'eu' (matching the in-app OAuth connect default) and
 * marketplace has no default — it's descriptive only, not required by the
 * Reporting API calls.
 */
export function resolveDirectAdsCredentials(): DirectAdsCredentials | null {
  const clientId = firstPresentEnv(CREDENTIAL_ENV_PAIRS.clientId)
  const clientSecret = firstPresentEnv(CREDENTIAL_ENV_PAIRS.clientSecret)
  const refreshToken = firstPresentEnv(CREDENTIAL_ENV_PAIRS.refreshToken)
  const profileId = firstPresentEnv(CREDENTIAL_ENV_PAIRS.profileId)
  if (!clientId || !clientSecret || !refreshToken || !profileId) return null

  const region = firstPresentEnv(CREDENTIAL_ENV_PAIRS.region) ?? 'eu'
  const marketplace = firstPresentEnv(CREDENTIAL_ENV_PAIRS.marketplace)
  return { clientId, clientSecret, refreshToken, profileId, region, marketplace }
}
