import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCompetitorProducts,
  groupCatalogProducts,
  resolveAsinProductDomains,
  selectProductForSkuContext,
  selectedAsins,
  shouldToggleProductFromKeyboard,
} from './product-domain'

const catalogRows = [
  { id: 'listing-1', asin: 'b0own00001', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-B', item_name: 'Own product' },
  { id: 'listing-2', asin: 'B0OWN00001', marketplace_id: 'A21TJRUUN4KGV', sku: 'SKU-A', item_name: null },
]

test('groups seller SKUs into one marketplace-scoped ASIN product and retains every SKU', () => {
  const products = groupCatalogProducts(catalogRows)

  assert.equal(products.length, 1)
  assert.equal(products[0].asin, 'B0OWN00001')
  assert.deepEqual(products[0].skus, ['SKU-A', 'SKU-B'])
  assert.deepEqual(products[0].sourceIds, ['listing-1', 'listing-2'])
})

test('same ASIN in another marketplace remains a separate product', () => {
  const products = groupCatalogProducts([
    ...catalogRows,
    { id: 'listing-us', asin: 'B0OWN00001', marketplace_id: 'ATVPDKIKX0DER', sku: 'SKU-US' },
  ])

  assert.equal(products.length, 2)
})

test('own overlap is excluded while a genuine competitor remains visible', () => {
  const competitors = buildCompetitorProducts([
    { id: 'tracked-own', asin: 'B0OWN00001', marketplace: 'IN', status: 'active' },
    { id: 'tracked-other', asin: 'B0OTHER001', marketplace: 'IN', status: 'active', product_title: 'Other product' },
  ], catalogRows)

  assert.deepEqual(competitors.map(product => product.primarySourceId), ['tracked-other'])
  assert.deepEqual(competitors[0].skus, [])
})

test('classification failures fail closed independently', () => {
  const trackedRows = [{ id: 'tracked-other', asin: 'B0OTHER001', marketplace: 'IN', status: 'active' }]

  assert.deepEqual(resolveAsinProductDomains({
    catalogRows: [], trackedRows, catalogUnavailable: true, trackedUnavailable: false,
  }), { myProducts: [], competitorProducts: [] })

  const trackedUnavailable = resolveAsinProductDomains({
    catalogRows, trackedRows: [], catalogUnavailable: false, trackedUnavailable: true,
  })
  assert.equal(trackedUnavailable.myProducts.length, 1)
  assert.deepEqual(trackedUnavailable.competitorProducts, [])
})

test('SKU context never changes queue targeting from the canonical ASIN', () => {
  const products = groupCatalogProducts(catalogRows)
  assert.deepEqual(selectedAsins(products, [products[0].key]), ['B0OWN00001'])
})

test('SKU activation selects its parent product once and preserves ASIN identity', () => {
  const product = groupCatalogProducts(catalogRows)[0]
  const firstClick = selectProductForSkuContext({
    selectedKeys: [],
    productKey: product.key,
    maxSelected: 2,
  })

  assert.equal(firstClick.accepted, true)
  assert.deepEqual(firstClick.selectedKeys, [product.key])
  assert.deepEqual(selectedAsins([product], firstClick.selectedKeys), ['B0OWN00001'])

  const contextChange = selectProductForSkuContext({
    selectedKeys: firstClick.selectedKeys,
    productKey: product.key,
    maxSelected: 2,
  })
  assert.equal(contextChange.accepted, true)
  assert.equal(contextChange.selectedKeys, firstClick.selectedKeys)
})

test('SKU activation respects selection limits and nested keys do not toggle the parent', () => {
  const blocked = selectProductForSkuContext({
    selectedKeys: ['my:IN:OTHER'],
    productKey: 'my:IN:B0OWN00001',
    maxSelected: 1,
  })

  assert.equal(blocked.accepted, false)
  assert.deepEqual(blocked.selectedKeys, ['my:IN:OTHER'])
  assert.equal(shouldToggleProductFromKeyboard({ key: 'Enter', isContainerTarget: false }), false)
  assert.equal(shouldToggleProductFromKeyboard({ key: ' ', isContainerTarget: false }), false)
  assert.equal(shouldToggleProductFromKeyboard({ key: 'Enter', isContainerTarget: true }), true)
})
