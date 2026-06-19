import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { normalizedKey } from '@/lib/internal/sku-component-mapping-parser'
import { parseSkuCostMasterJson, type SkuCostMasterRecord } from '@/lib/internal/sku-cost-master-parser'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const TABLE = 'internal_sku_cost_master'
const WRITE_CHUNK_SIZE = 500

// Local-machine path only — this file is not committed to the repo and this
// route only works where it exists on disk (matches the SKU mapping importer
// convention for fixed local-file imports in v1).
const DEFAULT_COST_MASTER_PATH = 'C:\\Vinay\\Emount Profitability Calculator\\cost_prices.json'
const costMasterPath = resolve(process.env.PROFITABILITY_COST_MASTER_PATH ?? DEFAULT_COST_MASTER_PATH)

type NormalizedCostMasterRow = {
  workspace_id: string
  sku: string
  sku_norm: string
  cost_price: number | null
  packing_transport: number | null
  gst_rate: number | null
  gst_history: SkuCostMasterRecord['gstHistory']
  product_name: string | null
  category: string | null
  notes: string | null
  source: string
  is_active: true
}

function toNormalizedRow(record: SkuCostMasterRecord, workspaceId: string): NormalizedCostMasterRow {
  return {
    workspace_id: workspaceId,
    sku: record.sku,
    sku_norm: normalizedKey(record.sku),
    cost_price: record.costPrice,
    packing_transport: record.packingTransport,
    gst_rate: record.gstRate,
    gst_history: record.gstHistory,
    product_name: record.productName,
    category: record.category,
    notes: record.notes,
    source: record.source,
    is_active: true,
  }
}

export async function POST() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  let result
  try {
    const raw = readFileSync(costMasterPath, 'utf8')
    result = parseSkuCostMasterJson(raw)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cost master file could not be read.' },
      { status: 400 },
    )
  }

  if (result.rejected.length > 0) {
    return NextResponse.json({
      written: false,
      ...result.stats,
      upsertedCount: 0,
    })
  }

  const rows = result.accepted.map(record => toNormalizedRow(record, workspaceId))
  const admin = createAdminClient()

  for (let index = 0; index < rows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin
      .from(TABLE)
      .upsert(chunk, { onConflict: 'workspace_id,sku_norm' })
    if (error) {
      return NextResponse.json(
        { error: 'Cost master rows could not be saved. Confirm migration 033 is applied.' },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({
    written: true,
    ...result.stats,
    upsertedCount: rows.length,
  })
}
