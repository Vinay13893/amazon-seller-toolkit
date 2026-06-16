import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import { ZodError } from 'zod'
import { z } from 'zod'
import { requireCheckerSecret } from './middleware/auth'
import {
  keywordRankRequestSchema,
  runKeywordRankCheck,
} from './checkers/keywordRank'
import {
  pincodeAvailabilityRequestSchema,
  runPincodeAvailabilityCheck,
} from './checkers/pincodeAvailability'
import { runBrandAnalyticsSync } from './brand-analytics/sync'
import {
  getBrandAnalyticsStatus,
  getBrandAnalyticsStatusDebug,
} from './brand-analytics/status'
import {
  createSupabaseAdminClient,
  getBrandAnalyticsJob,
} from './brand-analytics/supabase'

dotenv.config()

const app = express()
const port = Number.parseInt(process.env.PORT || '3001', 10)
const TEMP_ALLOWED_DEBUG_JOB_ID = '58761e56-4034-4ee9-a976-3fc968cd8e5e'
const tempBrandAnalyticsSyncRuns = new Map<string, {
  status: 'queued' | 'running' | 'done' | 'failed'
  updatedAt: string
  errorCode: string | null
  errorMessage: string | null
}>()

const brandAnalyticsSyncRequestSchema = z.object({
  jobId: z.string().uuid(),
  batchSize: z.number().int().min(1).max(1000).optional(),
})

const brandAnalyticsStatusRequestSchema = z.object({
  jobId: z.string().uuid(),
})

type BrandAnalyticsSyncDebugSafeResult = {
  success: boolean
  message: string | null
  envPresence: {
    hasSupabaseUrl: boolean
    hasSupabaseServiceRoleKey: boolean
    hasSpapiEncryptionKey: boolean
    hasSpapiLwaClientId: boolean
    hasSpapiLwaClientSecret: boolean
  }
  jobId: string
  reportId: string | null
  reportType: string | null
  reportDocumentId: string | null
  targetTable: string | null
  processingStatus: string | null
  parsedRowCount: number | null
  rowsPreparedForInsertCount: number | null
  storedRowCount: number | null
  rowCountByReportId: number | null
  rowCountByReportDocumentId: number | null
  brandAnalyticsRowsAppearStored: boolean | null
  failedStage: string | null
  errorCode: string | null
  errorMessage: string | null
  dbErrorCode: string | null
  dbErrorHint: string | null
  dbErrorMessage: string | null
  parsedFieldNames: string[]
  insertColumnNames: string[]
  missingRequiredColumns: string[]
  unsupportedReportType: boolean
}

function getBrandAnalyticsSyncEnvPresence(): BrandAnalyticsSyncDebugSafeResult['envPresence'] {
  return {
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL?.trim()),
    hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    hasSpapiEncryptionKey: Boolean(process.env.SPAPI_ENCRYPTION_KEY?.trim()),
    hasSpapiLwaClientId: Boolean(process.env.SPAPI_LWA_CLIENT_ID?.trim()),
    hasSpapiLwaClientSecret: Boolean(process.env.SPAPI_LWA_CLIENT_SECRET?.trim()),
  }
}

