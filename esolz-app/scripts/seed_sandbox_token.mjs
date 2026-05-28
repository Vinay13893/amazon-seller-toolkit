/**
 * One-time script: seed sandbox refresh token directly into amazon_connections.
 * Run: node scripts/seed_sandbox_token.mjs
 */
import { createCipheriv, randomBytes } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local manually
const envPath = resolve(__dirname, '../.env.local')
const envVars = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const idx = trimmed.indexOf('=')
  if (idx === -1) continue
  envVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
}

const ENCRYPTION_KEY = envVars['SPAPI_ENCRYPTION_KEY']
const SUPABASE_URL   = envVars['NEXT_PUBLIC_SUPABASE_URL']
const SERVICE_KEY    = envVars['SUPABASE_SERVICE_ROLE_KEY']

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('Missing or invalid SPAPI_ENCRYPTION_KEY (needs 64 hex chars)')
  process.exit(1)
}

// AES-256-GCM encrypt (matches crypto.ts exactly)
function encryptToken(plainText) {
  const key    = Buffer.from(ENCRYPTION_KEY, 'hex')
  const iv     = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct     = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`
}

const REFRESH_TOKEN = 'Atzr|IwEBIFo_EvH2s4A89HitelA0UxHSVIbm6GQ11EDThN2o_dWCZVlLpkTAXu3hI20yKZvAAmN29SyfU1T4LjSOxjIL71z1QEXWzPvq3wKqZCLyz4e4io0QWB4zzUpePCOjtib_dagnqgC_rwQ8REEGNFgYeFGZdtUxIdtSSMHNFG0mgyZ_jENHmXm5vn8aGT2Rcbb4NmbRqftUhNKlGksyViRqNcHmGcFinWUDTGXq08C0c1HtO5qRnkQuWn5f6SMtTyzBd8EimRqyqgGhyjG6Sc-CYkA7M48yyg94RFcdeCjVL83hT-Q1UR5Ba_AcSf1EHVsc80Y'

// Exchange refresh token for access token to get seller ID
async function getSellerInfo() {
  const LWA_CLIENT_ID     = envVars['SPAPI_LWA_CLIENT_ID']
  const LWA_CLIENT_SECRET = envVars['SPAPI_LWA_CLIENT_SECRET']

  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id:     LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  })
  const data = await resp.json()
  if (!resp.ok) {
    console.error('Token exchange failed:', data)
    process.exit(1)
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

async function main() {
  console.log('Exchanging refresh token for access token...')
  const { accessToken, expiresIn } = await getSellerInfo()
  console.log('Access token obtained. Expires in:', expiresIn, 'seconds')

  const encryptedRefresh = encryptToken(REFRESH_TOKEN)
  const encryptedAccess  = encryptToken(accessToken)
  const accessExpiresAt  = new Date(Date.now() + expiresIn * 1000).toISOString()

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

  // Get first workspace
  const { data: workspaces, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .limit(5)

  if (wsErr) { console.error('Failed to fetch workspaces:', wsErr); process.exit(1) }
  console.log('Available workspaces:', workspaces)

  if (!workspaces || workspaces.length === 0) {
    console.error('No workspaces found. Create a workspace first by logging into the app.')
    process.exit(1)
  }

  // Use first workspace (change index if needed)
  const workspaceId = workspaces[0].id
  console.log(`Using workspace: ${workspaces[0].name} (${workspaceId})`)

  const record = {
    workspace_id:             workspaceId,
    selling_partner_id:       'SANDBOX_EMOUNT',
    marketplace_id:           'A21TJRUUN4KGV',  // Amazon.in
    marketplace_name:         'Amazon.in (Sandbox)',
    refresh_token_encrypted:  encryptedRefresh,
    access_token_encrypted:   encryptedAccess,
    access_token_expires_at:  accessExpiresAt,
    status:                   'active',
    connected_at:             new Date().toISOString(),
  }

  const { error } = await supabase
    .from('amazon_connections')
    .upsert(record, { onConflict: 'workspace_id' })

  if (error) {
    console.error('DB upsert failed:', error)
    process.exit(1)
  }

  console.log('✓ Sandbox token seeded successfully!')
  console.log('  Seller ID: SANDBOX_EMOUNT')
  console.log('  Access token expires at:', accessExpiresAt)
}

main().catch(console.error)
