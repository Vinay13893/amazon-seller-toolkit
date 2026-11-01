import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getBuyBoxCsvValue,
  getBuyBoxDisplayLabel,
  getBuyBoxDisplayState,
  getBuyBoxReason,
  getMissingSignalLabel,
} from './buy-box-display'

test('confirmed product-page outcomes remain detected or not detected', () => {
  assert.equal(getBuyBoxDisplayState({ buy_box_detected: true, page_status: 'product' }), 'detected')
  assert.equal(getBuyBoxDisplayLabel({ buy_box_detected: true, page_status: 'product' }), 'Detected')
  assert.equal(getBuyBoxCsvValue({ buy_box_detected: true, page_status: 'product' }), 'Yes')

  assert.equal(getBuyBoxDisplayState({ buy_box_detected: false, page_status: 'product' }), 'not_detected')
  assert.equal(getBuyBoxDisplayLabel({ buy_box_detected: false, page_status: 'product' }), 'Not detected')
  assert.equal(getBuyBoxCsvValue({ buy_box_detected: false, page_status: 'product' }), 'No')
})

test('blocked pages never become confirmed negative Buy Box results', () => {
  const result = { buy_box_detected: false, page_status: 'blocked' }
  assert.equal(getBuyBoxDisplayState(result), 'blocked')
  assert.equal(getBuyBoxDisplayLabel(result), 'Blocked')
  assert.equal(getBuyBoxCsvValue(result), 'Blocked')
  assert.equal(getMissingSignalLabel(result.page_status), 'Blocked')
  assert.equal(getBuyBoxReason(null, result.page_status), 'blocked_or_captcha')
})

test('unknown and failed page states never become confirmed negatives', () => {
  for (const pageStatus of ['unknown', 'failed', null]) {
    const result = { buy_box_detected: false, page_status: pageStatus }
    assert.equal(getBuyBoxDisplayState(result), 'unknown')
    assert.equal(getBuyBoxDisplayLabel(result), 'Unknown')
    assert.equal(getBuyBoxCsvValue(result), 'Unknown')
    assert.equal(getMissingSignalLabel(pageStatus), 'Unknown')
    assert.equal(getBuyBoxReason(null, pageStatus), 'unknown_page_state')
  }
})

test('specific checker errors remain the displayed reason', () => {
  assert.equal(getBuyBoxReason('captcha_detected', 'blocked'), 'captcha_detected')
})
