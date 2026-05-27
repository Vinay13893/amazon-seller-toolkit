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
  page_number:    number | null
  pos_on_page:    number | null
  is_sponsored:   boolean
  sponsored_rank: number | null
  page_status:    'page_1' | 'page_2' | 'page_3' | 'not_ranking'
  scan_status:    string
  checked_at:     string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS  = 90_000   // 90 s — Playwright + network latency
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'rank_check_adapter.py')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPythonBin(): string {
  if (process.env.BSR_PYTHON_BIN) return process.env.BSR_PYTHON_BIN

  const candidates = [
    path.resolve(process.cwd(), '..', 'saas-backend', '.venv', 'Scripts', 'python.exe'),
    path.resolve(process.cwd(), '..', 'saas-backend', '.venv', 'bin', 'python'),
    path.resolve(process.cwd(), '..', '.venv', 'Scripts', 'python.exe'),
    path.resolve(process.cwd(), '..', '.venv', 'bin', 'python'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return 'python3'
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
  return new Promise((resolve, reject) => {
    const python = getPythonBin()

    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new Error(`rank_check_adapter.py not found at: ${SCRIPT_PATH}`))
      return
    }

    const proc = spawn(
      python,
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
    let stderr = ''

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`rank_check_adapter.py timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      const raw = stdout.trim()
      if (!raw) {
        reject(new Error(
          `rank_check_adapter.py produced no output. code=${code} stderr=${stderr.slice(0, 400)}`,
        ))
        return
      }
      try {
        const parsed = JSON.parse(raw) as KeywordRankResult
        resolve(parsed)
      } catch {
        reject(new Error(`rank_check_adapter.py: invalid JSON output: ${raw.slice(0, 400)}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to spawn Python: ${err.message}`))
    })
  })
}
