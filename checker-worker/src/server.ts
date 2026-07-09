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
} from './brand-analytics/status'
import {
  getScrapingJobStatus,
  runNextScrapingJob,
  scrapingJobStatusRequestSchema,
  scrapingRunNextRequestSchema,
} from './scraping/queue'
// productPageOrchestrator is intentionally NOT started anymore. Its 3-minute
// loop only pinged Vercel's /api/asins/jobs/enqueue and /api/asins/jobs/process-next
// routes, which do all the real work via Amazon SP-API. That responsibility now
// runs on a native Vercel Cron Job (esolz-app/vercel.json ->
// /api/cron/asins/process-product-snapshots, every 2 hours), so this Render
// worker no longer needs to drive that cadence. The file itself is left in
// place, unused, in case we ever need to restore it.

dotenv.config()

const app = express()
const port = Number.parseInt(process.env.PORT || '3001', 10)

const brandAnalyticsSyncRequestSchema = z.object({
  jobId: z.string().uuid(),
  batchSize: z.number().int().min(1).max(1000).optional(),
})

const brandAnalyticsStatusRequestSchema = z.object({
  jobId: z.string().uuid(),
})

app.use(express.json({ limit: '1mb' }))

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({
      ok: false,
      status: 'failed',
      error_message: 'Invalid JSON request body.',
    })
    return
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
      'POST /brand-analytics/status',
      'POST /scraping/run-next',
      'POST /scraping/job-status',
    ],
  })
})

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

app.post('/scraping/run-next', async (req: Request, res: Response) => {
  try {
    const payload = scrapingRunNextRequestSchema.parse(req.body ?? {})
    const result = await runNextScrapingJob(payload)
    const statusCode = result.status === 'idle' ? 200 : result.success ? 200 : 500
    res.status(statusCode).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        status: 'failed',
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid request payload for /scraping/run-next.',
      })
      return
    }

    res.status(500).json({
      success: false,
      status: 'failed',
      errorCode: 'scraping_run_next_failed',
      errorMessage: 'Scraping worker failed unexpectedly.',
    })
  }
})

app.post('/scraping/job-status', async (req: Request, res: Response) => {
  try {
    const payload = scrapingJobStatusRequestSchema.parse(req.body)
    const result = await getScrapingJobStatus(payload)
    res.status(result.success ? 200 : 500).json(result)
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid request payload for /scraping/job-status.',
      })
      return
    }

    res.status(500).json({
      success: false,
      errorCode: 'scraping_job_status_failed',
      errorMessage: 'Scraping job status failed unexpectedly.',
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
