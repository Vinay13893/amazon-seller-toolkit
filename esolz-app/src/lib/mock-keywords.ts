// ─── Types ────────────────────────────────────────────────────────────────────

export type KeywordIntent = 'generic' | 'long_tail' | 'competitor' | 'problem_based'
export type PageStatus = 'page_1' | 'page_2' | 'page_3' | 'not_ranking'
export type CompetitionLevel = 'low' | 'medium' | 'high'
export type Marketplace = 'amazon.in' | 'amazon.com'

export interface ResearchKeyword {
  id: string
  keyword: string
  search_volume: number
  /** CPC estimate in INR (amazon.in) or USD (amazon.com) */
  cpc_estimate: number
  competition: CompetitionLevel
  /** 0–100 keyword difficulty score */
  difficulty: number
  intent: KeywordIntent
  /** Top-ranking ASIN for this keyword */
  top_asin: string
}

export interface TrackedKeyword {
  id: string
  keyword: string
  asin: string
  product_name: string
  organic_rank: number | null
  prev_organic_rank: number | null
  sponsored_rank: number | null
  page_status: PageStatus
  search_volume: number
  last_checked: string
}

export interface KeywordHistoryPoint {
  date: string
  rank: number | null
}

export interface KeywordGroup {
  id: string
  name: string
  description: string
  keywords: string[]
  total_volume: number
  page_1_count: number
}

export interface KeywordAlert {
  id: string
  type:
    | 'rank_drop'
    | 'page_1_entry'
    | 'sponsored_lost'
    | 'competitor_overtake'
    | 'not_ranking'
    | 'rank_improved'
    | 'top_rank'
  keyword: string
  asin: string
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

// ─── Rank history generator ────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function seededRand(seed: number): () => number {
  let s = seed
  return (): number => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

function genHistory(
  seed: string,
  startRank: number,
  endRank: number,
  days = 30,
): KeywordHistoryPoint[] {
  const r = seededRand(seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0))
  return Array.from({ length: days }, (_, i) => {
    const base = new Date('2026-04-27T00:00:00Z')
    base.setUTCDate(base.getUTCDate() + i)
    const label = `${MONTHS[base.getUTCMonth()]} ${base.getUTCDate()}`
    const trend = startRank + (endRank - startRank) * (i / Math.max(days - 1, 1))
    const noise = (r() - 0.5) * Math.max(2, Math.abs(endRank - startRank) * 0.15)
    return { date: label, rank: Math.max(1, Math.round(trend + noise)) }
  })
}

function nullHistory(days = 30): KeywordHistoryPoint[] {
  return Array.from({ length: days }, (_, i) => {
    const base = new Date('2026-04-27T00:00:00Z')
    base.setUTCDate(base.getUTCDate() + i)
    const label = `${MONTHS[base.getUTCMonth()]} ${base.getUTCDate()}`
    return { date: label, rank: null }
  })
}

// ─── Research keywords ─────────────────────────────────────────────────────────

export const MOCK_RESEARCH_KEYWORDS: ResearchKeyword[] = [
  {
    id: 'rk1',
    keyword: 'pure desi ghee 500ml',
    search_volume: 12400,
    cpc_estimate: 8.5,
    competition: 'high',
    difficulty: 72,
    intent: 'generic',
    top_asin: 'B0BN5NZCGH',
  },
  {
    id: 'rk2',
    keyword: 'organic cow ghee online india',
    search_volume: 5800,
    cpc_estimate: 6.2,
    competition: 'medium',
    difficulty: 55,
    intent: 'long_tail',
    top_asin: 'B0BN5NZCGH',
  },
  {
    id: 'rk3',
    keyword: 'a2 ghee benefits health',
    search_volume: 8900,
    cpc_estimate: 4.8,
    competition: 'medium',
    difficulty: 48,
    intent: 'problem_based',
    top_asin: 'B0BN5NZCGH',
  },
  {
    id: 'rk4',
    keyword: 'best ghee brand india',
    search_volume: 22000,
    cpc_estimate: 12.0,
    competition: 'high',
    difficulty: 85,
    intent: 'generic',
    top_asin: 'B0ABC99999',
  },
  {
    id: 'rk5',
    keyword: 'patanjali ghee vs amul ghee',
    search_volume: 3400,
    cpc_estimate: 3.2,
    competition: 'low',
    difficulty: 30,
    intent: 'competitor',
    top_asin: 'B0COMP9999',
  },
  {
    id: 'rk6',
    keyword: 'ghee for weight loss keto diet',
    search_volume: 7200,
    cpc_estimate: 5.5,
    competition: 'medium',
    difficulty: 42,
    intent: 'problem_based',
    top_asin: 'B0PROB9999',
  },
  {
    id: 'rk7',
    keyword: 'buy desi ghee online home delivery',
    search_volume: 4100,
    cpc_estimate: 7.8,
    competition: 'medium',
    difficulty: 58,
    intent: 'long_tail',
    top_asin: 'B0BN5NZCGH',
  },
  {
    id: 'rk8',
    keyword: 'desi ghee 1kg lowest price',
    search_volume: 18500,
    cpc_estimate: 9.5,
    competition: 'high',
    difficulty: 78,
    intent: 'generic',
    top_asin: 'B0ABC11111',
  },
  {
    id: 'rk9',
    keyword: 'green tea weight loss india',
    search_volume: 34000,
    cpc_estimate: 11.2,
    competition: 'high',
    difficulty: 80,
    intent: 'problem_based',
    top_asin: 'B09W2N5K3X',
  },
  {
    id: 'rk10',
    keyword: 'himalayan organic tea bags 100',
    search_volume: 6200,
    cpc_estimate: 5.0,
    competition: 'low',
    difficulty: 35,
    intent: 'long_tail',
    top_asin: 'B09W2N5K3X',
  },
]

