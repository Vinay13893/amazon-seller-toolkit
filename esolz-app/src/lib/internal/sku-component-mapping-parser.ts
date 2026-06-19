import ExcelJS from 'exceljs'

const SHEET_NAME = 'Sheet1'
const REQUIRED_COLUMNS = [
  'EasyEcom WMS Parent SKU',
  'Amazon SKU',
  'Type of SKU',
  'Main Replenish Sku',
  'Replenish SKU 2',
  'Replenish SKU 3',
] as const
export const COMPONENT_COLUMNS = [
  'Main Replenish Sku',
  'Replenish SKU 2',
  'Replenish SKU 3',
] as const
const TERMINAL_QUANTITY = /&(\d+)$/

type RequiredColumn = typeof REQUIRED_COLUMNS[number]
type MappingType = 'single' | 'combo'

export type SkuComponentMappingRecord = {
  workbookRow: number
  amazonSku: string
  wmsParentSku: string
  componentSku: string
  componentQuantity: number
  mappingType: MappingType
  componentPosition: 1 | 2 | 3
}

export type SkuComponentMappingRejection = {
  workbookRow: number
  componentPosition: 1 | 2 | 3 | null
  reason:
    | 'missing_required_field'
    | 'invalid_mapping_type'
    | 'missing_component'
    | 'malformed_quantity'
}

export type SkuComponentMappingStats = {
  workbookRowCount: number
  acceptedComponentMappingCount: number
  rejectedComponentCount: number
  missingRequiredFieldCount: number
  malformedQuantityCount: number
  singleMappingCount: number
  comboMappingCount: number
  comboMultiComponentCount: number
  distinctAmazonSkuCount: number
  distinctWmsParentSkuCount: number
  distinctComponentSkuCount: number
  parentSkusMappedToMultipleAmazonSkusCount: number
  componentSkusSupportingMultipleAmazonSkusCount: number
}

export type SkuComponentMappingParseResult = {
  accepted: SkuComponentMappingRecord[]
  rejected: SkuComponentMappingRejection[]
  stats: SkuComponentMappingStats
}

export type WorkbookInput = string | Buffer | Uint8Array

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim()
    if ('result' in value && value.result !== undefined) return String(value.result).trim()
  }
  return String(value).trim()
}

export function normalizedKey(value: string): string {
  return value.toLocaleUpperCase('en-US')
}

function parseMappingType(value: string): MappingType | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'single') return 'single'
  if (normalized === 'combo') return 'combo'
  return null
}

function parseComponent(
  value: string,
  mappingType: MappingType,
): { componentSku: string; componentQuantity: number } | null {
  const trimmed = value.trim()
  const quantityMatch = trimmed.match(TERMINAL_QUANTITY)

  if (quantityMatch) {
    const componentQuantity = Number(quantityMatch[1])
    const componentSku = trimmed.slice(0, quantityMatch.index).trim()
    if (!componentSku || !Number.isSafeInteger(componentQuantity) || componentQuantity <= 0) {
      return null
    }
    return { componentSku, componentQuantity }
  }

  if (mappingType === 'combo') return null
  return trimmed ? { componentSku: trimmed, componentQuantity: 1 } : null
}

async function loadWorkbook(input: WorkbookInput): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  if (typeof input === 'string') {
    await workbook.xlsx.readFile(input)
  } else {
    const bytes = Buffer.from(input)
    await workbook.xlsx.load(
      bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0],
    )
  }
  return workbook
}

