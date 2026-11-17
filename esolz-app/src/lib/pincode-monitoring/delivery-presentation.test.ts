import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverySummaryText, summarizeDeliveryMessage } from './delivery-presentation'

test('turns Amazon delivery markup into a plain-language summary', () => {
  const raw = `In stock
    {"isInternal":false,"merchantId":"A1K3F9SKMFXUEV","availableFaceouts":["TK_BOUGHT"]}
    | In stock | FREE delivery Thursday, 19 November on orders dispatched by Amazon over ₹499. Details Or fastest delivery Tomorrow 8 am – 12 pm. Details | Deliver to New Delhi 110001`

  const summary = summarizeDeliveryMessage(raw, 'available')
  assert.equal(summary.headline, 'Or fastest delivery Tomorrow 8 am – 12 pm.')
  assert.equal(summary.detail, 'FREE delivery Thursday, 19 November on orders dispatched by Amazon over ₹499.')
  assert.equal(summary.location, 'Deliver to New Delhi 110001')
  assert.doesNotMatch(deliverySummaryText(raw, 'available'), /merchantId|isInternal|\{|\}/)
})

test('provides truthful fallbacks when Amazon gives no readable promise', () => {
  assert.deepEqual(summarizeDeliveryMessage(null, 'available'), {
    headline: 'Available for delivery', detail: null, location: null,
  })
  assert.deepEqual(summarizeDeliveryMessage('', 'unavailable'), {
    headline: 'Not available for delivery', detail: null, location: null,
  })
})

test('keeps a normal human-readable delivery message', () => {
  const summary = summarizeDeliveryMessage('Delivery by Friday, 20 November', 'available')
  assert.equal(summary.headline, 'Delivery by Friday, 20 November')
  assert.equal(summary.detail, null)
})
