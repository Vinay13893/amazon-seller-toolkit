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

const OVERALL_TIMEOUT_MS = 40_000
const GOTO_TIMEOUT_MS = 15_000
const DELIVERY_EXTRACTION_TIMEOUT_MS = 8_000
const PAGE_ACTION_TIMEOUT_MS = 5_000
const NAVIGATION_ACTION_TIMEOUT_MS = 15_000

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

function pincodeLog(input: PincodeAvailabilityRequest, phase: string, details?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      checker: 'pincode-availability',
      asin: input.asin,
      pincode: input.pincode,
      phase,
      ...details,
    }),
  )
}

function timeoutResponse(
  message = 'Pincode check timed out before availability could be confirmed.',
): PincodeAvailabilityResponse {
  return {
    ok: false,
    available: null,
    delivery_promise: null,
    price: null,
    seller: null,
    status: 'failed',
    error_message: message,
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutErrorMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function extractSnapshot(page: Page): Promise<{
  deliveryPromise: string | null
  price: number | null
  seller: string | null
  availabilitySignal: boolean | null
}> {
  const [deliveryPromise, price, seller, availabilitySignal] = await Promise.all([
    extractDeliveryPromise(page),
    extractPrice(page),
    extractSeller(page),
    detectAvailability(page),
  ])

  return {
    deliveryPromise,
    price,
    seller,
    availabilitySignal,
  }
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

  const deliveryDatePattern =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|\d{1,2} \w{3})\b/i
  const deliveryPromiseLower = (deliveryPromise || '').toLowerCase()
  const hasDeliveryDate = deliveryDatePattern.test(deliveryPromiseLower)

  if (
    explicitAvailableHint
    && (hasDeliveringToSignal || hasDeliveryDate || explicitAvailableHint === 'in stock')
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
    pincodeLog(input, 'start')

    return await withTimeout(
      withBrowserPage(async page => {
        page.setDefaultTimeout(PAGE_ACTION_TIMEOUT_MS)
        page.setDefaultNavigationTimeout(NAVIGATION_ACTION_TIMEOUT_MS)

        const productUrl = `https://www.amazon.in/dp/${encodeURIComponent(asin)}`
        pincodeLog(input, 'goto_started', { product_url: productUrl })
        await withTimeout(
          page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }),
          GOTO_TIMEOUT_MS,
          'Timed out while opening Amazon product page.',
        )
        pincodeLog(input, 'goto_completed')

        if (await isBlockedPage(page)) {
          pincodeLog(input, 'blocked_detected_after_goto')
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

        pincodeLog(input, 'pincode_set_started')
        const pincodeSet = await withTimeout(
          trySetPincode(page, input.pincode),
          8_000,
          'Timed out while setting pincode on delivery widget.',
        )
        pincodeLog(input, 'pincode_set_completed', { pincode_set: pincodeSet })

        if (!pincodeSet) {
          pincodeLog(input, 'fallback_extraction_started')
          const fallback = await withTimeout(
            extractSnapshot(page),
            DELIVERY_EXTRACTION_TIMEOUT_MS,
            'Timed out while collecting fallback page signals.',
          ).catch(() => ({ deliveryPromise: null, price: null, seller: null, availabilitySignal: null }))

          pincodeLog(input, 'fallback_extraction_completed', {
            delivery_promise_present: Boolean(fallback.deliveryPromise),
            price_present: fallback.price !== null,
            seller_present: Boolean(fallback.seller),
          })

          const response: PincodeAvailabilityResponse = {
            ok: false,
            available: null,
            delivery_promise: fallback.deliveryPromise,
            price: fallback.price,
            seller: fallback.seller,
            status: 'failed',
            error_message: 'Pincode-specific delivery could not be confirmed.',
          }

          pincodeLog(input, 'finish', { final_status: response.status, available: response.available })
          return response
        }

        if (await isBlockedPage(page)) {
          pincodeLog(input, 'blocked_detected_after_pincode')
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

        pincodeLog(input, 'delivery_extraction_started')
        const { deliveryPromise, price, seller, availabilitySignal } = await withTimeout(
          extractSnapshot(page),
          DELIVERY_EXTRACTION_TIMEOUT_MS,
          'Timed out while extracting delivery details.',
        )
        pincodeLog(input, 'delivery_extraction_completed', {
          delivery_promise_present: Boolean(deliveryPromise),
          price_present: price !== null,
          seller_present: Boolean(seller),
        })

        const decision = await decideAvailability(page, deliveryPromise)

        if (decision.available === null && availabilitySignal === true) {
          const response: PincodeAvailabilityResponse = {
            ok: true,
            available: true,
            delivery_promise: deliveryPromise,
            price,
            seller,
            status: 'success',
            error_message: null,
          }

          pincodeLog(input, 'finish', { final_status: response.status, available: response.available })
          return response
        }

        if (decision.available === true) {
          const response: PincodeAvailabilityResponse = {
            ok: true,
            available: true,
            delivery_promise: deliveryPromise,
            price,
            seller,
            status: 'success',
            error_message: null,
          }

          pincodeLog(input, 'finish', { final_status: response.status, available: response.available })
          return response
        }

        if (decision.available === false) {
          const response: PincodeAvailabilityResponse = {
            ok: true,
            available: false,
            delivery_promise: deliveryPromise,
            price,
            seller,
            status: 'unavailable',
            error_message: null,
          }

          pincodeLog(input, 'finish', { final_status: response.status, available: response.available })
          return response
        }

        const response: PincodeAvailabilityResponse = {
          ok: false,
          available: null,
          delivery_promise: deliveryPromise,
          price,
          seller,
          status: 'failed',
          error_message: decision.reason,
        }

        pincodeLog(input, 'finish', { final_status: response.status, available: response.available })
        return response
      }),
      OVERALL_TIMEOUT_MS,
      'Pincode check timed out before availability could be confirmed.',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pincode availability checker failed unexpectedly.'
    const timeoutLike = message.toLowerCase().includes('timed out')

    if (timeoutLike) {
      pincodeLog(input, 'timeout', { error_message: message })
      return timeoutResponse()
    }

    pincodeLog(input, 'error', { error_message: message })
    return {
      ok: false,
      available: null,
      delivery_promise: null,
      price: null,
      seller: null,
      status: 'failed',
      error_message: message,
    }
  }
}
