import { chromium, type Browser, type Page } from 'playwright'

const DEFAULT_OPERATION_TIMEOUT_MS = 45_000

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
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-zygote',
    ],
  })
}

export async function withBrowserPage<T>(
  run: (page: Page) => Promise<T>,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const browser = await createBrowser()
  const context = await browser.newContext({
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 },
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  // The checkers only need Amazon's HTML, CSS and JavaScript. Blocking heavy
  // visual assets keeps Chromium comfortably within the smaller Render
  // instance without changing the evidence used for rank, Buy Box or pincode
  // decisions.
  await page.route('**/*', async route => {
    const resourceType = route.request().resourceType()
    if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
      await route.abort()
      return
    }
    await route.continue()
  })
  page.setDefaultTimeout(timeoutMs)

  try {
    return await run(page)
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}
