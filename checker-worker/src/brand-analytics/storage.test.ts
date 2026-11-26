import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeSearchTermsBatch, rowsAppearStored } from './storage'
test('timeout splits batches and preserves all rows', async () => {
  const stored: number[] = []
  const result = await writeSearchTermsBatch(Array.from({ length: 100 }, (_, i) => i), async rows => {
    if (rows.length > 25) return { error: { code: '57014' } }
    stored.push(...rows)
    return { error: null }
  })
  assert.equal(result.error, null)
  assert.equal(new Set(stored).size, 100)
})
test('non-timeout failures and persistent small timeouts stop', async () => {
  let calls = 0
  const result = await writeSearchTermsBatch([1, 2], async () => { calls++; return { error: { code: '23505' } } })
  assert.equal(result.error?.code, '23505')
  assert.equal(calls, 1)
  assert.equal((await writeSearchTermsBatch([1], async () => ({ error: { code: '57014' } }))).error?.code, '57014')
})
test('zero exact rows overrides historical done metadata', () => {
  assert.equal(rowsAppearStored(0, 691247), false)
  assert.equal(rowsAppearStored(10, 0), true)
  assert.equal(rowsAppearStored(null, null), false)
})
