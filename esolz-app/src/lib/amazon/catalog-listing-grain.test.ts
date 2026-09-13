import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('catalog migration removes only ASIN uniqueness and keeps the SKU identity constraint', () => {
  const foundation = readFileSync(new URL('../../../supabase/migrations/007_amazon_account_data_foundation.sql', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../../../supabase/migrations/068_catalog_allow_multiple_skus_per_asin.sql', import.meta.url), 'utf8')

  assert.match(foundation, /UNIQUE \(workspace_id, sku, marketplace_id\)/)
  assert.match(migration, /CREATE INDEX IF NOT EXISTS amazon_listing_items_asin_marketplace_idx\s+ON public\.amazon_listing_items \(workspace_id, asin, marketplace_id\)\s+WHERE asin IS NOT NULL;/)
  assert.match(migration, /DROP INDEX IF EXISTS public\.amazon_listing_items_asin_marketplace_uidx;/)
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX|DROP (?:INDEX|CONSTRAINT)[^;]*sku_marketplace/i)
})
