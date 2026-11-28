import assert from 'node:assert/strict'
import test from 'node:test'
import { sellerFulfilledQuantity } from './spapi-client'

test('seller-fulfilled stock accepts only one confirmed DEFAULT-channel quantity', () => {
  assert.equal(sellerFulfilledQuantity({ sku: 'sample', fulfillmentAvailability: [
    { fulfillmentChannelCode: 'DEFAULT', quantity: 0 },
    { fulfillmentChannelCode: 'AMAZON_EU', quantity: null },
  ] }), 0)
  assert.equal(sellerFulfilledQuantity({ sku: 'sample', fulfillmentAvailability: [
    { fulfillmentChannelCode: 'DEFAULT', quantity: 12 },
  ] }), 12)
  assert.equal(sellerFulfilledQuantity({ sku: 'sample' }), null)
  assert.equal(sellerFulfilledQuantity({ sku: 'sample', fulfillmentAvailability: [
    { fulfillmentChannelCode: 'AMAZON_EU', quantity: null },
  ] }), null)
  assert.equal(sellerFulfilledQuantity({ sku: 'sample', fulfillmentAvailability: [
    { fulfillmentChannelCode: 'DEFAULT', quantity: 1 },
    { fulfillmentChannelCode: 'DEFAULT', quantity: 2 },
  ] }), null)
  assert.equal(sellerFulfilledQuantity({ sku: 'sample', fulfillmentAvailability: [
    { fulfillmentChannelCode: 'DEFAULT', quantity: -1 },
  ] }), null)
})
