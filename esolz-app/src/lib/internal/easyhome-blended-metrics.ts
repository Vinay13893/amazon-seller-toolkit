// Phase R3: blended ROAS/TACOS for Brahmastra. Combines two independently
// sourced numbers — never invents a third data source:
//   - Total Sales / Gross Sales / Refunds / Units / Orders: from
//     internal_payment_transactions (Payment Transactions).
//   - Ad Spend / Ad-attributed Sales: from the Amazon Ads Reporting API
//     tables (Amazon Ads Reports) — NOT the payment-transaction "Ad" fee
//     line items, which are a different, less precise figure.
// Every consumer of this module must keep those two sources labeled
// separately in the UI; only the blended ratios below intentionally combine
// them.

export type BlendedPeriodInputs = {
  totalSalesNet: number
  grossSales: number
  refunds: number
  unitsSold: number
  refundedUnits: number
  totalOrders: number
  adSpend: number
  adSales: number
}

export type BlendedPeriodMetrics = BlendedPeriodInputs & {
  blendedRoas: number | null
  tacos: number | null
  adRoas: number | null
  adAcos: number | null
  adSalesShare: number | null
  organicEstimate: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function computeBlendedMetrics(input: BlendedPeriodInputs): BlendedPeriodMetrics {
  const { totalSalesNet, adSpend, adSales } = input
  return {
    ...input,
    blendedRoas: adSpend > 0 ? round2(totalSalesNet / adSpend) : null,
    tacos: totalSalesNet > 0 ? round2((adSpend / totalSalesNet) * 100) : null,
    adRoas: adSpend > 0 ? round2(adSales / adSpend) : null,
    adAcos: adSales > 0 ? round2((adSpend / adSales) * 100) : null,
    adSalesShare: totalSalesNet > 0 ? round2((adSales / totalSalesNet) * 100) : null,
    organicEstimate: round2(Math.max(totalSalesNet - adSales, 0)),
  }
}

/**
 * Compare-mode-only correlation commentary (Single mode has no baseline, so
 * "improved/fell" framing doesn't apply there). Strictly correlation
 * language — never "caused" — and always says "review manually."
 */
export function buildBlendedInsights(before: BlendedPeriodMetrics, after: BlendedPeriodMetrics): string[] {
  const notes: string[] = []
  const salesFell = after.totalSalesNet < before.totalSalesNet
  const salesRose = after.totalSalesNet > before.totalSalesNet
  const adSpendFell = after.adSpend < before.adSpend
  const adSpendRose = after.adSpend > before.adSpend
  const adRoasImproved = before.adRoas !== null && after.adRoas !== null && after.adRoas > before.adRoas
  const tacosWorsened = before.tacos !== null && after.tacos !== null && after.tacos > before.tacos
  const shareRose = before.adSalesShare !== null && after.adSalesShare !== null && after.adSalesShare > before.adSalesShare
  const organicRose = after.organicEstimate > before.organicEstimate
  const organicFell = after.organicEstimate < before.organicEstimate

  if (adRoasImproved && salesFell) {
    notes.push('Ad ROAS improved but total sales fell — correlated with ads capturing a smaller share of overall demand; review manually.')
  }
  if (adSpendFell && salesFell && after.totalSalesNet < before.totalSalesNet * 0.9 && after.adSpend < before.adSpend * 0.95) {
    notes.push('Ad spend fell and total sales fell more sharply — may indicate over-throttling; review manually.')
  }
  if (adSpendRose && !salesRose) {
    notes.push('Ad spend rose but total sales did not improve — review waste/conversion manually.')
  }
  if (tacosWorsened) {
    notes.push('TACOS worsened — correlated with ad spend pressure increasing relative to total sales; review manually.')
  }
  if (shareRose && salesFell) {
    notes.push('Ad sales share rose while total sales fell — may indicate increased ad dependency; review manually.')
  }
  if (organicRose) {
    notes.push('Organic estimate (Total Sales minus Ad-attributed Sales) improved — this is an estimate, not a direct Amazon metric.')
  } else if (organicFell) {
    notes.push('Organic estimate (Total Sales minus Ad-attributed Sales) declined — this is an estimate, not a direct Amazon metric.')
  }
  return notes
}

export type RoasTacos = {
  roas: number | null
  tacos: number | null
}

/**
 * Phase R6: Business Report Blended ROAS/TACOS = Seller Central Business
 * Report Ordered Product Sales (order-date based) ÷ Amazon Ads Spend. This
 * is intentionally a SEPARATE metric from the Settlement-based
 * computeBlendedMetrics() above — Ordered Product Sales is a different
 * number from Settlement Net Sales and the two must never be substituted
 * for one another. Callers gate this on Business Report import
 * completeness and must never synthesize a value when data is missing.
 */
export function computeRoasTacos(sales: number, spend: number): RoasTacos {
  return {
    roas: spend > 0 ? Math.round((sales / spend) * 100) / 100 : null,
    tacos: sales > 0 ? Math.round((spend / sales) * 10000) / 100 : null,
  }
}
