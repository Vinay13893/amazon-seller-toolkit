import { chromium, type Browser, type Page } from 'playwright'

const DEFAULT_OPERATION_TIMEOUT_MS = 45_000

export async function createBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
  })
  const page = await context.newPage()
  page.setDefaultTimeout(timeoutMs)

  try {
    return await run(page)
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}
