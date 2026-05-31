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

const PINCODE_V1_FAILURE_MESSAGE = 'Pincode-specific check is not fully available in worker v1.'

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
      error_message: 'Only Amazon India marketplace is supported in worker v1.',
    }
  }

  const asin = input.asin.trim().toUpperCase()

  try {
    return await withBrowserPage(async page => {
      const productUrl = `https://www.amazon.in/dp/${encodeURIComponent(asin)}`
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

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
          error_message: PINCODE_V1_FAILURE_MESSAGE,
        }
      }

      const [available, deliveryPromise, price, seller] = await Promise.all([
        detectAvailability(page),
        extractDeliveryPromise(page),
        extractPrice(page),
        extractSeller(page),
      ])

      if (available === true) {
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

      if (available === false) {
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
        error_message: 'Could not determine clear pincode availability from Amazon page.',
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