function createBrandAnalyticsSyncDebugSafeResult(
  overrides: Partial<BrandAnalyticsSyncDebugSafeResult>,
): BrandAnalyticsSyncDebugSafeResult {
  return {
    success: false,
    message: null,
    envPresence: getBrandAnalyticsSyncEnvPresence(),
    jobId: '',
    reportId: null,
    reportType: null,
    reportDocumentId: null,
    targetTable: null,
    processingStatus: null,
    parsedRowCount: null,
    rowsPreparedForInsertCount: null,
    storedRowCount: null,
    rowCountByReportId: null,
    rowCountByReportDocumentId: null,
    brandAnalyticsRowsAppearStored: null,
    failedStage: null,
    errorCode: null,
    errorMessage: null,
    dbErrorCode: null,
    dbErrorHint: null,
    dbErrorMessage: null,
    parsedFieldNames: [],
    insertColumnNames: [],
    missingRequiredColumns: [],
    unsupportedReportType: false,
    ...overrides,
  }
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

async function getSafeBrandAnalyticsRowCounts(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  reportId: string | null | undefined,
  reportDocumentId: string | null | undefined,
): Promise<{ rowCountByReportId: number | null; rowCountByReportDocumentId: number | null }> {
  let rowCountByReportId: number | null = null
  let rowCountByReportDocumentId: number | null = null

  if (reportId) {
    try {
      const { count } = await supabase
        .from('brand_analytics_search_terms_rows')
        .select('*', { head: true, count: 'exact' })
        .eq('report_id', reportId)
      rowCountByReportId = count ?? null
    } catch {
      rowCountByReportId = null
    }
  }

  if (reportDocumentId) {
    try {
      const { count } = await supabase
        .from('brand_analytics_search_terms_rows')
        .select('*', { head: true, count: 'exact' })
        .eq('report_document_id', reportDocumentId)
      rowCountByReportDocumentId = count ?? null
    } catch {
      rowCountByReportDocumentId = null
    }
  }

  return { rowCountByReportId, rowCountByReportDocumentId }
}

app.use(express.json({ limit: '1mb' }))

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) {
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : ''

    if (req.path === '/brand-analytics/sync-debug-temp') {
      res.status(400).json(createBrandAnalyticsSyncDebugSafeResult({
        failedStage: 'invalid_json',
        jobId,
        errorCode: 'invalid_json',
        errorMessage: 'Invalid JSON request body.',
      }))
      return
    }

    if (req.path === '/brand-analytics/status-debug-temp') {
      res.status(400).json({
        success: false,
        failedStage: 'invalid_json',
        envPresence: {
          hasSupabaseUrl: Boolean(process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()),
          hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
        },
        jobId,
        reportId: null,
        reportType: null,
        reportDocumentId: null,
        jobProcessingStatus: null,
        jobParsedRowCount: null,
        jobStoredRowCount: null,
        documentProcessingStatus: null,
        documentStoredRowCount: null,
        rowCountByReportId: null,
        rowCountByReportDocumentId: null,
        brandAnalyticsRowsAppearStored: null,
        errorCode: 'invalid_json',
        errorMessage: 'Invalid JSON request body.',
      })
      return
    }
  }

  next(error)
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'sociomonkey-checker-worker',
    version: '0.1.0',
    buildMarker: 'ba-debug-health-marker-20260616-d007072',
    availableRoutes: [
      'GET /health',
      'GET /debug/routes',
      'POST /brand-analytics/status',
      'POST /brand-analytics/status-debug-temp',
    ],
  })
})

const publicDebugRouter = express.Router()

// TODO TEMPORARY DEBUG ROUTE REMOVE BEFORE PRODUCTION
publicDebugRouter.get('/debug/routes', (_req: Request, res: Response) => {
  res.json({
    success: true,
    service: 'sociomonkey-checker-worker',
    version: '0.1.0',
    availableRoutes: [
      'GET /health',
      'POST /brand-analytics/status',
      'POST /brand-analytics/status-debug-temp',
      'POST /brand-analytics/sync-debug-temp',
      'POST /brand-analytics/sync-status-debug-temp',
      'GET /debug/routes',
    ],
  })
})

