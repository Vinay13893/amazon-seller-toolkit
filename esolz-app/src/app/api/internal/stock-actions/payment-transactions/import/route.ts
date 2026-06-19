import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { normalizedKey } from '@/lib/internal/sku-component-mapping-parser'
import {
  parsePaymentTransactionReport,
  type PaymentTransactionRecord,
} from '@/lib/internal/payment-transaction-parser'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const TABLE = 'internal_payment_transactions'
const WRITE_CHUNK_SIZE = 500
const SAFE_FILE_NAME = /^[\w.,() -]+\.csv$/i

// Local-machine folder only — these reports are not committed to the repo and
// this route only works where the file already exists on disk, mirroring the
// SKU mapping importer's fixed local-file convention for v1.
const DEFAULT_TRANSACTIONS_DIR = 'C:\\Vinay\\Emount Profitability Calculator'
const transactionsDir = resolve(process.env.PROFITABILITY_TRANSACTIONS_DIR ?? DEFAULT_TRANSACTIONS_DIR)

type NormalizedTransactionRow = {
  workspace_id: string
  marketplace: string
  transaction_date: string
  settlement_id: string | null
  transaction_type: string
  category: string
  order_id: string | null
  sku: string | null
  sku_norm: string | null
  description: string | null
  quantity: number | null
  account_type: string | null
  fulfillment: string | null
  order_city: string | null
  order_state: string | null
  order_postal: string | null
  product_sales: number
  shipping_credits: number
  gift_wrap_credits: number
  promotional_rebates: number
  total_sales_tax_liable: number
  tcs_cgst: number
  tcs_sgst: number
  tcs_igst: number
  tds_194o: number
  selling_fees: number
  fba_fees: number
  other_transaction_fees: number
  other_amount: number
  total_amount: number
  transaction_status: string | null
  transaction_release_date: string | null
  source: string
  source_file_name: string
  source_row_number: number
}

/**
 * Amazon's transaction export can contain a small number of genuinely
 * distinct rows that collide on our dedupe business-key (e.g. several
 * same-amount fee lines posted at the identical second). Bulk-insert each
 * chunk; on a unique_violation, fall back to row-by-row so one colliding row
 * doesn't block the rest of the batch — duplicates are counted, not stored.
 */
async function insertRowsResilient(
  admin: ReturnType<typeof createAdminClient>,
  rows: NormalizedTransactionRow[],
): Promise<{ insertedCount: number; duplicateSkippedCount: number }> {
  let insertedCount = 0
  let duplicateSkippedCount = 0

  for (let index = 0; index < rows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).insert(chunk)
    if (!error) {
      insertedCount += chunk.length
      continue
    }
    if (error.code !== '23505') throw new Error(error.message)

    for (const row of chunk) {
      const { error: rowError } = await admin.from(TABLE).insert([row])
      if (!rowError) {
        insertedCount += 1
      } else if (rowError.code === '23505') {
        duplicateSkippedCount += 1
      } else {
        throw new Error(rowError.message)
      }
    }
  }

  return { insertedCount, duplicateSkippedCount }
}

function dedupeKey(row: {
  settlement_id: string | null
  order_id: string | null
  sku: string | null
  transaction_type: string
  transaction_date: string
  total_amount: number
}): string {
  return [
    row.settlement_id ?? '',
    row.order_id ?? '',
    row.sku ?? '',
    row.transaction_type,
    row.transaction_date,
    row.total_amount.toFixed(2),
  ].join('|')
}

