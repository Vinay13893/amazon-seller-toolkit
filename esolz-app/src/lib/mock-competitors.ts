// ─── Types ────────────────────────────────────────────────────────────────────

export type Marketplace = 'amazon.in' | 'amazon.com'
export type FulfillmentMethod = 'FBA' | 'FBM' | 'Amazon'
export type TrendDir = 'up' | 'down' | 'stable'

export interface CompetitorProduct {
  id: string
  asin: string
  title: string
  brand: string
  marketplace: Marketplace
  image_url: string // placeholder — will be real in production
  category: string
  current_price: number
  prev_price: number
  bsr_current: number
  bsr_prev: number
  bsr_category: string
  rating: number
  review_count: number
  prev_review_count: number
  fulfillment: FulfillmentMethod
  seller_name: string
  in_stock: boolean
  /** ASIN of your product this competes with */
  competing_with_asin: string
  competing_with_name: string
  last_updated: string
  notes: string
}

export interface BsrHistoryPoint {
  date: string
  bsr: number
}

export interface PriceHistoryPoint {
  date: string
  price: number
  competitor_price: number
}

// ─── Mock competitor products ─────────────────────────────────────────────────

export const MOCK_COMPETITORS: CompetitorProduct[] = [
  {
    id: 'c1',
    asin: 'B08HX5QG2W',
    title: 'DesiMilk A2 Desi Ghee 1kg — Pure Bilona Method',
    brand: 'DesiMilk',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Grocery & Gourmet Foods',
    current_price: 1199,
    prev_price: 1249,
    bsr_current: 120,
    bsr_prev: 850,
    bsr_category: 'Grocery & Gourmet Foods',
    rating: 4.4,
    review_count: 1842,
    prev_review_count: 1810,
    fulfillment: 'FBA',
    seller_name: 'DesiMilk Official',
    in_stock: true,
    competing_with_asin: 'B0BN5NZCGH',
    competing_with_name: 'Pure Desi Ghee 1kg',
    last_updated: '2026-05-26T06:00:00Z',
    notes: 'Aggressive recent price cut. BSR surging — likely running a deal or heavy ads.',
  },
  {
    id: 'c2',
    asin: 'B09KLM7NXP',
    title: 'NaturVeda Organic Cow Ghee 1kg — Grass-Fed',
    brand: 'NaturVeda',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Grocery & Gourmet Foods',
    current_price: 1350,
    prev_price: 1350,
    bsr_current: 340,
    bsr_prev: 310,
    bsr_category: 'Grocery & Gourmet Foods',
    rating: 4.2,
    review_count: 976,
    prev_review_count: 960,
    fulfillment: 'FBA',
    seller_name: 'NaturVeda Store',
    in_stock: true,
    competing_with_asin: 'B0BN5NZCGH',
    competing_with_name: 'Pure Desi Ghee 1kg',
    last_updated: '2026-05-26T06:00:00Z',
    notes: 'Stable price, slow BSR decline. Fewer reviews than us.',
  },
  {
    id: 'c3',
    asin: 'B07RQST4VN',
    title: 'TeaHouse Direct Assam CTC Tea 500g — Strong Brew',
    brand: 'TeaHouse Direct',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Grocery & Gourmet Foods',
    current_price: 649,
    prev_price: 679,
    bsr_current: 88,
    bsr_prev: 145,
    bsr_category: 'Tea & Infusions',
    rating: 4.3,
    review_count: 3241,
    prev_review_count: 3190,
    fulfillment: 'FBA',
    seller_name: 'TeaHouse Direct',
    in_stock: true,
    competing_with_asin: 'B09W2N5K3X',
    competing_with_name: 'Organic Assam Tea 500g',
    last_updated: '2026-05-26T05:45:00Z',
    notes: 'Currently holding Buy Box. ₹30 cheaper than us. Very high review count.',
  },
  {
    id: 'c4',
    asin: 'B0CX2YZ8NW',
    title: 'BrewMaster Premium Darjeeling Tea 500g — First Flush',
    brand: 'BrewMaster',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Grocery & Gourmet Foods',
    current_price: 799,
    prev_price: 749,
    bsr_current: 412,
    bsr_prev: 380,
    bsr_category: 'Tea & Infusions',
    rating: 4.5,
    review_count: 612,
    prev_review_count: 600,
    fulfillment: 'FBM',
    seller_name: 'BrewMaster India',
    in_stock: false,
    competing_with_asin: 'B09W2N5K3X',
    competing_with_name: 'Organic Assam Tea 500g',
    last_updated: '2026-05-25T22:00:00Z',
    notes: 'Currently out of stock. Premium positioning at higher price.',
  },
  {
    id: 'c5',
    asin: 'B08GF3KQ2T',
    title: 'VedaRoot Turmeric Curcumin 95% — 60 Veg Caps',
    brand: 'VedaRoot',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Health & Personal Care',
    current_price: 499,
    prev_price: 549,
    bsr_current: 67,
    bsr_prev: 72,
    bsr_category: 'Vitamins & Dietary Supplements',
    rating: 4.6,
    review_count: 5102,
    prev_review_count: 5045,
    fulfillment: 'FBA',
    seller_name: 'VedaRoot Health',
    in_stock: true,
    competing_with_asin: 'B07XQFM2XK',
    competing_with_name: 'Turmeric Curcumin 60 Capsules',
    last_updated: '2026-05-26T06:00:00Z',
    notes: 'Category leader. 5k+ reviews, very strong BSR. Hard to beat directly.',
  },
  {
    id: 'c6',
    asin: 'B09TRQ8MKL',
    title: 'AyurGlow Neem & Tulsi Face Wash 200ml — Acne Control',
    brand: 'AyurGlow',
    marketplace: 'amazon.in',
    image_url: '',
    category: 'Health & Personal Care',
    current_price: 199,
    prev_price: 199,
    bsr_current: 234,
    bsr_prev: 280,
    bsr_category: 'Face Wash',
    rating: 4.1,
    review_count: 2890,
    prev_review_count: 2840,
    fulfillment: 'FBA',
    seller_name: 'AyurGlow Official',
    in_stock: true,
    competing_with_asin: 'B0C3KJR45M',
    competing_with_name: 'Neem Face Wash 200ml',
    last_updated: '2026-05-26T06:00:00Z',
    notes: 'Improving BSR. Very affordable price point — mass market positioning.',
  },
]

