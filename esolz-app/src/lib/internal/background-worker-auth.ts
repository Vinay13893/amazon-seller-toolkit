import 'server-only'
import { createClient } from '@/lib/supabase/server'

export type JobsAuthResult =
  | { ok: true; mode: 'system' }
  | { ok: true; mode: 'session'; workspaceId: string }
  | { ok: false }

const SECRET_HEADER = 'x-background-worker-secret'

/**
 * If the secret header is present, authentication is decided exclusively by
 * that header (no fallback to session auth) — a present-but-wrong secret
 * must fail closed rather than silently trying the browser session path.
 */
export async function resolveJobsAuth(request: Request): Promise<JobsAuthResult> {
  const headerSecret = request.headers.get(SECRET_HEADER)
  if (headerSecret !== null) {
    const expectedSecret = process.env.BACKGROUND_WORKER_SECRET
    if (!expectedSecret) {
      console.warn('[jobs-auth] secret header was sent but BACKGROUND_WORKER_SECRET is not configured on this deployment.')
      return { ok: false }
    }
    if (headerSecret === expectedSecret) {
      return { ok: true, mode: 'system' }
    }
    console.warn('[jobs-auth] secret header was sent but did not match the configured BACKGROUND_WORKER_SECRET.')
    return { ok: false }
  }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) return { ok: false }
  return { ok: true, mode: 'session', workspaceId: member.workspace_id }
}
