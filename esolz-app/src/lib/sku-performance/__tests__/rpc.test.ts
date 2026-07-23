import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { getSkuPerformanceSummary, getSkuPerformanceDaily, SkuPerformanceRpcTransportError, type RpcClient } from '../rpc'

function fakeClient(response: { data: unknown; error: unknown }, captured: { fn?: string; params?: Record<string, unknown> }): RpcClient {
  return {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      captured.fn = fn
      captured.params = params
      return response
    },
  }
}

describe('getSkuPerformanceSummary', () => {
  test('calls exactly the get_sku_performance_summary RPC name, never a caller-suppliable name', async () => {
    const captured: { fn?: string; params?: Record<string, unknown> } = {}
    const client = fakeClient({ data: { result: 'success' }, error: null }, captured)
    await getSkuPerformanceSummary(client, {
      workspaceId: 'ws1', marketplaceId: 'M1', dateFrom: '2026-07-01', dateTo: '2026-07-20', asOf: '2026-07-20',
      limit: 100, offset: 0,
      filters: {
        skuFilter: null, asinFilter: null, categoryFilter: null, brandFilter: null,
        growingOnly: false, decliningOnly: false, spendSpikeOnly: false, noAttributedSalesOnly: false,
        highTacosOnly: false, unmappedOnly: false, identityConflictOnly: false, sort: 'attention_desc',
      },
    })
    assert.equal(captured.fn, 'get_sku_performance_summary')
  })

  test('maps every argument to its exact p_ RPC parameter name', async () => {
    const captured: { fn?: string; params?: Record<string, unknown> } = {}
    const client = fakeClient({ data: { result: 'success' }, error: null }, captured)
    await getSkuPerformanceSummary(client, {
      workspaceId: 'ws1', marketplaceId: 'M1', dateFrom: '2026-07-01', dateTo: '2026-07-20', asOf: '2026-07-20',
      limit: 50, offset: 10,
      filters: {
        skuFilter: 'ABC', asinFilter: 'B01', categoryFilter: 'Widgets', brandFilter: 'Acme',
        growingOnly: true, decliningOnly: false, spendSpikeOnly: true, noAttributedSalesOnly: false,
        highTacosOnly: true, unmappedOnly: false, identityConflictOnly: true, sort: 'sales_desc',
      },
    })
    assert.deepEqual(captured.params, {
      p_workspace_id: 'ws1', p_marketplace_id: 'M1', p_date_from: '2026-07-01', p_date_to: '2026-07-20', p_as_of: '2026-07-20',
      p_limit: 50, p_offset: 10,
      p_sku_filter: 'ABC', p_asin_filter: 'B01', p_category_filter: 'Widgets', p_brand_filter: 'Acme',
      p_growing_only: true, p_declining_only: false, p_spend_spike_only: true, p_no_attributed_sales_only: false,
      p_high_tacos_only: true, p_unmapped_only: false, p_identity_conflict_only: true, p_sort: 'sales_desc',
    })
  })

  test('throws SkuPerformanceRpcTransportError on an RPC error, never returns partial data', async () => {
    const client = fakeClient({ data: null, error: { message: 'db down' } }, {})
    await assert.rejects(
      () => getSkuPerformanceSummary(client, {
        workspaceId: 'ws1', marketplaceId: 'M1', dateFrom: '2026-07-01', dateTo: '2026-07-20', asOf: '2026-07-20',
        limit: 100, offset: 0,
        filters: {
          skuFilter: null, asinFilter: null, categoryFilter: null, brandFilter: null,
          growingOnly: false, decliningOnly: false, spendSpikeOnly: false, noAttributedSalesOnly: false,
          highTacosOnly: false, unmappedOnly: false, identityConflictOnly: false, sort: 'attention_desc',
        },
      }),
      (err: unknown) => err instanceof SkuPerformanceRpcTransportError && err.rpcName === 'get_sku_performance_summary',
    )
  })
})

describe('getSkuPerformanceDaily', () => {
  test('calls exactly the get_sku_performance_daily RPC name with the exact p_ parameters', async () => {
    const captured: { fn?: string; params?: Record<string, unknown> } = {}
    const client = fakeClient({ data: { result: 'success' }, error: null }, captured)
    await getSkuPerformanceDaily(client, { workspaceId: 'ws1', marketplaceId: 'M1', sku: 'SKU-1', dateFrom: '2026-07-01', dateTo: '2026-07-20' })
    assert.equal(captured.fn, 'get_sku_performance_daily')
    assert.deepEqual(captured.params, {
      p_workspace_id: 'ws1', p_marketplace_id: 'M1', p_sku: 'SKU-1', p_date_from: '2026-07-01', p_date_to: '2026-07-20',
    })
  })

  test('throws SkuPerformanceRpcTransportError on an RPC error', async () => {
    const client = fakeClient({ data: null, error: { message: 'timeout' } }, {})
    await assert.rejects(
      () => getSkuPerformanceDaily(client, { workspaceId: 'ws1', marketplaceId: 'M1', sku: 'SKU-1', dateFrom: '2026-07-01', dateTo: '2026-07-20' }),
      (err: unknown) => err instanceof SkuPerformanceRpcTransportError && err.rpcName === 'get_sku_performance_daily',
    )
  })
})
