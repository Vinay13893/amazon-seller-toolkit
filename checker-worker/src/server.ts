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

dotenv.config()

const app = express()
const port = Number.parseInt(process.env.PORT || '3001', 10)
const TEMP_ALLOWED_DEBUG_JOB_ID = '58761e56-4034-4ee9-a976-3fc968cd8e5e'

const brandAnalyticsSyncRequestSchema = z.object({
  jobId: z.string().uuid(),
  batchSize: z.number().int().min(1).max(1000).optional(),
})

const brandAnalyticsStatusRequestSchema = z.object({
  jobId: z.string().uuid(),
})

type BrandAnalyticsSyncDebugSafeResult = {
  success: boolean
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
  processingStatus: string | null
  parsedRowCount: number | null
  storedRowCount: number | null
  rowCountByReportId: number | null
  rowCountByReportDocumentId: number | null
  brandAnalyticsRowsAppearStored: boolean | null
  failedStage: string | null
  errorCode: string | null
  errorMessage: string | null
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
    envPresence: getBrandAnalyticsSyncEnvPresence(),
    jobId: '',
    reportId: null,
    reportType: null,
    reportDocumentId: null,
    processingStatus: null,
    parsedRowCount: null,
    storedRowCount: null,
    rowCountByReportId: null,
    rowCountByReportDocumentId: null,
    brandAnalyticsRowsAppearStored: null,
    failedStage: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  }
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

    const result = await runBrandAnalyticsSync({ jobId })

    // Only return safe aggregate counts; no raw rows or downloaded content.
    const supabase = (await import('./brand-analytics/supabase')).createSupabaseAdminClient()
    const { count: countByReportId } = await supabase
      .from('brand_analytics_search_terms_rows')
      .select('*', { head: true, count: 'exact' })
      .eq('report_id', result.reportId ?? '__missing_report_id__')
    const { count: countByDocumentId } = await supabase
      .from('brand_analytics_search_terms_rows')
      .select('*', { head: true, count: 'exact' })
      .eq('report_document_id', result.reportDocumentId || '__missing_report_document_id__')

    const rowsAppearStored =
      (result.totalStoredRows ?? 0) > 0 ||
      (countByReportId ?? 0) > 0 ||
      (countByDocumentId ?? 0) > 0

    res.status(result.status === 'success' ? 200 : 500).json(createBrandAnalyticsSyncDebugSafeResult({
      success: result.status === 'success',
      jobId: result.jobId,
      reportId: result.reportId,
      reportType: result.reportType,
      reportDocumentId: result.reportDocumentId,
      processingStatus: result.status,
      parsedRowCount: result.totalParsedRows,
      storedRowCount: result.totalStoredRows,
      rowCountByReportId: countByReportId ?? 0,
      rowCountByReportDocumentId: countByDocumentId ?? 0,
      brandAnalyticsRowsAppearStored: rowsAppearStored,
      failedStage: result.status === 'success' ? 'success' : result.errorCode ?? 'sync_failed',
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
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
