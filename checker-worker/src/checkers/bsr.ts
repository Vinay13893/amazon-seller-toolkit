import { z } from 'zod'
import type { Page } from 'playwright'
import { withBrowserPage } from '../utils/browser'
import { isBlockedPage } from '../utils/amazon'

export const bsrRequestSchema = z.object({
  workspace_id: z.string().min(1),
  tracked_asin_id: z.string().min(1),
  asin: z.string().regex(/^[A-Z0-9]{10}$/i),
  marketplace: z.string().min(1),
})

export type BsrRequest = z.infer<typeof bsrRequestSchema>

export type BsrResponse = {
  ok: boolean
  bsr: number | null
  category: string | null
  price: number | null
  rating: number | null
  review_count: number | null
  buy_box_owner: string | null
  availability_score: number | null
  status: 'success' | 'partial_success' | 'blocked' | 'failed'
  error_message: string | null
}

function domainFor(marketplace: string): string | null {
  const value = marketplace.trim().toLowerCase()
  if (value === 'in' || value === 'amazon.in') return 'www.amazon.in'
  if (value === 'us' || value === 'amazon.com') return 'www.amazon.com'
  if (value === 'uk' || value === 'gb' || value === 'amazon.co.uk') return 'www.amazon.co.uk'
  if (value === 'de' || value === 'amazon.de') return 'www.amazon.de'
  return null
}

function numberFrom(value: string | null): number | null {
  if (!value) return null
  const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

async function firstText(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const value = await page.$eval(selector, element => element.textContent?.replace(/\s+/g, ' ').trim() || null).catch(() => null)
    if (value) return value
  }
  return null
}

export function parseBestSellerRank(value: string): { bsr: number | null; category: string | null } {
  const normalized = value.replace(/\s+/g, ' ')
  const match = normalized.match(/#\s*([\d,]+)\s+in\s+([^#|(;]+)/i)
  if (!match) return { bsr: null, category: null }
  return {
    bsr: Number(match[1].replace(/,/g, '')),
    category: match[2].trim() || null,
  }
}

export async function runBsrCheck(input: BsrRequest): Promise<BsrResponse> {
  const domain = domainFor(input.marketplace)
  if (!domain) {
    return { ok: false, bsr: null, category: null, price: null, rating: null, review_count: null, buy_box_owner: null, availability_score: null, status: 'failed', error_message: 'Marketplace is not supported by the public checker.' }
  }

  try {
    return await withBrowserPage(async page => {
      await page.goto(`https://${domain}/dp/${encodeURIComponent(input.asin.toUpperCase())}`, {
        waitUntil: 'commit',
        timeout: 20_000,
      })
      await page.waitForSelector('#productTitle, #dp, #centerCol, #ppd', { timeout: 12_000 }).catch(() => undefined)

    if (await isBlockedPage(page)) {
      return { ok: false, bsr: null, category: null, price: null, rating: null, review_count: null, buy_box_owner: null, availability_score: null, status: 'blocked', error_message: 'Amazon temporarily blocked the public product check. It will retry automatically.' }
    }

    const [title, priceText, ratingText, reviewText, seller, availabilityText, detailsText] = await Promise.all([
      firstText(page, ['#productTitle']),
      firstText(page, ['#corePriceDisplay_desktop_feature_div .a-price .a-offscreen', '#corePrice_feature_div .a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '.a-price .a-offscreen']),
      firstText(page, ['#acrPopover', '[data-hook="rating-out-of-text"]', '.a-icon-alt']),
      firstText(page, ['#acrCustomerReviewText', '[data-hook="total-review-count"]']),
      firstText(page, ['#sellerProfileTriggerId', '#merchant-info a', '#tabular-buybox .tabular-buybox-text']),
      firstText(page, ['#availability', '#availability span']),
      firstText(page, ['#detailBullets_feature_div', '#productDetails_detailBullets_sections1', '#productDetails_db_sections']),
    ])

    const rank = parseBestSellerRank(detailsText ?? '')
    const price = numberFrom(priceText)
    const rating = numberFrom(ratingText)
    const reviewCount = numberFrom(reviewText)
    const availabilityLower = availabilityText?.toLowerCase() ?? ''
    const availabilityScore = /currently unavailable|out of stock/.test(availabilityLower)
      ? 0
      : /in stock|available/.test(availabilityLower)
        ? 100
        : price !== null || seller !== null
          ? 50
          : null
    const signalCount = [rank.bsr, price, rating, reviewCount, seller, availabilityScore].filter(value => value !== null).length

    if (!title && signalCount === 0) {
      return { ok: false, bsr: null, category: null, price: null, rating: null, review_count: null, buy_box_owner: null, availability_score: null, status: 'failed', error_message: 'The product page did not expose enough public data. It will retry automatically.' }
    }

    return {
      ok: true,
      bsr: rank.bsr,
      category: rank.category,
      price,
      rating,
      review_count: reviewCount,
      buy_box_owner: seller,
      availability_score: availabilityScore,
      status: rank.bsr !== null && price !== null ? 'success' : 'partial_success',
      error_message: null,
    }
    }, 55_000)
  } catch {
    return { ok: false, bsr: null, category: null, price: null, rating: null, review_count: null, buy_box_owner: null, availability_score: null, status: 'failed', error_message: 'The public product check timed out. It will retry automatically.' }
  }
}
