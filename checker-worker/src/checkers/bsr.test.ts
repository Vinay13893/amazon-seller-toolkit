import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBestSellerRank } from './bsr'

test('parses the first public Amazon best seller rank', () => {
  assert.deepEqual(parseBestSellerRank('Best Sellers Rank: #1,234 in Home & Kitchen (See Top 100) #45 in Shelf Liners'), {
    bsr: 1234,
    category: 'Home & Kitchen',
  })
})

test('does not invent a rank when public details omit it', () => {
  assert.deepEqual(parseBestSellerRank('Product information unavailable'), { bsr: null, category: null })
})
