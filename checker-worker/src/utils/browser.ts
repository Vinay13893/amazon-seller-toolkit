import { readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'

const DEFAULT_OPERATION_TIMEOUT_MS = 45_000

// A 512 MB Render instance cannot safely run more than one Chromium process at
// a time. Keep every browser-backed checker behind one in-process slot. This
// preserves all existing HTTP routes while preventing overlapping cron/manual
// requests from multiplying Chromium's memory usage.
let browserOperationTail: Promise<void> = Promise.resolve()
let browserOperationActive = false
let browserOperationsWaiting = 0
let currentOperationPeakBytes: number | null = null
let lastOperationPeakBytes: number | null = null

function readContainerMemoryBytes(): number | null {
  try {
    const value = Number.parseInt(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function acquireBrowserOperationSlot(): Promise<() => void> {
  const previousOperation = browserOperationTail
  let releaseNextOperation: () => void = () => undefined

  browserOperationTail = new Promise<void>(resolve => {
    releaseNextOperation = resolve
  })
  browserOperationsWaiting += 1

  await previousOperation
  browserOperationsWaiting -= 1
  browserOperationActive = true

  let released = false
  return () => {
    if (released) return
    released = true
    browserOperationActive = false
    releaseNextOperation()
  }
}

export function getBrowserWorkloadStats(): {
  active: number
  waiting: number
  maxConcurrent: number
  containerMemoryBytes: number | null
  operationPeakBytes: number | null
} {
  return {
    active: browserOperationActive ? 1 : 0,
    waiting: browserOperationsWaiting,
    maxConcurrent: 1,
    containerMemoryBytes: readContainerMemoryBytes(),
    operationPeakBytes: browserOperationActive ? currentOperationPeakBytes : lastOperationPeakBytes,
  }
}

export async function createBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    timeout: 30_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-features=BackForwardCache,MediaRouter,Translate',
      '--disable-site-isolation-trials',
      '--disable-sync',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--single-process',
    ],
  })
}

export async function withBrowserPage<T>(
  run: (page: Page) => Promise<T>,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const releaseBrowserOperationSlot = await acquireBrowserOperationSlot()
  let browser: Browser | null = null
  currentOperationPeakBytes = readContainerMemoryBytes()
  const memorySampler = setInterval(() => {
    const currentBytes = readContainerMemoryBytes()
    if (currentBytes === null) return
    currentOperationPeakBytes = Math.max(currentOperationPeakBytes ?? 0, currentBytes)
  }, 250)

  try {
    browser = await createBrowser()
    const context = await browser.newContext({
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    // The checkers only need Amazon's HTML, CSS and JavaScript. Blocking heavy
    // visual assets keeps Chromium within the smaller Render instance without
    // changing the evidence used for rank, Buy Box or pincode decisions.
    await page.route('**/*', async route => {
      const resourceType = route.request().resourceType()
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
        await route.abort()
        return
      }
      await route.continue()
    })
    page.setDefaultTimeout(timeoutMs)

    return await run(page)
  } finally {
    await browser?.close().catch(() => undefined)
    clearInterval(memorySampler)
    const finalBytes = readContainerMemoryBytes()
    if (finalBytes !== null) {
      currentOperationPeakBytes = Math.max(currentOperationPeakBytes ?? 0, finalBytes)
    }
    lastOperationPeakBytes = currentOperationPeakBytes
    currentOperationPeakBytes = null
    releaseBrowserOperationSlot()
  }
}
