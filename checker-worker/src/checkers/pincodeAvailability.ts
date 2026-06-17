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
  error_code?: string | null
  error_message: string | null
  diagnostics?: PincodeDiagnostics
}

type AvailabilityDecision = {
  available: boolean | null
  status: 'success' | 'unavailable' | 'failed'
  reason: string | null
  reasonCode: string
  matchedPositivePhrase: string | null
  matchedNegativePhrase: string | null
  locationConfirmed: boolean
  deliveryTextFound: boolean
}

type PincodeDiagnostics = {
  page_loaded: boolean
  product_page_detected: boolean
  location_set_attempted: boolean
  location_set_success: boolean
  captcha_or_robot_detected: boolean
  availability_selector_found: boolean
  price_selector_found: boolean
  buy_box_selector_found: boolean
  final_page_type: 'product' | 'captcha' | 'unavailable' | 'unknown'
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

const STRONG_UNAVAILABLE_HINTS = [
  'currently unavailable',
  'out of stock',
  "we don't know when or if this item will be back",
  'cannot be shipped to your selected delivery location',
  'this item cannot be delivered to your selected location',
  'not deliverable to this address',
  'not available for this pincode',
  'this item is not eligible for delivery to your location',
]

const PINCODE_UNCONFIRMED_MESSAGE = 'Pincode-specific delivery could not be confirmed.'

function emptyDiagnostics(): PincodeDiagnostics {
  return {
    page_loaded: false,
    product_page_detected: false,
    location_set_attempted: false,
    location_set_success: false,
    captcha_or_robot_detected: false,
    availability_selector_found: false,
    price_selector_found: false,
    buy_box_selector_found: false,
    final_page_type: 'unknown',
  }
}

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
  void input
  console.log(
    JSON.stringify({
      checker: 'pincode-availability',
      phase,
      ...details,
    }),
  )
}

async function selectorFound(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const found = await page.locator(selector).first().isVisible().catch(() => false)
    if (found) return true
  }
  return false
}

async function detectProductPage(page: Page): Promise<boolean> {
  const hasProductSelector = await selectorFound(page, [
    '#productTitle',
    '#dp',
    '#centerCol',
    '#ppd',
    '#ASIN',
  ])
  if (hasProductSelector) return true

  const url = page.url().toLowerCase()
  return url.includes('/dp/') || url.includes('/gp/product/')
}

