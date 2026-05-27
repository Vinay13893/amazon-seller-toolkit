/**
 * Service-role Supabase client — bypasses RLS entirely.
 *
 * Use ONLY in server-side code (API route handlers, Server Actions).
 * NEVER import this from a client component or expose the key to the browser.
 *
 * Setup: add to .env.local:
 *   SUPABASE_SERVICE_ROLE_KEY=<your service_role secret key>
 * Find it in: Supabase Dashboard → Settings → API → service_role (secret)
 */
import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set.\n' +
      'Go to Supabase Dashboard → Settings → API → service_role (secret) key.\n' +
      'Add it to .env.local as:  SUPABASE_SERVICE_ROLE_KEY=eyJ...',
    )
  }

  return createClient(url, key, {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  })
}
