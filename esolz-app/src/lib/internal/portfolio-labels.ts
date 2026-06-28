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
  // \b alone doesn't create a boundary before "_" (it's a word character),
  // so "EH_BOC_4x9_Maroon_P1" was falling through to Unmapped — match an
  // explicit separator/end instead, same fix as the SRA rule above.
  { pattern: /\b(eh_?boc|boc)(?:[_\s-]|$)|curtains?/i, portfolio: 'Curtains' },
  { pattern: /\b(wtc|spa-?wtc)\b|tank[_\s-]*cover|water\s*tank\s*cover|insulation\s*cover/i, portfolio: 'Water Tank Cover' },
  { pattern: /facial\s*box|facialbox|face\s*tissue|tissue\s*box|papfoil|baking\s*paper|parchment\s*paper|butter\s*paper/i, portfolio: 'Coze' },
  // Same underscore-boundary issue as BOC above — "EH_BPM" and
  // "SP-PT-EH_BPM-(...)" were falling through because "_BPM" has no \b.
  { pattern: /\b(eh_?)?bpm(?:[_\s-]|$)|baby\s*play\s*mat|baby\s*mats?\s*for\s*floor/i, portfolio: 'BPM' },
  // "SB"/"SBin" is the account's own abbreviation for Storage Bags — require
  // it as its own delimited token (not just a substring) to avoid false
  // positives on unrelated names that happen to contain "sb".
  { pattern: /storage\s*bags?|wardrobe|under\s*-?bed|\bsbin\b|(?:^|[_-])sb(?:[_-]|$)/i, portfolio: 'Storage Bags' },
  // All self-adhesive products (Corner, Sticker, Rack-with-hooks, Organiser/
  // Organizer) belong to Bathroom Shelf — confirmed by the team; this was
  // previously scoped to Rack-with-hooks only, which left Corner/Sticker
  // variants unmapped.
  { pattern: /selfadv|self[_\s]*adhesive|rack[_\s]*with[_\s]*hooks?|bathroom[_\s]*rack|bathroom[_\s]*shelf/i, portfolio: 'Bathroom Shelf' },
  { pattern: /gulp[_\s-]*shaker/i, portfolio: 'Unifit' },
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
