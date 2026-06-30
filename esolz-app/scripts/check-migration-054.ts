// Check whether migration 054 (brahmastra thresholds table) has been applied.
// Run from esolz-app/: npx tsx scripts/check-migration-054.ts

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env.local not found — rely on existing env */ }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !key) {
  console.error('❌  NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.')
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  console.log('Migration 054 check — internal_brahmastra_thresholds')
  console.log('Project URL:', url)
  console.log()

  // Step 1: probe the table
  const { data, error } = await supabase
    .from('internal_brahmastra_thresholds')
    .select('portfolio, waste_spend_threshold, minimum_roas, max_acos_pct, protect_roas, good_roas, warning_tacos_pct, critical_tacos_pct, refund_warning_pct, high_refund_amount, min_ordered_sales_for_category_action, min_ad_spend_for_action, min_clicks_for_waste, high_spend_threshold, protect_acos_pct, is_active')
    .limit(5)

  if (error) {
    console.error('❌  Table query failed:', error.message)
    if (error.message?.includes('does not exist') || error.message?.includes('relation')) {
      console.log()
      console.log('Migration 054 has NOT been applied yet.')
      console.log('Apply it via the Supabase SQL Editor:')
      console.log('https://supabase.com/dashboard/project/okxfwcfxxrtmijmvztdq/sql/new')
      console.log()
      console.log('Then run this script again to verify.')
    }
    return
  }

  console.log('✅  Table internal_brahmastra_thresholds exists.')
  console.log(`    Row count (sample): ${data?.length ?? 0}`)
  if (data && data.length > 0) {
    console.log('    Sample rows:')
    for (const row of data) {
      console.log(`      portfolio=${row.portfolio}, waste_spend_threshold=${row.waste_spend_threshold}, minimum_roas=${row.minimum_roas}, max_acos_pct=${row.max_acos_pct}`)
    }
  } else {
    console.log('    No rows yet — table is empty (system defaults will be used by engine).')
  }

  // Step 2: verify column defaults by inserting a test row then reading it back
  console.log()
  console.log('Testing column defaults with a probe insert...')
  const workspace = await (async () => {
    const { data: ws } = await supabase.from('workspaces').select('id').limit(1).maybeSingle()
    return ws?.id as string | null
  })()
  if (!workspace) {
    console.log('    Could not find a workspace to test. Skipping insert test.')
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('internal_brahmastra_thresholds')
      .upsert({ workspace_id: workspace, portfolio: '__test_probe__' }, { onConflict: 'workspace_id,portfolio' })
      .select()
      .maybeSingle()
    if (insErr) {
      console.error('    Insert test failed:', insErr.message)
    } else {
      const row = inserted as Record<string, unknown>
      console.log('✅  Default values from DB:')
      const expected: Record<string, number> = {
        waste_spend_threshold: 300, minimum_roas: 1.5, max_acos_pct: 40,
        protect_roas: 4, good_roas: 2.5, warning_tacos_pct: 15,
        critical_tacos_pct: 25, refund_warning_pct: 20, high_refund_amount: 1000,
        min_ordered_sales_for_category_action: 5000, min_ad_spend_for_action: 100,
        min_clicks_for_waste: 5, high_spend_threshold: 500, protect_acos_pct: 25,
      }
      let allMatch = true
      for (const [field, exp] of Object.entries(expected)) {
        const actual = Number(row[field])
        const match = Math.abs(actual - exp) < 0.001
        console.log(`    ${match ? '✓' : '✗'} ${field}: expected ${exp}, got ${actual}`)
        if (!match) allMatch = false
      }
      console.log(allMatch ? '\n✅  All defaults match R10 system values.' : '\n⚠️  Some defaults do not match. Check migration.')

      // Cleanup probe row
      await supabase.from('internal_brahmastra_thresholds').delete().eq('workspace_id', workspace).eq('portfolio', '__test_probe__')
      console.log('    Probe row cleaned up.')
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
