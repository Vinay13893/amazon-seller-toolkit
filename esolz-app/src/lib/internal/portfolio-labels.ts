// Display-only portfolio label mapping. The underlying stored/matched
// portfolio key (e.g. "BPM") never changes — this only controls what text
// is shown to the team. Keep this map in sync with EasyhomePortfolio.
const PORTFOLIO_DISPLAY_LABELS: Record<string, string> = {
  BPM: 'Baby Play Mat (BPM)',
  SRA: 'Sage Royal Ayurveda',
  'Sage Royal Ayurveda': 'Sage Royal Ayurveda',
  BOC: 'Curtains',
  Curtains: 'Curtains',
  WTC: 'Water Tank Cover',
  'Water Tank Cover': 'Water Tank Cover',
  Coze: 'Coze',
  'Papfoil / Kitchen Paper': 'Coze',
}

export function portfolioDisplayLabel(portfolio: string): string {
  return PORTFOLIO_DISPLAY_LABELS[portfolio] ?? portfolio
}

const UNMAPPED = 'Unmapped / Needs Review'

const PORTFOLIO_RULES: Array<{ pattern: RegExp; portfolio: string }> = [
  { pattern: /\bsra(?:[_\s-]|$)|sage\s*royal\s*ayurveda/i, portfolio: 'Sage Royal Ayurveda' },
  { pattern: /\b(eh_?boc|boc)\b|curtain/i, portfolio: 'Curtains' },
  { pattern: /\b(wtc|spa-?wtc)\b|tank[_\s-]*cover|water\s*tank\s*cover|insulation\s*cover/i, portfolio: 'Water Tank Cover' },
  { pattern: /facial\s*box|facialbox|face\s*tissue|tissue\s*box|papfoil|baking\s*paper|parchment\s*paper|butter\s*paper/i, portfolio: 'Coze' },
  { pattern: /baby\s*play\s*mat|\bbpm\b/i, portfolio: 'BPM' },
]

const AUTO_TARGET_LABELS: Record<string, string> = {
  'close-match': 'Auto targeting: Close match',
  'loose-match': 'Auto targeting: Loose match',
  substitutes: 'Auto targeting: Substitutes',
  complements: 'Auto targeting: Complements',
}

export function resolveEasyhomePortfolio(...values: Array<string | null | undefined>): string {
  const existing = values[0]?.trim()
  if (existing && existing !== UNMAPPED && existing !== 'PENDING_SKU_LOOKUP') {
    return existing === 'Papfoil / Kitchen Paper' ? 'Coze' : existing
  }
  const haystack = values.filter(Boolean).join(' ')
  for (const rule of PORTFOLIO_RULES) {
    if (rule.pattern.test(haystack)) return rule.portfolio
  }
  return UNMAPPED
}

export function autoTargetDisplayLabel(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  return AUTO_TARGET_LABELS[normalized] ?? trimmed
}

export function entityDisplayLabel(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .split(/(\s*\([^)]+\))/)
    .map(part => {
      const suffix = part.match(/^\s*\(([^)]+)\)$/)
      if (suffix) return ` (${autoTargetDisplayLabel(suffix[1])})`
      return autoTargetDisplayLabel(part)
    })
    .join('')
}
