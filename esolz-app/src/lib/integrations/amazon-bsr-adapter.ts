/**
 * Server-side only — do NOT import from client components.
 *
 * Spawns `scripts/scrape_bsr.py` as a child process and returns
 * a parsed snapshot result.  Python executable is resolved from:
 *   1. BSR_PYTHON_BIN env var (explicit override)
 *   2. Root .venv relative to process.cwd() (../. venv)
 *   3. Fallback to "python3"
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface BsrScrapeResult {
  asin:               string
  marketplace:        string
  bsr:                number | null
  bsr_category:       string | null
  price:              number | null
  rating:             number | null
  review_count:       number | null
  buy_box_owner:      string | null
  buy_box_status:     'won' | 'lost' | 'suppressed' | 'unknown'
  availability_score: number | null
  checked_at:         string
  scrape_status:      string
}

const TIMEOUT_MS  = 90_000   // 90 s — Playwright can be slow
// When Next.js dev server runs from esolz-app/, process.cwd() = esolz-app/
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'scrape_bsr.py')

function getPythonBin(): string {
  if (process.env.BSR_PYTHON_BIN) return process.env.BSR_PYTHON_BIN

  // Prefer saas-backend venv — it already has playwright, bs4, lxml
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

export function scrapeAsinBsr(
  asin:        string,
  marketplace: string,
): Promise<BsrScrapeResult> {
  if (process.env.NODE_ENV === 'production') {
    return Promise.reject(
      new Error('Python BSR checker is not available in production. Configure CHECKER_WORKER_URL to use the external checker worker.'),
    )
  }
  return new Promise((resolve, reject) => {
    const python     = getPythonBin()
    const scriptExists = fs.existsSync(SCRIPT_PATH)

    console.log(`[bsr-adapter][5a] python   : ${python} (exists=${fs.existsSync(python)})`)
    console.log(`[bsr-adapter][5b] script   : ${SCRIPT_PATH} (exists=${scriptExists})`)
    console.log(`[bsr-adapter][5c] cwd      : ${process.cwd()}`)

    if (!scriptExists) {
      reject(new Error(`scrape_bsr.py not found at: ${SCRIPT_PATH}`))
      return
    }

    const proc = spawn(
      python,
      [SCRIPT_PATH, '--asin', asin, '--marketplace', marketplace],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`scrape_bsr.py timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)

      console.log(`[bsr-adapter][5d] exit code: ${code}`)
      if (stderr.trim()) console.log(`[bsr-adapter][5e] stderr   : ${stderr.trim().slice(0, 400)}`)
      console.log(`[bsr-adapter][5f] stdout   : ${stdout.trim().slice(0, 300)}`)

      if (code !== 0) {
        reject(new Error(`scraper exited ${code ?? 'null'}: ${stderr.slice(0, 500)}`))
        return
      }

      // Find the last complete JSON object in stdout
      // (ignores any print() debug lines before the final JSON)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        reject(new Error(`no JSON in scraper output: ${stdout.slice(0, 300)}`))
        return
      }

      try {
        const parsed = JSON.parse(jsonMatch[0]) as BsrScrapeResult
        console.log(`[bsr-adapter][5g] parsed   : bsr=${parsed.bsr} price=${parsed.price} status=${parsed.scrape_status}`)
        console.log(`[bsr-adapter][5g] full JSON: ${JSON.stringify(parsed, null, 2)}`)
        resolve(parsed)
      } catch (err) {
        reject(new Error(`failed to parse scraper JSON: ${err}`))
      }
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      console.error(`[bsr-adapter][5x] spawn error: ${err.message}`)
      reject(err)
    })
  })
}
