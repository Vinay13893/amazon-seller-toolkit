import { z } from 'zod'
import { runPincodeAvailabilityCheck } from '../checkers/pincodeAvailability'
import { createSupabaseAdminClient } from '../brand-analytics/supabase'

const JOB_TYPE_PINCODE_AVAILABILITY = 'PINCODE_AVAILABILITY_CHECK'
const WORKER_ID = process.env.RENDER_SERVICE_NAME || 'checker-worker'
const MAX_ASINS = 3
const MAX_PINCODES = 5

const pincodePayloadSchema = z.object({
  marketplaceId: z.string().min(1),
  asins: z.array(z.string().min(1)).min(1).max(MAX_ASINS),
  pincodes: z.array(z.string().regex(/^\d{6}$/)).min(1).max(MAX_PINCODES),
})

const jobStatusSchema = z.object({
  jobId: z.string().uuid(),
})

const runNextSchema = z.object({
  jobId: z.string().uuid().optional(),
})

export const scrapingJobStatusRequestSchema = jobStatusSchema
export const scrapingRunNextRequestSchema = runNextSchema

type ScrapingJobRow = {
  id: string
  workspace_id: string
  job_type: string
  status: string
  payload: unknown
  progress_current: number | null
  progress_total: number | null
  attempts: number | null
  max_attempts: number | null
  result_summary: Record<string, unknown> | null
  error_code: string | null
  error_message: string | null
  locked_at: string | null
  locked_by: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string | null
  updated_at: string | null
}

type PincodeResultPayload = {
  job_id: string
  workspace_id: string
  marketplace_id: string
  asin: string
  pincode: string
  availability_status: string
  delivery_message_category: string
  delivery_message: string | null
  price_detected: boolean
  buy_box_detected: boolean
  seller_name: string | null
  checked_at: string
  error_code: string | null
  error_message: string | null
}

function sanitizeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
}

function normalizeMarketplace(value: string): string {
  const normalized = value.trim()
  if (normalized === 'A21TJRUUN4KGV') return 'amazon.in'
  if (normalized.toLowerCase() === 'in') return 'amazon.in'
  return normalized
}

function toAvailabilityStatus(status: string, available: boolean | null): string {
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'unknown'
  if (available === true) return 'available'
  if (available === false) return 'unavailable'
  return 'unknown'
}

function categorizeDeliveryMessage(status: string, available: boolean | null): string {
  if (status === 'blocked') return 'blocked_or_captcha'
  if (available === true) return 'available'
  if (available === false) return 'unavailable'
  return 'unknown'
}

