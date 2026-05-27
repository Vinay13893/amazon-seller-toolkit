/**
 * Server-side only — do NOT import from client components.
 *
 * Spawns `scripts/check_pincode.py` as a child process and returns
 * a parsed pincode check result. Python executable is resolved from:
 *   1. PINCODE_PYTHON_BIN or BSR_PYTHON_BIN env var (explicit override)
 *   2. Root .venv relative to process.cwd()
 *   3. Fallback to "python3"
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface PincodeCheckResult {
  asin:               string
  pincode:            string
  marketplace:        string
  url:                string
  title:              string
  is_buyable:         boolean
  availability_text:  string
  amazon_fulfilled:   boolean
  merchant_text:      string
  delivery_type:      'same_day' | 'next_day' | 'two_day' | 'other' | 'unknown' | 'unavailable' | 'error'
  delivery_text:      string
  captcha_seen:       boolean
  error:              string
  checked_at:         string
}

const TIMEOUT_MS  = 120_000  // 120s — Playwright + pincode set can be slow
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'check_pincode.py')
const PROFILE_DIR = path.resolve(process.cwd(), '..', 'amazon-pincode-checker', 'pincode_checker', 'amazon_profile')

function getPythonBin(): string {
  // Prefer PINCODE_PYTHON_BIN, fall back to BSR_PYTHON_BIN, then common paths
  if (process.env.PINCODE_PYTHON_BIN) return process.env.PINCODE_PYTHON_BIN
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

export function checkPincode(
  asin:        string,
  pincode:     string,
  marketplace: string,
): Promise<PincodeCheckResult> {
  return new Promise((resolve, reject) => {
    const python       = getPythonBin()
    const scriptExists = fs.existsSync(SCRIPT_PATH)
    const profileExists = fs.existsSync(PROFILE_DIR)

    console.log(`[pincode-adapter][1a] python   : ${python} (exists=${fs.existsSync(python)})`)
    console.log(`[pincode-adapter][1b] script   : ${SCRIPT_PATH} (exists=${scriptExists})`)
    console.log(`[pincode-adapter][1c] profile  : ${PROFILE_DIR} (exists=${profileExists})`)
    console.log(`[pincode-adapter][1d] cwd      : ${process.cwd()}`)

    if (!scriptExists) {
      reject(new Error(`check_pincode.py not found at: ${SCRIPT_PATH}`))
      return
    }

    const proc = spawn(
      python,
      [
        SCRIPT_PATH,
        '--asin', asin,
        '--pincode', pincode,
        '--marketplace', marketplace,
        '--profile-dir', PROFILE_DIR,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`check_pincode.py timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)

      console.log(`[pincode-adapter][2a] exit code: ${code}`)
      if (stderr.trim()) console.log(`[pincode-adapter][2b] stderr   : ${stderr.trim().slice(0, 500)}`)
      console.log(`[pincode-adapter][2c] stdout   : ${stdout.trim().slice(0, 400)}`)

      if (code !== 0) {
        // Even on error, try to parse JSON output (script outputs error as JSON)
        const jsonMatch = stdout.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as PincodeCheckResult
            console.log(`[pincode-adapter][2d] parsed error result: ${parsed.error}`)
            resolve(parsed) // Return error result instead of rejecting
            return
          } catch {}
        }
        reject(new Error(`checker exited ${code ?? 'null'}: ${stderr.slice(0, 500)}`))
        return
      }

      // Find the last complete JSON object in stdout
      const jsonMatch = stdout.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        reject(new Error(`no JSON in checker output: ${stdout.slice(0, 300)}`))
        return
      }

      try {
        const parsed = JSON.parse(jsonMatch[0]) as PincodeCheckResult
        console.log(`[pincode-adapter][2e] parsed   : buyable=${parsed.is_buyable} delivery=${parsed.delivery_type}`)
        console.log(`[pincode-adapter][2f] full JSON: ${JSON.stringify(parsed, null, 2)}`)
        resolve(parsed)
      } catch (err) {
        reject(new Error(`failed to parse checker JSON: ${err}`))
      }
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      console.error(`[pincode-adapter][2x] spawn error: ${err.message}`)
      reject(err)
    })
  })
}