// TODO TEMPORARY DEBUG ROUTE REMOVE BEFORE PRODUCTION
publicDebugRouter.post('/brand-analytics/status-debug-temp', async (req: Request, res: Response) => {
  try {
    const payload = brandAnalyticsStatusRequestSchema.parse(req.body)

    if (payload.jobId !== TEMP_ALLOWED_DEBUG_JOB_ID) {
      res.status(403).json({
        success: false,
        failedStage: 'job_not_allowed',
        envPresence: {
          hasSupabaseUrl: Boolean(process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()),
          hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
        },
        jobId: payload.jobId,
        reportId: null,
        reportType: null,
        reportDocumentId: null,
        jobProcessingStatus: null,
        jobParsedRowCount: null,
        jobStoredRowCount: null,
        documentProcessingStatus: null,
        documentStoredRowCount: null,
        rowCountByReportId: null,
        rowCountByReportDocumentId: null,
        brandAnalyticsRowsAppearStored: null,
        errorCode: 'job_not_allowed',
        errorMessage: 'Only the temporary debug jobId is allowed.',
      })
      return
    }

    const result = await getBrandAnalyticsStatusDebug(payload)
    const statusCode = result.success ? 200 : 500
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        failedStage: 'invalid_payload',
        envPresence: {
          hasSupabaseUrl: Boolean(process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()),
          hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
        },
        jobId: typeof req.body?.jobId === 'string' ? req.body.jobId : '',
        reportId: null,
        reportType: null,
        reportDocumentId: null,
        jobProcessingStatus: null,
        jobParsedRowCount: null,
        jobStoredRowCount: null,
        documentProcessingStatus: null,
        documentStoredRowCount: null,
        rowCountByReportId: null,
        rowCountByReportDocumentId: null,
        brandAnalyticsRowsAppearStored: null,
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid request payload for /brand-analytics/status-debug-temp.',
      })
      return
    }

    res.status(500).json({
      success: false,
      failedStage: 'read_job_failed',
      envPresence: {
        hasSupabaseUrl: Boolean(process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()),
        hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      },
      jobId: typeof req.body?.jobId === 'string' ? req.body.jobId : '',
      reportId: null,
      reportType: null,
      reportDocumentId: null,
      jobProcessingStatus: null,
      jobParsedRowCount: null,
      jobStoredRowCount: null,
      documentProcessingStatus: null,
      documentStoredRowCount: null,
      rowCountByReportId: null,
      rowCountByReportDocumentId: null,
      brandAnalyticsRowsAppearStored: null,
      errorCode: 'read_job_failed',
      errorMessage: 'Brand Analytics status debug failed unexpectedly.',
    })
  }
})

// TODO TEMPORARY DEBUG ROUTE REMOVE BEFORE PRODUCTION
publicDebugRouter.post('/brand-analytics/sync-debug-temp', async (req: Request, res: Response) => {
  let jobId: string | undefined
  try {
    const payload = brandAnalyticsStatusRequestSchema.parse(req.body)
    jobId = payload.jobId

    if (jobId !== TEMP_ALLOWED_DEBUG_JOB_ID) {
      res.status(403).json(createBrandAnalyticsSyncDebugSafeResult({
        failedStage: 'job_not_allowed',
        jobId,
        errorCode: 'job_not_allowed',
        errorMessage: 'Only the temporary debug jobId is allowed.',
      }))
      return
    }

    const supabase = createSupabaseAdminClient()
    const job = await getBrandAnalyticsJob(supabase, jobId)
    if (!job) {
      res.status(404).json(createBrandAnalyticsSyncDebugSafeResult({
        failedStage: 'job_not_found',
        jobId,
        errorCode: 'job_not_found',
        errorMessage: 'Brand Analytics sync failed: job not found.',
      }))
      return
    }

    const { rowCountByReportId, rowCountByReportDocumentId } =
      await getSafeBrandAnalyticsRowCounts(supabase, job.report_id, job.report_document_id)

    const currentRun = tempBrandAnalyticsSyncRuns.get(jobId)
    if (!currentRun || currentRun.status === 'done' || currentRun.status === 'failed') {
      const startedAt = new Date().toISOString()
      tempBrandAnalyticsSyncRuns.set(jobId, {
        status: 'queued',
        updatedAt: startedAt,
        errorCode: null,
        errorMessage: null,
      })

      void (async () => {
        tempBrandAnalyticsSyncRuns.set(jobId!, {
          status: 'running',
          updatedAt: new Date().toISOString(),
          errorCode: null,
          errorMessage: null,
        })
        const result = await runBrandAnalyticsSync({ jobId: jobId!, batchSize: 5000 })
        tempBrandAnalyticsSyncRuns.set(jobId!, {
          status: result.status === 'success' ? 'done' : 'failed',
          updatedAt: new Date().toISOString(),
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        })
      })().catch(() => {
        tempBrandAnalyticsSyncRuns.set(jobId!, {
          status: 'failed',
          updatedAt: new Date().toISOString(),
          errorCode: 'sync_failed',
          errorMessage: 'Brand Analytics sync failed.',
        })
      })
    }

    res.status(202).json(createBrandAnalyticsSyncDebugSafeResult({
      success: true,
      message: 'sync started',
      jobId,
      reportId: job.report_id,
      reportType: job.report_type,
      reportDocumentId: job.report_document_id,
      processingStatus: tempBrandAnalyticsSyncRuns.get(jobId)?.status ?? 'queued',
      rowCountByReportId,
      rowCountByReportDocumentId,
      brandAnalyticsRowsAppearStored: (rowCountByReportId ?? 0) > 0 || (rowCountByReportDocumentId ?? 0) > 0,
      failedStage: null,
      errorCode: null,
      errorMessage: null,
    }))
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json(createBrandAnalyticsSyncDebugSafeResult({
        failedStage: 'invalid_payload',
        jobId: typeof req.body?.jobId === 'string' ? req.body.jobId : '',
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid request payload for /brand-analytics/sync-debug-temp.',
      }))
      return
    }
    res.status(500).json(createBrandAnalyticsSyncDebugSafeResult({
      failedStage: 'sync_failed',
      jobId: jobId ?? '',
      errorCode: 'sync_failed',
      errorMessage: 'Brand Analytics sync debug failed unexpectedly.',
    }))
  }
})

