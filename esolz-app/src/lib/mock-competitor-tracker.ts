// Mock data for Competitor Tracker page — no real API, no Supabase

export type RiskLevel = 'Low' | 'Medium' | 'High'
export type BuyBoxStatus = 'owned' | 'lost' | 'shared' | 'suppressed'
export type PriceMovement = 'up' | 'down' | 'stable'
export type BsrMovement = 'improved' | 'declined' | 'stable'

export interface CompetitorAsin {
  id: string
  asin: string
  title: string
  brand: string
  marketplace: 'amazon.in'
  category: string
  currentPrice: number
  previousPrice: number
  priceMovement: PriceMovement
  currentBsr: number
  previousBsr: number
  bsrMovement: BsrMovement
  rating: number
  reviewCount: number
  reviewVelocity30d: number
  buyBoxStatus: BuyBoxStatus
  availabilityScore: number   // 0-100
  keywordOverlap: number
  lastChecked: string         // ISO date string
  riskLevel: RiskLevel
}

export const MOCK_COMPETITOR_ASINS: CompetitorAsin[] = [
  {
    id: 'ct1',
    asin: 'B07XK3PJMZ',
    title: 'Organic India Pure Cow Ghee 1kg — A2 Desi Ghee, Cold Pressed',
    brand: 'Organic India',
    marketplace: 'amazon.in',
    category: 'Grocery & Gourmet Foods',
    currentPrice: 649,
    previousPrice: 699,
    priceMovement: 'down',
    currentBsr: 342,
    previousBsr: 520,
    bsrMovement: 'improved',
    rating: 4.3,
    reviewCount: 8420,
    reviewVelocity30d: 142,
    buyBoxStatus: 'owned',
    availabilityScore: 95,
    keywordOverlap: 18,
    lastChecked: '2026-05-26T10:30:00Z',
    riskLevel: 'High',
  },
  {
    id: 'ct2',
    asin: 'B08LFPKWNH',
    title: 'Amul Pure Ghee 1kg Tin — 100% Cow Milk, FSSAI Certified',
    brand: 'Amul',
    marketplace: 'amazon.in',
    category: 'Grocery & Gourmet Foods',
    currentPrice: 595,
    previousPrice: 575,
    priceMovement: 'up',
    currentBsr: 189,
    previousBsr: 162,
    bsrMovement: 'declined',
    rating: 4.1,
    reviewCount: 22310,
    reviewVelocity30d: 387,
    buyBoxStatus: 'owned',
    availabilityScore: 99,
    keywordOverlap: 24,
    lastChecked: '2026-05-26T10:28:00Z',
    riskLevel: 'High',
  },
  {
    id: 'ct3',
    asin: 'B091YNLFXK',
    title: 'Tata Tea Premium 500g — Strong, Full-Bodied Assam Blend',
    brand: 'Tata Tea',
    marketplace: 'amazon.in',
    category: 'Tea, Coffee & Beverages',
    currentPrice: 249,
    previousPrice: 269,
    priceMovement: 'down',
    currentBsr: 78,
    previousBsr: 94,
    bsrMovement: 'improved',
    rating: 4.4,
    reviewCount: 41800,
    reviewVelocity30d: 520,
    buyBoxStatus: 'shared',
    availabilityScore: 98,
    keywordOverlap: 9,
    lastChecked: '2026-05-26T09:55:00Z',
    riskLevel: 'Medium',
  },
  {
    id: 'ct4',
    asin: 'B07YQVN5ZN',
    title: 'Vahdam Organic First Flush Darjeeling Tea 250g — Loose Leaf',
    brand: 'Vahdam',
    marketplace: 'amazon.in',
    category: 'Tea, Coffee & Beverages',
    currentPrice: 499,
    previousPrice: 499,
    priceMovement: 'stable',
    currentBsr: 1204,
    previousBsr: 980,
    bsrMovement: 'declined',
    rating: 4.5,
    reviewCount: 6740,
    reviewVelocity30d: 58,
    buyBoxStatus: 'owned',
    availabilityScore: 87,
    keywordOverlap: 6,
    lastChecked: '2026-05-26T09:40:00Z',
    riskLevel: 'Low',
  },
  {
    id: 'ct5',
    asin: 'B00J5GMKZG',
    title: 'Himalaya Purifying Neem Face Wash 150ml — Oil Control Daily',
    brand: 'Himalaya',
    marketplace: 'amazon.in',
    category: 'Beauty & Personal Care',
    currentPrice: 85,
    previousPrice: 99,
    priceMovement: 'down',
    currentBsr: 412,
    previousBsr: 618,
    bsrMovement: 'improved',
    rating: 4.2,
    reviewCount: 98540,
    reviewVelocity30d: 1240,
    buyBoxStatus: 'lost',
    availabilityScore: 100,
    keywordOverlap: 4,
    lastChecked: '2026-05-26T08:15:00Z',
    riskLevel: 'Medium',
  },
  {
    id: 'ct6',
    asin: 'B07BHLXTRC',
    title: 'Organic Tattva Turmeric Powder 200g — USDA Organic Certified',
    brand: 'Organic Tattva',
    marketplace: 'amazon.in',
    category: 'Grocery & Gourmet Foods',
    currentPrice: 179,
    previousPrice: 199,
    priceMovement: 'down',
    currentBsr: 2840,
    previousBsr: 2210,
    bsrMovement: 'declined',
    rating: 4.0,
    reviewCount: 3120,
    reviewVelocity30d: 34,
    buyBoxStatus: 'suppressed',
    availabilityScore: 62,
    keywordOverlap: 11,
    lastChecked: '2026-05-25T22:00:00Z',
    riskLevel: 'High',
  },
]