export async function parseSkuComponentMappingWorkbook(
  input: WorkbookInput,
): Promise<SkuComponentMappingParseResult> {
  const workbook = await loadWorkbook(input)
  const sheet = workbook.getWorksheet(SHEET_NAME)
  if (!sheet) throw new Error(`Required worksheet "${SHEET_NAME}" was not found.`)

  const headerIndexes = new Map<RequiredColumn, number>()
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const header = cellText(cell.value)
    const required = REQUIRED_COLUMNS.find(column => column === header)
    if (required) headerIndexes.set(required, columnNumber)
  })

  const missingColumns = REQUIRED_COLUMNS.filter(column => !headerIndexes.has(column))
  if (missingColumns.length > 0) {
    throw new Error(`Workbook is missing ${missingColumns.length} required column(s).`)
  }

  const accepted: SkuComponentMappingRecord[] = []
  const rejected: SkuComponentMappingRejection[] = []
  let workbookRowCount = 0
  let missingRequiredFieldCount = 0
  let malformedQuantityCount = 0
  let singleMappingCount = 0
  let comboMappingCount = 0
  let comboMultiComponentCount = 0

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const values = Object.fromEntries(
      REQUIRED_COLUMNS.map(column => [
        column,
        cellText(row.getCell(headerIndexes.get(column)!).value),
      ]),
    ) as Record<RequiredColumn, string>

    if (REQUIRED_COLUMNS.every(column => !values[column])) continue
    workbookRowCount += 1

    const amazonSku = values['Amazon SKU']
    const wmsParentSku = values['EasyEcom WMS Parent SKU']
    const mappingType = parseMappingType(values['Type of SKU'])
    const componentValues = COMPONENT_COLUMNS.map(column => values[column])
    const populatedComponents = componentValues.filter(Boolean)

    if (!amazonSku || !wmsParentSku) {
      missingRequiredFieldCount += 1
      rejected.push({
        workbookRow: rowNumber,
        componentPosition: null,
        reason: 'missing_required_field',
      })
      continue
    }

    if (!mappingType) {
      rejected.push({
        workbookRow: rowNumber,
        componentPosition: null,
        reason: 'invalid_mapping_type',
      })
      continue
    }

    if (mappingType === 'single') singleMappingCount += 1
    if (mappingType === 'combo') {
      comboMappingCount += 1
      if (populatedComponents.length > 1) comboMultiComponentCount += 1
    }

    if (populatedComponents.length === 0) {
      missingRequiredFieldCount += 1
      rejected.push({
        workbookRow: rowNumber,
        componentPosition: null,
        reason: 'missing_component',
      })
      continue
    }

    componentValues.forEach((componentValue, componentIndex) => {
      if (!componentValue) return
      const componentPosition = (componentIndex + 1) as 1 | 2 | 3
      const parsed = parseComponent(componentValue, mappingType)
      if (!parsed) {
        malformedQuantityCount += 1
        rejected.push({
          workbookRow: rowNumber,
          componentPosition,
          reason: 'malformed_quantity',
        })
        return
      }

      accepted.push({
        workbookRow: rowNumber,
        amazonSku,
        wmsParentSku,
        componentSku: parsed.componentSku,
        componentQuantity: parsed.componentQuantity,
        mappingType,
        componentPosition,
      })
    })
  }

  const amazonSkus = new Set<string>()
  const parentSkus = new Set<string>()
  const componentSkus = new Set<string>()
  const amazonSkusByParent = new Map<string, Set<string>>()
  const amazonSkusByComponent = new Map<string, Set<string>>()

  for (const record of accepted) {
    const amazonSku = normalizedKey(record.amazonSku)
    const parentSku = normalizedKey(record.wmsParentSku)
    const componentSku = normalizedKey(record.componentSku)
    amazonSkus.add(amazonSku)
    parentSkus.add(parentSku)
    componentSkus.add(componentSku)

    const parentAmazonSkus = amazonSkusByParent.get(parentSku) ?? new Set<string>()
    parentAmazonSkus.add(amazonSku)
    amazonSkusByParent.set(parentSku, parentAmazonSkus)

    const componentAmazonSkus = amazonSkusByComponent.get(componentSku) ?? new Set<string>()
    componentAmazonSkus.add(amazonSku)
    amazonSkusByComponent.set(componentSku, componentAmazonSkus)
  }

  return {
    accepted,
    rejected,
    stats: {
      workbookRowCount,
      acceptedComponentMappingCount: accepted.length,
      rejectedComponentCount: rejected.length,
      missingRequiredFieldCount,
      malformedQuantityCount,
      singleMappingCount,
      comboMappingCount,
      comboMultiComponentCount,
      distinctAmazonSkuCount: amazonSkus.size,
      distinctWmsParentSkuCount: parentSkus.size,
      distinctComponentSkuCount: componentSkus.size,
      parentSkusMappedToMultipleAmazonSkusCount: [...amazonSkusByParent.values()]
        .filter(skus => skus.size > 1).length,
      componentSkusSupportingMultipleAmazonSkusCount: [...amazonSkusByComponent.values()]
        .filter(skus => skus.size > 1).length,
    },
  }
}
