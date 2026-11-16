// Read-only Finance API. Never log tokens, response bodies or transaction identifiers.
// Model: amzn/selling-partner-api-models, finances_2024-06-19.json.
export type FinanceRow = {
  transaction_id: string
  posted_at: string
  transaction_type: string
  transaction_status: string
  currency: string
  total_amount: number
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Finance API response.')
  return value as Record<string, unknown>
}

export function normalizeFinanceTransaction(value: unknown, marketplaceId: string): FinanceRow {
  const row = object(value)
  const metadata = object(row.sellingPartnerMetadata)
  const money = object(row.totalAmount)
  if (metadata.marketplaceId !== marketplaceId) throw new Error('Finance marketplace mismatch.')
  for (const key of ['transactionId', 'postedDate', 'transactionType', 'transactionStatus']) {
    if (typeof row[key] !== 'string' || !row[key]) throw new Error('Incomplete Finance transaction.')
  }
  if (!Number.isFinite(Date.parse(row.postedDate as string)) ||
      typeof money.currencyAmount !== 'number' || !Number.isFinite(money.currencyAmount) ||
      typeof money.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(money.currencyCode)) {
    throw new Error('Invalid Finance date or amount.')
  }
  // Deliberately exclude descriptions, order IDs, item contexts and buyer information.
  // Net receipts are NOT product sales; no synthetic sales/fee/tax classification.
  return {
    transaction_id: row.transactionId as string,
    posted_at: new Date(row.postedDate as string).toISOString(),
    transaction_type: row.transactionType as string,
    transaction_status: row.transactionStatus as string,
    currency: money.currencyCode,
    total_amount: money.currencyAmount,
  }
}

type FinanceOptions = {
  marketplaceId: string
  postedAfter: string
  postedBefore: string
  accessToken: () => Promise<string>
  fetcher?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export async function* financeTransactionPages(options: FinanceOptions): AsyncGenerator<FinanceRow[]> {
  const { marketplaceId, postedAfter, postedBefore } = options
  // This release is explicitly scoped to the India marketplace and EU endpoint.
  if (marketplaceId !== 'A21TJRUUN4KGV') throw new Error('Finance marketplace is not supported yet.')
  const start = Date.parse(postedAfter), end = Date.parse(postedBefore)
  const now = options.now ?? Date.now
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
      end - start > 180 * 86400000 || end >= now() - 120000) throw new Error('Invalid Finance sync window.')
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const seen = new Set<string>()
  let nextToken: string | undefined
  for (let page = 0; page < 2000; page++) {
    const url = new URL('https://sellingpartnerapi-eu.amazon.com/finances/2024-06-19/transactions')
    url.searchParams.set('marketplaceId', marketplaceId)
    url.searchParams.set('postedAfter', postedAfter)
    url.searchParams.set('postedBefore', postedBefore)
    if (nextToken) url.searchParams.set('nextToken', nextToken)
    let response: Response | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      // Default rate is 0.5 requests/sec. Pace retries and empty pages too.
      await sleep(2100)
      try {
        response = await fetcher(url, {
          headers: { 'x-amz-access-token': await options.accessToken(), accept: 'application/json' },
          signal: AbortSignal.timeout(60000), cache: 'no-store',
        })
      } catch {
        if (attempt === 4) throw new Error('Finance API connection failed.')
        await sleep(2000 * 2 ** attempt)
        continue
      }
      if (response.ok) break
      if (response.status !== 429 && response.status < 500) throw new Error(`Finance API HTTP ${response.status}; check Amazon Finance and Accounting access.`)
      if (attempt === 4) throw new Error(`Finance API HTTP ${response.status}; retry limit reached.`)
      const retry = response.headers.get('retry-after')
      const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now()) : 0
      // Do not shorten Amazon's requested delay. Defer very long waits to the next scheduled run.
      if (retryMs > 300000) throw new Error('Finance API requested a later retry.')
      await sleep(Math.max(2000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0))
    }
    if (!response?.ok) throw new Error('Finance API request failed.')
    let body: Record<string, unknown>
    try { body = object(await response.json()) } catch { throw new Error('Invalid Finance API JSON.') }
    const payload = object(body.payload)
    if (!Array.isArray(payload.transactions)) throw new Error('Finance transactions are missing.')
    const rows = payload.transactions.map(value => normalizeFinanceTransaction(value, marketplaceId))
    if (rows.some(row => Date.parse(row.posted_at) < start || Date.parse(row.posted_at) >= end)) {
      throw new Error('Finance transaction outside requested window.')
    }
    yield rows
    if (payload.nextToken == null || payload.nextToken === '') return
    if (typeof payload.nextToken !== 'string' || seen.has(payload.nextToken)) throw new Error('Invalid Finance pagination token.')
    nextToken = payload.nextToken
    seen.add(nextToken)
  }
  throw new Error('Finance page limit exceeded; narrow the sync window.')
}
