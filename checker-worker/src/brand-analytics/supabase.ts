import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface BrandAnalyticsJobRow {
  id: string
  workspace_id: string
  amazon_connection_id: string
  report_type: string
  report_id: string | null
  report_document_id: string | null
  marketplace_id: string | null
  report_period: string | null
  data_start_time: string | null
  data_end_time: string | null
  processing_status: string
  requested_at: string | null
  raw_summary: Record<string, unknown> | null
}

export interface AmazonConnectionRow {
  id: string
  status: string
  refresh_token_encrypted: string | null
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`)
  }
  return value.trim()
}

export function createSupabaseAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url) {
    throw new Error('SUPABASE_URL is required')
  }

  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

export async function getBrandAnalyticsJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<BrandAnalyticsJobRow | null> {
  const { data, error } = await supabase
    .from('amazon_report_jobs')
    .select('id, workspace_id, amazon_connection_id, report_type, report_id, report_document_id, marketplace_id, report_period, data_start_time, data_end_time, processing_status, requested_at, raw_summary')
    .eq('id', jobId)
    .maybeSingle()

  if (error) throw new Error('Failed to read report job')
  return (data as BrandAnalyticsJobRow | null) ?? null
}

export async function getAmazonConnection(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<AmazonConnectionRow | null> {
  const { data, error } = await supabase
    .from('amazon_connections')
    .select('id, status, refresh_token_encrypted')
    .eq('id', connectionId)
    .maybeSingle()

  if (error) throw new Error('Failed to read Amazon connection')
  return (data as AmazonConnectionRow | null) ?? null
}

export async function updateAmazonReportDocument(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('amazon_report_documents')
    .upsert(payload, { onConflict: 'workspace_id,report_document_id' })

  if (error) {
    throw new Error('Failed to upsert amazon_report_documents row')
  }
}

export async function updateAmazonJobSummary(
  supabase: SupabaseClient,
  jobId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('amazon_report_jobs')
    .update(values)
    .eq('id', jobId)

  if (error) {
    throw new Error('Failed to update amazon_report_jobs')
  }
}

export async function updateAmazonDocumentSummary(
  supabase: SupabaseClient,
  workspaceId: string,
  reportDocumentId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('amazon_report_documents')
    .update(values)
    .eq('workspace_id', workspaceId)
    .eq('report_document_id', reportDocumentId)

  if (error) {
    throw new Error('Failed to update amazon_report_documents')
  }
}

export function getSafeBatchSize(input: number | undefined): number {
  if (!input || !Number.isFinite(input)) return 500
  const normalized = Math.trunc(input)
  return Math.min(1000, Math.max(1, normalized))
}

export function requireWorkerEnvForSync(): void {
  // Validate these early with clear messages but without printing sensitive values.
  getRequiredEnv('SUPABASE_URL')
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  getRequiredEnv('SPAPI_ENCRYPTION_KEY')
  getRequiredEnv('SPAPI_LWA_CLIENT_ID')
  getRequiredEnv('SPAPI_LWA_CLIENT_SECRET')
}