function diagnosticsMessage(diagnostics: PincodeDiagnostics): string {
  return [
    `page_loaded=${diagnostics.page_loaded}`,
    `product_page_detected=${diagnostics.product_page_detected}`,
    `location_set_attempted=${diagnostics.location_set_attempted}`,
    `location_set_success=${diagnostics.location_set_success}`,
    `captcha_or_robot_detected=${diagnostics.captcha_or_robot_detected}`,
    `availability_selector_found=${diagnostics.availability_selector_found}`,
    `price_selector_found=${diagnostics.price_selector_found}`,
    `buy_box_selector_found=${diagnostics.buy_box_selector_found}`,
    `final_page_type=${diagnostics.final_page_type}`,
  ].join('; ')
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
    error_code: 'checker_timeout',
    error_message: message,
    diagnostics: emptyDiagnostics(),
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

async function collectDiagnostics(page: Page, previous: PincodeDiagnostics): Promise<PincodeDiagnostics> {
  const captchaOrRobotDetected = previous.captcha_or_robot_detected || await isBlockedPage(page)
  const productPageDetected = await detectProductPage(page)
  const availabilitySelectorFound = await selectorFound(page, [
    '#availability',
    '#availability span',
    '#availability_feature_div',
    '#outOfStock',
    '#deliveryBlockMessage',
    '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
    '#ddmDeliveryMessage',
  ])
  const priceSelectorFound = await selectorFound(page, [
    '.a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#price_inside_buybox',
  ])
  const buyBoxSelectorFound = await selectorFound(page, [
    '#add-to-cart-button',
    '#buy-now-button',
    '#submit.add-to-cart',
    '#submit.buy-now',
    '#desktop_buybox',
    '#buybox',
  ])

  return {
    ...previous,
    product_page_detected: productPageDetected,
    captcha_or_robot_detected: captchaOrRobotDetected,
    availability_selector_found: availabilitySelectorFound,
    price_selector_found: priceSelectorFound,
    buy_box_selector_found: buyBoxSelectorFound,
    final_page_type: captchaOrRobotDetected
      ? 'captcha'
      : productPageDetected
        ? 'product'
        : availabilitySelectorFound
          ? 'unavailable'
          : 'unknown',
  }
}

async function decideAvailability(
  page: Page,
  deliveryPromise: string | null,
  pincode: string,
): Promise<AvailabilityDecision> {
  const availabilityText = await collectText(page, ['#availability', '#availability span'])
  const deliveryText = await collectText(page, [
    '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
    '#deliveryBlockMessage',
    '#ddmDeliveryMessage',
  ])
  const locationText = await collectText(page, ['#glow-ingress-line2', '#contextualIngressPtLabel_deliveryShortLine'])

  const focusedText = [
    availabilityText,
    deliveryPromise || '',
    deliveryText,
    locationText,
  ]
    .join(' | ')
    .toLowerCase()

  const locationConfirmed = locationText.toLowerCase().includes(pincode) || locationText.toLowerCase().includes('delivering to')
  const deliveryTextFound = Boolean(normalizeWhitespace(deliveryPromise || '') || normalizeWhitespace(deliveryText))

  const clearUnavailableReason = includesAny(focusedText, STRONG_UNAVAILABLE_HINTS)
  if (clearUnavailableReason) {
    return {
      available: false,
      status: 'unavailable',
      reason: `Amazon indicates unavailability: ${clearUnavailableReason}.`,
      reasonCode: 'strong_negative_evidence',
      matchedPositivePhrase: null,
      matchedNegativePhrase: clearUnavailableReason,
      locationConfirmed,
      deliveryTextFound,
    }
  }

  const explicitAvailableHint = includesAny(focusedText, AVAILABLE_HINTS)
  const hasDeliveringToSignal = focusedText.includes('delivering to')

  const deliveryDatePattern =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|\d{1,2} \w{3})\b/i
  const deliveryPromiseLower = (deliveryPromise || '').toLowerCase()
  const hasDeliveryDate = deliveryDatePattern.test(deliveryPromiseLower)

  if (
    explicitAvailableHint
    && (hasDeliveringToSignal || hasDeliveryDate || locationConfirmed || explicitAvailableHint === 'in stock')
  ) {
    return {
      available: true,
      status: 'success',
      reason: null,
      reasonCode: 'strong_positive_evidence',
      matchedPositivePhrase: explicitAvailableHint,
      matchedNegativePhrase: null,
      locationConfirmed,
      deliveryTextFound,
    }
  }

  return {
    available: null,
    status: 'failed',
    reason: PINCODE_UNCONFIRMED_MESSAGE,
    reasonCode: 'insufficient_evidence',
    matchedPositivePhrase: explicitAvailableHint,
    matchedNegativePhrase: null,
    locationConfirmed,
    deliveryTextFound,
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
      error_code: 'unsupported_marketplace',
      error_message: 'Only Amazon India marketplace is supported by this checker.',
      diagnostics: emptyDiagnostics(),
    }
  }

  const asin = input.asin.trim().toUpperCase()

  try {
    pincodeLog(input, 'start')

    return await withTimeout(
      withBrowserPage(async page => {
        let diagnostics = emptyDiagnostics()
        page.setDefaultTimeout(PAGE_ACTION_TIMEOUT_MS)
        page.setDefaultNavigationTimeout(NAVIGATION_ACTION_TIMEOUT_MS)

        const productUrl = `https://www.amazon.in/dp/${encodeURIComponent(asin)}`
        pincodeLog(input, 'goto_started', { product_url_present: Boolean(productUrl) })
        await withTimeout(
          page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }),
          GOTO_TIMEOUT_MS,
          'Timed out while opening Amazon product page.',
        )
        diagnostics = {
          ...diagnostics,
          page_loaded: true,
        }
        pincodeLog(input, 'goto_completed')

        diagnostics = await collectDiagnostics(page, diagnostics)
        if (diagnostics.captcha_or_robot_detected) {
          pincodeLog(input, 'blocked_detected_after_goto')
          return {
            ok: false,
            available: null,
            delivery_promise: null,
            price: null,
            seller: null,
            status: 'blocked',
            error_code: 'amazon_blocked_or_captcha',
            error_message: diagnosticsMessage(diagnostics),
            diagnostics,
          }
        }

        pincodeLog(input, 'pincode_set_started')
        diagnostics = {
          ...diagnostics,
          location_set_attempted: true,
        }
        const pincodeSet = await withTimeout(
          trySetPincode(page, input.pincode),
          8_000,
          'Timed out while setting pincode on delivery widget.',
        )
        diagnostics = {
          ...diagnostics,
          location_set_success: pincodeSet,
        }
        pincodeLog(input, 'pincode_set_completed', { pincode_set: pincodeSet })

        if (!pincodeSet) {
          diagnostics = await collectDiagnostics(page, diagnostics)
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
            error_code: 'pincode_not_applied',
            error_message: diagnosticsMessage(diagnostics),
            diagnostics,
          }

          pincodeLog(input, 'finish', {
            final_status: response.status,
            available: response.available,
            reason_code: 'pincode_not_confirmed',
            matched_positive_phrase: null,
            matched_negative_phrase: null,
            location_confirmed: false,
            delivery_text_found: Boolean(fallback.deliveryPromise),
          })
          return response
        }

        diagnostics = await collectDiagnostics(page, diagnostics)
        if (diagnostics.captcha_or_robot_detected) {
          pincodeLog(input, 'blocked_detected_after_pincode')
          return {
            ok: false,
            available: null,
            delivery_promise: null,
            price: null,
            seller: null,
            status: 'blocked',
            error_code: 'amazon_blocked_or_captcha',
            error_message: diagnosticsMessage(diagnostics),
            diagnostics,
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

        const decision = await decideAvailability(page, deliveryPromise, input.pincode)
        diagnostics = await collectDiagnostics(page, diagnostics)

        if (decision.available === null && availabilitySignal === true) {
          const response: PincodeAvailabilityResponse = {
            ok: true,
            available: true,
            delivery_promise: deliveryPromise,
            price,
            seller,
            status: 'success',
            error_code: null,
            error_message: null,
            diagnostics,
          }

          pincodeLog(input, 'finish', {
            final_status: response.status,
            available: response.available,
            reason_code: decision.reasonCode,
            matched_positive_phrase: decision.matchedPositivePhrase,
            matched_negative_phrase: decision.matchedNegativePhrase,
            location_confirmed: decision.locationConfirmed,
            delivery_text_found: decision.deliveryTextFound,
          })
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
            error_code: null,
            error_message: null,
            diagnostics,
          }

          pincodeLog(input, 'finish', {
            final_status: response.status,
            available: response.available,
            reason_code: decision.reasonCode,
            matched_positive_phrase: decision.matchedPositivePhrase,
            matched_negative_phrase: decision.matchedNegativePhrase,
            location_confirmed: decision.locationConfirmed,
            delivery_text_found: decision.deliveryTextFound,
          })
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
            error_code: 'product_unavailable',
            error_message: decision.reason,
            diagnostics: {
              ...diagnostics,
              final_page_type: 'unavailable',
            },
          }

          pincodeLog(input, 'finish', {
            final_status: response.status,
            available: response.available,
            reason_code: decision.reasonCode,
            matched_positive_phrase: decision.matchedPositivePhrase,
            matched_negative_phrase: decision.matchedNegativePhrase,
            location_confirmed: decision.locationConfirmed,
            delivery_text_found: decision.deliveryTextFound,
          })
          return response
        }

        const response: PincodeAvailabilityResponse = {
          ok: false,
          available: null,
          delivery_promise: deliveryPromise,
          price,
          seller,
          status: 'failed',
          error_code: diagnostics.availability_selector_found || diagnostics.price_selector_found || diagnostics.buy_box_selector_found
            ? 'pincode_not_applied'
            : 'selectors_not_found',
          error_message: diagnosticsMessage(diagnostics),
          diagnostics,
        }

        pincodeLog(input, 'finish', {
          final_status: response.status,
          available: response.available,
          reason_code: decision.reasonCode,
          matched_positive_phrase: decision.matchedPositivePhrase,
          matched_negative_phrase: decision.matchedNegativePhrase,
          location_confirmed: decision.locationConfirmed,
          delivery_text_found: decision.deliveryTextFound,
        })
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
      error_code: timeoutLike ? 'checker_timeout' : 'checker_failed',
      error_message: message,
      diagnostics: emptyDiagnostics(),
    }
  }
}
