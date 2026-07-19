/**
 * Pincode Monitoring P0-B — configuration.
 *
 * Every value here is env-var-driven and read fresh on every call (never
 * cached at module load) so a test can set `process.env` and observe the
 * change without a process restart — this module is exercised directly by
 * `__tests__/config.test.ts`.
 *
 * P0-A's DATA_MODEL.md sec2b/sec2c locked three config names and explicitly
 * left the numeric values as "a product/ops decision ... not invented in
 * this spec": PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE,
 * PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS,
 * PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE. The feature-flag/
 * workspace-allowlist env vars below (PINCODE_MONITORING_ENABLED,
 * PINCODE_MONITORING_ALLOWED_WORKSPACE_IDS) have no prior name locked
 * anywhere in the spec -- IMPLEMENTATION_PLAN.md sec6 only says "same shape
 * as PINCODE_ALERTS_PAUSED and the existing internal-test-account pattern,"
 * neither of which is actually workspace-ID-based (confirmed by reading
 * both: PINCODE_ALERTS_PAUSED is a hardcoded `true` constant in
 * generate-alerts.ts, not an env var; the internal-test-account pattern in
 * internal-test-entitlement.ts is an email allowlist, not a workspace-ID
 * one) -- these two names are this PR's own choice, introduced fresh, not a
 * reuse of an existing mechanism.
 *
 * All defaults below are deliberately conservative, for internal-workspace
 * testing only per IMPLEMENTATION_PLAN.md sec6's staged rollout -- they are
 * NOT commercial values and must be set explicitly via environment
 * variables before any real usage. PINCODE_MONITORING_ENABLED defaults to
 * disabled (fail closed) if unset or unparseable.
 */

const MAX_QUOTA_LIMIT = 100_000 // must stay <= enroll_pincode_monitored_products' own MAX_QUOTA_LIMIT (063 migration)
const MAX_MANUAL_PENDING_LIMIT = 10_000 // must stay <= queue_pincode_manual_check's own MAX_MANUAL_PENDING_LIMIT

const DEFAULT_QUOTA_PER_WORKSPACE_MARKETPLACE = 50
const DEFAULT_MANUAL_CHECK_COOLDOWN_SECONDS = 300
const DEFAULT_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE = 10

export interface PincodeMonitoringConfig {
  enabled: boolean
  allowedWorkspaceIds: Set<string>
  quotaPerWorkspaceMarketplace: number
  manualCheckCooldownSeconds: number
  manualMaxOutstandingPerWorkspaceMarketplace: number
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/** Positive-integer env var within (0, ceiling], falling back to a documented default on anything else (unset, non-numeric, non-positive, or over ceiling). */
function parseBoundedPositiveInt(value: string | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > ceiling) return fallback
  return parsed
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseAllowedWorkspaceIds(value: string | undefined): Set<string> {
  if (!value) return new Set()
  return new Set(
    value
      .split(',')
      .map(id => id.trim().toLowerCase())
      .filter(id => UUID_RE.test(id)),
  )
}

/** Reads and validates every Pincode Monitoring env var fresh — never cached, so tests and runtime config changes are both observed immediately. */
export function getPincodeMonitoringConfig(): PincodeMonitoringConfig {
  return {
    enabled: parseBoolean(process.env.PINCODE_MONITORING_ENABLED),
    allowedWorkspaceIds: parseAllowedWorkspaceIds(process.env.PINCODE_MONITORING_ALLOWED_WORKSPACE_IDS),
    quotaPerWorkspaceMarketplace: parseBoundedPositiveInt(
      process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE,
      DEFAULT_QUOTA_PER_WORKSPACE_MARKETPLACE,
      MAX_QUOTA_LIMIT,
    ),
    manualCheckCooldownSeconds: parseBoundedPositiveInt(
      process.env.PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS,
      DEFAULT_MANUAL_CHECK_COOLDOWN_SECONDS,
      3600, // queue_pincode_manual_check's own hard ceiling on p_cooldown_seconds
    ),
    manualMaxOutstandingPerWorkspaceMarketplace: parseBoundedPositiveInt(
      process.env.PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE,
      DEFAULT_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE,
      MAX_MANUAL_PENDING_LIMIT,
    ),
  }
}

/** Fails closed: an empty/unset allowlist means no workspace is allowlisted, never "every workspace passes." */
export function isWorkspaceAllowlisted(config: PincodeMonitoringConfig, workspaceId: string): boolean {
  return config.enabled && config.allowedWorkspaceIds.has(workspaceId.toLowerCase())
}