// ─── BSR history (30 days, our product vs competitor) ─────────────────────────
// Seeded deterministic generator

function seededRand(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

const BASE_DATE = new Date('2026-04-27T00:00:00Z')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function makeDate(offsetDays: number): string {
  const d = new Date(BASE_DATE.getTime() + offsetDays * 86400000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

function genBsrHistory(
  seed: number,
  startBsr: number,
  endBsr: number,
  days = 30,
): BsrHistoryPoint[] {
  const rand = seededRand(seed)
  return Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1)
    const base = Math.round(startBsr + (endBsr - startBsr) * t)
    const noise = Math.round((rand() - 0.5) * 80)
    return { date: makeDate(i), bsr: Math.max(1, base + noise) }
  })
}

function genPriceHistory(
  seed: number,
  ourStart: number,
  ourEnd: number,
  compStart: number,
  compEnd: number,
  days = 30,
): PriceHistoryPoint[] {
  const rand = seededRand(seed)
  return Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1)
    const ourBase = Math.round(ourStart + (ourEnd - ourStart) * t)
    const compBase = Math.round(compStart + (compEnd - compStart) * t)
    const noise = Math.round((rand() - 0.5) * 30)
    return {
      date: makeDate(i),
      price: Math.max(1, ourBase + noise),
      competitor_price: Math.max(1, compBase + Math.round((rand() - 0.5) * 20)),
    }
  })
}

export const COMPETITOR_BSR_HISTORY: Record<string, BsrHistoryPoint[]> = {
  c1: genBsrHistory(101, 850, 120, 30),
  c2: genBsrHistory(102, 310, 340, 30),
  c3: genBsrHistory(103, 145, 88, 30),
  c4: genBsrHistory(104, 380, 412, 30),
  c5: genBsrHistory(105, 72, 67, 30),
  c6: genBsrHistory(106, 280, 234, 30),
}

export const COMPETITOR_PRICE_HISTORY: Record<string, PriceHistoryPoint[]> = {
  c1: genPriceHistory(201, 1200, 1200, 1249, 1199, 30),
  c2: genPriceHistory(202, 1200, 1200, 1350, 1350, 30),
  c3: genPriceHistory(203, 679, 679, 679, 649, 30),
  c4: genPriceHistory(204, 679, 679, 749, 799, 30),
  c5: genPriceHistory(205, 599, 599, 549, 499, 30),
  c6: genPriceHistory(206, 249, 249, 199, 199, 30),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function bsrTrend(c: CompetitorProduct): TrendDir {
  if (c.bsr_current < c.bsr_prev) return 'up'   // lower BSR = better = they improved
  if (c.bsr_current > c.bsr_prev) return 'down'
  return 'stable'
}

export function priceTrend(c: CompetitorProduct): TrendDir {
  if (c.current_price < c.prev_price) return 'down'
  if (c.current_price > c.prev_price) return 'up'
  return 'stable'
}

export function reviewGrowth(c: CompetitorProduct): number {
  return c.review_count - c.prev_review_count
}

// ─── Integration placeholders ─────────────────────────────────────────────────

/**
 * Add a competitor ASIN to track.
 * Wire to: POST /api/competitors/add (stores in Supabase competitor_asins table)
 */
export async function addCompetitorAsin(
  _asin: string,
  _competingWithAsin: string,
  _marketplace: Marketplace,
): Promise<CompetitorProduct> {
  await new Promise(r => setTimeout(r, 800))
  // TODO: scrape ASIN data via bsr_stealth.py, store in DB
  return MOCK_COMPETITORS[0]
}

/**
 * Refresh all competitor data.
 * Wire to: POST /api/competitors/refresh — triggers scrape job
 */
export async function refreshCompetitorData(): Promise<CompetitorProduct[]> {
  await new Promise(r => setTimeout(r, 1200))
  // TODO: run scrape for each tracked ASIN
  return MOCK_COMPETITORS
}
