/**
 * Server-side only — do NOT import from client components.
 *
 * Spawns scripts/rank_check_adapter.py as a child process.
 * Python executable resolved via the same strategy as amazon-bsr-adapter.ts:
 *   1. BSR_PYTHON_BIN env var
 *   2. Known venv candidates relative to process.cwd()
 *   3. Fallback: "python3"
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeywordRankResult {
  keyword:        string
  asin:           string
  organic_rank:   number | null
  organic_page:   number | null
  organic_slot:   number | null
  organic_found:  boolean
  page_number:    number | null
  pos_on_page:    number | null
  is_sponsored:   boolean
  sponsored_rank: number | null
  sponsored_page: number | null
  sponsored_slot: number | null
  sponsored_found: boolean
  page_status:    'page_1' | 'page_2' | 'page_3' | 'not_ranking'
  scan_status:    string
  checked_at:     string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS  = 90_000   // 90 s — Playwright + network latency
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'rank_check_adapter.py')
export const KEYWORD_RUNTIME_UNAVAILABLE_ERROR = 'Keyword rank checker runtime is not available in this deployment.'

type AttemptSource = 'env' | 'default' | 'fallback'

interface BinaryAttempt {
  binary: string
  source: AttemptSource
}

class KeywordRuntimeUnavailableError extends Error {
  attemptedBinaries: BinaryAttempt[]

  constructor(attemptedBinaries: BinaryAttempt[]) {
    super(KEYWORD_RUNTIME_UNAVAILABLE_ERROR)
    this.name = 'KeywordRuntimeUnavailableError'
    this.attemptedBinaries = attemptedBinaries
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveInitialPythonAttempt(): BinaryAttempt {
  if (process.env.KEYWORD_PYTHON_BIN?.trim()) {
    return { binary: process.env.KEYWORD_PYTHON_BIN.trim(), source: 'env' }
  }
  // Keep a consistent default probe order across environments:
  // try python3 first, then fallback to python if unavailable.
  return { binary: 'python3', source: 'default' }
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const maybeErr = err as NodeJS.ErrnoException
  return maybeErr.code === 'ENOENT'
}

function shouldRetryWithPython(attempt: BinaryAttempt, err: unknown): boolean {
  return attempt.binary === 'python3' && isEnoent(err)
}

function toMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Unknown checker failure'
}

function runCheckerWithBinary(
  keyword: string,
  asin: string,
  marketplace: string,
  pages: number,
  attempt: BinaryAttempt,
): Promise<KeywordRankResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      attempt.binary,
      [
        SCRIPT_PATH,
        '--keyword',     keyword,
        '--asin',        asin,
        '--marketplace', marketplace,
        '--pages',       String(pages),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`rank_check_adapter.py timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.resume()

    proc.on('close', (code) => {
      clearTimeout(timer)
      const raw = stdout.trim()
      if (!raw) {
        reject(new Error(
          `Keyword rank checker produced no output (code ${code ?? 'unknown'}).`,
        ))
        return
      }
      try {
        const parsed = JSON.parse(raw) as KeywordRankResult
        resolve(parsed)
      } catch {
        reject(new Error('Keyword rank checker returned an invalid response.'))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function isKeywordRuntimeUnavailableError(err: unknown): err is KeywordRuntimeUnavailableError {
  return err instanceof KeywordRuntimeUnavailableError
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Runs rank_check_adapter.py for a single keyword+ASIN pair.
 * Returns the parsed JSON result from stdout.
 */
export function checkKeywordRank(
  keyword:     string,
  asin:        string,
  marketplace: string,
  pages = 7,
): Promise<KeywordRankResult> {
  if (process.env.NODE_ENV === 'production') {
    return Promise.reject(
      new KeywordRuntimeUnavailableError([]),
    )
  }
  return new Promise((resolve, reject) => {
    const initialAttempt = resolveInitialPythonAttempt()
    const attempts: BinaryAttempt[] = [initialAttempt]

    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new Error('Keyword rank checker runtime is missing.'))
      return
    }

    runCheckerWithBinary(keyword, asin, marketplace, pages, initialAttempt)
      .then(resolve)
      .catch((firstErr: unknown) => {
        if (shouldRetryWithPython(initialAttempt, firstErr)) {
          const fallbackAttempt: BinaryAttempt = { binary: 'python', source: 'fallback' }
          attempts.push(fallbackAttempt)
          runCheckerWithBinary(keyword, asin, marketplace, pages, fallbackAttempt)
            .then(resolve)
            .catch((fallbackErr: unknown) => {
              if (isEnoent(fallbackErr)) {
                reject(new KeywordRuntimeUnavailableError(attempts))
                return
              }
              reject(new Error(`Keyword rank checker failed (${fallbackAttempt.binary}): ${toMessage(fallbackErr)}`))
            })
          return
        }

        if (isEnoent(firstErr)) {
          reject(new KeywordRuntimeUnavailableError(attempts))
          return
        }
        reject(new Error(`Keyword rank checker failed (${initialAttempt.binary}): ${toMessage(firstErr)}`))
      })
  })
}
