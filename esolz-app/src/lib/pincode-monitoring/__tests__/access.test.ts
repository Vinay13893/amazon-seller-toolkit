/**
 * Covers the access-control scenarios the P0-B task explicitly requires,
 * plus Correction 5's additions (PR #55 review round): marketplace
 * entitlement, unknown-role rejection. `decidePincodeAccess` is the exact
 * pure function `resolvePincodeAccess` (the real I/O-backed gate every
 * route calls) delegates its decision to -- see access.ts's own doc
 * comment for why the two are split, and `__tests__/validation.test.ts`
 * for the UUID/marketplace-string shape checks `resolvePincodeAccess`
 * itself performs before this function is ever called.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decidePincodeAccess, type AccessDecisionInput } from '../access'

const BASE: AccessDecisionInput = {
  authenticated: true,
  membershipRole: 'owner',
  requireWriteRole: false,
  featureEnabled: true,
  workspaceAllowlisted: true,
  marketplaceAuthorized: true,
}

describe('decidePincodeAccess', () => {
  test('unauthenticated session is rejected with 401, before any other check', () => {
    const result = decidePincodeAccess({ ...BASE, authenticated: false, membershipRole: null, featureEnabled: false, workspaceAllowlisted: false, marketplaceAuthorized: false })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 401)
      assert.equal(result.errorCode, 'unauthorized')
    }
  })

  test('non-member (no workspace_members row for the requested workspace) is rejected with 403', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: null })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 403)
      assert.equal(result.errorCode, 'not_a_member')
    }
  })

  test('cross-workspace protection: a member of workspace A is treated as a non-member for workspace B (membershipRole resolved per-workspace, never assumed)', () => {
    // Simulates the exact scenario resolvePincodeAccess produces when the
    // caller supplies a workspace_id the session has no membership row
    // for -- the membership lookup itself is scoped to (user_id,
    // workspace_id), so a real membership in a DIFFERENT workspace never
    // reaches this function as anything but membershipRole: null.
    const result = decidePincodeAccess({ ...BASE, membershipRole: null })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, 'not_a_member')
  })

  test('viewer role is allowed for a read-only route', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'viewer', requireWriteRole: false })
    assert.equal(result.ok, true)
  })

  test('viewer role is rejected with 403 for a mutating route', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'viewer', requireWriteRole: true })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 403)
      assert.equal(result.errorCode, 'viewer_forbidden')
    }
  })

  for (const role of ['owner', 'admin', 'member'] as const) {
    test(`${role} role is allowed for a mutating route`, () => {
      const result = decidePincodeAccess({ ...BASE, membershipRole: role, requireWriteRole: true })
      assert.equal(result.ok, true)
    })
  }

  test('non-allowlisted workspace is rejected with 403 even for an owner', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'owner', workspaceAllowlisted: false })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 403)
      assert.equal(result.errorCode, 'pincode_monitoring_disabled')
    }
  })

  test('feature disabled globally is rejected even for an allowlisted workspace', () => {
    const result = decidePincodeAccess({ ...BASE, featureEnabled: false, workspaceAllowlisted: true })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, 'pincode_monitoring_disabled')
  })

  test('allowlist gate is checked before the role check (a non-allowlisted workspace rejects a viewer read too, not just writes)', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'viewer', requireWriteRole: false, workspaceAllowlisted: false })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, 'pincode_monitoring_disabled')
  })

  test('fully authorized owner on an allowlisted, enabled workspace is accepted for a mutating route', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'owner', requireWriteRole: true })
    assert.equal(result.ok, true)
  })

  // ── Correction 5 (PR #55 review round) ──────────────────────────────────

  test('marketplace not authorized for this workspace is rejected with 403, even for an owner with an otherwise-valid membership', () => {
    const result = decidePincodeAccess({ ...BASE, marketplaceAuthorized: false })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 403)
      assert.equal(result.errorCode, 'marketplace_not_authorized')
    }
  })

  test('marketplace authorization is checked before the role check (an unauthorized marketplace rejects a viewer read too)', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: 'viewer', requireWriteRole: false, marketplaceAuthorized: false })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, 'marketplace_not_authorized')
  })

  test('an unknown/unrecognized role is rejected outright, not treated as either viewer or writable', () => {
    const readResult = decidePincodeAccess({ ...BASE, membershipRole: 'superadmin', requireWriteRole: false })
    assert.equal(readResult.ok, false)
    if (!readResult.ok) {
      assert.equal(readResult.status, 403)
      assert.equal(readResult.errorCode, 'unknown_role')
    }
    const writeResult = decidePincodeAccess({ ...BASE, membershipRole: 'superadmin', requireWriteRole: true })
    assert.equal(writeResult.ok, false)
    if (!writeResult.ok) assert.equal(writeResult.errorCode, 'unknown_role')
  })

  test('an empty-string role is rejected as unknown, not silently coerced', () => {
    const result = decidePincodeAccess({ ...BASE, membershipRole: '' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, 'unknown_role')
  })
})
