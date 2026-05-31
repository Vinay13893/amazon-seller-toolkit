import type { Page } from 'playwright'
import { z } from 'zod'
import { withBrowserPage } from '../utils/browser'
import {
  detectAvailability,
  extractDeliveryPromise,
  extractPrice,
  extractSeller,
  isAmazonIndiaMarketplace,
  isBlockedPage,
  trySetPincode,
} from '../utils/amazon'

export const pincodeAvailabilityRequestSchema = z.object({
  workspace_id: z.string().min(1),
  tracked_asin_id: z.string().min(1),
  asin: z.string().min(1),
  marketplace: z.string().min(1),
  pincode: z.string().regex(/^\d{6}$/),
})

export type PincodeAvailabilityRequest = z.infer<typeof pincodeAvailabilityRequestSchema>

export type PincodeAvailabilityResponse = {
  ok: boolean
  available: boolean | null
  delivery_promise: string | null
  price: number | null
  seller: string | null
  status: 'success' | 'unavailable' | 'blocked' | 'failed'
  error_message: string | null
}

type AvailabilityDecision = {
  available: boolean | null
  status: 'success' | 'unavailable' | 'failed'
  reason: string | null
}

const AVAILABLE_HINTS = [
  'in stock',
  'free delivery',
  'get it by',
  'today',
  'tomorrow',
  'usually dispatched',
]

const UNAVAILABLE_HINTS = [
  'currently unavailable',
  'out of stock',
  "we don't know when or if this item will be back",
  'cannot be shipped to your selected delivery location',
  'not deliverable to this address',
  'unavailable for this pincode',
]

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

async function collectText(page: Page, selectors: string[]): Promise<string> {
  const collected: string[] = []

  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    const limit = Math.min(count, 3)

    for (let index = 0; index < limit; index += 1) {
      const text = await locator
        .nth(index)
        .textContent()
        .then(value => value ?? '')
        .catch(() => '')

      const normalized = normalizeWhitespace(text)
      if (normalized) {
        collected.push(normalized)
      }
    }
  }

  return collected.join(' | ')
}

function includesAny(haystack: string, hints: string[]): string | null {
  for (const hint of hints) {
    if (haystack.includes(hint)) {
      return hint
    }
  }
  return null
}

async function decideAvailability(page: Page, deliveryPromise: string | null): Promise<AvailabilityDecision> {
  const availabilityText = await collectText(page, ['#availability', '#availability span'])
  const deliveryText = await collectText(page, [
    '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
    '#deliveryBlockMessage',
    '#ddmDeliveryMessage',
  ])
  const locationText = await collectText(page, ['#glow-ingress-line2', '#contextualIngressPtLabel_deliveryShortLine'])
  const bodyTextRaw = (await page.textContent('body').catch(() => '')) || ''

  const combinedText = [
    availabilityText,
    deliveryPromise || '',
    deliveryText,
    locationText,
    bodyTextRaw.slice(0, 6000),
  ]
    .join(' | ')
    .toLowerCase()

  const clearUnavailableReason = includesAny(combinedText, UNAVAILABLE_HINTS)
  if (clearUnavailableReason) {
    return {
      available: false,
      status: 'unavailable',
      reason: `Amazon indicates unavailability: ${clearUnavailableReason}.`,
    }
  }

  const explicitAvailableHint = includesAny(combinedText, AVAILABLE_HINTS)
  const hasDeliveringToSignal = combinedText.includes('delivering to')

  // Delivery promise with a weekday/month name or a date is strong stock evidence.
  const deliveryDatePattern =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|\d{1,2} \w{3})\b/i
  const deliveryPromiseLower = (deliveryPromise || '').toLowerCase()
  const hasDeliveryDate = deliveryDatePattern.test(deliveryPromiseLower)

  if (
    explicitAvailableHint &&
    (hasDeliveringToSignal || hasDeliveryDate || explicitAvailableHint === 'in stock')
  ) {
    return {
      available: true,
      status: 'success',
      reason: null,
    }
  }

  return {
    available: null,
    status: 'failed',
    reason: 'Delivery availability is unclear after setting pincode.',
  }
}

export async function runPincodeAvailabilityCheck(
  input: PincodeAvailabilityRequest,
): Promise<PincodeAvailabilityResponse> {
  if (!isAmazonIndiaMarketplace(input.marketplace)) {
    return {
      ok: false,
      available: null,
      delivery_promise: null,
      price: null,
      seller: null,
      status: 'failed',
      error_message: 'Only Amazon India marketplace is supported by this checker.',
    }
  }

  const asin = input.asin.trim().toUpperCase()

  try {
    return await withBrowserPage(async page => {
      const productUrl = `https://www.amazon.in/dp/${encodeURIComponent(asin)}`
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 })

      if (await isBlockedPage(page)) {
        return {
          ok: false,
          available: null,
          delivery_promise: null,
          price: null,
          seller: null,
          status: 'blocked',
          error_message: 'Amazon blocked the pincode check. Try again later.',
        }
      }

      const pincodeSet = await trySetPincode(page, input.pincode)
      if (!pincodeSet) {
        return {
          ok: false,
          available: null,
          delivery_promise: null,
          price: null,
          seller: null,
          status: 'failed',
          error_message: 'Could not set pincode on Amazon delivery widget.',
        }
      }

      if (await isBlockedPage(page)) {
        return {
          ok: false,
          available: null,
          delivery_promise: null,
          price: null,
          seller: null,
          status: 'blocked',
          error_message: 'Amazon blocked the pincode check. Try again later.',
        }
      }

      const [deliveryPromise, price, seller, availabilitySignal] = await Promise.all([
        extractDeliveryPromise(page),
        extractPrice(page),
        extractSeller(page),
        detectAvailability(page),
      ])

      const decision = await decideAvailability(page, deliveryPromise)

      if (decision.available === null && availabilitySignal === true) {
        return {
          ok: true,
          available: true,
          delivery_promise: deliveryPromise,
          price,
          seller,
          status: 'success',
          error_message: null,
        }
      }

      if (decision.available === true) {
        return {
          ok: true,
          available: true,
          delivery_promise: deliveryPromise,
          price,
          seller,
          status: 'success',
          error_message: null,
        }
      }

      if (decision.available === false) {
        return {
          ok: true,
          available: false,
          delivery_promise: deliveryPromise,
          price,
          seller,
          status: 'unavailable',
          error_message: null,
        }
      }

      return {
        ok: false,
        available: null,
        delivery_promise: deliveryPromise,
        price,
        seller,
        status: 'failed',
        error_message: decision.reason,
      }
    })
  } catch (error) {
    return {
      ok: false,
      available: null,
      delivery_promise: null,
      price: null,
      seller: null,
      status: 'failed',
      error_message: error instanceof Error ? error.message : 'Pincode availability checker failed unexpectedly.',
    }
  }
}
