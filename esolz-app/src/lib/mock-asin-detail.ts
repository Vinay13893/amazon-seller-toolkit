// ─── Types ───────────────────────────────────────────────────────────────────

export interface BsrPoint   { date: string; rank: number }
export interface PricePoint { date: string; price: number }

export interface BuyBoxPoint {
  date: string
  winner: string
  is_self: boolean
}

export interface KeywordRank {
  keyword: string
  rank: number | null
  prev_rank: number | null
  search_volume: number
  trend: 'up' | 'down' | 'flat'
}

export interface PincodeData {
  pincode: string
  city: string
  state: string
  available: boolean
  delivery_days: number | null
}

export interface AsinAlert {
  id: string
  type: 'bsr_drop' | 'bsr_rise' | 'buybox_lost' | 'buybox_won' | 'price_change' | 'low_stock' | 'oos'
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

// ─── Deterministic PRNG (Linear Congruential) ────────────────────────────────

function pseudoRand(seed: number) {
  let s = seed | 0
  return (): number => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

function asinSeed(asin: string): number {
  return asin.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0)
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ─── Generators ──────────────────────────────────────────────────────────────

export function generateBsrHistory(
  asin: string,
  currentRank: number | null,
  days = 30,
): BsrPoint[] {
  if (currentRank === null) return []
  const rand = pseudoRand(asinSeed(asin))
  const points: BsrPoint[] = []
  let rank = Math.round(currentRank * (1.15 + rand() * 0.25))

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    points.push({ date: fmtDate(d), rank: Math.max(1, Math.round(rank)) })

    if (i > 0) {
      const drift = ((rank - currentRank) / (i + 1)) * 0.35
      const noise = (rand() - 0.48) * currentRank * 0.07
      rank = Math.max(
        Math.round(currentRank * 0.6),
        Math.min(Math.round(currentRank * 2.2), rank - drift + noise),
      )
    }
  }
  points[points.length - 1].rank = currentRank
  return points
}

export function generatePriceHistory(
  asin: string,
  currentPrice: number | null,
  days = 30,
): PricePoint[] {
  if (currentPrice === null) return []
  const rand = pseudoRand(asinSeed(asin) + 42)
  const points: PricePoint[] = []
  let price = currentPrice

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    points.push({ date: fmtDate(d), price: Math.round(price) })
    if (i > 0 && rand() < 0.12) {
      const delta = (rand() - 0.5) * currentPrice * 0.08
      price = Math.round(
        Math.max(currentPrice * 0.82, Math.min(currentPrice * 1.25, price + delta)),
      )
    }
  }
  points[points.length - 1].price = currentPrice
  return points
}

export function generateBuyBoxHistory(
  isSelf: boolean | null,
  winner: string | null,
): BuyBoxPoint[] {
  const you = 'You'
  const other = winner && !isSelf ? winner : 'Competitor'
  const history: BuyBoxPoint[] = []

  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const date = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
    let dayOwner: string
    if (isSelf === null) {
      dayOwner = '—'
    } else if (isSelf === true) {
      dayOwner = i === 3 || i === 5 ? other : you
    } else {
      dayOwner = i >= 4 ? you : other
    }
    history.push({ date, winner: dayOwner, is_self: dayOwner === you })
  }
  return history
}

// ─── Static Mock Data ─────────────────────────────────────────────────────────

const KEYWORD_MAP: Record<string, KeywordRank[]> = {
  B0BN5NZCGH: [
    { keyword: 'cow ghee 1kg',          rank: 12,   prev_rank: 15,  search_volume: 40500, trend: 'up'   },
    { keyword: 'pure desi ghee',         rank: 28,   prev_rank: 28,  search_volume: 33200, trend: 'flat' },
    { keyword: 'organic ghee india',     rank: 34,   prev_rank: 41,  search_volume: 12100, trend: 'up'   },
    { keyword: 'grass fed cow ghee',     rank: 67,   prev_rank: 55,  search_volume: 8900,  trend: 'down' },
    { keyword: 'daily herbs ghee',       rank: 3,    prev_rank: 4,   search_volume: 2200,  trend: 'up'   },
    { keyword: 'best ghee for cooking',  rank: null, prev_rank: null, search_volume: 61000, trend: 'flat' },
  ],
  B09W2N5K3X: [
    { keyword: 'herbal green tea',    rank: 45, prev_rank: 52, search_volume: 28400, trend: 'up'   },
    { keyword: 'organic tea blend',   rank: 33, prev_rank: 30, search_volume: 15600, trend: 'down' },
    { keyword: 'ayurvedic tea 250g',  rank: 18, prev_rank: 22, search_volume: 9800,  trend: 'up'   },
    { keyword: 'tulsi ginger tea',    rank: 71, prev_rank: 68, search_volume: 7200,  trend: 'down' },
  ],
  B07XQFM2XK: [
    { keyword: 'turmeric powder 500g',   rank: 89, prev_rank: 82,  search_volume: 35000, trend: 'down' },
    { keyword: 'organic turmeric india', rank: 43, prev_rank: 50,  search_volume: 18000, trend: 'up'   },
    { keyword: 'haldi powder 250g',      rank: 61, prev_rank: 58,  search_volume: 27000, trend: 'down' },
    { keyword: 'raw turmeric powder',    rank: null, prev_rank: null, search_volume: 41000, trend: 'flat' },
  ],
  B0C3KJR45M: [
    { keyword: 'neem face wash',           rank: 8,  prev_rank: 11, search_volume: 55000, trend: 'up'   },
    { keyword: 'ayurvedic face wash',      rank: 15, prev_rank: 15, search_volume: 42000, trend: 'flat' },
    { keyword: 'neem tulsi cleanser',      rank: 22, prev_rank: 28, search_volume: 18500, trend: 'up'   },
    { keyword: 'natural face wash india',  rank: 41, prev_rank: 36, search_volume: 29000, trend: 'down' },
    { keyword: 'neem face wash 200ml',     rank: 6,  prev_rank: 7,  search_volume: 3100,  trend: 'up'   },
  ],
  B08JK2MN7P: [
    { keyword: 'ashwagandha capsules',     rank: null, prev_rank: null, search_volume: 71000, trend: 'flat' },
    { keyword: 'ashwagandha 500mg',        rank: null, prev_rank: null, search_volume: 38000, trend: 'flat' },
    { keyword: 'organic ashwagandha 60ct', rank: null, prev_rank: null, search_volume: 12000, trend: 'flat' },
  ],
}

