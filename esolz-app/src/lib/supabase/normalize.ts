/**
 * Supabase foreign-key embeds can return either a single object or
 * an array depending on the relationship cardinality and query shape.
 *
 * Use this wherever you join a related table via select('..., table(col)'):
 *   const plan = normalizeEmbed<Plan>(raw.subscription_plans)
 *   const ws   = normalizeEmbed<Workspace>(raw.workspaces)
 *
 * Handles all three shapes Supabase may return:
 *   - null / undefined  → null
 *   - single object     → that object
 *   - array             → first element, or null if empty
 */
export function normalizeEmbed<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value[0] ?? null
  return value
}
