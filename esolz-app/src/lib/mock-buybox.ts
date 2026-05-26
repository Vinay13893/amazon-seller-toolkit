// ─── Types ────────────────────────────────────────────────────────────────────

export type BuyBoxOwnership = 'won' | 'lost' | 'suppressed'
export type RiskLevel = 'low' | 'medium' | 'high'
export type Marketplace = 'amazon.in' | 'amazon.com'
export type Fulfillment = 'FBA' | 'FBM'
export type HealthStatus = 'Healthy' | 'Warning' | 'Critical'

export interface BuyBoxEntry {
  asin: string
  product_name: string
  marketplace: Marketplace
  /** Seller name currently holding the Buy Box */
  current_owner: string
  /** true if YOU are the current Buy Box holder */
  owner_is_self: boolean
  status: BuyBoxOwnership
  buybox_price: number | null
  your_price: number | null
  /** your_price - buybox_price: positive = you're more expensive */
  price_gap: number | null
  fulfillment: Fulfillment
  competitor_fulfillment?: Fulfillment
  last_checked: string
}

export interface BuyBoxHistoryDay {
  date: string
  /** 1 if you owned the Buy Box that day, 0 otherwise */
  you: number
  competitor: number
  suppressed: number
  unknown: number
}

export interface CompetitorSeller {
  id: string
  name: string
  /** Number of your ASINs this seller appears on */
  asin_count: number
  /** Average price delta vs your price (negative = they're cheaper) */
  price_advantage: number
  fulfillment: Fulfillment
  risk: RiskLevel
  asins: string[]
}

