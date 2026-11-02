import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const metadataRoute = readFileSync(
  'src/app/api/internal/stock-intelligence/metadata/route.ts',
  'utf8',
)
const worksheetRoute = readFileSync(
  'src/app/api/internal/stock-intelligence/worksheet/route.ts',
  'utf8',
)
const page = readFileSync(
  'src/app/(dashboard)/dashboard/internal/stock-intelligence/page.tsx',
  'utf8',
)
const adapter = readFileSync('src/lib/stock-intelligence/google-sheets.ts', 'utf8')

test('page and every Stock Intelligence API route enforce existing internal authorization', () => {
  for (const source of [metadataRoute, worksheetRoute, page]) {
    assert.match(source, /getInternalAccessContext/)
    assert.match(source, /access\.authorized/)
  }
})

test('Google adapter uses read-only scope and contains no Sheets write endpoints', () => {
  assert.match(adapter, /spreadsheets\.readonly/)
  assert.doesNotMatch(adapter, /values:append|values:batchUpdate|:batchUpdate/)
  assert.doesNotMatch(adapter, /script\.googleapis\.com|scripts\.run/)
})

test('server-only credentials are never exposed through NEXT_PUBLIC variables', () => {
  assert.match(adapter, /server-only/)
  assert.doesNotMatch(adapter, /NEXT_PUBLIC_GOOGLE/)
})

test('worksheet indexing is bounded and reports partial data instead of reading an unlimited grid', () => {
  assert.match(adapter, /MAX_WORKSHEET_INDEX_ROWS = 5000/)
  assert.match(adapter, /Math\.min\(sheet\.rowCount, headerRow \+ MAX_WORKSHEET_INDEX_ROWS\)/)
  assert.match(adapter, /Results are partial/)
})
