import { readFileSync } from 'node:fs'
import { parsePaymentTransactionReport } from '../src/lib/internal/payment-transaction-parser'

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('Usage: tsx scripts/preview-payment-transactions.ts <path-to-transaction-report.csv>')
  process.exit(1)
}

function main() {
  const raw = readFileSync(csvPath, 'utf8')
  const result = parsePaymentTransactionReport(raw)

  // Aggregate-only preview. Never print accepted/rejected records because they
  // contain order IDs, SKUs, and geography.
  console.log(JSON.stringify(result.stats, null, 2))
}

main()
