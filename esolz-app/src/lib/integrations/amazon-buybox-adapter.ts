/**
 * Server-side only — do NOT import from client components.
 *
 * Spawns `scripts/check_buybox.py` as a child process and returns
 * a parsed Buy Box check result. Python executable resolved from:
 *   1. BSR_PYTHON_BIN env var (explicit override)
 *   2. Root .venv relative to process.cwd()
 *   3. Fallback to "python3"
 *
 * The underlying scraping logic is identical to hijack_check() in
 * saas-backend/app/tasks/tools.py — scrapes the Amazon offer listing page.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface BuyBoxOffer {
  seller:      string
  seller_id:   string
  price:       string
  price_num:   number | null
  fulfillment: string
  delivery:    string
}

export interface BuyBoxCheckResult {
  asin:               string
  marketplace:        string
  buy_box_owner:      string | null
  buy_box_seller_id:  string | null
  buy_box_price:      number | null
  buy_box_status:     string
  fulfillment_type:   string | null
  all_offers:         BuyBoxOffer[]
  total_sellers:      number
  captcha_seen:       boolean
  error:              string
  checked_at:         string
}

const TIMEOUT_MS  = 120_000  // 120s — Playwright can be slow
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'check_buybox.py')

function getPythonBin(): string {
  if (process.env.BSR_PYTHON_BIN) return process.env.BSR_PYTHON_BIN

  const candidates = [
    path.resolve(process.cwd(), '..', '.venv', 'Scripts', 'python.exe'),
    path.resolve(process.cwd(), '..', '.venv', 'bin', 'python'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return 'python3'
}

export function checkBuyBox(
  asin:        string,
  marketplace: string,
): Promise<BuyBoxCheckResult> {
  return new Promise((resolve, reject) => {
    const python = getPythonBin()

    console.log(`[buybox-adapter] python    : ${python} (exists=${fs.existsSync(python)})`)
    console.log(`[buybox-adapter] script    : ${SCRIPT_PATH} (exists=${fs.existsSync(SCRIPT_PATH)})`)
    console.log(`[buybox-adapter] asin      : ${asin}  marketplace: ${marketplace}`)

    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new Error(`check_buybox.py not found at: ${SCRIPT_PATH}`))
      return
    }

    const proc = spawn(
      python,
      [SCRIPT_PATH, '--asin', asin, '--marketplace', marketplace],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout   = ''
    let stderr   = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
      reject(new Error(`check_buybox.py timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      console.error('[buybox-adapter]', chunk.toString().trimEnd())
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`check_buybox.py exited ${code}: ${stderr.slice(0, 500)}`))
        return
      }

      try {
        const result = JSON.parse(stdout.trim()) as BuyBoxCheckResult
        resolve(result)
      } catch {
        reject(new Error(`check_buybox.py output not JSON: ${stdout.slice(0, 300)}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      if (!timedOut) reject(err)
    })
  })
}