// TODO TEMPORARY DEBUG ROUTE REMOVE BEFORE PRODUCTION
publicDebugRouter.post('/brand-analytics/sync-status-debug-temp', async (req: Request, res: Response) => {
  try {
    const payload = brandAnalyticsStatusRequestSchema.parse(req.body)

    if (payload.jobId !== TEMP_ALLOWED_DEBUG_JOB_ID) {
      res.status(403).json({
        success: false,
        jobId: payload.jobId,
        syncStatus: 'unknown',
        failedStage: 'job_not_allowed',
        errorCode: 'job_not_allowed',
        errorMessage: 'Only the temporary debug jobId is allowed.',
      })
      return
    }

    const supabase = createSupabaseAdminClient()
    const job = await getBrandAnalyticsJob(supabase, payload.jobId)
    if (!job) {
      res.status(404).json({
        success: false,
        jobId: payload.jobId,
        syncStatus: 'unknown',
        failedStage: 'job_not_found',
        errorCode: 'job_not_found',
        errorMessage: 'Brand Analytics sync failed: job not found.',
      })
      return
    }

    const summary = job.raw_summary ?? {}
    const run = tempBrandAnalyticsSyncRuns.get(payload.jobId)
    const { rowCountByReportId, rowCountByReportDocumentId } =
      await getSafeBrandAnalyticsRowCounts(supabase, job.report_id, job.report_document_id)
    const parsedRowCount = toNullableNumber(summary.parsed_row_count)
    const storedRowCount = toNullableNumber(summary.stored_row_count)
    const summaryStatus = toNullableString(summary.sync_status)
    const syncStatus =
      run?.status ??
      (summaryStatus === 'queued' || summaryStatus === 'running' || summaryStatus === 'done' || summaryStatus === 'failed'
        ? summaryStatus
        : 'unknown')

    res.status(200).json({
      success: true,
      jobId: job.id,
      reportId: job.report_id,
      reportType: job.report_type,
      reportDocumentId: job.report_document_id,
      syncStatus,
      parsedRowCount,
      storedRowCount,
      rowCountByReportId,
      rowCountByReportDocumentId,
      brandAnalyticsRowsAppearStored:
        (storedRowCount ?? 0) > 0 ||
        (rowCountByReportId ?? 0) > 0 ||
        (rowCountByReportDocumentId ?? 0) > 0,
      failedStage: toNullableString(summary.last_failed_stage),
      errorCode: run?.errorCode ?? toNullableString(summary.last_error_code),
      errorMessage: run?.errorMessage ?? null,
      updatedAt: run?.updatedAt ?? toNullableString(summary.sync_updated_at),
    })
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        jobId: typeof req.body?.jobId === 'string' ? req.body.jobId : '',
        syncStatus: 'unknown',
        failedStage: 'invalid_payload',
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid request payload for /brand-analytics/sync-status-debug-temp.',
      })
      return
    }
    res.status(500).json({
      success: false,
      jobId: typeof req.body?.jobId === 'string' ? req.body.jobId : '',
      syncStatus: 'unknown',
      failedStage: 'sync_failed',
      errorCode: 'sync_failed',
      errorMessage: 'Brand Analytics sync status debug failed unexpectedly.',
    })
  }
})

