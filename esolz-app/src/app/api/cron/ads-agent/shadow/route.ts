import { createAdminClient } from '@/lib/supabase/admin'
import { runEnabledShadowAgents } from '@/lib/internal/ads-agent-runner'
export const runtime = 'nodejs'
export const maxDuration = 280
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const count = await runEnabledShadowAgents(createAdminClient())
    return Response.json({ status: 'complete', settingsEvaluated: count, amazonWrites: 0 })
  } catch {
    console.error(JSON.stringify({ task: 'ads-agent-shadow', error: 'shadow_run_failed' }))
    return Response.json({ error: 'shadow_run_failed', amazonWrites: 0 }, { status: 500 })
  }
}
