import { createClient } from '@/lib/supabase/server'

/**
 * Get the currently authenticated user (server-side).
 * Returns null if not authenticated.
 */
export async function getUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) return null
  return user
}

/**
 * Get the current session (server-side).
 * Returns null if no active session.
 */
export async function getSession() {
  const supabase = await createClient()
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error) return null
  return session
}

/**
 * Get a simplified user profile from auth metadata.
 * Returns null if not authenticated.
 */
export async function getUserProfile() {
  const user = await getUser()
  if (!user) return null
  return {
    id: user.id,
    email: user.email ?? '',
    name: (user.user_metadata?.full_name as string) ?? user.email ?? 'User',
    avatarUrl: (user.user_metadata?.avatar_url as string) ?? null,
  }
}