app.use(publicDebugRouter)

app.use(requireCheckerSecret)

app.post('/keyword-rank', async (req: Request, res: Response) => {
  try {
    const payload = keywordRankRequestSchema.parse(req.body)
    const result = await runKeywordRankCheck(payload)
    const statusCode = result.ok ? 200 : result.status === 'blocked' ? 429 : 502
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        ok: false,
        status: 'failed',
        error_message: 'Invalid request payload for /keyword-rank.',
        details: error.flatten(),
      })
      return
    }

    res.status(500).json({
      ok: false,
      status: 'failed',
      error_message: 'Keyword rank check failed unexpectedly.',
    })
  }
})

app.post('/pincode-availability', async (req: Request, res: Response) => {
  try {
    const payload = pincodeAvailabilityRequestSchema.parse(req.body)
    const result = await Promise.race([
      runPincodeAvailabilityCheck(payload),
      new Promise<Awaited<ReturnType<typeof runPincodeAvailabilityCheck>>>(resolve => {
        setTimeout(() => {
          resolve({
            ok: false,
            available: null,
            delivery_promise: null,
            price: null,
            seller: null,
            status: 'failed',
            error_message: 'Pincode check timed out before availability could be confirmed.',
          })
        }, 45_000)
      }),
    ])

    const statusCode = result.status === 'blocked' ? 429 : 200
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        ok: false,
        status: 'failed',
        error_message: 'Invalid request payload for /pincode-availability.',
        details: error.flatten(),
      })
      return
    }

    res.status(500).json({
      ok: false,
      status: 'failed',
      error_message: 'Pincode availability check failed unexpectedly.',
    })
  }
})

app.post('/brand-analytics/sync', async (req: Request, res: Response) => {
  try {
    const payload = brandAnalyticsSyncRequestSchema.parse(req.body)
    const result = await runBrandAnalyticsSync(payload)

    const statusCode = result.status === 'success' ? 200 : 500
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        status: 'failed',
        error: 'Invalid request payload for /brand-analytics/sync.',
        details: error.flatten(),
      })
      return
    }

    res.status(500).json({
      status: 'failed',
      error: 'Brand Analytics sync failed unexpectedly.',
    })
  }
})

app.post('/brand-analytics/status', async (req: Request, res: Response) => {
  try {
    const payload = brandAnalyticsStatusRequestSchema.parse(req.body)
    const result = await getBrandAnalyticsStatus(payload)

    const statusCode = result.success ? 200 : 500
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        errorCode: 'invalid_request',
        errorMessage: 'Invalid request payload for /brand-analytics/status.',
        details: error.flatten(),
      })
      return
    }

    res.status(500).json({
      success: false,
      errorCode: 'status_failed',
      errorMessage: 'Brand Analytics status failed unexpectedly.',
    })
  }
})

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    ok: false,
    status: 'failed',
    error_message: 'Route not found.',
  })
})

app.listen(port, () => {
  console.log(`[checker-worker] listening on port ${port}`)
  console.log('[checker-worker] route enabled: POST /brand-analytics/status')
})
