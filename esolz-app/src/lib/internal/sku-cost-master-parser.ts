export type SkuCostMasterGstHistoryEntry = {
  from: string
  rate: number
}

export type SkuCostMasterRecord = {
  sku: string
  costPrice: number | null
  packingTransport: number | null
  gstRate: number | null
  gstHistory: SkuCostMasterGstHistoryEntry[]
  productName: string | null
  category: string | null
  notes: string | null
  source: string
}

export type SkuCostMasterRejection = {
  sku: string
  reason: 'invalid_entry'
}

export type SkuCostMasterStats = {
  totalSkuCount: number
  acceptedCount: number
  rejectedCount: number
  skusWithCostPriceCount: number
  skusMissingCostPriceCount: number
  skusWithGstHistoryCount: number
}

export type SkuCostMasterParseResult = {
  accepted: SkuCostMasterRecord[]
  rejected: SkuCostMasterRejection[]
  stats: SkuCostMasterStats
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function toTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function toGstHistory(value: unknown): SkuCostMasterGstHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const history: SkuCostMasterGstHistoryEntry[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const from = toTextOrNull((entry as Record<string, unknown>).from)
    const rate = toNumberOrNull((entry as Record<string, unknown>).rate)
    if (from && rate !== null) history.push({ from, rate })
  }
  return history
}

export function parseSkuCostMasterJson(input: string): SkuCostMasterParseResult {
  const parsed = JSON.parse(input) as { skus?: Record<string, unknown> }
  const skus = parsed.skus && typeof parsed.skus === 'object' ? parsed.skus : {}
  const skuEntries = Object.entries(skus)

  const accepted: SkuCostMasterRecord[] = []
  const rejected: SkuCostMasterRejection[] = []

  for (const [sku, rawEntry] of skuEntries) {
    const trimmedSku = sku.trim()
    if (!trimmedSku || !rawEntry || typeof rawEntry !== 'object') {
      rejected.push({ sku: trimmedSku || sku, reason: 'invalid_entry' })
      continue
    }
    const entry = rawEntry as Record<string, unknown>
    accepted.push({
      sku: trimmedSku,
      costPrice: toNumberOrNull(entry.cost_price),
      packingTransport: toNumberOrNull(entry.packing_transport),
      gstRate: toNumberOrNull(entry.gst_rate),
      gstHistory: toGstHistory(entry.gst_history),
      productName: toTextOrNull(entry.product_name),
      category: toTextOrNull(entry.category),
      notes: toTextOrNull(entry.notes),
      source: toTextOrNull(entry.source) ?? 'json_import',
    })
  }

  const skusWithCostPriceCount = accepted.filter(record => record.costPrice !== null).length
  const skusWithGstHistoryCount = accepted.filter(record => record.gstHistory.length > 0).length

  return {
    accepted,
    rejected,
    stats: {
      totalSkuCount: skuEntries.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      skusWithCostPriceCount,
      skusMissingCostPriceCount: accepted.length - skusWithCostPriceCount,
      skusWithGstHistoryCount,
    },
  }
}
