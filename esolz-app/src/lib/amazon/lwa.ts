/**
 * src/lib/amazon/lwa.ts
 *
 * Login with Amazon (LWA) token helper — server-only.
 *
 * SECURITY: Never log refresh_token, access_token, or client_secret.
 * This module must only be imported by server-side code (API route handlers).
 */

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

export interface LWARefreshResult {
  access_token: string
  expires_in:   number
  token_type?:  string
}

/**
 * Exchanges a stored refresh token for a fresh LWA access token.
 *
 * @throws Error with a safe message if the exchange fails.
 *         Never includes token values in the error message.
 */
export async function refreshAccessToken(refreshToken: string): Promise<LWARefreshResult> {
  const clientId     = process.env.SPAPI_LWA_CLIENT_ID
  const clientSecret = process.env.SPAPI_LWA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('LWA credentials not configured (SPAPI_LWA_CLIENT_ID / SPAPI_LWA_CLIENT_SECRET missing)')
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  })

  if (!res.ok) {
    // In dev, log the LWA error body for debugging — never log in production (may contain hints)
    if (process.env.NODE_ENV !== 'production') {
      const errBody = await res.text().catch(() => '<unreadable>')
      console.error('[lwa] Token refresh HTTP error:', res.status, errBody)
    } else {
      console.error('[lwa] Token refresh HTTP error:', res.status)
    }
    throw new Error(`LWA token refresh failed with HTTP ${res.status}`)
  }

  const data = await res.json() as LWARefreshResult

  if (process.env.NODE_ENV !== 'production') {
    console.log('[lwa] Token refresh success — expires_in:', data.expires_in)
  }

  return data
}
