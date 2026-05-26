// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'warning' | 'opportunity' | 'info'
export type AlertModule =
  | 'buybox'
  | 'bsr'
  | 'keywords'
  | 'pincode'
  | 'price'
  | 'reviews'
  | 'competitor'
export type AlertStatus = 'new' | 'read' | 'resolved'
export type AlertMarketplace = 'amazon.in' | 'amazon.com'

export interface AlertMetric {
  label: string
  before: string
  after: string
}

export interface CenterAlert {
  id: string
  title: string
  description: string
  severity: AlertSeverity
  module: AlertModule
  status: AlertStatus
  marketplace: AlertMarketplace
  asin: string
  product_name: string
  timestamp: string
  /** Short sentence about what to do next */
  recommended_action: string
  /** What happened in detail */
  what_happened: string
  /** Why this matters to the seller */
  why_it_matters: string
  /** Optional before/after metrics */
  metric?: AlertMetric
}

// ─── Mock data ────────────────────────────────────────────────────────────────

export const MOCK_ALERTS: CenterAlert[] = [
  // ── Buy Box ────────────────────────────────────────────────────────────────
  {
    id: 'a1',
    title: 'Buy Box Lost',
    description: 'You lost the Buy Box on B09W2N5K3X to a competitor at ₹649.',
    severity: 'critical',
    module: 'buybox',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B09W2N5K3X',
    product_name: 'Organic Assam Tea 500g',
    timestamp: '2026-05-26T06:15:00Z',
    recommended_action: 'Lower your price to ₹645 or check competitor fulfillment method.',
    what_happened:
      'Competitor seller "TeaHouse Direct" undercut your price by ₹30 and took the Buy Box at ₹649. Your price is ₹679.',
    why_it_matters:
      'Buy Box ownership drives ~82% of Amazon sales. Losing it will significantly reduce your orders.',
    metric: { label: 'Buy Box Price', before: '₹679 (yours)', after: '₹649 (competitor)' },
  },
  {
    id: 'a2',
    title: 'New Seller Detected on ASIN',
    description: 'A new FBM seller appeared on B0BN5NZCGH offering at ₹1,099.',
    severity: 'warning',
    module: 'buybox',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-25T14:30:00Z',
    recommended_action: 'Monitor if seller gains traction. Consider reporting if counterfeit.',
    what_happened:
      'Seller "NaturalFarms99" listed on your ASIN at ₹1,099 (₹101 below your price) using FBM fulfillment.',
    why_it_matters:
      'New sellers on your listing can steal sales and damage brand perception with inferior products.',
    metric: { label: 'Your Price vs New Seller', before: '₹1,200 (you, FBA)', after: '₹1,099 (new seller, FBM)' },
  },

  // ── BSR ────────────────────────────────────────────────────────────────────
  {
    id: 'a3',
    title: 'BSR Dropped Sharply',
    description: 'BSR on B0BN5NZCGH fell by 721 positions in Grocery & Gourmet Foods.',
    severity: 'critical',
    module: 'bsr',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-26T03:00:00Z',
    recommended_action:
      'Check your ad spend, review recent price changes, and verify stock levels.',
    what_happened:
      'BSR moved from #342 to #1,063 in a single overnight window. No stockout detected.',
    why_it_matters:
      'A sharp BSR drop indicates a sudden loss of sales velocity. This may cascade into lower organic ranking.',
    metric: { label: 'BSR Rank', before: '#342', after: '#1,063' },
  },
  {
    id: 'a4',
    title: 'BSR Entered Top 100',
    description: 'B07XQFM2XK entered the Top 100 in Health & Personal Care.',
    severity: 'opportunity',
    module: 'bsr',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B07XQFM2XK',
    product_name: 'Turmeric Curcumin 60 Capsules',
    timestamp: '2026-05-25T18:45:00Z',
    recommended_action: 'Increase ad spend to capitalise on momentum. Consider a lightning deal.',
    what_happened:
      'After a 14-day upward trend, BSR crossed #100 in Health & Personal Care for the first time.',
    why_it_matters:
      'Top 100 BSR increases discoverability via Amazon bestseller badges and browse recommendations.',
    metric: { label: 'BSR Rank', before: '#118', after: '#94' },
  },

  // ── Keywords ───────────────────────────────────────────────────────────────
  {
    id: 'a5',
    title: 'Keyword Rank Drop',
    description: '"pure desi ghee 1kg" dropped from #8 to #22 on B0BN5NZCGH.',
    severity: 'critical',
    module: 'keywords',
    status: 'read',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-25T08:00:00Z',
    recommended_action:
      'Increase Sponsored Products bid for this keyword. Review listing copy for relevance.',
    what_happened:
      'Organic rank for "pure desi ghee 1kg" (14,500 searches/month) fell from page 1 to page 2 over 3 days.',
    why_it_matters:
      'Page 2 keywords receive ~95% less clicks than page 1. This keyword drives an estimated 18% of organic sales.',
    metric: { label: 'Keyword Rank', before: '#8 (Page 1)', after: '#22 (Page 2)' },
  },
  {
    id: 'a6',
    title: 'Keyword Entered Page 1',
    description: '"organic ghee india" entered Page 1 at #14 for B0BN5NZCGH.',
    severity: 'opportunity',
    module: 'keywords',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-24T12:00:00Z',
    recommended_action:
      'Push sponsored bids to defend and move this keyword to the top 5.',
    what_happened:
      'After 3 weeks of consistent indexing, "organic ghee india" (8,200 searches/month) moved from #31 to #14.',
    why_it_matters:
      'Entering page 1 for a high-volume keyword can significantly boost organic sales without ad spend.',
    metric: { label: 'Keyword Rank', before: '#31 (Page 2)', after: '#14 (Page 1)' },
  },

  // ── Pincode ────────────────────────────────────────────────────────────────
  {
    id: 'a7',
    title: 'Product Unavailable — Bangalore',
    description: 'B09W2N5K3X shows "Currently unavailable" across 12 Bangalore pincodes.',
    severity: 'critical',
    module: 'pincode',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B09W2N5K3X',
    product_name: 'Organic Assam Tea 500g',
    timestamp: '2026-05-26T05:00:00Z',
    recommended_action:
      'Check FBA inventory at BLR1/BLR3 fulfilment centres. Replenish if stock is low.',
    what_happened:
      'Pincode availability check across Bangalore (560001–560100) shows "unavailable" for all tested pincodes.',
    why_it_matters:
      'Bangalore is a top-3 metro for Amazon India. Unavailability here can drop your weekly sales by 15–25%.',
    metric: { label: 'Pincodes Available', before: '47 / 50', after: '0 / 50' },
  },
  {
    id: 'a8',
    title: 'Slow Delivery — Mumbai',
    description: 'Delivery for B0C3KJR45M showing 7-9 days in Mumbai instead of 2.',
    severity: 'warning',
    module: 'pincode',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0C3KJR45M',
    product_name: 'Neem Face Wash 200ml',
    timestamp: '2026-05-25T22:00:00Z',
    recommended_action:
      'Check BOM1 inventory levels. Consider creating a Mumbai FBA shipment.',
    what_happened:
      'Delivery promise for 400001–400030 pincodes has increased from 2-day to 7-9 days, indicating stock is being dispatched from a distant FC.',
    why_it_matters:
      'Long delivery times reduce conversion rate by up to 40% and suppress Buy Box eligibility.',
    metric: { label: 'Delivery Promise', before: '2 days', after: '7–9 days' },
  },

  // ── Price ──────────────────────────────────────────────────────────────────
  {
    id: 'a9',
    title: 'Competitor Price Cut',
    description: 'Top competitor reduced price by ₹50 on competing ASIN B08HX5QG2W.',
    severity: 'warning',
    module: 'price',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-25T10:00:00Z',
    recommended_action:
      'Monitor your conversion rate for the next 48 hours. Consider a ₹30 price reduction if sales drop.',
    what_happened:
      'Competitor product "DesiMilk A2 Ghee 1kg" (B08HX5QG2W) dropped from ₹1,249 to ₹1,199 — now ₹1 below your price.',
    why_it_matters:
      'Price parity with a well-reviewed competitor can shift buying decisions and reduce your conversion rate.',
    metric: { label: 'Price Gap (you vs competitor)', before: '+₹49 (you cheaper)', after: '-₹1 (you more expensive)' },
  },
  {
    id: 'a10',
    title: 'Price Suppression Risk',
    description: 'B08JK2MN7P is priced above the "Was Price" threshold — Buy Box at risk.',
    severity: 'warning',
    module: 'price',
    status: 'read',
    marketplace: 'amazon.in',
    asin: 'B08JK2MN7P',
    product_name: 'Ashwagandha Root Extract 60 Caps',
    timestamp: '2026-05-24T16:00:00Z',
    recommended_action:
      'Lower your price to ₹499 or update the "Was Price" reference price in Seller Central.',
    what_happened:
      'Your current price ₹699 is 40% above the historical "Was Price" of ₹499. Amazon may suppress the Buy Box if this continues.',
    why_it_matters:
      'Amazon can suppress the Buy Box when your price is deemed too high vs. historical price, even if you are the only seller.',
    metric: { label: 'Price vs Was Price', before: '₹499 (was price)', after: '₹699 (current)' },
  },

  // ── Reviews ────────────────────────────────────────────────────────────────
  {
    id: 'a11',
    title: 'Rating Dropped',
    description: 'B09W2N5K3X average rating fell from 4.3 ★ to 4.1 ★ after 3 new 1-star reviews.',
    severity: 'warning',
    module: 'reviews',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B09W2N5K3X',
    product_name: 'Organic Assam Tea 500g',
    timestamp: '2026-05-26T04:30:00Z',
    recommended_action:
      'Read the 1-star reviews and respond. If product quality issue, investigate batch. Request removal if policy violation.',
    what_happened:
      '3 new 1-star reviews posted within 24 hours citing "broken seal" and "stale smell". Average rating dropped 0.2 points.',
    why_it_matters:
      'Ratings below 4.0 significantly reduce conversion rates and can trigger Amazon quality alerts.',
    metric: { label: 'Average Rating', before: '4.3 ★', after: '4.1 ★' },
  },
  {
    id: 'a12',
    title: 'Positive Review Spike',
    description: 'B07XQFM2XK received 12 verified 5-star reviews in the last 7 days.',
    severity: 'opportunity',
    module: 'reviews',
    status: 'read',
    marketplace: 'amazon.in',
    asin: 'B07XQFM2XK',
    product_name: 'Turmeric Curcumin 60 Capsules',
    timestamp: '2026-05-24T09:00:00Z',
    recommended_action:
      'Use this momentum for a Sponsored Brands campaign. Highlight the 4.8★ rating in your ad copy.',
    what_happened:
      '12 new 5-star verified purchase reviews received this week, pushing rating from 4.5 to 4.8.',
    why_it_matters:
      'High review velocity and strong ratings boost organic rank and conversion rate simultaneously.',
    metric: { label: 'Rating', before: '4.5 ★ (234 reviews)', after: '4.8 ★ (246 reviews)' },
  },

  // ── Competitor ─────────────────────────────────────────────────────────────
  {
    id: 'a13',
    title: 'Competitor BSR Surge',
    description: 'Competing ASIN B08HX5QG2W surged from #850 to #120 in Grocery.',
    severity: 'warning',
    module: 'competitor',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-25T20:00:00Z',
    recommended_action:
      'Investigate if competitor is running a deal or lightning deal. Consider matching with a coupon.',
    what_happened:
      '"DesiMilk A2 Ghee 1kg" (B08HX5QG2W) jumped 730 BSR positions over 48 hours — likely running a deal or heavy ad spend.',
    why_it_matters:
      'A sudden competitor BSR surge often indicates a promotional push that can temporarily steal your customers.',
    metric: { label: 'Competitor BSR', before: '#850', after: '#120' },
  },
  {
    id: 'a14',
    title: 'Competitor Out of Stock',
    description: 'Top competitor B08HX5QG2W is out of stock — opportunity window open.',
    severity: 'opportunity',
    module: 'competitor',
    status: 'new',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-26T07:00:00Z',
    recommended_action:
      'Immediately increase Sponsored Products bids by 30–50% to capture displaced demand.',
    what_happened:
      '"DesiMilk A2 Ghee 1kg" (B08HX5QG2W) went out of stock. Their shoppers will now look at the next available option — you.',
    why_it_matters:
      'Competitor stockouts are high-value windows. Aggressively bidding during this period can permanently gain new customers.',
    metric: { label: 'Competitor Stock Status', before: 'In Stock', after: 'Out of Stock' },
  },
  {
    id: 'a15',
    title: 'Resolved: Hijacker Removed',
    description: 'Unauthorised seller removed from B0BN5NZCGH after brand registry complaint.',
    severity: 'info',
    module: 'competitor',
    status: 'resolved',
    marketplace: 'amazon.in',
    asin: 'B0BN5NZCGH',
    product_name: 'Pure Desi Ghee 1kg',
    timestamp: '2026-05-23T11:00:00Z',
    recommended_action: 'No action needed. Monitor for re-listing.',
    what_happened:
      'Brand Registry complaint filed on May 21 resulted in removal of unauthorised seller "QuickDeals99" on May 23.',
    why_it_matters: 'You now have sole ownership of the Buy Box on this ASIN again.',
    metric: { label: 'Sellers on Listing', before: '2 sellers', after: '1 seller (you)' },
  },
]

