// R10.1: Brahmastra configurable action engine thresholds.
// SYSTEM_DEFAULT_THRESHOLDS = R10 hardcoded values — used as the ultimate
// fallback when no DB row exists (e.g. migration not yet applied or first
// run before the user has saved any overrides). Engine behavior is identical
// to the deployed R10 version until the user edits thresholds via the UI.

export type ThresholdValues = {
  // Spend thresholds
  waste_spend_threshold: number       // ≥ this spend = waste candidate
  minimum_roas: number                // ROAS < this = waste / low-impact candidate
  min_clicks_for_waste: number        // min clicks before flagging waste
  high_spend_threshold: number        // ≥ this spend = high-spend-low-impact candidate
  min_ad_spend_for_action: number     // min spend for High ACOS / Protect-Scale checks
  // ACOS / ROAS thresholds
  max_acos_pct: number                // ACOS > this % = High ACOS finding; ≤ = Good Working
  protect_roas: number                // ROAS ≥ this = Protect/Scale candidate
  protect_acos_pct: number            // ACOS ≤ this % = Protect/Scale candidate
  good_roas: number                   // ROAS ≥ this = Good Working candidate (engine)
  // TACOS / category thresholds
  warning_tacos_pct: number           // TACOS ≥ this % = Medium priority TACOS finding
  critical_tacos_pct: number          // TACOS ≥ this % = High priority TACOS finding
  min_ordered_sales_for_category_action: number  // min Business Report ordered sales to check
  // Refund thresholds
  refund_warning_pct: number          // refunds / gross ≥ this % = Refund Watch
  high_refund_amount: number          // min refund amount (₹) to trigger Refund Watch
}

// Current R10 hardcoded values — these are the authoritative fallback.
// No value is 0; each default is the value used by the deployed R10 engine.
export const SYSTEM_DEFAULT_THRESHOLDS: ThresholdValues = {
  waste_spend_threshold: 300,
  minimum_roas: 1.5,
  min_clicks_for_waste: 5,
  high_spend_threshold: 500,
  min_ad_spend_for_action: 100,
  max_acos_pct: 40,
  protect_roas: 4,
  protect_acos_pct: 25,
  good_roas: 2.5,
  warning_tacos_pct: 15,
  critical_tacos_pct: 25,
  min_ordered_sales_for_category_action: 5000,
  refund_warning_pct: 20,
  high_refund_amount: 1000,
}

// Portfolios the engine and UI know about. '__global__' = workspace-wide default.
export const BRAHMASTRA_PORTFOLIOS = [
  '__global__',
  'Baby Play Mat (BPM)',
  'EVA Kids',
  'EVA Gym',
  'ASM',
  'Storage Bags',
  'Water Tank Cover',
  'Curtains',
  'Bathroom Shelf',
  'Coze',
  'Unifit',
  'Sage Royal Ayurveda',
  'Planter and Garden',
] as const

export type BrahmastraPortfolio = (typeof BRAHMASTRA_PORTFOLIOS)[number]

export const PORTFOLIO_DISPLAY_NAMES: Record<string, string> = {
  '__global__': 'Global (all categories)',
  'Baby Play Mat (BPM)': 'Baby Play Mat (BPM)',
  'EVA Kids': 'EVA Kids',
  'EVA Gym': 'EVA Gym',
  'ASM': 'ASM',
  'Storage Bags': 'Storage Bags',
  'Water Tank Cover': 'Water Tank Cover',
  'Curtains': 'Curtains',
  'Bathroom Shelf': 'Bathroom Shelf',
  'Coze': 'Coze',
  'Unifit': 'Unifit',
  'Sage Royal Ayurveda': 'Sage Royal Ayurveda',
  'Planter and Garden': 'Planter and Garden',
}

export function mergeWithSystemDefaults(partial: Partial<ThresholdValues> | null | undefined): ThresholdValues {
  if (!partial) return SYSTEM_DEFAULT_THRESHOLDS
  return {
    waste_spend_threshold: partial.waste_spend_threshold ?? SYSTEM_DEFAULT_THRESHOLDS.waste_spend_threshold,
    minimum_roas: partial.minimum_roas ?? SYSTEM_DEFAULT_THRESHOLDS.minimum_roas,
    min_clicks_for_waste: partial.min_clicks_for_waste ?? SYSTEM_DEFAULT_THRESHOLDS.min_clicks_for_waste,
    high_spend_threshold: partial.high_spend_threshold ?? SYSTEM_DEFAULT_THRESHOLDS.high_spend_threshold,
    min_ad_spend_for_action: partial.min_ad_spend_for_action ?? SYSTEM_DEFAULT_THRESHOLDS.min_ad_spend_for_action,
    max_acos_pct: partial.max_acos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.max_acos_pct,
    protect_roas: partial.protect_roas ?? SYSTEM_DEFAULT_THRESHOLDS.protect_roas,
    protect_acos_pct: partial.protect_acos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.protect_acos_pct,
    good_roas: partial.good_roas ?? SYSTEM_DEFAULT_THRESHOLDS.good_roas,
    warning_tacos_pct: partial.warning_tacos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.warning_tacos_pct,
    critical_tacos_pct: partial.critical_tacos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.critical_tacos_pct,
    min_ordered_sales_for_category_action: partial.min_ordered_sales_for_category_action ?? SYSTEM_DEFAULT_THRESHOLDS.min_ordered_sales_for_category_action,
    refund_warning_pct: partial.refund_warning_pct ?? SYSTEM_DEFAULT_THRESHOLDS.refund_warning_pct,
    high_refund_amount: partial.high_refund_amount ?? SYSTEM_DEFAULT_THRESHOLDS.high_refund_amount,
  }
}

/** Build portfolio→threshold map from DB rows. Falls back global→system defaults. */
export function buildThresholdsMap(
  rows: Array<Partial<ThresholdValues> & { portfolio: string; is_active?: boolean }>,
): { globalThresholds: ThresholdValues; thresholdsMap: Map<string, ThresholdValues> } {
  const map = new Map<string, ThresholdValues>()
  for (const row of rows) {
    if (row.is_active === false) continue
    map.set(row.portfolio, mergeWithSystemDefaults(row))
  }
  const globalThresholds = map.get('__global__') ?? SYSTEM_DEFAULT_THRESHOLDS
  return { globalThresholds, thresholdsMap: map }
}

export function resolveThresholds(
  portfolio: string,
  thresholdsMap: Map<string, ThresholdValues>,
  globalThresholds: ThresholdValues,
): ThresholdValues {
  return thresholdsMap.get(portfolio) ?? globalThresholds
}
