import type { Page } from 'playwright'

const BLOCK_HINTS = [
  'Enter the characters you see below',
  'Type the characters you see in this image',
  'Robot Check',
  'Sorry, we just need to make sure',
  'To discuss automated access to Amazon data please contact',
  'enter the characters as they are shown in the image',
  'automated access to amazon data',
]

const PINCODE_TRIGGER_SELECTORS = [
  '#nav-global-location-popover-link',
  '#contextualIngressPtLabel_deliveryShortLine',
  '#contextualIngressPtLabel',
  '#glow-ingress-line2',
  '#glow-ingress-block',
]

const PINCODE_INPUT_SELECTORS = [
  'input#GLUXZipUpdateInput',
  '#GLUXZipUpdateInput',
  'input[aria-label*="pincode" i]',
]

const PINCODE_SUBMIT_SELECTORS = [
  '#GLUXZipUpdate',
  '#GLUXZipUpdate .a-button-input',
  '#GLUXZipUpdate-announce',
]

const PINCODE_CLOSE_SELECTORS = [
  '#GLUXConfirmClose',
  'button[aria-label*="close" i]',
]

const DELIVERY_PROMISE_SELECTORS = [
  '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
  '#deliveryBlockMessage',
  '#ddmDeliveryMessage',
  '#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE',
]

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function nowMs(): number {
  return Date.now()
}

function hasBudget(startMs: number, budgetMs: number): boolean {
  return nowMs() - startMs < budgetMs
}

async function readFirstVisibleText(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    const visible = await locator.isVisible().catch(() => false)
    if (!visible) {
      continue
    }

    const text = await locator.textContent().catch(() => null)
    if (text && normalizeWhitespace(text)) {
      return normalizeWhitespace(text)
    }
  }

  return null
}

function parsePrice(rawPrice: string): number | null {
  const cleaned = rawPrice.replace(/[^\d.]/g, '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

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

  const hasCaptchaInput = await page.locator('#captchacharacters').first().isVisible().catch(() => false)

  if (hasCaptchaInput) {
    return true
  }

  return BLOCK_HINTS.some(hint => {
    const needle = hint.toLowerCase()
    return title.includes(needle) || bodyText.includes(needle)
  })
}

export async function extractPrice(page: Page): Promise<number | null> {
  const selectors = [
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '.a-price .a-offscreen',
  ]

  for (const selector of selectors) {
    const text = await page.locator(selector).first().textContent().catch(() => null)
    if (!text || !normalizeWhitespace(text)) {
      continue
    }

    const parsed = parsePrice(text)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

export async function extractSeller(page: Page): Promise<string | null> {
  const selectors = [
    '#sellerProfileTriggerId',
    '#shipsFromSoldByInsideBuyBox_feature_div',
    '#merchant-info a',
    '#merchant-info',
  ]

  for (const selector of selectors) {
    const text = await page.locator(selector).first().textContent().catch(() => null)
    if (text && normalizeWhitespace(text)) {
      return normalizeWhitespace(text)
    }
  }

  return null
}

export async function extractDeliveryPromise(page: Page): Promise<string | null> {
  return readFirstVisibleText(page, DELIVERY_PROMISE_SELECTORS)
}

export async function detectAvailability(page: Page): Promise<boolean | null> {
  const bodyText = ((await page.textContent('body').catch(() => null)) || '').toLowerCase()
  if (!bodyText) {
    return null
  }

  const unavailableHints = [
    'currently unavailable',
    'out of stock',
    "we don't know when or if this item will be back",
    'cannot be shipped to your selected delivery location',
    'not deliverable to this address',
    'unavailable for this pincode',
  ]

  const hasUnavailable = unavailableHints.some(hint => bodyText.includes(hint))
  if (hasUnavailable) {
    return false
  }

  const hasPositiveStockHint =
    bodyText.includes('in stock') ||
    bodyText.includes('free delivery') ||
    bodyText.includes('get it by') ||
    bodyText.includes('today') ||
    bodyText.includes('tomorrow')

  if (hasPositiveStockHint && bodyText.includes('delivering to')) {
    return true
  }

  return null
}

export async function trySetPincode(page: Page, pincode: string): Promise<boolean> {
  const startMs = nowMs()
  const budgetMs = 8_000

  for (const selector of PINCODE_TRIGGER_SELECTORS) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    const trigger = page.locator(selector).first()
    const visible = await trigger.isVisible().catch(() => false)
    if (!visible) {
      continue
    }

    await trigger.click({ timeout: 1_000 }).catch(() => undefined)
    break
  }

  let inputReady = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    for (const selector of PINCODE_INPUT_SELECTORS) {
      const input = page.locator(selector).first()
      const visible = await input.isVisible().catch(() => false)
      if (visible) {
        inputReady = true
        break
      }
    }

    if (inputReady) {
      break
    }

    await page.waitForTimeout(300)
  }

  if (!inputReady) {
    return false
  }

  let filled = false
  for (const selector of PINCODE_INPUT_SELECTORS) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    const input = page.locator(selector).first()
    const visible = await input.isVisible().catch(() => false)
    if (!visible) {
      continue
    }

    await input.click({ timeout: 1_000 }).catch(() => undefined)
    await input.fill('', { timeout: 1_000 }).catch(() => undefined)
    await input.type(pincode, { delay: 25, timeout: 2_000 }).catch(() => undefined)
    filled = true
    break
  }

  if (!filled) {
    return false
  }

  let submitted = false
  for (const selector of PINCODE_SUBMIT_SELECTORS) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    const button = page.locator(selector).first()
    const visible = await button.isVisible().catch(() => false)
    if (!visible) {
      continue
    }

    await button.click({ timeout: 1_000 }).catch(() => undefined)
    submitted = true
    break
  }

  if (!submitted) {
    return false
  }

  await page.waitForTimeout(1400)

  for (const selector of PINCODE_CLOSE_SELECTORS) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    const closeButton = page.locator(selector).first()
    const visible = await closeButton.isVisible().catch(() => false)
    if (visible) {
      await closeButton.click({ timeout: 1_000 }).catch(() => undefined)
      break
    }
  }

  let labelText = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!hasBudget(startMs, budgetMs)) {
      return false
    }

    const line2 = (await page.locator('#glow-ingress-line2').first().textContent().catch(() => '')) || ''
    const shortLine =
      (await page.locator('#contextualIngressPtLabel_deliveryShortLine').first().textContent().catch(() => '')) || ''
    labelText = `${line2} ${shortLine}`.toLowerCase()

    if (labelText.includes(pincode) || labelText.includes('delivering to')) {
      return true
    }

    await page.waitForTimeout(350)
  }

  return false
}
