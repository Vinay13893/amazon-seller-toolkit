import type { Page } from 'playwright'

const BLOCK_HINTS = [
  'Enter the characters you see below',
  'Type the characters you see in this image',
  'Robot Check',
  'Sorry, we just need to make sure',
  'To discuss automated access to Amazon data please contact',
]

const OUT_OF_STOCK_HINTS = [
  'currently unavailable',
  'temporarily out of stock',
  'out of stock',
  'unavailable',
  'cannot be delivered',
]

const IN_STOCK_HINTS = [
  'in stock',
  'available',
  'usually dispatched',
  'delivery by',
]

export function normalizeMarketplace(marketplace: string): string {
  return marketplace.trim().toLowerCase()
}

export function isAmazonIndiaMarketplace(marketplace: string): boolean {
  const normalized = normalizeMarketplace(marketplace)
  return normalized === 'in' || normalized === 'amazon.in'
}

export async function isBlockedPage(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => '')).toLowerCase()
  const bodyText = (await page.textContent('body').catch(() => '') || '').toLowerCase()

  return BLOCK_HINTS.some(hint => {
    const needle = hint.toLowerCase()
    return title.includes(needle) || bodyText.includes(needle)
  })
}

export async function extractPrice(page: Page): Promise<number | null> {
  const rawPrice = await page
    .locator('.a-price .a-offscreen')
    .first()
    .textContent()
    .catch(() => null)

  if (!rawPrice) return null
  const cleaned = rawPrice.replace(/[^\d.]/g, '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export async function extractSeller(page: Page): Promise<string | null> {
  const selectors = [
    '#sellerProfileTriggerId',
    '#merchant-info a',
    '#merchant-info',
  ]

  for (const selector of selectors) {
    const text = await page.locator(selector).first().textContent().catch(() => null)
    if (text && text.trim()) return text.trim()
  }

  return null
}

export async function extractDeliveryPromise(page: Page): Promise<string | null> {
  const selectors = [
    '#deliveryBlockMessage',
    '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
    '#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE',
    '#ddmDeliveryMessage',
  ]

  for (const selector of selectors) {
    const text = await page.locator(selector).first().textContent().catch(() => null)
    if (text && text.trim()) return text.trim().replace(/\s+/g, ' ')
  }

  return null
}

export async function detectAvailability(page: Page): Promise<boolean | null> {
  const bodyText = ((await page.textContent('body').catch(() => null)) || '').toLowerCase()

  if (!bodyText) return null

  if (OUT_OF_STOCK_HINTS.some(hint => bodyText.includes(hint))) {
    return false
  }

  if (IN_STOCK_HINTS.some(hint => bodyText.includes(hint))) {
    return true
  }

  return null
}

export async function trySetPincode(page: Page, pincode: string): Promise<boolean> {
  const triggerSelectors = [
    '#nav-global-location-popover-link',
    '#glow-ingress-block',
    '#contextualIngressPtLabel',
  ]

  let opened = false
  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first()
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click().catch(() => undefined)
      opened = true
      break
    }
  }

  if (!opened) {
    return false
  }

  const input = page.locator('#GLUXZipUpdateInput').first()
  if (!(await input.isVisible().catch(() => false))) {
    return false
  }

  await input.fill(pincode).catch(() => undefined)

  const submitSelectors = [
    '#GLUXZipUpdate .a-button-input',
    '#GLUXZipUpdate',
    '#GLUXZipUpdate-announce',
  ]

  let submitted = false
  for (const selector of submitSelectors) {
    const submit = page.locator(selector).first()
    if (await submit.isVisible().catch(() => false)) {
      await submit.click().catch(() => undefined)
      submitted = true
      break
    }
  }

  if (!submitted) {
    return false
  }

  await page.waitForTimeout(1500)

  const pinVisible = await page
    .locator('#glow-ingress-line2')
    .first()
    .textContent()
    .then(text => (text || '').includes(pincode))
    .catch(() => false)

  return pinVisible
}
