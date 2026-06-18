import { z } from 'zod'
import { withBrowserPage } from '../utils/browser'
import { isAmazonIndiaMarketplace, isBlockedPage } from '../utils/amazon'

export const keywordRankRequestSchema = z.object({
  workspace_id: z.string().min(1),
  tracked_keyword_id: z.string().min(1),
  asin: z.string().min(1),
  keyword: z.string().min(1),
  marketplace: z.string().min(1),
  marketplace_id: z.string().optional(),
})

export type KeywordRankRequest = z.infer<typeof keywordRankRequestSchema>

export type KeywordRankResponse = {
  ok: boolean
  found: boolean
  organic_rank: number | null
  organic_page: number | null
  organic_slot: number | null
  organic_found: boolean
  sponsored_rank: number | null
  sponsored_page: number | null
  sponsored_slot: number | null
  sponsored_found: boolean
  status: 'success' | 'not_found' | 'blocked' | 'failed'
  error_message: string | null
}

type SearchResultRow = {
  asin: string
  sponsored: boolean
  positionOnPage: number
}

function normalizeAsin(asin: string): string {
  return asin.trim().toUpperCase()
}

export async function runKeywordRankCheck(input: KeywordRankRequest): Promise<KeywordRankResponse> {
  if (!isAmazonIndiaMarketplace(input.marketplace)) {
    return {
      ok: false,
      found: false,
      organic_rank: null,
      organic_page: null,
      organic_slot: null,
      organic_found: false,
      sponsored_rank: null,
      sponsored_page: null,
      sponsored_slot: null,
      sponsored_found: false,
      status: 'failed',
      error_message: 'Only Amazon India marketplace is supported in worker v1.',
    }
  }

  const targetAsin = normalizeAsin(input.asin)
  const keyword = input.keyword.trim()

  try {
    return await withBrowserPage(async page => {
      let organicCounter = 0
      let sponsoredCounter = 0
      let organicRank: number | null = null
      let organicPage: number | null = null
      let organicSlot: number | null = null
      let sponsoredRank: number | null = null
      let sponsoredPage: number | null = null
      let sponsoredSlot: number | null = null

      for (let pageIndex = 1; pageIndex <= 3; pageIndex += 1) {
        const searchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(keyword)}&page=${pageIndex}`

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

        if (await isBlockedPage(page)) {
          return {
            ok: false,
            found: false,
            organic_rank: null,
            organic_page: null,
            organic_slot: null,
            organic_found: false,
            sponsored_rank: null,
            sponsored_page: null,
            sponsored_slot: null,
            sponsored_found: false,
            status: 'blocked',
            error_message: 'Amazon blocked the keyword check. Try again later.',
          }
        }

        const rows = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll<HTMLElement>('div.s-main-slot div[data-component-type="s-search-result"][data-asin]'))
          return cards
            .map((card, idx) => {
              const asin = (card.getAttribute('data-asin') || '').trim().toUpperCase()
              if (!asin) return null

              const rowText = (card.textContent || '').toLowerCase()
              const sponsored = rowText.includes('sponsored') || !!card.closest('[data-component-type="sp-sponsored-result"]')

              return {
                asin,
                sponsored,
                positionOnPage: idx + 1,
              }
            })
            .filter((item): item is { asin: string; sponsored: boolean; positionOnPage: number } => !!item)
        }) as SearchResultRow[]

        for (const row of rows) {
          if (row.sponsored) {
            sponsoredCounter += 1
          } else {
            organicCounter += 1
          }

          if (row.asin !== targetAsin) {
            continue
          }

          if (!row.sponsored && organicRank === null) {
            organicRank = organicCounter
            organicPage = pageIndex
            organicSlot = row.positionOnPage
          }

          if (row.sponsored && sponsoredRank === null) {
            sponsoredRank = sponsoredCounter
            sponsoredPage = pageIndex
            sponsoredSlot = row.positionOnPage
          }
        }

        if (organicRank !== null && sponsoredRank !== null) break
      }

      const found = organicRank !== null || sponsoredRank !== null
      return {
        ok: true,
        found,
        organic_rank: organicRank,
        organic_page: organicPage,
        organic_slot: organicSlot,
        organic_found: organicRank !== null,
        sponsored_rank: sponsoredRank,
        sponsored_page: sponsoredPage,
        sponsored_slot: sponsoredSlot,
        sponsored_found: sponsoredRank !== null,
        status: found ? 'success' : 'not_found',
        error_message: null,
      }
    })
  } catch {
    return {
      ok: false,
      found: false,
      organic_rank: null,
      organic_page: null,
      organic_slot: null,
      organic_found: false,
      sponsored_rank: null,
      sponsored_page: null,
      sponsored_slot: null,
      sponsored_found: false,
      status: 'failed',
      error_message: 'Keyword rank checker failed unexpectedly.',
    }
  }
}
