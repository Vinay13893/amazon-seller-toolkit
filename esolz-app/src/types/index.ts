export type PlanTier = 'free' | 'starter' | 'pro' | 'agency'
export type Marketplace = 'IN' | 'US' | 'UK' | 'DE'

export interface User {
  id: string
  email: string
  full_name: string
  plan: PlanTier
  created_at: string
}

export interface Asin {
  id: string
  user_id: string
  asin: string
  label: string
  marketplace: Marketplace
  is_active: boolean
  created_at: string
}

export interface BsrSnapshot {
  id: string
  asin_id: string
  asin: string
  bsr_rank: number | null
  category: string | null
  sub_rank: number | null
  sub_category: string | null
  captured_at: string
}

export interface BsrSummary {
  asin_id: string
  asin: string
  label: string
  marketplace: Marketplace
  bsr_rank: number | null
  category: string | null
  sub_rank: number | null
  sub_category: string | null
  captured_at: string | null
}

export interface BsrHistory {
  asin_id: string
  asin: string
  label: string
  data: Pick<BsrSnapshot, 'bsr_rank' | 'captured_at'>[]
}

export interface PlanLimits {
  max_asins: number
  history_days: number
  refresh_interval_minutes: number
  keywords: boolean
  pincode: boolean
  buybox: boolean
  competitors: boolean
  alerts: number
  reports: boolean
  api_access: boolean
}

export interface Insight {
  id: string
  type: 'bsr_change' | 'alert' | 'scrape_complete' | 'new_asin'
  title: string
  description: string
  timestamp: string
  severity?: 'info' | 'warning' | 'success' | 'error'
}

export type Availability = 'in_stock' | 'out_of_stock' | 'limited'

export interface ProductSnapshot {
  id: string
  asin: string
  label: string
  marketplace: Marketplace
  is_active: boolean
  created_at: string
  // BSR
  bsr_rank: number | null
  bsr_rank_prev: number | null       // previous scrape rank (for movement indicator)
  category: string | null
  sub_rank: number | null
  sub_category: string | null
  // Pricing & ratings
  price: number | null
  price_currency: string             // 'INR' | 'USD' | 'GBP' | 'EUR'
  rating: number | null              // 0–5
  review_count: number | null
  // Buy Box
  buybox_winner: string | null       // seller name; null = suppressed
  buybox_is_self: boolean | null     // true when tracked seller owns it
  // Availability
  availability: Availability | null
  availability_score: number | null  // 0–100
  // Meta
  scrape_status?: 'success' | 'partial_success' | 'failed' | null
  captured_at: string | null
}