// Derived summary stats for KPI cards
export function getCompetitorSummary(data: CompetitorAsin[]) {
  const tracked = data.length
  const priceDrops = data.filter(c => c.priceMovement === 'down').length
  const bsrGainers = data.filter(c => c.bsrMovement === 'improved').length
  const velocityLeaders = data.filter(c => c.reviewVelocity30d > 100).length
  const buyBoxThreats = data.filter(
    c => c.buyBoxStatus === 'lost' || c.buyBoxStatus === 'shared'
  ).length
  const totalKeywordOverlap = data.reduce((sum, c) => sum + c.keywordOverlap, 0)

  return { tracked, priceDrops, bsrGainers, velocityLeaders, buyBoxThreats, totalKeywordOverlap }
}

// ─── Buy Box threat extra data ────────────────────────────────────────────────

export type FulfillmentType = 'FBA' | 'FBM' | 'AMZ'

export interface BuyBoxThreatExtra {
  competitorId: string
  competitorSeller: string
  fulfillmentType: FulfillmentType
  /** Our price minus competitor price. Negative = competitor is cheaper. */
  priceGap: number
}

export const MOCK_BUYBOX_THREATS: BuyBoxThreatExtra[] = [
  {
    competitorId: 'ct3',
    competitorSeller: 'Tata Consumer Products Official',
    fulfillmentType: 'FBM',
    priceGap: -20,
  },
  {
    competitorId: 'ct5',
    competitorSeller: 'Himalaya Wellness Store',
    fulfillmentType: 'FBA',
    priceGap: -14,
  },
]

// ─── Keyword overlap data ─────────────────────────────────────────────────────

export interface KeywordOverlapEntry {
  competitorId: string
  /** Keywords both we and competitor rank/target */
  overlappingKeywords: string[]
  /** Keywords competitor ranks for that we currently miss */
  missingKeywords: string[]
}

export const MOCK_KEYWORD_OVERLAP: KeywordOverlapEntry[] = [
  {
    competitorId: 'ct1',
    overlappingKeywords: ['desi ghee 1kg', 'cow ghee', 'pure ghee', 'organic ghee'],
    missingKeywords: ['bilona ghee', 'a2 ghee bulk', 'ghee 2kg'],
  },
  {
    competitorId: 'ct2',
    overlappingKeywords: ['cow ghee 1kg', 'cooking ghee', 'ghee tin'],
    missingKeywords: ['amul ghee 5kg', 'daily use ghee'],
  },
  {
    competitorId: 'ct3',
    overlappingKeywords: ['assam tea 500g', 'strong tea blend'],
    missingKeywords: ['tata tea 1kg family pack', 'black tea breakfast'],
  },
  {
    competitorId: 'ct4',
    overlappingKeywords: ['darjeeling tea', 'organic loose leaf tea'],
    missingKeywords: ['first flush premium', 'estate tea 500g'],
  },
  {
    competitorId: 'ct5',
    overlappingKeywords: ['neem face wash', 'purifying face wash 150ml'],
    missingKeywords: ['oil control face wash 300ml', 'anti acne neem wash'],
  },
  {
    competitorId: 'ct6',
    overlappingKeywords: ['organic turmeric powder', 'haldi 200g'],
    missingKeywords: ['bulk turmeric 500g', 'certified organic haldi', 'turmeric latte powder'],
  },
]
