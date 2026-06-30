// Clear any stuck 'running' sync rows older than 30 minutes so the next sync can proceed.
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
} catch { /* */ }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

async function main() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min
  const { data: stale } = await supabase
    .from('internal_data_refresh_runs')
    .select('id, source, started_at')
    .like('source', 'ads_%')
    .eq('status', 'running')
    .lt('started_at', cutoff)

  if (!stale || stale.length === 0) {
    // Also check recent ones
    const { data: all } = await supabase
      .from('internal_data_refresh_runs')
      .select('id, source, status, started_at')
      .like('source', 'ads_%')
      .eq('status', 'running')
    console.log(`Running rows (any age): ${all?.length ?? 0}`)
    for (const r of all ?? []) console.log(`  ${r.source} started_at=${r.started_at} id=${r.id}`)

    if (all && all.length > 0) {
      // Force-clear all running rows
      const { error } = await supabase
        .from('internal_data_refresh_runs')
        .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: 'Manually cleared stuck running row.' })
        .in('id', all.map(r => r.id))
      if (error) console.error('Clear failed:', error.message)
      else console.log(`✅  Cleared ${all.length} stuck running row(s).`)
    } else {
      console.log('No stuck running rows found.')
    }
    return
  }

  const { error } = await supabase
    .from('internal_data_refresh_runs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: 'Manually cleared stale running row.' })
    .in('id', stale.map(r => r.id))
  if (error) console.error('Clear failed:', error.message)
  else console.log(`✅  Cleared ${stale.length} stale row(s):`, stale.map(r => r.source).join(', '))
}
main().catch(console.error)
