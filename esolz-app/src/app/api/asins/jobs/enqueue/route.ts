import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 30

const JOB_TYPE = 'product_page_snapshot'
const DEFAULT_CADENCE_HOURS = 24
const MAX_JOBS_PER_RUN = 200
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

const MARKETPLACE_ID_BY_MARKETPLACE: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
}

type NewJobRow = {
  workspace_id: string
  job_type: string
  target_type: 'my_product' | 'competitor_asin'
  target_id: string
  marketplace_id: string
  payload_json: { asin: string }
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id

  const [listingsResult, trackedResult, activeJobsResult] = await Promise.all([
    supabase
      .from('amazon_listing_items')
      .select('id, asin, marketplace_id')
      .eq('workspace_id', workspaceId)
      .not('asin', 'is', null)
      .limit(1000),
    supabase
      .from('tracked_asins')
      .select('id, asin, marketplace')
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .limit(1000),
    supabase
      .from('background_jobs')
      .select('target_type, target_id, status, completed_at')
      .eq('workspace_id', workspaceId)
      .eq('job_type', JOB_TYPE)
      .limit(2000),
  ])

  if (listingsResult.error || trackedResult.error || activeJobsResult.error) {
    return NextResponse.json({ error: 'Unable to read product/checker data.' }, { status: 503 })
  }

  const cadenceCutoff = Date.now() - DEFAULT_CADENCE_HOURS * 60 * 60 * 1000
  const skipKeys = new Set<string>()
  for (const job of activeJobsResult.data ?? []) {
    const key = `${job.target_type}:${job.target_id}`
    if (job.status === 'queued' || job.status === 'running') {
      skipKeys.add(key)
      continue
    }
    if (job.status === 'completed' && job.completed_at) {
      if (new Date(job.completed_at).getTime() > cadenceCutoff) skipKeys.add(key)
    }
  }

  const candidates: NewJobRow[] = []
  let totalActiveMyProducts = 0
  for (const listing of listingsResult.data ?? []) {
    if (!listing.asin) continue
    totalActiveMyProducts += 1
    const key = `my_product:${listing.id}`
    if (skipKeys.has(key)) continue
    candidates.push({
      workspace_id: workspaceId,
      job_type: JOB_TYPE,
      target_type: 'my_product',
      target_id: listing.id as string,
      marketplace_id: (listing.marketplace_id as string | null) ?? DEFAULT_MARKETPLACE_ID,
      payload_json: { asin: (listing.asin as string).toUpperCase() },
    })
  }

  let totalActiveCompetitors = 0
  for (const tracked of trackedResult.data ?? []) {
    totalActiveCompetitors += 1
    const key = `competitor_asin:${tracked.id}`
    if (skipKeys.has(key)) continue
    const marketplaceId = MARKETPLACE_ID_BY_MARKETPLACE[String(tracked.marketplace).toUpperCase()] ?? DEFAULT_MARKETPLACE_ID
    candidates.push({
      workspace_id: workspaceId,
      job_type: JOB_TYPE,
      target_type: 'competitor_asin',
      target_id: tracked.id as string,
      marketplace_id: marketplaceId,
      payload_json: { asin: String(tracked.asin).toUpperCase() },
    })
  }

  const jobsToInsert = candidates.slice(0, MAX_JOBS_PER_RUN)
  let insertedCount = 0
  if (jobsToInsert.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from('background_jobs')
      .insert(jobsToInsert)
      .select('id')

    if (insertError) {
      return NextResponse.json({ error: 'Unable to enqueue checker jobs.' }, { status: 503 })
    }
    insertedCount = inserted?.length ?? 0
  }

  const enqueuedMyProducts = jobsToInsert.filter(job => job.target_type === 'my_product').length
  const enqueuedCompetitors = jobsToInsert.filter(job => job.target_type === 'competitor_asin').length

  return NextResponse.json({
    jobType: JOB_TYPE,
    totalActiveMyProducts,
    totalActiveCompetitors,
    enqueuedMyProducts,
    enqueuedCompetitors,
    insertedCount,
    skippedAlreadyQueuedOrRecentlyChecked: skipKeys.size,
    candidatesExceedingCap: Math.max(0, candidates.length - jobsToInsert.length),
  })
}
