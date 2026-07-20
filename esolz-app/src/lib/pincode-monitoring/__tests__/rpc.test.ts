/**
 * Asserts each wrapper calls exactly the right Postgres function name with
 * exactly the right parameter keys (matching the real signatures in
 * `063_pincode_p0a_rpcs.sql`/`064_pincode_p0b_config_lifecycle_and_rpcs.sql`
 * verbatim) via a lightweight fake `RpcClient` double -- no live database.
 * SERVER-ROLE SAFETY: also asserts the module never exposes a generic
 * pass-through (`rpc.ts` has exactly seven exported call functions, each
 * hardcoded to one function name).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  enrollProducts, setTrackingState, removeProducts, queueManualCheck,
  replaceProductTargets, replaceWorkspaceDefaultPincodes, getTargetResults,
  PincodeRpcTransportError, type RpcClient,
} from '../rpc'

function fakeClient(response: { data: unknown; error: { message: string } | null }): RpcClient & { calls: { fn: string; params: Record<string, unknown> }[] } {
  const calls: { fn: string; params: Record<string, unknown> }[] = []
  return {
    calls,
    async rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params })
      return response
    },
  }
}

describe('enrollProducts', () => {
  test('calls enroll_pincode_monitored_products with exactly the RPC-named parameters', async () => {
    const client = fakeClient({ data: { result: 'success' }, error: null })
    await enrollProducts(client, {
      workspaceId: 'ws-1',
      marketplaceId: 'mp-1',
      products: [{ asin: 'B0D9QXVWLL', product_source: 'other', pincodes: ['110001'] }],
      quotaLimit: 50,
    })
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0].fn, 'enroll_pincode_monitored_products')
    assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['p_marketplace_id', 'p_products', 'p_quota_limit', 'p_workspace_id'])
    assert.equal(client.calls[0].params.p_workspace_id, 'ws-1')
    assert.equal(client.calls[0].params.p_marketplace_id, 'mp-1')
    assert.equal(client.calls[0].params.p_quota_limit, 50)
  })
})

describe('setTrackingState', () => {
  test('calls set_pincode_tracking_state with exactly the RPC-named parameters', async () => {
    const client = fakeClient({ data: { result: 'success', action: 'pause', targetCount: 1 }, error: null })
    await setTrackingState(client, { workspaceId: 'ws-1', marketplaceId: 'mp-1', targetIds: ['t-1'], action: 'pause', quotaLimit: 50 })
    assert.equal(client.calls[0].fn, 'set_pincode_tracking_state')
    assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['p_action', 'p_marketplace_id', 'p_quota_limit', 'p_target_ids', 'p_workspace_id'])
    assert.equal(client.calls[0].params.p_action, 'pause')
  })
})

describe('removeProducts', () => {
  test('calls remove_pincode_monitored_products, always with removal_reason "user_requested" (never a free-text client value)', async () => {
    const client = fakeClient({ data: { result: 'success', productCount: 1 }, error: null })
    await removeProducts(client, { workspaceId: 'ws-1', marketplaceId: 'mp-1', monitoredProductIds: ['p-1'] })
    assert.equal(client.calls[0].fn, 'remove_pincode_monitored_products')
    assert.equal(client.calls[0].params.p_removal_reason, 'user_requested')
    assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['p_marketplace_id', 'p_monitored_product_ids', 'p_removal_reason', 'p_workspace_id'])
  })
})

describe('queueManualCheck', () => {
  test('calls queue_pincode_manual_check with exactly the RPC-named parameters, including the caller-scoped userId', async () => {
    const client = fakeClient({ data: { result: 'queued', manual_request_token: 'tok' }, error: null })
    await queueManualCheck(client, {
      targetId: 't-1', workspaceId: 'ws-1', marketplaceId: 'mp-1', userId: 'u-1', cooldownSeconds: 300, manualPendingLimit: 10,
    })
    assert.equal(client.calls[0].fn, 'queue_pincode_manual_check')
    assert.deepEqual(
      Object.keys(client.calls[0].params).sort(),
      ['p_cooldown_seconds', 'p_manual_pending_limit', 'p_marketplace_id', 'p_target_id', 'p_user_id', 'p_workspace_id'],
    )
    assert.equal(client.calls[0].params.p_user_id, 'u-1')
  })
})

describe('replaceProductTargets', () => {
  test('calls replace_pincode_product_targets with exactly the RPC-named parameters', async () => {
    const client = fakeClient({ data: { result: 'success', addedCount: 1, reconfiguredCount: 0, unconfiguredCount: 0, targetCount: 1 }, error: null })
    await replaceProductTargets(client, { workspaceId: 'ws-1', marketplaceId: 'mp-1', monitoredProductId: 'p-1', pincodes: ['110001'], quotaLimit: 50 })
    assert.equal(client.calls[0].fn, 'replace_pincode_product_targets')
    assert.deepEqual(
      Object.keys(client.calls[0].params).sort(),
      ['p_marketplace_id', 'p_monitored_product_id', 'p_pincodes', 'p_quota_limit', 'p_workspace_id'],
    )
    assert.equal(client.calls[0].params.p_monitored_product_id, 'p-1')
    assert.deepEqual(client.calls[0].params.p_pincodes, ['110001'])
  })
})

describe('replaceWorkspaceDefaultPincodes', () => {
  test('calls replace_workspace_default_pincodes with exactly the RPC-named parameters, pincodes mapped to {pincode, displayOrder}', async () => {
    const client = fakeClient({ data: { result: 'success', defaults: [] }, error: null })
    await replaceWorkspaceDefaultPincodes(client, { workspaceId: 'ws-1', marketplaceId: 'mp-1', pincodes: [{ pincode: '110001', displayOrder: 0 }] })
    assert.equal(client.calls[0].fn, 'replace_workspace_default_pincodes')
    assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['p_marketplace_id', 'p_pincodes', 'p_workspace_id'])
    assert.deepEqual(client.calls[0].params.p_pincodes, [{ pincode: '110001', displayOrder: 0 }])
  })
})

describe('getTargetResults', () => {
  test('calls get_pincode_target_results with exactly the RPC-named parameters', async () => {
    const client = fakeClient({ data: [], error: null })
    await getTargetResults(client, { workspaceId: 'ws-1', targetIds: ['t-1', 't-2'] })
    assert.equal(client.calls[0].fn, 'get_pincode_target_results')
    assert.deepEqual(Object.keys(client.calls[0].params).sort(), ['p_target_ids', 'p_workspace_id'])
    assert.deepEqual(client.calls[0].params.p_target_ids, ['t-1', 't-2'])
  })
})

describe('transport error handling', () => {
  test('a client-level error (network/permission failure) throws PincodeRpcTransportError instead of returning the error as a normal RPC result', async () => {
    const client = fakeClient({ data: null, error: { message: 'connection refused' } })
    await assert.rejects(
      () => enrollProducts(client, { workspaceId: 'ws-1', marketplaceId: 'mp-1', products: [], quotaLimit: 50 }),
      (err: unknown) => err instanceof PincodeRpcTransportError && err.rpcName === 'enroll_pincode_monitored_products',
    )
  })
})
