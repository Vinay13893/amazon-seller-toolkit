import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachCompleteListingSkus,
  listingSkuAssociationScope,
} from './listing-sku-associations'

test('attaches every SKU for a paged product without adding unrelated marketplace rows', () => {
  const pageRows = [{
    id: 'listing-page-1',
    asin: 'B0PRODUCT01',
    marketplace_id: 'A21TJRUUN4KGV',
    sku: 'SKU-A',
  }]
  const associationRows = [
    { asin: 'B0PRODUCT01', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-C' },
    { asin: 'B0PRODUCT01', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-B' },
    { asin: 'B0PRODUCT01', marketplace_id: 'ATVPDKIKX0DER', sku: 'SKU-US' },
    { asin: 'B0OTHER001', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-OTHER' },
  ]

  const rows = attachCompleteListingSkus(pageRows, associationRows)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'listing-page-1')
  assert.deepEqual(rows[0].skus, ['SKU-A', 'SKU-B', 'SKU-C'])
})

test('association lookup scope is limited to products represented on the current API page', () => {
  const scope = listingSkuAssociationScope([
    { asin: 'B0PRODUCT01', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-A' },
    { asin: 'B0PRODUCT02', marketplace_id: 'ATVPDKIKX0DER', sku: 'SKU-B' },
    { asin: null, marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-NO-ASIN' },
  ])

  assert.deepEqual(scope.asins, ['B0PRODUCT01', 'B0PRODUCT02'])
  assert.deepEqual(scope.marketplaceIds, ['A21TJRUUN4KGV', 'ATVPDKIKX0DER'])
  assert.deepEqual([...scope.productKeys], [
    'A21TJRUUN4KGV:B0PRODUCT01',
    'ATVPDKIKX0DER:B0PRODUCT02',
  ])
})
