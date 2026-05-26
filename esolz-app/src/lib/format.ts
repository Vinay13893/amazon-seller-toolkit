const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  GBP: '£',
  EUR: '€',
}

export function formatPrice(price: number | null, currency: string): string {
  if (price === null) return '—'
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency
  return `${symbol}${price.toLocaleString('en-IN')}`
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
