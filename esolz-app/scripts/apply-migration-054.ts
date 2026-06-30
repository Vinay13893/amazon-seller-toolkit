// Apply migration 054: internal_brahmastra_thresholds
// Run from esolz-app/: npx tsx scripts/apply-migration-054.ts

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
} catch { /* rely on existing env */ }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const MIGRATION_SQL = `
create table if not exists public.internal_brahmastra_thresholds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  portfolio text not null default '__global__',
  waste_spend_threshold numeric not null default 300,
  minimum_roas numeric not null default 1.5,
  min_clicks_for_waste integer not null default 5,
  max_acos_pct numeric not null default 40,
  min_ad_spend_for_action numeric not null default 100,
  high_spend_threshold numeric not null default 500,
  protect_roas numeric not null default 4,
  protect_acos_pct numeric not null default 25,
  warning_tacos_pct numeric not null default 15,
  critical_tacos_pct numeric not null default 25,
  min_ordered_sales_for_category_action numeric not null default 5000,
  refund_warning_pct numeric not null default 20,
  high_refund_amount numeric not null default 1000,
  good_roas numeric not null default 2.5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, portfolio)
);
`

async function main() {
  console.log('Checking SDK version for sql() support...')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyClient = supabase as any
  if (typeof anyClient.sql === 'function') {
    console.log('SDK has sql() method — trying migration...')
    try {
      await anyClient.sql(MIGRATION_SQL)
      console.log('✅  Migration applied via supabase.sql()!')
      return
    } catch (e) {
      console.error('sql() failed:', e)
    }
  } else {
    console.log('SDK does not have sql() method in this version.')
  }

  // Try rpc with a hypothetical exec function
  const { error: rpcErr } = await supabase.rpc('exec_sql' as string, { sql: MIGRATION_SQL })
  if (!rpcErr) {
    console.log('✅  Migration applied via supabase.rpc(exec_sql)!')
    return
  }
  console.log('rpc(exec_sql) not available:', rpcErr.message)

  // Check if table already exists
  const { error: checkErr } = await supabase.from('internal_brahmastra_thresholds').select('id').limit(1)
  if (!checkErr) {
    console.log('✅  Table already exists! Migration is applied.')
    return
  }

  console.log()
  console.log('❌  Cannot apply migration programmatically. Please run this SQL in:')
  console.log(`    https://supabase.com/dashboard/project/okxfwcfxxrtmijmvztdq/sql/new`)
  console.log()
  console.log(MIGRATION_SQL)
}

main().catch(console.error)