// ─── Tracked keywords ──────────────────────────────────────────────────────────

export const MOCK_TRACKED_KEYWORDS: TrackedKeyword[] = [
  {
    id: 'tk1',
    keyword: 'pure desi ghee 500ml',
    asin: 'B0BN5NZCGH',
    product_name: 'A2B Natural Desi Ghee (500ml)',
    organic_rank: 3,
    prev_organic_rank: 7,
    sponsored_rank: 1,
    page_status: 'page_1',
    search_volume: 12400,
    last_checked: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk2',
    keyword: 'organic ghee online india',
    asin: 'B0BN5NZCGH',
    product_name: 'A2B Natural Desi Ghee (500ml)',
    organic_rank: 12,
    prev_organic_rank: 18,
    sponsored_rank: 3,
    page_status: 'page_1',
    search_volume: 5800,
    last_checked: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk3',
    keyword: 'best green tea india',
    asin: 'B09W2N5K3X',
    product_name: 'Himalayan Green Tea (100 bags)',
    organic_rank: 28,
    prev_organic_rank: 15,
    sponsored_rank: null,
    page_status: 'page_2',
    search_volume: 31000,
    last_checked: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk4',
    keyword: 'himalayan green tea bags',
    asin: 'B09W2N5K3X',
    product_name: 'Himalayan Green Tea (100 bags)',
    organic_rank: 8,
    prev_organic_rank: 9,
    sponsored_rank: 2,
    page_status: 'page_1',
    search_volume: 7600,
    last_checked: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk5',
    keyword: 'organic turmeric powder 250g',
    asin: 'B07XQFM2XK',
    product_name: 'Organic Turmeric Powder (250g)',
    organic_rank: 1,
    prev_organic_rank: 3,
    sponsored_rank: 1,
    page_status: 'page_1',
    search_volume: 9200,
    last_checked: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk6',
    keyword: 'neem face wash herbal',
    asin: 'B0C3KJR45M',
    product_name: 'Neem & Tulsi Face Wash (100ml)',
    organic_rank: 5,
    prev_organic_rank: 2,
    sponsored_rank: null,
    page_status: 'page_1',
    search_volume: 24000,
    last_checked: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk7',
    keyword: 'ashwagandha capsules 500mg',
    asin: 'B08JK2MN7P',
    product_name: 'Ashwagandha Root Capsules (60ct)',
    organic_rank: null,
    prev_organic_rank: null,
    sponsored_rank: null,
    page_status: 'not_ranking',
    search_volume: 45000,
    last_checked: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
  },
  {
    id: 'tk8',
    keyword: 'herbal immunity booster supplement',
    asin: 'B08JK2MN7P',
    product_name: 'Ashwagandha Root Capsules (60ct)',
    organic_rank: 35,
    prev_organic_rank: 22,
    sponsored_rank: 8,
    page_status: 'page_3',
    search_volume: 8800,
    last_checked: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
  },
]

// ─── 30-day rank histories per tracked keyword ─────────────────────────────────

export const KEYWORD_RANK_HISTORY: Record<string, KeywordHistoryPoint[]> = {
  tk1: genHistory('tk1', 15, 3),     // improving: 15 → 3
  tk2: genHistory('tk2', 22, 12),    // improving: 22 → 12
  tk3: genHistory('tk3', 12, 28),    // declining: 12 → 28
  tk4: genHistory('tk4', 11, 8),     // slightly improving: 11 → 8
  tk5: genHistory('tk5', 9, 1),      // strong improvement: 9 → 1
  tk6: genHistory('tk6', 2, 5),      // slight decline: 2 → 5
  tk7: nullHistory(),                // never ranked
  tk8: genHistory('tk8', 18, 35),    // declining: 18 → 35
}

