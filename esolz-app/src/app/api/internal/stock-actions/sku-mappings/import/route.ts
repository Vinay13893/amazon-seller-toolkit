import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  COMPONENT_COLUMNS,
  normalizedKey,
  parseSkuComponentMappingWorkbook,
  type SkuComponentMappingRecord,
} from '@/lib/internal/sku-component-mapping-parser'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const TABLE = 'internal_sku_component_mappings'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const SOURCE_FILE_NAME = 'Amaozn SKU map to warehouse SKU.xlsx'
const WRITE_CHUNK_SIZE = 500

const workbookPath = resolve(
  process.cwd(),
  '..',
  'Map Amazon SKU to warehouse SKU',
  SOURCE_FILE_NAME,
)

type NormalizedComponentRow = {
  workspace_id: string
  marketplace_id: string
  amazon_sku: string
  amazon_sku_norm: string
  wms_parent_sku: string
  wms_parent_sku_norm: string
  component_sku: string
  component_sku_norm: string
  component_quantity: number
  mapping_type: SkuComponentMappingRecord['mappingType']
  source: string
  source_file_name: string
  source_row_number: number
  source_component_column: string
  is_active: true
}

function toNormalizedRow(
  record: SkuComponentMappingRecord,
  workspaceId: string,
): NormalizedComponentRow {
  return {
    workspace_id: workspaceId,
    marketplace_id: DEFAULT_MARKETPLACE_ID,
    amazon_sku: record.amazonSku,
    amazon_sku_norm: normalizedKey(record.amazonSku),
    wms_parent_sku: record.wmsParentSku,
    wms_parent_sku_norm: normalizedKey(record.wmsParentSku),
    component_sku: record.componentSku,
    component_sku_norm: normalizedKey(record.componentSku),
    component_quantity: record.componentQuantity,
    mapping_type: record.mappingType,
    source: 'excel_upload',
    source_file_name: SOURCE_FILE_NAME,
    source_row_number: record.workbookRow,
    source_component_column: COMPONENT_COLUMNS[record.componentPosition - 1],
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
    result = await parseSkuComponentMappingWorkbook(workbookPath)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Workbook could not be parsed.' },
      { status: 400 },
    )
  }

  if (result.rejected.length > 0) {
    return NextResponse.json({
      written: false,
      ...result.stats,
      insertedCount: 0,
      updatedCount: 0,
    })
  }

  const dedupedRows = new Map<string, NormalizedComponentRow>()
  for (const record of result.accepted) {
    const normalized = toNormalizedRow(record, workspaceId)
    dedupedRows.set(`${normalized.amazon_sku_norm}|${normalized.component_sku_norm}`, normalized)
  }
  const rows = [...dedupedRows.values()]

  const admin = createAdminClient()
  const { data: existingRows, error: existingError } = await admin
    .from(TABLE)
    .select('id, amazon_sku_norm, component_sku_norm')
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', DEFAULT_MARKETPLACE_ID)
    .eq('is_active', true)

  if (existingError) {
    return NextResponse.json(
      { error: 'Existing mappings could not be read. Confirm migrations 031 and 032 are applied.' },
      { status: 503 },
    )
  }

  const existingIdByKey = new Map<string, string>()
  for (const row of existingRows ?? []) {
    existingIdByKey.set(`${row.amazon_sku_norm as string}|${row.component_sku_norm as string}`, row.id as string)
  }

  const insertRows: NormalizedComponentRow[] = []
  const updateRows: (NormalizedComponentRow & { id: string })[] = []

  for (const row of rows) {
    const existingId = existingIdByKey.get(`${row.amazon_sku_norm}|${row.component_sku_norm}`)
    if (existingId) {
      updateRows.push({ ...row, id: existingId })
    } else {
      insertRows.push(row)
    }
  }

  for (let index = 0; index < insertRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = insertRows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).insert(chunk)
    if (error) {
      return NextResponse.json(
        { error: 'New mappings could not be saved. Confirm migrations 031 and 032 are applied.' },
        { status: 503 },
      )
    }
  }

  for (let index = 0; index < updateRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = updateRows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).upsert(chunk, { onConflict: 'id' })
    if (error) {
      return NextResponse.json(
        { error: 'Existing mappings could not be updated. Confirm migrations 031 and 032 are applied.' },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({
    written: true,
    ...result.stats,
    insertedCount: insertRows.length,
    updatedCount: updateRows.length,
  })
}
