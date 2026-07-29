import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { splitRowsForUpsert } from '../ads-upsert-split'

describe('splitRowsForUpsert', () => {
  test('a dedupe_key with no existing row is a fresh insert', () => {
    const rows = [{ dedupe_key: 'a', spend: 10 }]
    const { insertRows, updateRows } = splitRowsForUpsert(new Map(), rows)
    assert.equal(insertRows.length, 1)
    assert.equal(updateRows.length, 0)
  })

  test('a dedupe_key that already has a row id becomes an update by that id, never a second insert', () => {
    const existing = new Map([['a', 'row-uuid-1']])
    const rows = [{ dedupe_key: 'a', spend: 20 }]
    const { insertRows, updateRows } = splitRowsForUpsert(existing, rows)
    assert.equal(insertRows.length, 0)
    assert.equal(updateRows.length, 1)
    assert.equal(updateRows[0].id, 'row-uuid-1')
    assert.equal(updateRows[0].spend, 20)
  })

  // The exact idempotent-recovery scenario: poll-pending-reports.ts re-polls
  // and re-parses the same report twice (e.g. run manually a second time
  // before the daily cron's own rolling window overtakes it). Calling this
  // split twice with the SAME existing-rows map must never produce two
  // inserts for the same dedupe_key -- the second pass must resolve to an
  // update against the row the first pass just created.
  test('idempotent re-polling: the same dedupe_key seen across two passes never inserts twice', () => {
    const rows = [{ dedupe_key: 'stable-key', spend: 100 }]

    const firstPass = splitRowsForUpsert(new Map(), rows)
    assert.equal(firstPass.insertRows.length, 1)
    assert.equal(firstPass.updateRows.length, 0)

    // Simulate: the first pass's insert succeeded and is now a known row.
    const existingAfterFirstPass = new Map([['stable-key', 'row-uuid-2']])
    const secondPass = splitRowsForUpsert(existingAfterFirstPass, rows)
    assert.equal(secondPass.insertRows.length, 0, 'second pass must not insert a duplicate row')
    assert.equal(secondPass.updateRows.length, 1)
    assert.equal(secondPass.updateRows[0].id, 'row-uuid-2')
  })

  test('mixed batch: new and existing dedupe_keys split correctly, order preserved within each group', () => {
    const existing = new Map([['b', 'row-uuid-b']])
    const rows = [
      { dedupe_key: 'a', spend: 1 },
      { dedupe_key: 'b', spend: 2 },
      { dedupe_key: 'c', spend: 3 },
    ]
    const { insertRows, updateRows } = splitRowsForUpsert(existing, rows)
    assert.deepEqual(insertRows.map(r => r.dedupe_key), ['a', 'c'])
    assert.deepEqual(updateRows.map(r => r.dedupe_key), ['b'])
    assert.equal(updateRows[0].id, 'row-uuid-b')
  })

  test('empty rows produces empty output', () => {
    const { insertRows, updateRows } = splitRowsForUpsert(new Map([['a', 'x']]), [])
    assert.equal(insertRows.length, 0)
    assert.equal(updateRows.length, 0)
  })
})
