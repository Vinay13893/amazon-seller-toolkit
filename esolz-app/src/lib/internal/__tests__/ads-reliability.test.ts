import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdsApiError, adsRetryDelay, parseRetryAfter } from '../ads-api-error'
import { evaluateAdsSource } from '../brahmastra-data-health'

const now = Date.parse('2026-11-08T12:00:00Z')
const sources = ['ads_campaign_daily', 'ads_sb_campaign_daily', 'ads_sd_campaign_daily', 'ads_advertised_product', 'ads_targeting', 'ads_search_term']
function fixture() {
  return {
    latestDataDate: '2026-11-07', profileSelected: true, staleAfterDays: 2, nowMs: now,
    runsBySource: new Map(sources.map(source => [source, {
      source, status: 'success', started_at: '2026-11-08T02:00:00Z',
      finished_at: '2026-11-08T02:10:00Z', error_message: null as string | null,
    }])),
  }
}

test('healthy Ads requires all six reports to have recent successful runs', () => {
  const result = evaluateAdsSource(fixture())
  assert.equal(result.status, 'healthy')
  assert.equal(result.blocksActions, false)
})

test('a single throttled Sponsored Brands report blocks complete-data recommendations', () => {
  const input = fixture()
  Object.assign(input.runsBySource.get('ads_sb_campaign_daily')!, { status: 'failed', error_message: 'HTTP 429' })
  const result = evaluateAdsSource(input)
  assert.equal(result.status, 'rate_limited')
  assert.equal(result.blocksActions, true)
})

test('fresh campaign rows cannot hide missing, failed, running or stale deep reports', () => {
  for (const state of ['missing', 'failed', 'running', 'stale']) {
    const input = fixture()
    const row = input.runsBySource.get('ads_search_term')!
    if (state === 'missing') input.runsBySource.delete('ads_search_term')
    else if (state === 'stale') row.finished_at = '2026-11-06T23:59:59Z'
    else row.status = state
    assert.equal(evaluateAdsSource(input).blocksActions, true, state)
  }
})

test('missing dataset or profile never produces healthy Ads', () => {
  assert.equal(evaluateAdsSource({ ...fixture(), latestDataDate: null }).blocksActions, true)
  assert.equal(evaluateAdsSource({ ...fixture(), profileSelected: false }).blocksActions, true)
})

test('Retry-After supports seconds and HTTP dates and ignores malformed values', () => {
  assert.equal(parseRetryAfter('120', now), 120_000)
  assert.equal(parseRetryAfter('Sun, 08 Nov 2026 12:02:00 GMT', now), 120_000)
  assert.equal(parseRetryAfter('-1', now), null)
  assert.equal(parseRetryAfter('invalid', now), null)
  assert.equal(parseRetryAfter(null, now), null)
})

test('retry waits at least the server cooldown and defers excessive delays', () => {
  assert.equal(adsRetryDelay(new AdsApiError('HTTP 429', 429, 120_000), 30_000), 120_000)
  assert.equal(adsRetryDelay(new AdsApiError('HTTP 429', 429, 1000), 30_000), 30_000)
  assert.equal(adsRetryDelay(new AdsApiError('HTTP 429', 429, 600_000), 30_000), null)
})