// ─── Keyword groups ────────────────────────────────────────────────────────────

export const KEYWORD_GROUPS: KeywordGroup[] = [
  {
    id: 'g1',
    name: 'High Intent',
    description: 'Strong purchase signals — users likely to buy',
    keywords: ['pure desi ghee 500ml', 'organic ghee online india', 'organic turmeric powder 250g', 'buy desi ghee online home delivery'],
    total_volume: 31500,
    page_1_count: 3,
  },
  {
    id: 'g2',
    name: 'Long-tail',
    description: 'Specific multi-word queries with lower competition',
    keywords: ['organic cow ghee online india', 'himalayan green tea bags', 'buy desi ghee online home delivery', 'herbal immunity booster supplement'],
    total_volume: 26300,
    page_1_count: 2,
  },
  {
    id: 'g3',
    name: 'Competitor',
    description: 'Keywords targeting competitor brands',
    keywords: ['patanjali ghee vs amul ghee'],
    total_volume: 3400,
    page_1_count: 0,
  },
  {
    id: 'g4',
    name: 'Problem-based',
    description: 'Users solving health or lifestyle problems',
    keywords: ['a2 ghee benefits health', 'ghee for weight loss keto diet', 'neem face wash herbal', 'green tea weight loss india'],
    total_volume: 74100,
    page_1_count: 1,
  },
  {
    id: 'g5',
    name: 'Generic',
    description: 'Broad category keywords — high volume, high competition',
    keywords: ['best ghee brand india', 'desi ghee 1kg lowest price', 'best green tea india', 'ashwagandha capsules 500mg'],
    total_volume: 120500,
    page_1_count: 0,
  },
]

// ─── Alerts ────────────────────────────────────────────────────────────────────

export const KEYWORD_ALERTS: KeywordAlert[] = [
  {
    id: 'ka1',
    type: 'rank_drop',
    keyword: 'best green tea india',
    asin: 'B09W2N5K3X',
    message: '"best green tea india" dropped from #15 to #28 over the last 7 days. You are now on Page 2.',
    severity: 'error',
    timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka2',
    type: 'page_1_entry',
    keyword: 'organic ghee online india',
    asin: 'B0BN5NZCGH',
    message: '"organic ghee online india" improved from #18 to #12. Now on Page 1!',
    severity: 'success',
    timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka3',
    type: 'sponsored_lost',
    keyword: 'neem face wash herbal',
    asin: 'B0C3KJR45M',
    message: 'Sponsored rank disappeared for "neem face wash herbal". Campaign budget may be exhausted.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka4',
    type: 'competitor_overtake',
    keyword: 'neem face wash herbal',
    asin: 'B0C3KJR45M',
    message: 'Competitor overtook your ASIN for "neem face wash herbal". Your rank dropped from #2 to #5.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka5',
    type: 'not_ranking',
    keyword: 'ashwagandha capsules 500mg',
    asin: 'B08JK2MN7P',
    message: '"ashwagandha capsules 500mg" (45K monthly searches) is not indexing for B08JK2MN7P. Review your listing.',
    severity: 'error',
    timestamp: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka6',
    type: 'rank_improved',
    keyword: 'pure desi ghee 500ml',
    asin: 'B0BN5NZCGH',
    message: '"pure desi ghee 500ml" improved from #7 to #3. Strong upward momentum over 7 days.',
    severity: 'success',
    timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ka7',
    type: 'top_rank',
    keyword: 'organic turmeric powder 250g',
    asin: 'B07XQFM2XK',
    message: '"organic turmeric powder 250g" reached organic rank #1! Maintain pricing and inventory to hold position.',
    severity: 'success',
    timestamp: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString(),
  },
]

// ─── Integration placeholders ──────────────────────────────────────────────────
//
// Replace the bodies of these functions with your real keyword logic.
//
// Suggested wiring:
//   researchKeywords  → Amazon Suggest API / keyword scraper / 3rd-party tool
//   refreshKeywordRanks → Amazon SERP scraper for organic/sponsored rank position

export async function researchKeywords(
  _seedKeyword: string,
  _marketplace: Marketplace = 'amazon.in',
  _category?: string,
): Promise<ResearchKeyword[]> {
  // ── TODO: replace body with real keyword research call ─────────────────────
  await new Promise(r => setTimeout(r, 1000))
  return MOCK_RESEARCH_KEYWORDS
}

export async function refreshKeywordRanks(
  _keywords: string[],
  _asins: string[],
): Promise<TrackedKeyword[]> {
  // ── TODO: replace body with real rank-check scraper call ───────────────────
  await new Promise(r => setTimeout(r, 1200))
  return MOCK_TRACKED_KEYWORDS.map(k => ({
    ...k,
    last_checked: new Date().toISOString(),
  }))
}