function safeJob(row: ScrapingJobRow | null, resultCount = 0) {
  if (!row) {
    return {
      success: false,
      job: null,
      results: [],
      errorCode: 'job_not_found',
      errorMessage: 'Scraping job was not found.',
    }
  }

  return {
    success: true,
    job: {
      id: row.id,
      jobType: row.job_type,
      status: row.status,
      progressCurrent: row.progress_current ?? 0,
      progressTotal: row.progress_total ?? 0,
      attempts: row.attempts ?? 0,
      maxAttempts: row.max_attempts ?? 0,
      resultSummary: row.result_summary ?? null,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    resultCount,
  }
}

async function markJobFailed(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  summary: Record<string, unknown> = {},
) {
  const supabase = createSupabaseAdminClient()
  await supabase
    .from('scraping_jobs')
    .update({
      status: 'failed',
      error_code: errorCode,
      error_message: sanitizeErrorMessage(errorMessage),
      result_summary: summary,
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq('id', jobId)
}

export async function runNextScrapingJob(input?: z.infer<typeof runNextSchema>) {
  const supabase = createSupabaseAdminClient()

  let queuedQuery = supabase
    .from('scraping_jobs')
    .select('*')
    .eq('status', 'queued')
    .eq('job_type', JOB_TYPE_PINCODE_AVAILABILITY)
    .order('created_at', { ascending: true })
    .limit(1)

  if (input?.jobId) {
    queuedQuery = queuedQuery.eq('id', input.jobId)
  }

  const { data: queued, error: readError } = await queuedQuery
    .maybeSingle()

  if (readError) {
    return {
      success: false,
      status: 'failed',
      errorCode: 'queue_read_failed',
      errorMessage: 'Unable to read queued scraping jobs.',
    }
  }

  const job = queued as ScrapingJobRow | null
  if (!job) {
    return {
      success: true,
      status: 'idle',
      message: 'No queued pincode availability jobs found.',
    }
  }

  const parsedPayload = pincodePayloadSchema.safeParse(job.payload)
  if (!parsedPayload.success) {
    await markJobFailed(job.id, 'invalid_payload', 'Scraping job payload is invalid.')
    return {
      success: false,
      status: 'failed',
      jobId: job.id,
      errorCode: 'invalid_payload',
      errorMessage: 'Scraping job payload is invalid.',
    }
  }

  const payload = parsedPayload.data
  const total = payload.asins.length * payload.pincodes.length
  const lockedAt = new Date().toISOString()
  const attempts = (job.attempts ?? 0) + 1

  const { data: lockedRows, error: lockError } = await supabase
    .from('scraping_jobs')
    .update({
      status: 'running',
      locked_at: lockedAt,
      locked_by: WORKER_ID,
      started_at: job.started_at ?? lockedAt,
      attempts,
      progress_total: total,
      error_code: null,
      error_message: null,
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('*')

  if (lockError || !Array.isArray(lockedRows) || lockedRows.length === 0) {
    return {
      success: false,
      status: 'failed',
      jobId: job.id,
      errorCode: 'job_lock_failed',
      errorMessage: 'Unable to lock queued scraping job.',
    }
  }

  let progress = 0
  let available = 0
  let unavailable = 0
  let unknown = 0
  const results: PincodeResultPayload[] = []

  try {
    for (const asinInput of payload.asins) {
      const asin = asinInput.trim().toUpperCase()

      for (const pincode of payload.pincodes) {
        const checkedAt = new Date().toISOString()
        const result = await runPincodeAvailabilityCheck({
          workspace_id: job.workspace_id,
          tracked_asin_id: job.id,
          asin,
          marketplace: normalizeMarketplace(payload.marketplaceId),
          pincode,
        })

        const availabilityStatus = toAvailabilityStatus(result.status, result.available)
        const diagnostics = result.diagnostics ?? {
          buy_box_selector_found: Boolean(result.seller),
        }
        if (availabilityStatus === 'available') available += 1
        else if (availabilityStatus === 'unavailable') unavailable += 1
        else unknown += 1

        results.push({
          job_id: job.id,
          workspace_id: job.workspace_id,
          marketplace_id: payload.marketplaceId,
          asin,
          pincode,
          availability_status: availabilityStatus,
          delivery_message_category: categorizeDeliveryMessage(result.status, result.available),
          delivery_message: result.delivery_promise,
          price_detected: result.price !== null,
          buy_box_detected: Boolean(diagnostics.buy_box_selector_found),
          seller_name: result.seller,
          checked_at: checkedAt,
          error_code: result.error_code ?? (result.ok ? null : result.status),
          error_message: sanitizeErrorMessage(result.error_message),
        })

        progress += 1
        await supabase
          .from('scraping_jobs')
          .update({
            progress_current: progress,
            result_summary: {
              total,
              available,
              unavailable,
              unknown,
            },
          })
          .eq('id', job.id)
      }
    }

    if (results.length > 0) {
      const { error: insertError } = await supabase
        .from('pincode_availability_results')
        .insert(results)

      if (insertError) {
        await markJobFailed(job.id, 'result_insert_failed', 'Unable to store structured pincode results.', {
          total,
          available,
          unavailable,
          unknown,
        })
        return {
          success: false,
          status: 'failed',
          jobId: job.id,
          errorCode: 'result_insert_failed',
          errorMessage: 'Unable to store structured pincode results.',
        }
      }
    }

    const completedAt = new Date().toISOString()
    await supabase
      .from('scraping_jobs')
      .update({
        status: 'done',
        progress_current: total,
        progress_total: total,
        result_summary: {
          total,
          available,
          unavailable,
          unknown,
        },
        completed_at: completedAt,
        locked_at: null,
        locked_by: null,
      })
      .eq('id', job.id)

    return {
      success: true,
      status: 'done',
      jobId: job.id,
      progressCurrent: total,
      progressTotal: total,
      resultSummary: {
        total,
        available,
        unavailable,
        unknown,
      },
    }
  } catch {
    const canRetry = attempts < (job.max_attempts ?? 2)
    const nextStatus = canRetry ? 'queued' : 'failed'
    await supabase
      .from('scraping_jobs')
      .update({
        status: nextStatus,
        error_code: 'checker_failed',
        error_message: 'Pincode availability checker failed safely.',
        progress_current: progress,
        progress_total: total,
        result_summary: {
          total,
          available,
          unavailable,
          unknown,
        },
        completed_at: canRetry ? null : new Date().toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq('id', job.id)

    return {
      success: false,
      status: nextStatus,
      jobId: job.id,
      errorCode: 'checker_failed',
      errorMessage: 'Pincode availability checker failed safely.',
      progressCurrent: progress,
      progressTotal: total,
    }
  }
}

export async function getScrapingJobStatus(input: z.infer<typeof scrapingJobStatusRequestSchema>) {
  const supabase = createSupabaseAdminClient()

  const { data: jobData, error: jobError } = await supabase
    .from('scraping_jobs')
    .select('*')
    .eq('id', input.jobId)
    .maybeSingle()

  if (jobError) {
    return {
      success: false,
      errorCode: 'job_read_failed',
      errorMessage: 'Unable to read scraping job status.',
    }
  }

  const job = jobData as ScrapingJobRow | null
  if (!job) return safeJob(null)

  const { data: resultsData, error: resultsError } = await supabase
    .from('pincode_availability_results')
    .select('asin, pincode, availability_status, delivery_message_category, delivery_message, price_detected, buy_box_detected, seller_name, checked_at, error_code, error_message')
    .eq('job_id', input.jobId)
    .order('checked_at', { ascending: false })
    .limit(25)

  if (resultsError) {
    return {
      ...safeJob(job, 0),
      results: [],
      errorCode: 'results_read_failed',
      errorMessage: 'Unable to read structured pincode results.',
    }
  }

  return {
    ...safeJob(job, Array.isArray(resultsData) ? resultsData.length : 0),
    results: resultsData ?? [],
  }
}
