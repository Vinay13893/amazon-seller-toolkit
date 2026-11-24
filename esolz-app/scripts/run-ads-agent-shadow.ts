// CLI entry point; no Amazon API client or write capability.
import { createClient } from '@supabase/supabase-js'
import { runEnabledShadowAgents } from '../src/lib/internal/ads-agent-runner'
try { process.loadEnvFile('.env.local') } catch { /* hosted environment supplies credentials */ }
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('server_credentials_missing')
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const count = await runEnabledShadowAgents(admin)
  console.log(JSON.stringify({ status: 'complete', settingsEvaluated: count }))
}
main().catch(() => {
  console.error(JSON.stringify({ status: 'failed', errorCode: 'shadow_run_failed' }))
  process.exitCode = 1
})
