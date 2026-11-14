import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isValidUuid } from '@/lib/pincode-monitoring/validation'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const workspaceId = params.get('workspaceId') ?? ''
  if (!isValidUuid(workspaceId)) return NextResponse.json({ error: 'Workspace required' }, { status: 400 })
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: member, error } = await db.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle()
  if (error || !member || !['owner', 'admin', 'member', 'viewer'].includes(member.role)) {
    return NextResponse.json({ error: 'Workspace access denied' }, { status: 403 })
  }
  const offset = Math.min(100_000, Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0))
  const search = (params.get('search') ?? '').trim().toUpperCase()
  if (search && !/^[A-Z0-9]{1,10}$/.test(search)) return NextResponse.json({ error: 'Search by ASIN or pincode' }, { status: 400 })
  let query = createAdminClient().from('pincode_availability_results')
    .select('id, asin, pincode, checked_at, availability_status, check_status, delivery_message, error_code, tracking_target_id', { count: 'exact' })
    .eq('workspace_id', workspaceId)
  if (search) query = query.or(`asin.ilike.%${search}%,pincode.ilike.%${search}%`)
  for (const key of ['from', 'to'] as const) {
    const value = params.get(key)
    if (!value) continue
    if (!Number.isFinite(Date.parse(value))) return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    query = key === 'from' ? query.gte('checked_at', new Date(value).toISOString()) : query.lt('checked_at', new Date(value).toISOString())
  }
  const { data, count, error: readError } = await query.order('checked_at', { ascending: false })
    .order('id', { ascending: false }).range(offset, offset + 49)
  if (readError) return NextResponse.json({ error: 'History could not be loaded. Try again.' }, { status: 503 })
  return NextResponse.json({ items: data, total: count ?? 0, offset, limit: 50 }, { headers: { 'Cache-Control': 'no-store' } })
}