export function getMockKeywords(asin: string): KeywordRank[] {
  return KEYWORD_MAP[asin] ?? []
}

export const MOCK_PINCODES: PincodeData[] = [
  { pincode: '110001', city: 'New Delhi',  state: 'Delhi',       available: true,  delivery_days: 2    },
  { pincode: '400001', city: 'Mumbai',     state: 'Maharashtra', available: true,  delivery_days: 2    },
  { pincode: '560001', city: 'Bengaluru',  state: 'Karnataka',   available: true,  delivery_days: 3    },
  { pincode: '600001', city: 'Chennai',    state: 'Tamil Nadu',  available: true,  delivery_days: 3    },
  { pincode: '700001', city: 'Kolkata',    state: 'West Bengal', available: false, delivery_days: null },
  { pincode: '500001', city: 'Hyderabad',  state: 'Telangana',   available: true,  delivery_days: 4    },
  { pincode: '380001', city: 'Ahmedabad',  state: 'Gujarat',     available: true,  delivery_days: 3    },
  { pincode: '411001', city: 'Pune',       state: 'Maharashtra', available: false, delivery_days: null },
]

const ALERT_MAP: Record<string, AsinAlert[]> = {
  B0BN5NZCGH: [
    { id: 'a1', type: 'bsr_rise',    severity: 'success', message: 'BSR improved from #380 → #342 in Grocery & Gourmet Foods',     timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() },
    { id: 'a2', type: 'buybox_won',  severity: 'success', message: 'You own the Buy Box for this listing',                          timestamp: new Date(Date.now() - 6 * 3600_000).toISOString() },
    { id: 'a3', type: 'price_change',severity: 'info',    message: 'Price stable at ₹1,299 for 7 consecutive days',                 timestamp: new Date(Date.now() - 7 * 86400_000).toISOString() },
  ],
  B09W2N5K3X: [
    { id: 'b1', type: 'bsr_drop',    severity: 'warning', message: 'BSR dropped from #1,650 → #1,842 — rank worsened by 192',       timestamp: new Date(Date.now() - 3 * 3600_000).toISOString() },
    { id: 'b2', type: 'buybox_lost', severity: 'error',   message: 'Buy Box lost to TeaWorld. Price gap: ₹30',                       timestamp: new Date(Date.now() - 12 * 3600_000).toISOString() },
    { id: 'b3', type: 'price_change',severity: 'warning', message: 'Competitor TeaWorld lowered price to ₹519',                     timestamp: new Date(Date.now() - 86400_000).toISOString() },
  ],
  B07XQFM2XK: [
    { id: 'c1', type: 'bsr_drop',    severity: 'error',   message: 'BSR significantly worsened from #4,900 → #5,621',               timestamp: new Date(Date.now() - 5 * 3600_000).toISOString() },
    { id: 'c2', type: 'low_stock',   severity: 'error',   message: 'Inventory critically low — availability score 35/100',          timestamp: new Date(Date.now() - 8 * 3600_000).toISOString() },
    { id: 'c3', type: 'oos',         severity: 'warning', message: 'Product unavailable in 2 tracked pincodes',                     timestamp: new Date(Date.now() - 2 * 86400_000).toISOString() },
  ],
  B0C3KJR45M: [
    { id: 'd1', type: 'bsr_rise',    severity: 'success', message: 'BSR improved from #315 → #289 in Beauty & Personal Care',        timestamp: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'd2', type: 'buybox_lost', severity: 'warning', message: 'Buy Box lost to NaturaBeauty — review your pricing',             timestamp: new Date(Date.now() - 4 * 3600_000).toISOString() },
    { id: 'd3', type: 'price_change',severity: 'info',    message: 'Keyword "neem face wash" rank improved to #8 — top 10!',         timestamp: new Date(Date.now() - 18 * 3600_000).toISOString() },
  ],
  B08JK2MN7P: [
    { id: 'e1', type: 'bsr_drop',    severity: 'info',    message: 'First scrape pending — data will appear within 30 minutes',      timestamp: new Date(Date.now() - 30 * 60_000).toISOString() },
  ],
}

export function getMockAlerts(asin: string): AsinAlert[] {
  return ALERT_MAP[asin] ?? [
    { id: 'z1', type: 'bsr_drop', severity: 'info', message: 'No alerts yet for this ASIN', timestamp: new Date().toISOString() },
  ]
}
