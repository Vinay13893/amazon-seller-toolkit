import type { NextFunction, Request, Response } from 'express'

const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 30

type WindowBucket = {
  count: number
  resetAt: number
}

const requestWindows = new Map<string, WindowBucket>()

function getClientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown'
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function applyRateLimit(req: Request, res: Response): boolean {
  const now = Date.now()
  const key = getClientKey(req)
  const current = requestWindows.get(key)

  if (!current || current.resetAt <= now) {
    requestWindows.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }

  if (current.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    res.setHeader('Retry-After', retryAfter.toString())
    res.status(429).json({
      ok: false,
      status: 'failed',
      error_message: 'Rate limit exceeded. Please retry shortly.',
    })
    return false
  }

  current.count += 1
  return true
}

export function requireCheckerSecret(req: Request, res: Response, next: NextFunction): void {
  const expectedSecret = process.env.CHECKER_WORKER_SECRET
  if (!expectedSecret) {
    res.status(500).json({
      ok: false,
      status: 'failed',
      error_message: 'Checker worker is misconfigured: missing CHECKER_WORKER_SECRET.',
    })
    return
  }

  const providedSecret = req.header('x-checker-secret')
  if (!providedSecret || providedSecret !== expectedSecret) {
    res.status(401).json({
      ok: false,
      status: 'failed',
      error_message: 'Unauthorized',
    })
    return
  }

  if (!applyRateLimit(req, res)) {
    return
  }

  next()
}
