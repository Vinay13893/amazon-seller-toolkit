import { readFileSync } from 'node:fs'
import { parseSkuCostMasterJson } from '../src/lib/internal/sku-cost-master-parser'

const jsonPath = process.argv[2]
if (!jsonPath) {
  console.error('Usage: tsx scripts/preview-sku-cost-master.ts <path-to-cost_prices.json>')
  process.exit(1)
}

function main() {
  const raw = readFileSync(jsonPath, 'utf8')
  const result = parseSkuCostMasterJson(raw)

  // Aggregate-only preview. Never print accepted/rejected records because they contain SKUs.
  console.log(JSON.stringify(result.stats, null, 2))
}

main()
