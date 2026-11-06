import assert from 'node:assert/strict'
import test from 'node:test'
import { getSourceStatusTone, TODAY_SHIPMENT_METRIC_LABEL } from './presentation'

test('Today describes the source FBA attention count as shipment alerts', () => {
  assert.equal(TODAY_SHIPMENT_METRIC_LABEL, 'Shipment alerts')
})

test('generic status presentation only marks explicit success states as successful', () => {
  for (const status of ['unknown', 'pending', 'receiving', 'in-transit', 'not due yet', 'custom state']) {
    assert.equal(getSourceStatusTone(status), 'neutral')
  }
  assert.equal(getSourceStatusTone('completed'), 'success')
  assert.equal(getSourceStatusTone('failed'), 'danger')
  assert.equal(getSourceStatusTone('blocked'), 'warning')
})