// ─── Derived stats ─────────────────────────────────────────────────────────────

export function getAlertStats(alerts: CenterAlert[]) {
  return {
    total: alerts.length,
    critical: alerts.filter(a => a.severity === 'critical').length,
    warning: alerts.filter(a => a.severity === 'warning').length,
    opportunity: alerts.filter(a => a.severity === 'opportunity').length,
    resolved: alerts.filter(a => a.status === 'resolved').length,
    unread: alerts.filter(a => a.status === 'new').length,
  }
}

// ─── Integration placeholders ─────────────────────────────────────────────────
// Replace these functions when wiring to real data sources.

/**
 * Generate BSR-based alerts by comparing current BSR snapshot with previous.
 * Wire to: amazon_bsr_tracker.py or BSR API endpoint.
 */
export async function generateBsrAlerts(
  _asins: string[],
  _threshold = 200,
): Promise<CenterAlert[]> {
  // TODO: call GET /api/bsr/snapshot and compare delta
  await new Promise(r => setTimeout(r, 500))
  return MOCK_ALERTS.filter(a => a.module === 'bsr')
}

/**
 * Generate Buy Box alerts by polling Buy Box ownership status.
 * Wire to: verify_seller.py or bsr_stealth.py scraper.
 */
export async function generateBuyBoxAlerts(_asins: string[]): Promise<CenterAlert[]> {
  // TODO: call checkBuyBoxStatus() for each ASIN and diff against last known owner
  await new Promise(r => setTimeout(r, 500))
  return MOCK_ALERTS.filter(a => a.module === 'buybox')
}

/**
 * Generate keyword rank alerts when rank changes exceed threshold.
 * Wire to: Keyword rank scraper / Amazon Search API.
 */
export async function generateKeywordAlerts(
  _asins: string[],
  _rankDropThreshold = 5,
): Promise<CenterAlert[]> {
  // TODO: compare KEYWORD_RANK_HISTORY last two data points per keyword
  await new Promise(r => setTimeout(r, 500))
  return MOCK_ALERTS.filter(a => a.module === 'keywords')
}

/**
 * Generate pincode availability alerts.
 * Wire to: pincode_checker/ scripts or FastAPI /pincode/check endpoint.
 */
export async function generatePincodeAlerts(_asins: string[]): Promise<CenterAlert[]> {
  // TODO: run pincode check batch and flag ASINs with availability < 80%
  await new Promise(r => setTimeout(r, 500))
  return MOCK_ALERTS.filter(a => a.module === 'pincode')
}

/**
 * Fetch all alerts (mock). Replace with real aggregation from DB / rule engine.
 */
export async function fetchAllAlerts(): Promise<CenterAlert[]> {
  await new Promise(r => setTimeout(r, 600))
  return MOCK_ALERTS
}
