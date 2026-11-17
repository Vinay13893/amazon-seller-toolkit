export type DeliverySummary = {
  headline: string
  detail: string | null
  location: string | null
}

function withoutJsonObjects(value: string): string {
  let output = ''
  let depth = 0
  let inString = false
  let escaped = false

  for (const character of value) {
    if (depth > 0) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\' && inString) {
        escaped = true
        continue
      }
      if (character === '"') {
        inString = !inString
        continue
      }
      if (!inString && character === '{') depth += 1
      if (!inString && character === '}') depth -= 1
      continue
    }

    if (character === '{') {
      depth = 1
      inString = false
      escaped = false
      continue
    }
    output += character
  }

  return output
}

function clean(value: string): string {
  return value
    .replace(/\bDetails\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[|,;:\s]+|[|,;:\s]+$/g, '')
    .trim()
}

function uniqueSegments(value: string): string[] {
  const seen = new Set<string>()
  const segments: string[] = []

  for (const raw of withoutJsonObjects(value).split('|')) {
    const segment = clean(raw)
    if (!segment || /^(in stock|available)$/i.test(segment)) continue
    const key = segment.toLocaleLowerCase('en-IN')
    if (seen.has(key)) continue
    seen.add(key)
    segments.push(segment)
  }

  return segments
}

function firstMatch(value: string, expression: RegExp): string | null {
  const match = value.match(expression)?.[0]
  return match ? clean(match) : null
}

export function summarizeDeliveryMessage(
  message: string | null | undefined,
  availability: string | null | undefined,
): DeliverySummary {
  const fallback = availability === 'available'
    ? 'Available for delivery'
    : availability === 'unavailable'
      ? 'Not available for delivery'
      : 'Delivery details not confirmed'

  if (!message?.trim()) return { headline: fallback, detail: null, location: null }

  const segments = uniqueSegments(message)
  const readable = clean(segments.join(' | '))
  const location = firstMatch(readable, /deliver(?:ing)? to\s+[^|]+?(?=$|\s+\|)/i)
  const fastest = firstMatch(readable, /(?:or\s+)?fastest delivery\s+[^|]+?(?=$|\s+\|)/i)
  const standard = firstMatch(readable, /(?:free\s+)?delivery\s+[^|]+?(?=\s+(?:or\s+)?fastest delivery|$|\s+\|)/i)

  const headline = fastest ?? standard ?? segments[0] ?? fallback
  const detail = standard && standard !== headline
    ? standard
    : segments.find(segment => segment !== headline && segment !== location) ?? null

  return { headline, detail, location }
}

export function deliverySummaryText(
  message: string | null | undefined,
  availability: string | null | undefined,
): string {
  const summary = summarizeDeliveryMessage(message, availability)
  return [summary.headline, summary.detail, summary.location].filter(Boolean).join(' · ')
}
