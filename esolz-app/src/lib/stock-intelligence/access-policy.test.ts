import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canAccessStockIntelligence,
  EASYHOME_STOCK_WORKSPACE_ID,
} from './access-policy'

test('authenticated approved EasyHOME members can access Stock Intelligence', () => {
  assert.equal(canAccessStockIntelligence({
    authenticated: true,
    internalAuthorized: true,
    membershipWorkspaceId: EASYHOME_STOCK_WORKSPACE_ID,
    lookupFailed: false,
  }), true)
})

test('an approved Internal Tester from a different workspace cannot read EasyHOME stock data', () => {
  assert.equal(canAccessStockIntelligence({
    authenticated: true,
    internalAuthorized: true,
    membershipWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lookupFailed: false,
  }), false)
})

test('authentication, internal approval and successful membership lookup all fail closed', () => {
  const base = {
    authenticated: true,
    internalAuthorized: true,
    membershipWorkspaceId: EASYHOME_STOCK_WORKSPACE_ID,
    lookupFailed: false,
  }

  assert.equal(canAccessStockIntelligence({ ...base, authenticated: false }), false)
  assert.equal(canAccessStockIntelligence({ ...base, internalAuthorized: false }), false)
  assert.equal(canAccessStockIntelligence({ ...base, lookupFailed: true }), false)
  assert.equal(canAccessStockIntelligence({ ...base, membershipWorkspaceId: null }), false)
})