export interface BuyBoxAlert {
  id: string
  type:
    | 'new_seller'
    | 'buybox_lost'
    | 'suppressed'
    | 'price_undercut'
    | 'fbm_over_fba'
    | 'buybox_won'
    | 'hijacker'
  asin: string
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

// ─── Buy Box Status ────────────────────────────────────────────────────────────

export const MOCK_BUYBOX_ENTRIES: BuyBoxEntry[] = [
  {
    asin: 'B0BN5NZCGH',
    product_name: 'A2B Natural Desi Ghee (500ml)',
    marketplace: 'amazon.in',
    current_owner: 'A2B Foods',
    owner_is_self: true,
    status: 'won',
    buybox_price: 649,
    your_price: 649,
    price_gap: 0,
    fulfillment: 'FBA',
    last_checked: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
  {
    asin: 'B09W2N5K3X',
    product_name: 'Himalayan Green Tea (100 bags)',
    marketplace: 'amazon.in',
    current_owner: 'TechMart Retail',
    owner_is_self: false,
    status: 'lost',
    buybox_price: 299,
    your_price: 349,
    price_gap: 50,
    fulfillment: 'FBA',
    competitor_fulfillment: 'FBA',
    last_checked: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
  },
  {
    asin: 'B07XQFM2XK',
    product_name: 'Organic Turmeric Powder (250g)',
    marketplace: 'amazon.in',
    current_owner: 'SpiceRoute Organics',
    owner_is_self: true,
    status: 'won',
    buybox_price: 199,
    your_price: 199,
    price_gap: 0,
    fulfillment: 'FBA',
    last_checked: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  },
  {
    asin: 'B0C3KJR45M',
    product_name: 'Neem & Tulsi Face Wash (100ml)',
    marketplace: 'amazon.in',
    current_owner: '—',
    owner_is_self: false,
    status: 'suppressed',
    buybox_price: null,
    your_price: 189,
    price_gap: null,
    fulfillment: 'FBA',
    last_checked: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  },
  {
    asin: 'B08JK2MN7P',
    product_name: 'Ashwagandha Root Capsules (60ct)',
    marketplace: 'amazon.in',
    current_owner: 'QuickShip Solutions',
    owner_is_self: false,
    status: 'lost',
    buybox_price: 449,
    your_price: 499,
    price_gap: 50,
    fulfillment: 'FBM',
    competitor_fulfillment: 'FBM',
    last_checked: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
  },
]

// ─── 7-day ownership history per ASIN ─────────────────────────────────────────

export const MOCK_BUYBOX_HISTORY: Record<string, BuyBoxHistoryDay[]> = {
  B0BN5NZCGH: [
    { date: 'May 20', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 21', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 22', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 23', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 24', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 25', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 26', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
  ],
  B09W2N5K3X: [
    { date: 'May 20', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 21', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 22', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 23', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 24', you: 0, competitor: 0, suppressed: 0, unknown: 1 },
    { date: 'May 25', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 26', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
  ],
  B07XQFM2XK: [
    { date: 'May 20', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 21', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 22', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 23', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 24', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 25', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 26', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
  ],
  B0C3KJR45M: [
    { date: 'May 20', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 21', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 22', you: 0, competitor: 0, suppressed: 1, unknown: 0 },
    { date: 'May 23', you: 0, competitor: 0, suppressed: 1, unknown: 0 },
    { date: 'May 24', you: 0, competitor: 0, suppressed: 1, unknown: 0 },
    { date: 'May 25', you: 0, competitor: 0, suppressed: 1, unknown: 0 },
    { date: 'May 26', you: 0, competitor: 0, suppressed: 1, unknown: 0 },
  ],
  B08JK2MN7P: [
    { date: 'May 20', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 21', you: 1, competitor: 0, suppressed: 0, unknown: 0 },
    { date: 'May 22', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 23', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 24', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 25', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
    { date: 'May 26', you: 0, competitor: 1, suppressed: 0, unknown: 0 },
  ],
}

// ─── Competitor sellers ────────────────────────────────────────────────────────

export const MOCK_COMPETITORS: CompetitorSeller[] = [
  {
    id: 'c1',
    name: 'TechMart Retail',
    asin_count: 2,
    price_advantage: -45,
    fulfillment: 'FBA',
    risk: 'medium',
    asins: ['B09W2N5K3X', 'B07XQFM2XK'],
  },
  {
    id: 'c2',
    name: 'QuickShip Solutions',
    asin_count: 2,
    price_advantage: -80,
    fulfillment: 'FBM',
    risk: 'high',
    asins: ['B08JK2MN7P', 'B09W2N5K3X'],
  },
  {
    id: 'c3',
    name: 'BestValue Store',
    asin_count: 1,
    price_advantage: -20,
    fulfillment: 'FBA',
    risk: 'low',
    asins: ['B07XQFM2XK'],
  },
  {
    id: 'c4',
    name: 'UnknownSeller_78X',
    asin_count: 1,
    price_advantage: -150,
    fulfillment: 'FBM',
    risk: 'high',
    asins: ['B0BN5NZCGH'],
  },
]

// ─── Alerts ────────────────────────────────────────────────────────────────────

export const MOCK_BUYBOX_ALERTS: BuyBoxAlert[] = [
  {
    id: 'a1',
    type: 'hijacker',
    asin: 'B0BN5NZCGH',
    message:
      'UnknownSeller_78X listed B0BN5NZCGH at ₹499 — ₹150 below your price. Possible counterfeit or hijacker.',
    severity: 'error',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a2',
    type: 'new_seller',
    asin: 'B0BN5NZCGH',
    message: 'New seller detected on B0BN5NZCGH: UnknownSeller_78X (FBM, appeared 2h ago).',
    severity: 'error',
    timestamp: new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a3',
    type: 'buybox_lost',
    asin: 'B09W2N5K3X',
    message:
      'TechMart Retail won Buy Box on B09W2N5K3X with FBA at ₹299 (your price: ₹349). You are ₹50 higher.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a4',
    type: 'suppressed',
    asin: 'B0C3KJR45M',
    message:
      'Listing B0C3KJR45M has been suppressed by Amazon. No Buy Box is available. Check your listing quality.',
    severity: 'error',
    timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a5',
    type: 'price_undercut',
    asin: 'B08JK2MN7P',
    message:
      'QuickShip Solutions undercut you by ₹50 on B08JK2MN7P. Consider reducing price to ₹449 to reclaim the Buy Box.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a6',
    type: 'fbm_over_fba',
    asin: 'B09W2N5K3X',
    message:
      'FBM seller QuickShip Solutions won Buy Box over your FBA listing on B09W2N5K3X — unusual. Check pricing.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'a7',
    type: 'buybox_won',
    asin: 'B07XQFM2XK',
    message: 'You regained the Buy Box on B07XQFM2XK (Organic Turmeric Powder) after 1 day.',
    severity: 'success',
    timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
  },
]

// ─── Health score helpers ──────────────────────────────────────────────────────

/** Computes Buy Box health score (0–100) based on win rate across active (non-suppressed) ASINs */
export function buyBoxHealthScore(entries: BuyBoxEntry[]): number {
  const active = entries.filter(e => e.status !== 'suppressed')
  if (active.length === 0) return 0
  const won = active.filter(e => e.status === 'won').length
  return Math.round((won / active.length) * 100)
}

export function healthLabel(score: number): HealthStatus {
  if (score >= 80) return 'Healthy'
  if (score >= 50) return 'Warning'
  return 'Critical'
}

export function healthColor(status: HealthStatus): string {
  if (status === 'Healthy') return 'text-green-400'
  if (status === 'Warning') return 'text-yellow-400'
  return 'text-red-400'
}

export function healthBg(status: HealthStatus): string {
  if (status === 'Healthy') return 'bg-green-500/5 border-green-500/20'
  if (status === 'Warning') return 'bg-yellow-500/5 border-yellow-500/20'
  return 'bg-red-500/5 border-red-500/20'
}

// ─── Integration placeholder ───────────────────────────────────────────────────
//
// Replace the body of this function with your real Buy Box checker logic.
//
// Existing files to wire up:
//   e:\amazon-bsr-tracker\verify_seller.py  — Buy Box ownership checker
//   e:\amazon-bsr-tracker\bsr_stealth.py    — Stealth scraping helper
//   e:\amazon-bsr-tracker\app.py            — Flask API (can expose a /buybox endpoint)
//
// Expected: scrape Amazon product page for the Buy Box widget, extract seller
// name, price, fulfillment type, and whether it matches your seller account.
//
// Input:  asin, marketplace, optional pincode (India)
// Output: BuyBoxEntry

export async function checkBuyBoxStatus(
  asin: string,
  marketplace: Marketplace = 'amazon.in',
  _pincode?: string,
): Promise<BuyBoxEntry> {
  // ── TODO: replace body with real scraper call ──────────────────────────────
  await new Promise(r => setTimeout(r, 900))
  const found = MOCK_BUYBOX_ENTRIES.find(
    e => e.asin.toUpperCase() === asin.toUpperCase() && e.marketplace === marketplace,
  )
  if (found) return { ...found, last_checked: new Date().toISOString() }
  return {
    asin: asin.toUpperCase(),
    product_name: 'Unknown Product',
    marketplace,
    current_owner: '—',
    owner_is_self: false,
    status: 'lost',
    buybox_price: null,
    your_price: null,
    price_gap: null,
    fulfillment: 'FBM',
    last_checked: new Date().toISOString(),
  }
}
