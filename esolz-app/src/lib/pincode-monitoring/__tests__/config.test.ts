import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getPincodeMonitoringConfig, isWorkspaceAllowlisted } from '../config'

const ENV_KEYS = [
  'PINCODE_MONITORING_ENABLED',
  'PINCODE_MONITORING_ALLOWED_WORKSPACE_IDS',
  'PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE',
  'PINCODE_MANUAL_CHECK_COOLDOWN_SECONDS',
  'PINCODE_MANUAL_MAX_OUTSTANDING_PER_WORKSPACE_MARKETPLACE',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('getPincodeMonitoringConfig', () => {
  test('defaults to disabled (fails closed) when PINCODE_MONITORING_ENABLED is unset', () => {
    assert.equal(getPincodeMonitoringConfig().enabled, false)
  })

  test('enables only on the exact string "true"', () => {
    process.env.PINCODE_MONITORING_ENABLED = 'TRUE'
    assert.equal(getPincodeMonitoringConfig().enabled, true)
    process.env.PINCODE_MONITORING_ENABLED = 'yes'
    assert.equal(getPincodeMonitoringConfig().enabled, false)
  })

  test('parses a comma-separated allowlist, lowercased, invalid entries dropped', () => {
    process.env.PINCODE_MONITORING_ALLOWED_WORKSPACE_IDS =
      'A0000000-0000-0000-0000-000000000001, b0000000-0000-0000-0000-000000000002 ,not-a-uuid'
    const config = getPincodeMonitoringConfig()
    assert.equal(config.allowedWorkspaceIds.size, 2)
    assert.equal(config.allowedWorkspaceIds.has('a0000000-0000-0000-0000-000000000001'), true)
    assert.equal(config.allowedWorkspaceIds.has('b0000000-0000-0000-0000-000000000002'), true)
  })

  test('falls back to the documented default when the quota env var is unset', () => {
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 50)
  })

  test('falls back to the default when the quota env var is non-numeric', () => {
    process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE = 'not-a-number'
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 50)
  })

  test('falls back to the default when the quota env var is zero or negative', () => {
    process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE = '0'
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 50)
    process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE = '-5'
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 50)
  })

  test('falls back to the default when the quota env var exceeds the hard ceiling (never an effectively unlimited quota from a malformed env value)', () => {
    process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE = '999999999'
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 50)
  })

  test('accepts a valid in-range quota override', () => {
    process.env.PINCODE_TRACKING_QUOTA_PER_WORKSPACE_MARKETPLACE = '250'
    assert.equal(getPincodeMonitoringConfig().quotaPerWorkspaceMarketplace, 250)
  })

  test('manual cooldown and outstanding-limit defaults are documented values', () => {
    const config = getPincodeMonitoringConfig()
    assert.equal(config.manualCheckCooldownSeconds, 300)
    assert.equal(config.manualMaxOutstandingPerWorkspaceMarketplace, 10)
  })
})

describe('isWorkspaceAllowlisted', () => {
  test('fails closed: an allowlisted workspace ID is still rejected if the feature is disabled', () => {
    const config = {
      enabled: false,
      allowedWorkspaceIds: new Set(['a0000000-0000-0000-0000-000000000001']),
      quotaPerWorkspaceMarketplace: 50,
      manualCheckCooldownSeconds: 300,
      manualMaxOutstandingPerWorkspaceMarketplace: 10,
    }
    assert.equal(isWorkspaceAllowlisted(config, 'a0000000-0000-0000-0000-000000000001'), false)
  })

  test('fails closed: an empty allowlist rejects every workspace even when enabled', () => {
    const config = {
      enabled: true,
      allowedWorkspaceIds: new Set<string>(),
      quotaPerWorkspaceMarketplace: 50,
      manualCheckCooldownSeconds: 300,
      manualMaxOutstandingPerWorkspaceMarketplace: 10,
    }
    assert.equal(isWorkspaceAllowlisted(config, 'a0000000-0000-0000-0000-000000000001'), false)
  })

  test('accepts a workspace that is both enabled and allowlisted, case-insensitively', () => {
    const config = {
      enabled: true,
      allowedWorkspaceIds: new Set(['a0000000-0000-0000-0000-000000000001']),
      quotaPerWorkspaceMarketplace: 50,
      manualCheckCooldownSeconds: 300,
      manualMaxOutstandingPerWorkspaceMarketplace: 10,
    }
    assert.equal(isWorkspaceAllowlisted(config, 'A0000000-0000-0000-0000-000000000001'), true)
  })
})