function toNormalizedRow(
  record: PaymentTransactionRecord,
  workspaceId: string,
  fileName: string,
): NormalizedTransactionRow {
  return {
    workspace_id: workspaceId,
    marketplace: record.marketplace ?? 'amazon.in',
    transaction_date: record.transactionDate,
    settlement_id: record.settlementId,
    transaction_type: record.transactionType,
    category: record.category,
    order_id: record.orderId,
    sku: record.sku,
    sku_norm: record.sku ? normalizedKey(record.sku) : null,
    description: record.description,
    quantity: record.quantity,
    account_type: record.accountType,
    fulfillment: record.fulfillment,
    order_city: record.orderCity,
    order_state: record.orderState,
    order_postal: record.orderPostal,
    product_sales: record.productSales,
    shipping_credits: record.shippingCredits,
    gift_wrap_credits: record.giftWrapCredits,
    promotional_rebates: record.promotionalRebates,
    total_sales_tax_liable: record.totalSalesTaxLiable,
    tcs_cgst: record.tcsCgst,
    tcs_sgst: record.tcsSgst,
    tcs_igst: record.tcsIgst,
    tds_194o: record.tds194o,
    selling_fees: record.sellingFees,
    fba_fees: record.fbaFees,
    other_transaction_fees: record.otherTransactionFees,
    other_amount: record.otherAmount,
    total_amount: record.totalAmount,
    transaction_status: record.transactionStatus,
    transaction_release_date: record.transactionReleaseDate,
    source: 'transaction_report_upload',
    source_file_name: fileName,
    source_row_number: record.sourceRowNumber,
  }
}

type RequestBody = { fileName?: unknown }

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const body = await request.json().catch(() => ({})) as RequestBody
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  if (!fileName || !SAFE_FILE_NAME.test(fileName)) {
    return NextResponse.json({ error: 'A valid .csv file name is required.' }, { status: 400 })
  }

  const filePath = resolve(/* turbopackIgnore: true */ transactionsDir, fileName)
  if (!filePath.startsWith(transactionsDir)) {
    return NextResponse.json({ error: 'File name is not allowed.' }, { status: 400 })
  }

  let result
  try {
    const raw = readFileSync(filePath, 'utf8')
    result = parsePaymentTransactionReport(raw)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transaction report could not be read.' },
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

  const dedupedRows = new Map<string, NormalizedTransactionRow>()
  for (const record of result.accepted) {
    const normalized = toNormalizedRow(record, workspaceId, fileName)
    dedupedRows.set(dedupeKey(normalized), normalized)
  }
  const rows = [...dedupedRows.values()]

  const admin = createAdminClient()
  const { dateRangeStart, dateRangeEnd } = result.stats
  let existingQuery = admin
    .from(TABLE)
    .select('id, settlement_id, order_id, sku, transaction_type, transaction_date, total_amount')
    .eq('workspace_id', workspaceId)
  if (dateRangeStart) existingQuery = existingQuery.gte('transaction_date', dateRangeStart)
  if (dateRangeEnd) existingQuery = existingQuery.lte('transaction_date', dateRangeEnd)

  const { data: existingRows, error: existingError } = await existingQuery
  if (existingError) {
    return NextResponse.json(
      { error: 'Existing transactions could not be read. Confirm migration 033 is applied.' },
      { status: 503 },
    )
  }

  const existingIdByKey = new Map<string, string>()
  for (const row of existingRows ?? []) {
    existingIdByKey.set(
      dedupeKey({
        settlement_id: row.settlement_id as string | null,
        order_id: row.order_id as string | null,
        sku: row.sku as string | null,
        transaction_type: row.transaction_type as string,
        transaction_date: row.transaction_date as string,
        total_amount: Number(row.total_amount),
      }),
      row.id as string,
    )
  }

  const insertRows: NormalizedTransactionRow[] = []
  const updateRows: (NormalizedTransactionRow & { id: string })[] = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(dedupeKey(row))
    if (existingId) {
      updateRows.push({ ...row, id: existingId })
    } else {
      insertRows.push(row)
    }
  }

  let insertedCount = 0
  let duplicateSkippedCount = 0
  try {
    const insertResult = await insertRowsResilient(admin, insertRows)
    insertedCount = insertResult.insertedCount
    duplicateSkippedCount = insertResult.duplicateSkippedCount
  } catch {
    return NextResponse.json(
      { error: 'New transactions could not be saved. Confirm migration 033 is applied.' },
      { status: 503 },
    )
  }

  for (let index = 0; index < updateRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = updateRows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).upsert(chunk, { onConflict: 'id' })
    if (error) {
      return NextResponse.json(
        { error: 'Existing transactions could not be updated. Confirm migration 033 is applied.' },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({
    written: true,
    ...result.stats,
    insertedCount,
    updatedCount: updateRows.length,
    duplicateSkippedCount,
  })
}
