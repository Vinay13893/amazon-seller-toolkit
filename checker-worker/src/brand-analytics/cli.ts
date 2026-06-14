import dotenv from 'dotenv'
import { runBrandAnalyticsSync } from './sync'

dotenv.config()

function parseArgs(argv: string[]): { jobId: string; batchSize?: number } {
  const args = new Map<string, string>()

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i]
    if (!current.startsWith('--')) continue
    const key = current.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) {
      args.set(key, value)
      i++
    } else {
      args.set(key, 'true')
    }
  }

  const jobId = args.get('jobId')?.trim()
  if (!jobId) {
    throw new Error('Missing required --jobId argument')
  }

  const batchSizeRaw = args.get('batchSize')
  const batchSize = batchSizeRaw ? Number.parseInt(batchSizeRaw, 10) : undefined

  return { jobId, batchSize }
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2))
  const result = await runBrandAnalyticsSync(input)

  const statusCode = result.status === 'success' ? 0 : 1
  const output = {
    jobId: result.jobId,
    reportType: result.reportType,
    reportDocumentId: result.reportDocumentId,
    totalParsedRows: result.totalParsedRows,
    totalStoredRows: result.totalStoredRows,
    batchSize: result.batchSize,
    fieldNames: result.fieldNames,
    targetTable: result.targetTable,
    status: result.status,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  }

  console.log(JSON.stringify(output, null, 2))
  process.exit(statusCode)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'CLI failed'
  console.error(message)
  process.exit(1)
})
