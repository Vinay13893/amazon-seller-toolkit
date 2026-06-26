// Phase 2C.1: minimal Amazon Ads Reporting API (v3) client for the daily
// auto-refresh of Sponsored Products report data. Read-only — only ever
// calls report-creation/read endpoints, never a write endpoint, and never
// touches bids/budgets/campaigns/keywords/targets.
//
// SECURITY: never log refresh_token/access_token values.

import { gunzipSync } from 'node:zlib'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

const AD_API_BASE_BY_REGION: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
}

export function adsApiBaseUrl(region: string): string {
  return AD_API_BASE_BY_REGION[region.toLowerCase()] ?? AD_API_BASE_BY_REGION.eu
}

/**
 * Exchanges a refresh token for a fresh access token. Ads API uses its own
 * LWA app — separate client id/secret from SP-API. Pass explicit
 * clientId/clientSecret for a directly-configured credential set (which may
 * use a different LWA app than the in-app OAuth connect flow); falls back
 * to AMAZON_ADS_CLIENT_ID/SECRET (the in-app OAuth app) when omitted.
 */
export async function refreshAdsAccessToken(
  refreshToken: string,
  creds?: { clientId: string; clientSecret: string },
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = creds?.clientId ?? process.env.AMAZON_ADS_CLIENT_ID
  const clientSecret = creds?.clientSecret ?? process.env.AMAZON_ADS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('AMAZON_ADS_CLIENT_ID / AMAZON_ADS_CLIENT_SECRET are not configured.')
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!res.ok) {
    throw new Error(`Ads LWA token refresh failed with HTTP ${res.status}`)
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export type AdsReportType = 'spCampaigns' | 'spAdvertisedProduct' | 'spTargeting' | 'spSearchTerm'

const REPORT_CONFIG: Record<AdsReportType, { groupBy: string[]; columns: string[] }> = {
  spCampaigns: {
    groupBy: ['campaign'],
    columns: [
      'date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount',
      'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d',
    ],
  },
  spAdvertisedProduct: {
    groupBy: ['advertiser'],
    columns: [
      'date', 'campaignId', 'campaignName', 'campaignStatus', 'adGroupId', 'adGroupName',
      'advertisedAsin', 'advertisedSku', 'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d',
    ],
  },
  spTargeting: {
    groupBy: ['targeting'],
    columns: [
      'date', 'campaignId', 'campaignName', 'campaignStatus', 'adGroupId', 'adGroupName',
      'keywordId', 'keyword', 'keywordType', 'matchType', 'targeting',
      'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d',
    ],
  },
  spSearchTerm: {
    groupBy: ['searchTerm'],
    columns: [
      'date', 'campaignId', 'campaignName', 'campaignStatus', 'adGroupId', 'adGroupName',
      'targeting', 'matchType', 'searchTerm', 'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d',
    ],
  },
}

type AdsApiContext = {
  region: string
  accessToken: string
  profileId: string
  /** Must match the LWA app that issued accessToken — falls back to the in-app OAuth client id when omitted. */
  clientId?: string
}

function authHeaders(ctx: AdsApiContext): HeadersInit {
  const clientId = ctx.clientId ?? process.env.AMAZON_ADS_CLIENT_ID ?? ''
  return {
    'Authorization': `Bearer ${ctx.accessToken}`,
    'Amazon-Advertising-API-ClientId': clientId,
    'Amazon-Advertising-API-Scope': ctx.profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
  }
}

/** Requests a daily Sponsored Products report for [startDate, endDate] (inclusive, YYYY-MM-DD). Returns the Amazon reportId to poll. */
export async function requestAdsReport(ctx: AdsApiContext, reportType: AdsReportType, startDate: string, endDate: string): Promise<string> {
  const config = REPORT_CONFIG[reportType]
  const res = await fetch(`${adsApiBaseUrl(ctx.region)}/reporting/reports`, {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify({
      name: `brahmastra-${reportType}-${startDate}-${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: config.groupBy,
        columns: config.columns,
        reportTypeId: reportType,
        timeUnit: 'DAILY',
        format: 'GZIP_JSON',
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Report request for ${reportType} failed: HTTP ${res.status} ${body.slice(0, 300)}`)
  }
  const data = await res.json() as { reportId: string }
  if (!data.reportId) throw new Error(`Report request for ${reportType} did not return a reportId.`)
  return data.reportId
}

export type ReportPollResult = { status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; url?: string; failureReason?: string }

export async function pollAdsReport(ctx: AdsApiContext, reportId: string): Promise<ReportPollResult> {
  const res = await fetch(`${adsApiBaseUrl(ctx.region)}/reporting/reports/${reportId}`, {
    method: 'GET',
    headers: authHeaders(ctx),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Report status check failed: HTTP ${res.status} ${body.slice(0, 300)}`)
  }
  const data = await res.json() as { status: ReportPollResult['status']; url?: string; failureReason?: string }
  return { status: data.status, url: data.url, failureReason: data.failureReason }
}

/** Polls until COMPLETED/FAILED, with a sane timeout — Amazon reports usually finish within a couple of minutes. */
export async function waitForAdsReport(ctx: AdsApiContext, reportId: string, { maxWaitMs = 180_000, pollIntervalMs = 5_000 } = {}): Promise<string> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const result = await pollAdsReport(ctx, reportId)
    if (result.status === 'COMPLETED') {
      if (!result.url) throw new Error('Report marked COMPLETED but no download url was returned.')
      return result.url
    }
    if (result.status === 'FAILED') {
      throw new Error(`Report generation failed: ${result.failureReason ?? 'unknown reason'}`)
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms.`)
}

/** Downloads and decompresses a completed report document into its row objects. No auth headers needed — it's a pre-signed URL. */
export async function downloadAdsReportRows(downloadUrl: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(downloadUrl)
  if (!res.ok) throw new Error(`Report document download failed: HTTP ${res.status}`)
  const gzipped = Buffer.from(await res.arrayBuffer())
  const json = gunzipSync(gzipped).toString('utf8')
  const parsed = JSON.parse(json)
  return Array.isArray(parsed) ? parsed : []
}

export type { AdsApiContext }
