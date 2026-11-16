import test from 'node:test'
import assert from 'node:assert/strict'
import { financeTransactionPages, normalizeFinanceTransaction } from './finance-transactions'

const marketplaceId = 'A21TJRUUN4KGV'
const transaction = {
  sellingPartnerMetadata: { marketplaceId }, transactionId: 'test-transaction',
  transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2026-11-10T10:00:00Z',
  totalAmount: { currencyCode: 'INR', currencyAmount: 123.45 },
  description: 'must-not-persist', contexts: [{ buyer: 'must-not-persist' }],
}
const base = { marketplaceId, postedAfter: '2026-11-01T00:00:00Z', postedBefore: '2026-11-11T00:00:00Z', accessToken: async () => 'test-token', sleep: async () => {}, now: () => Date.parse('2026-11-12T00:00:00Z') }
const response = (transactions: unknown[], nextToken?: string) => Response.json({ payload: { transactions, nextToken } })
async function collect(fetcher: typeof fetch) {
  const rows = []
  for await (const page of financeTransactionPages({ ...base, fetcher })) rows.push(...page)
  return rows
}

test('projects only safe ledger fields; net receipts are not invented sales', () => {
  const row = normalizeFinanceTransaction(transaction, marketplaceId)
  assert.equal(row.total_amount, 123.45)
  assert.equal(Object.keys(row).length, 6)
  assert.equal('description' in row, false)
  assert.equal('product_sales' in row, false)
  assert.throws(() => normalizeFinanceTransaction(transaction, 'another-marketplace'))
  assert.throws(() => normalizeFinanceTransaction({ ...transaction, totalAmount: {} }, marketplaceId))
})

test('continues through an empty page with nextToken, preserving scope and dates', async () => {
  const urls: URL[] = []
  const rows = await collect(async input => {
    const url = new URL(String(input)); urls.push(url)
    return urls.length === 1 ? response([], 'next') : response([transaction])
  })
  assert.equal(rows.length, 1)
  assert.equal(urls[1].searchParams.get('nextToken'), 'next')
  for (const url of urls) {
    assert.equal(url.searchParams.get('marketplaceId'), marketplaceId)
    assert.equal(url.searchParams.get('postedAfter'), base.postedAfter)
    assert.equal(url.searchParams.get('postedBefore'), base.postedBefore)
  }
})

test('honors Retry-After without exposing response bodies', async () => {
  let attempts = 0
  const sleeps: number[] = []
  for await (const page of financeTransactionPages({ ...base,
    sleep: async ms => { sleeps.push(ms) },
    fetcher: async () => ++attempts === 1 ? new Response('secret-body', { status: 429, headers: { 'Retry-After': '6' } }) : response([]),
  })) assert.deepEqual(page, [])
  assert.equal(attempts, 2)
  assert.ok(sleeps.includes(6000))
})

test('403 stops without retries or credential disclosure', async () => {
  let calls = 0
  await assert.rejects(collect(async () => { calls++; return new Response('secret-body', { status: 403 }) }), /HTTP 403/)
  assert.equal(calls, 1)
})

test('rejects malformed payloads, repeated tokens and out-of-window transactions', async () => {
  await assert.rejects(collect(async () => Response.json({})), /Invalid/)
  await assert.rejects(collect(async () => response([], 'same')), /pagination/)
  await assert.rejects(collect(async () => response([{ ...transaction, postedDate: base.postedBefore }])), /outside/)
})

test('invalid sync scope and oversized windows make no Amazon call', async () => {
  for (const overrides of [{ marketplaceId: 'unsupported' }, { postedAfter: '2025-01-01T00:00:00Z' }, { postedBefore: base.postedAfter }]) {
    await assert.rejects(async () => {
      for await (const page of financeTransactionPages({ ...base, ...overrides, fetcher: async () => { assert.fail('No request allowed') } })) void page
    })
  }
})
