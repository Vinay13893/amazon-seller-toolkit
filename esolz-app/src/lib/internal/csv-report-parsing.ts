// Shared low-level CSV/number/date parsing utilities for the internal Amazon
// Ads CSV importers (campaign / advertised-product / targeting / search-term).
// Pure functions only — no I/O, no Supabase, no Amazon API calls.

export function splitCsvLine(line: string, delimiter = ','): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      result.push(current)
      current = ''
      continue
    }
    current += ch
  }
  result.push(current)
  return result
}

export function toTextOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const cleaned = value.replace(/[₹,%\s]/g, '').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export function toNumber(value: string | undefined): number {
  return toNumberOrNull(value) ?? 0
}

/** Parses a percentage cell (e.g. "12.5%" or "12.5") into a plain number (12.5), or null. */
export function toPercentOrNull(value: string | undefined): number | null {
  return toNumberOrNull(value)
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

export function parseFlexibleDate(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  // DD/MM/YYYY — matches this account's Amazon Ads export convention
  // (e.g. "Campaign start date" = "29/05/2025").
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const day = slash[1].padStart(2, '0')
    const month = slash[2].padStart(2, '0')
    return `${slash[3]}-${month}-${day}`
  }

  const monthName = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/)
  if (monthName) {
    const monthIndex = MONTH_INDEX[monthName[2].slice(0, 3).toLowerCase()]
    if (monthIndex !== undefined) {
      const day = monthName[1].padStart(2, '0')
      const month = String(monthIndex + 1).padStart(2, '0')
      return `${monthName[3]}-${month}-${day}`
    }
  }

  const parsed = new Date(trimmed)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** CTR as a percentage (0-100 scale). Never Infinity/NaN. */
export function computeCtr(clicks: number, impressions: number): number | null {
  if (!Number.isFinite(impressions) || impressions <= 0) return null
  return round2((clicks / impressions) * 100)
}

/** CPC in currency units. Never Infinity/NaN. */
export function computeCpc(spend: number, clicks: number): number | null {
  if (!Number.isFinite(clicks) || clicks <= 0) return null
  return round2(spend / clicks)
}

/** ACOS as a percentage (0-100+ scale). Null when sales is zero/absent, never Infinity/NaN. */
export function computeAcos(spend: number, sales: number): number | null {
  if (!Number.isFinite(sales) || sales <= 0) return null
  return round2((spend / sales) * 100)
}

/** ROAS as a ratio. Null when spend is zero/absent, never Infinity/NaN. */
export function computeRoas(spend: number, sales: number): number | null {
  if (!Number.isFinite(spend) || spend <= 0) return null
  return round2(sales / spend)
}

/**
 * Finds the first header column matching any alias in priority order.
 * Used to pick the shortest available attribution window (1d > 7d > 14d)
 * consistently across purchases/sales/units columns in Ads API v3 exports.
 */
export function findFirstColumnIndex(
  header: string[],
  aliasesInPriorityOrder: string[],
): { index: number; matchedAlias: string | null } {
  for (const alias of aliasesInPriorityOrder) {
    const idx = header.indexOf(alias)
    if (idx >= 0) return { index: idx, matchedAlias: alias }
  }
  return { index: -1, matchedAlias: null }
}

/** Extracts "1d"/"7d"/"14d" from a matched alias like "sales7d", else "unknown". */
export function attributionWindowFromAlias(matchedAlias: string | null): string {
  if (!matchedAlias) return 'unknown'
  const match = matchedAlias.match(/(\d+d)$/)
  return match ? match[1] : 'unknown'
}
