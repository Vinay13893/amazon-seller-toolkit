import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runForSettings } from '../ads-agent-runner'
const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const from = new Date(Date.parse(day) - 13 * 86400000).toISOString().slice(0, 10)
const settings = { workspace_id: 'w', profile_id: 'p', updated_at: 'v1', mode: 'shadow' as const, emergency_stop: true, target_acos_percent: 30, max_bid_change_percent: 10, minimum_clicks: 8, minimum_spend: 300, lookback_days: 14, cooldown_hours: 24, max_data_age_days: 3 }
// Small relational fake: exercise actual runner filters, not a second evaluator.
function database(status = 'success') {
  type Row = Record<string, unknown>
  const tables: Record<string, Row[]> = {
    ads_agent_runs: [], ads_agent_actions: [],
    ads_agent_settings: [{ ...settings, enabled: true }],
    amazon_ads_profiles: [{ workspace_id: 'w', profile_id: 'p', status: 'active', brahmastra_sync_enabled: true, marketplace_id: 'A21TJRUUN4KGV' }],
    internal_data_refresh_runs: ['ads_targeting', 'ads_advertised_product'].map(source => ({ id: source, workspace_id: 'w', profile_id: 'p', source, status, rows_rejected: 0, date_from: from, date_to: day, started_at: new Date().toISOString() })),
    internal_ads_targeting_daily_rows: [{ id: 'r', workspace_id: 'w', profile_id: 'p', report_date: day, campaign_id: 'c', ad_group_id: 'g', keyword_id: 'k', keyword: 'synthetic', keyword_bid: 10, impressions: 100, clicks: 10, spend: 500, purchases: 0, sales: 0 }, { id: 'other', workspace_id: 'other', profile_id: 'p', report_date: day, campaign_id: 'c', ad_group_id: 'g', keyword_id: 'other', keyword_bid: 10, impressions: 100, clicks: 10, spend: 500, purchases: 0, sales: 0 }],
    internal_ads_advertised_product_daily_rows: [], tracked_keywords: [], keyword_rank_snapshots: [],
    pincode_monitored_products: [], pincode_tracking_targets: [], pincode_availability_results: [],
  }
  const client = { from(table: string) {
    let rows = [...tables[table]], mutation: Row | undefined, single = false
    const q = {
      select() { return q }, order() { return q },
      eq(key: string, value: unknown) { rows = rows.filter(r => r[key] === value); return q },
      gte(key: string, value: string) { rows = rows.filter(r => String(r[key]) >= value); return q },
      lte(key: string, value: string) { rows = rows.filter(r => String(r[key]) <= value); return q },
      range(start: number, end: number) { rows = rows.slice(start, end + 1); return q },
      single() { single = true; return q },
      insert(row: Row) { const created = { ...row, id: 'run' }; tables[table].push(created); rows = [created]; return q },
      update(row: Row) { mutation = row; return q },
      upsert(batch: Row[]) { rows = batch.filter(row => !tables[table].some(old => old.action_key === row.action_key)); tables[table].push(...rows); return q },
      then(resolve: (value: unknown) => unknown) {
        if (mutation) for (const row of rows) Object.assign(row, mutation)
        return Promise.resolve(resolve({ data: single ? rows[0] : rows, error: null }))
      },
    }
    return q
  } }
  return { client: client as unknown as SupabaseClient, tables }
}
test('runner writes shadow proposals only for scoped accepted evidence with stop engaged', async () => {
  const db = database()
  await runForSettings(db.client, settings)
  assert.equal(db.tables.ads_agent_actions.length, 1)
  assert.equal(db.tables.ads_agent_actions[0].status, 'proposed')
  assert.equal(db.tables.ads_agent_actions[0].entity_id, 'k')
  assert.equal(db.tables.ads_agent_runs[0].status, 'success')
  await runForSettings(db.client, settings)
  assert.equal(db.tables.ads_agent_actions.length, 1)
})
test('runner skips partial ingestion and writes no actions', async () => {
  const db = database('partial_success')
  await runForSettings(db.client, settings)
  assert.equal(db.tables.ads_agent_actions.length, 0)
  assert.equal(db.tables.ads_agent_runs[0].status, 'skipped')
})
