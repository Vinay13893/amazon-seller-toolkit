import dotenv from 'dotenv'
import express, { type Request, type Response } from 'express'
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

dotenv.config()

const app = express()
const port = Number.parseInt(process.env.PORT || '3001', 10)

app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'sociomonkey-checker-worker',
    version: '0.1.0',
  })
})

app.use(requireCheckerSecret)

const brandAnalyticsSyncRequestSchema = z.object({
  jobId: z.string().uuid(),
  batchSize: z.number().int().min(1).max(1000).optional(),
})

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

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    ok: false,
    status: 'failed',
    error_message: 'Route not found.',
  })
})

app.listen(port, () => {
  console.log(`[checker-worker] listening on port ${port}`)
})
