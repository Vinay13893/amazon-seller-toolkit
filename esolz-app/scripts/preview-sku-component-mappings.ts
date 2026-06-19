import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkuComponentMappingWorkbook } from '../src/lib/internal/sku-component-mapping-parser'

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
const workbookPath = resolve(
  scriptDirectory,
  '..',
  '..',
  'Map Amazon SKU to warehouse SKU',
  'Amaozn SKU map to warehouse SKU.xlsx',
)

async function main() {
  const result = await parseSkuComponentMappingWorkbook(workbookPath)

  // Aggregate-only preview. Never print accepted/rejected records because they contain SKUs.
  console.log(JSON.stringify(result.stats, null, 2))
}

void main()
