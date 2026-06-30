// R10.1: Brahmastra configurable action engine thresholds.
// SYSTEM_DEFAULT_THRESHOLDS are the R10 hardcoded values — used as the
// ultimate fallback when no DB row exists (e.g. migration not applied yet,
// or first run before the user has saved any overrides). Behavior is
// identical to the deployed R10 version until the user edits thresholds.

export type BrahmastraThresholds = {
  portfolio: string
  waste_spend_min: number
  waste_roas_max: number
  min_clicks_for_waste: number
  high_acos_pct: number
  high_acos_spend_min: number
  high_spend_low_roas_spend_min: number
  high_spend_low_roas_max: number
  protect_roas_min: number
  protect_acos_max: number
  protect_spend_min: number
  high_tacos_pct: number
  high_tacos_min_ordered_sales: number
  refund_rate_min_pct: number
  refund_min_amount: number
  good_roas_min: number
  good_acos_max: number
  is_active: boolean
  updated_at?: string
}

export type ThresholdValues = Omit<BrahmastraThresholds, 'portfolio' | 'is_active' | 'updated_at'>

// Current R10 hardcoded values — these are the authoritative fallback.
export const SYSTEM_DEFAULT_THRESHOLDS: ThresholdValues = {
  waste_spend_min: 300,
  waste_roas_max: 1.5,
  min_clicks_for_waste: 5,
  high_acos_pct: 40,
  high_acos_spend_min: 100,
  high_spend_low_roas_spend_min: 500,
  high_spend_low_roas_max: 2,
  protect_roas_min: 4,
  protect_acos_max: 25,
  protect_spend_min: 100,
  high_tacos_pct: 15,
  high_tacos_min_ordered_sales: 5000,
  refund_rate_min_pct: 20,
  refund_min_amount: 1000,
  good_roas_min: 2.5,
  good_acos_max: 40,
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
    waste_spend_min: partial.waste_spend_min ?? SYSTEM_DEFAULT_THRESHOLDS.waste_spend_min,
    waste_roas_max: partial.waste_roas_max ?? SYSTEM_DEFAULT_THRESHOLDS.waste_roas_max,
    min_clicks_for_waste: partial.min_clicks_for_waste ?? SYSTEM_DEFAULT_THRESHOLDS.min_clicks_for_waste,
    high_acos_pct: partial.high_acos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.high_acos_pct,
    high_acos_spend_min: partial.high_acos_spend_min ?? SYSTEM_DEFAULT_THRESHOLDS.high_acos_spend_min,
    high_spend_low_roas_spend_min: partial.high_spend_low_roas_spend_min ?? SYSTEM_DEFAULT_THRESHOLDS.high_spend_low_roas_spend_min,
    high_spend_low_roas_max: partial.high_spend_low_roas_max ?? SYSTEM_DEFAULT_THRESHOLDS.high_spend_low_roas_max,
    protect_roas_min: partial.protect_roas_min ?? SYSTEM_DEFAULT_THRESHOLDS.protect_roas_min,
    protect_acos_max: partial.protect_acos_max ?? SYSTEM_DEFAULT_THRESHOLDS.protect_acos_max,
    protect_spend_min: partial.protect_spend_min ?? SYSTEM_DEFAULT_THRESHOLDS.protect_spend_min,
    high_tacos_pct: partial.high_tacos_pct ?? SYSTEM_DEFAULT_THRESHOLDS.high_tacos_pct,
    high_tacos_min_ordered_sales: partial.high_tacos_min_ordered_sales ?? SYSTEM_DEFAULT_THRESHOLDS.high_tacos_min_ordered_sales,
    refund_rate_min_pct: partial.refund_rate_min_pct ?? SYSTEM_DEFAULT_THRESHOLDS.refund_rate_min_pct,
    refund_min_amount: partial.refund_min_amount ?? SYSTEM_DEFAULT_THRESHOLDS.refund_min_amount,
    good_roas_min: partial.good_roas_min ?? SYSTEM_DEFAULT_THRESHOLDS.good_roas_min,
    good_acos_max: partial.good_acos_max ?? SYSTEM_DEFAULT_THRESHOLDS.good_acos_max,
  }
}

/** Build the portfolio → threshold map the engine needs. Falls back to global → system defaults. */
export function buildThresholdsMap(
  rows: Array<Partial<BrahmastraThresholds> & { portfolio: string }>,
): { globalThresholds: ThresholdValues; thresholdsMap: Map<string, ThresholdValues> } {
  const map = new Map<string, ThresholdValues>()
  for (const row of rows) {
    if (!row.is_active) continue
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
