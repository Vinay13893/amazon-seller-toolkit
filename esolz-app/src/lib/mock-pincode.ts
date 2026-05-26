// ─── Types ────────────────────────────────────────────────────────────────────

export type Fulfillment = 'FBA' | 'FBM'
export type StockStatus = 'in_stock' | 'limited' | 'oos'
export type AvailabilityStatus = 'healthy' | 'warning' | 'critical'

export interface PincodeResult {
  pincode: string
  city: string
  state: string
  available: boolean
  delivery_days: number | null
  delivery_promise: string | null
  price: number | null
  price_currency: string
  buybox_seller: string | null
  buybox_is_self: boolean
  fulfillment: Fulfillment | null
  stock_status: StockStatus | null
  checked_at: string
}

export interface CityPreset {
  city: string
  pincodes: string[]
}

export interface PincodeAlert {
  id: string
  type: 'unavailable' | 'delivery_delay' | 'seller_change' | 'price_mismatch' | 'fba_unavailable'
  city: string
  pincode?: string
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

// ─── City presets ─────────────────────────────────────────────────────────────

export const CITY_PRESETS: CityPreset[] = [
  { city: 'Delhi NCR',  pincodes: ['110001', '110011', '122001'] },
  { city: 'Mumbai',     pincodes: ['400001', '400002', '400051'] },
  { city: 'Bangalore',  pincodes: ['560001', '560002', '560034'] },
  { city: 'Hyderabad',  pincodes: ['500001', '500002', '500032'] },
  { city: 'Chennai',    pincodes: ['600001', '600002', '600028'] },
  { city: 'Pune',       pincodes: ['411001', '411002', '411028'] },
  { city: 'Kolkata',    pincodes: ['700001', '700002', '700019'] },
  { city: 'Ahmedabad',  pincodes: ['380001', '380006', '380009'] },
]

// ─── Mock pincode results (ASIN: B0BN5NZCGH — Daily Herbs Ghee 1L) ───────────

const _now = Date.now()
const _t = (hoursAgo: number) => new Date(_now - hoursAgo * 3600000).toISOString()

export const MOCK_PINCODE_RESULTS: PincodeResult[] = [
  // ── Delhi NCR ──────────────────────────────────────────────────────────────
  { pincode: '110001', city: 'Delhi NCR', state: 'Delhi',   available: true,  delivery_days: 1, delivery_promise: 'Tomorrow',      price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(1) },
  { pincode: '110011', city: 'Delhi NCR', state: 'Delhi',   available: true,  delivery_days: 1, delivery_promise: 'Tomorrow',      price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(1) },
  { pincode: '122001', city: 'Delhi NCR', state: 'Haryana', available: true,  delivery_days: 1, delivery_promise: 'Tomorrow',      price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(1) },

  // ── Mumbai ─────────────────────────────────────────────────────────────────
  { pincode: '400001', city: 'Mumbai', state: 'Maharashtra', available: true,  delivery_days: 1, delivery_promise: 'Tomorrow',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '400002', city: 'Mumbai', state: 'Maharashtra', available: true,  delivery_days: 2, delivery_promise: 'In 2 days',  price: 1299, price_currency: 'INR', buybox_seller: 'NutriMart India',      buybox_is_self: false, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '400051', city: 'Mumbai', state: 'Maharashtra', available: true,  delivery_days: 1, delivery_promise: 'Tomorrow',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },

  // ── Bangalore ──────────────────────────────────────────────────────────────
  { pincode: '560001', city: 'Bangalore', state: 'Karnataka', available: true,  delivery_days: 2, delivery_promise: 'In 2 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(3) },
  { pincode: '560002', city: 'Bangalore', state: 'Karnataka', available: true,  delivery_days: 2, delivery_promise: 'In 2 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(3) },
  { pincode: '560034', city: 'Bangalore', state: 'Karnataka', available: false, delivery_days: null, delivery_promise: null,     price: null, price_currency: 'INR', buybox_seller: null,                   buybox_is_self: false, fulfillment: null,  stock_status: 'oos',      checked_at: _t(3) },

  // ── Hyderabad ──────────────────────────────────────────────────────────────
  { pincode: '500001', city: 'Hyderabad', state: 'Telangana', available: true, delivery_days: 2, delivery_promise: 'In 2 days',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '500002', city: 'Hyderabad', state: 'Telangana', available: true, delivery_days: 2, delivery_promise: 'In 2 days',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '500032', city: 'Hyderabad', state: 'Telangana', available: true, delivery_days: 3, delivery_promise: 'In 2-3 days', price: 1350, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },

  // ── Chennai ────────────────────────────────────────────────────────────────
  { pincode: '600001', city: 'Chennai', state: 'Tamil Nadu', available: true,  delivery_days: 3, delivery_promise: 'In 2-3 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(4) },
  { pincode: '600002', city: 'Chennai', state: 'Tamil Nadu', available: false, delivery_days: null, delivery_promise: null,       price: null, price_currency: 'INR', buybox_seller: null,                   buybox_is_self: false, fulfillment: null,  stock_status: 'oos',      checked_at: _t(4) },
  { pincode: '600028', city: 'Chennai', state: 'Tamil Nadu', available: true,  delivery_days: 5, delivery_promise: 'In 4-5 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true,  fulfillment: 'FBA', stock_status: 'limited',  checked_at: _t(4) },

  // ── Pune ───────────────────────────────────────────────────────────────────
  { pincode: '411001', city: 'Pune', state: 'Maharashtra', available: true, delivery_days: 1, delivery_promise: 'Tomorrow',  price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '411002', city: 'Pune', state: 'Maharashtra', available: true, delivery_days: 2, delivery_promise: 'In 2 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },
  { pincode: '411028', city: 'Pune', state: 'Maharashtra', available: true, delivery_days: 1, delivery_promise: 'Tomorrow',  price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(2) },

  // ── Kolkata ────────────────────────────────────────────────────────────────
  { pincode: '700001', city: 'Kolkata', state: 'West Bengal', available: true,  delivery_days: 4, delivery_promise: 'In 3-4 days', price: 1299, price_currency: 'INR', buybox_seller: 'QuickDeals Store', buybox_is_self: false, fulfillment: 'FBM', stock_status: 'in_stock', checked_at: _t(5) },
  { pincode: '700002', city: 'Kolkata', state: 'West Bengal', available: false, delivery_days: null, delivery_promise: null,       price: null, price_currency: 'INR', buybox_seller: null,               buybox_is_self: false, fulfillment: null,  stock_status: 'oos',      checked_at: _t(5) },
  { pincode: '700019', city: 'Kolkata', state: 'West Bengal', available: false, delivery_days: null, delivery_promise: null,       price: null, price_currency: 'INR', buybox_seller: null,               buybox_is_self: false, fulfillment: null,  stock_status: 'oos',      checked_at: _t(5) },

  // ── Ahmedabad ──────────────────────────────────────────────────────────────
  { pincode: '380001', city: 'Ahmedabad', state: 'Gujarat', available: true, delivery_days: 2, delivery_promise: 'In 2 days',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(3) },
  { pincode: '380006', city: 'Ahmedabad', state: 'Gujarat', available: true, delivery_days: 2, delivery_promise: 'In 2 days',   price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(3) },
  { pincode: '380009', city: 'Ahmedabad', state: 'Gujarat', available: true, delivery_days: 3, delivery_promise: 'In 2-3 days', price: 1299, price_currency: 'INR', buybox_seller: 'Daily Herbs Official', buybox_is_self: true, fulfillment: 'FBA', stock_status: 'in_stock', checked_at: _t(3) },
]

// ─── Alerts ───────────────────────────────────────────────────────────────────

export const PINCODE_ALERTS: PincodeAlert[] = [
  {
    id: 'pin1',
    type: 'unavailable',
    city: 'Kolkata',
    pincode: '700002, 700019',
    message: 'Product unavailable in 2 Kolkata pincodes (700002, 700019). Both show out of stock.',
    severity: 'error',
    timestamp: _t(5),
  },
  {
    id: 'pin2',
    type: 'unavailable',
    city: 'Bangalore',
    pincode: '560034',
    message: 'Product unavailable in Bangalore 560034 (Koramangala). May be missing in FBA inventory.',
    severity: 'warning',
    timestamp: _t(3),
  },
  {
    id: 'pin3',
    type: 'seller_change',
    city: 'Mumbai',
    pincode: '400002',
    message: 'Buy Box seller changed to "NutriMart India" in Mumbai 400002. Previously "Daily Herbs Official".',
    severity: 'warning',
    timestamp: _t(2),
  },
  {
    id: 'pin4',
    type: 'price_mismatch',
    city: 'Hyderabad',
    pincode: '500032',
    message: 'Price mismatch in Hyderabad 500032 — listed at ₹1,350 vs ₹1,299 in other pincodes.',
    severity: 'warning',
    timestamp: _t(2),
  },
  {
    id: 'pin5',
    type: 'delivery_delay',
    city: 'Chennai',
    pincode: '600028',
    message: 'Delivery delayed to Chennai 600028 (Adyar) — 4-5 days vs expected 1-2 days.',
    severity: 'warning',
    timestamp: _t(4),
  },
  {
    id: 'pin6',
    type: 'fba_unavailable',
    city: 'Kolkata',
    message: 'FBA not available in Kolkata. 700001 is FBM (QuickDeals Store); 700002 & 700019 are out of stock.',
    severity: 'error',
    timestamp: _t(5),
  },
]

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Parse a newline/comma/space separated string of 6-digit pincodes */
export function parsePincodes(text: string): string[] {
  return text
    .split(/[\n,\s]+/)
    .map(p => p.trim())
    .filter(p => /^\d{6}$/.test(p))
}

export function availabilityScore(results: PincodeResult[]): number {
  if (!results.length) return 0
  return Math.round((results.filter(r => r.available).length / results.length) * 100)
}

export function scoreToStatus(score: number): AvailabilityStatus {
  if (score >= 80) return 'healthy'
  if (score >= 50) return 'warning'
  return 'critical'
}

// ─── Future integration point ─────────────────────────────────────────────────
//
// Replace the body of this function with your real pincode scraper logic.
// Compatible with: e:\amazon-bsr-tracker\amazon-pincode-checker\
//
// Example integration:
//   import { checkPincode } from '@/lib/pincode-scraper'
//   return await Promise.all(pincodes.map(p => checkPincode(asin, p, marketplace)))
//
export async function checkAsinPincodeAvailability(
  _asin: string,
  pincodes: string[],
  _marketplace = 'IN',
): Promise<PincodeResult[]> {
  // TODO: Replace with real scraper call
  await new Promise(res => setTimeout(res, 800)) // simulate latency
  return MOCK_PINCODE_RESULTS.filter(r => pincodes.includes(r.pincode))
}
