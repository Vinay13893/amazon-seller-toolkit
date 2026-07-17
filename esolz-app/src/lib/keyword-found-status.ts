/**
 * src/lib/keyword-found-status.ts
 *
 * Seller-facing "Found" classification for a keyword_rank_snapshots row,
 * used by the ASIN-detail page's KeywordsTable. Mirrors the state meaning
 * already used correctly by the main Keywords tab's FoundStatusBadge
 * (dashboard/keywords/page.tsx) -- 'checker_unavailable' and 'failed' must
 * never fall through to the found/not-found branch, since that would
 * render a check the system never completed as the factual claim
 * "Not found" (PINCODE_CHECKER_PRODUCT_AUDIT.md/KEYWORDS_TAB_PRODUCT_AUDIT.md
 * sec D.6 -- the confirmed P0 this file fixes).
 *
 * The main tab's FoundStatusBadge is left untouched -- it is already
 * correct, and duplicating its exact label wording here is intentionally
 * not attempted; this module owns its own small, independently-testable
 * state model for the one render site that had the bug.
 */

export type KeywordFoundState = 'found' | 'not_found' | 'check_unavailable' | 'not_confirmed'

export interface KeywordFoundInput {
  scrape_status: 'never_checked' | 'success' | 'failed' | 'checker_unavailable'
  found: boolean
}

export function classifyKeywordFound(kw: KeywordFoundInput): KeywordFoundState {
  if (kw.scrape_status === 'never_checked') return 'not_confirmed'
  if (kw.scrape_status === 'checker_unavailable' || kw.scrape_status === 'failed') return 'check_unavailable'
  return kw.found ? 'found' : 'not_found'
}

export const KEYWORD_FOUND_LABEL: Record<KeywordFoundState, string> = {
  found: 'Found',
  not_found: 'Not found',
  check_unavailable: 'Check unavailable',
  not_confirmed: 'Not confirmed',
}

export const KEYWORD_FOUND_TONE: Record<KeywordFoundState, string> = {
  found: 'text-green-400',
  not_found: 'text-yellow-400',
  check_unavailable: 'text-amber-400',
  not_confirmed: 'text-muted-foreground',
}
