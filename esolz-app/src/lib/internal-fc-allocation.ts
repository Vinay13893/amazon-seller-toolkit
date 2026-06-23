import type {
  ComponentMappingRow,
  FcReplenishmentRow,
  InventoryByLocationRow,
} from './internal-replenishment-report'

// This module adds a "complete fulfilment" view on top of the existing FC
// Replenishment numbers: how much of the FC send plan current XHZU/component
// stock can actually support, and where to allocate first when stock is short.
// It does not change buildFcReplenishmentRows or buildFlexReplenishmentRows.

export type AmazonRecommendationStatus = 'not_connected' | 'not_available' | 'pending_fetch' | 'available'

export type AmazonRecommendationRow = {
  amazonSkuNorm: string
  recommendedQty: number | null
  recommendedShipDate: string | null
  benefitEligibleQty: number | null
  benefitType: string | null
  benefitExpiry: string | null
}

export type FcComponentFulfillmentRow = {
  componentSku: string
  currentXhzuComponentStock: number
  fcComponentRequirement: number
  componentShortage: number
  componentSurplus: number
  coveragePercent: number
  linkedAmazonSkuCount: number
  fastestSellingAmazonSku: string | null
  allocatableFinishedUnitsNow: number
  shortFinishedUnits: number
  amazonRecommendationStatus: AmazonRecommendationStatus
  action: 'fully_covered' | 'partially_covered' | 'no_requirement'
  reason: string
}

export type FcAllocationCsvRow = {
  componentSku: string
  amazonSku: string
  fcCode: string
  skuDemand30d: number
  fcDemand30d: number
  requiredSendUnits: number
  componentQtyPerUnit: number
  componentUnitsRequired: number
  currentXhzuComponentStock: number
  allocatedSendUnitsNow: number
  unfulfilledSendUnits: number
  amazonRecommendedQty: number | null
  amazonRecommendationStatus: AmazonRecommendationStatus
  allocationPriority: number
  reason: string
}

export type FcFulfillmentSummary = {
  fcUnitsRequested: number
  fcUnitsAllocatableNow: number
  finishedUnitsShort: number
  componentUnitsShort: number
  componentsConstrained: number
  amazonRecommendationsSynced: number
  amazonRecommendationsNotSynced: number
}

function norm(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

/**
 * Shared allocator for both the component->SKU split and the SKU->FC split:
 * give every eligible item a 1-unit floor first (so no active SKU/FC drops to
 * zero just because stock is tight), then hand out what is left weighted by
 * demand (velocity), capped per item by its own requirement.
 */
function allocateWithFloor(
  items: Array<{ key: string; demand: number; cap: number }>,
  available: number,
): Map<string, number> {
  const allocated = new Map<string, number>()
  let remaining = Math.max(0, Math.floor(available))
  const eligible = items.filter(item => item.cap > 0)

  for (const item of eligible) {
    if (remaining <= 0) break
    const floor = Math.min(1, item.cap)
    allocated.set(item.key, floor)
    remaining -= floor
  }

  const totalDemand = eligible.reduce((sum, item) => sum + Math.max(0, item.demand), 0)
  if (remaining > 0 && totalDemand > 0) {
    for (const item of eligible) {
      if (remaining <= 0) break
      const already = allocated.get(item.key) ?? 0
      const share = Math.floor((Math.max(0, item.demand) / totalDemand) * remaining)
      const grant = Math.min(share, item.cap - already)
      if (grant > 0) {
        allocated.set(item.key, already + grant)
        remaining -= grant
      }
    }
  }

  if (remaining > 0) {
    for (const item of eligible) {
      if (remaining <= 0) break
      const already = allocated.get(item.key) ?? 0
      const grant = Math.min(remaining, item.cap - already)
      if (grant > 0) {
        allocated.set(item.key, already + grant)
        remaining -= grant
      }
    }
  }

  return allocated
}

function recommendationStatusFor(
  amazonSkuNorm: string,
  recommendations: Map<string, AmazonRecommendationRow>,
  amazonConnected: boolean,
): AmazonRecommendationStatus {
  if (recommendations.has(amazonSkuNorm)) return 'available'
  return amazonConnected ? 'pending_fetch' : 'not_connected'
}

export function buildFcComponentFulfillment(input: {
  fcReplenishmentRows: FcReplenishmentRow[]
  componentMappings: ComponentMappingRow[]
  inventoryByLocation: InventoryByLocationRow[]
  sellerFlexLocationCodes: Set<string>
  amazonRecommendations: Map<string, AmazonRecommendationRow>
  amazonConnected: boolean
}): {
  componentRows: FcComponentFulfillmentRow[]
  csvRows: FcAllocationCsvRow[]
  summary: FcFulfillmentSummary
} {
  // FC send requirement per Amazon SKU, aggregated across all its FCs.
  const fcRowsBySkuNorm = new Map<string, FcReplenishmentRow[]>()
  for (const row of input.fcReplenishmentRows) {
    const skuNorm = norm(row.amazonSku)
    if (!skuNorm) continue
    const list = fcRowsBySkuNorm.get(skuNorm) ?? []
    list.push(row)
    fcRowsBySkuNorm.set(skuNorm, list)
  }
  const requiredSendUnitsBySkuNorm = new Map<string, number>()
  const demand30dBySkuNorm = new Map<string, number>()
  for (const [skuNorm, rows] of fcRowsBySkuNorm) {
    requiredSendUnitsBySkuNorm.set(skuNorm, rows.reduce((sum, row) => sum + row.suggestedSendQty, 0))
    demand30dBySkuNorm.set(skuNorm, rows.reduce((sum, row) => sum + row.demand30d, 0))
  }

  // XHZU/component stock, same convention as Flex: usable stock at Seller Flex
  // (XHZU-family) location codes only.
  const xhzuStockByComponent = new Map<string, number>()
  for (const row of input.inventoryByLocation) {
    if (!row.locationCode || !input.sellerFlexLocationCodes.has(norm(row.locationCode))) continue
    const skuNorm = norm(row.sku)
    if (!skuNorm) continue
    const usable = Math.max(0, Math.trunc(row.available - row.reserved - row.unsellable))
    xhzuStockByComponent.set(skuNorm, (xhzuStockByComponent.get(skuNorm) ?? 0) + usable)
  }

  const mappingsByComponent = new Map<string, ComponentMappingRow[]>()
  const componentsByAmazonSku = new Map<string, ComponentMappingRow[]>()
  for (const mapping of input.componentMappings) {
    const componentList = mappingsByComponent.get(mapping.componentSkuNorm) ?? []
    componentList.push(mapping)
    mappingsByComponent.set(mapping.componentSkuNorm, componentList)

    const skuList = componentsByAmazonSku.get(mapping.amazonSkuNorm) ?? []
    skuList.push(mapping)
    componentsByAmazonSku.set(mapping.amazonSkuNorm, skuList)
  }

  // Pass 1: per component, allocate that component's XHZU stock across the
  // Amazon SKUs it feeds (floor-then-velocity), using only this component's
  // own stock as the constraint.
  const componentRows: FcComponentFulfillmentRow[] = []
  const allocatedComponentUnitsBySkuByComponent = new Map<string, Map<string, number>>()

  for (const [componentSkuNorm, mappings] of mappingsByComponent) {
    const componentSku = mappings[0].componentSku
    const linkedSkuNorms = new Set(mappings.map(mapping => mapping.amazonSkuNorm))
    const currentXhzuComponentStock = xhzuStockByComponent.get(componentSkuNorm) ?? 0

    let fcComponentRequirement = 0
    const skuAllocationItems: Array<{ key: string; demand: number; cap: number }> = []
    for (const mapping of mappings) {
      const requiredSendUnits = requiredSendUnitsBySkuNorm.get(mapping.amazonSkuNorm) ?? 0
      const componentUnitsForSku = requiredSendUnits * mapping.componentQuantity
      fcComponentRequirement += componentUnitsForSku
      skuAllocationItems.push({
        key: mapping.amazonSkuNorm,
        demand: demand30dBySkuNorm.get(mapping.amazonSkuNorm) ?? 0,
        cap: componentUnitsForSku,
      })
    }

    const allocatedBySku = allocateWithFloor(skuAllocationItems, currentXhzuComponentStock)
    allocatedComponentUnitsBySkuByComponent.set(componentSkuNorm, allocatedBySku)

    const componentShortage = Math.max(0, fcComponentRequirement - currentXhzuComponentStock)
    const componentSurplus = Math.max(0, currentXhzuComponentStock - fcComponentRequirement)
    const coveragePercent = fcComponentRequirement > 0
      ? Math.min(100, Math.round((currentXhzuComponentStock / fcComponentRequirement) * 1000) / 10)
      : 100

    let allocatableFinishedUnitsNow = 0
    let shortFinishedUnits = 0
    let fastestSellingAmazonSku: string | null = null
    let fastestVelocity = -1
    for (const mapping of mappings) {
      const requiredSendUnits = requiredSendUnitsBySkuNorm.get(mapping.amazonSkuNorm) ?? 0
      const allocatedComponentUnits = allocatedBySku.get(mapping.amazonSkuNorm) ?? 0
      const allocatableViaThisComponent = mapping.componentQuantity > 0
        ? Math.floor(allocatedComponentUnits / mapping.componentQuantity)
        : 0
      allocatableFinishedUnitsNow += allocatableViaThisComponent
      shortFinishedUnits += Math.max(0, requiredSendUnits - allocatableViaThisComponent)

      const velocity = demand30dBySkuNorm.get(mapping.amazonSkuNorm) ?? 0
      if (velocity > fastestVelocity) {
        fastestVelocity = velocity
        fastestSellingAmazonSku = mapping.amazonSku
      }
    }

    const amazonRecommendationStatus = linkedSkuNorms.size === 1
      ? recommendationStatusFor([...linkedSkuNorms][0], input.amazonRecommendations, input.amazonConnected)
      : [...linkedSkuNorms].some(skuNorm => input.amazonRecommendations.has(skuNorm))
        ? 'available'
        : input.amazonConnected ? 'pending_fetch' : 'not_connected'

    const action: FcComponentFulfillmentRow['action'] = fcComponentRequirement <= 0
      ? 'no_requirement'
      : componentShortage > 0
        ? 'partially_covered'
        : 'fully_covered'

    const reason = action === 'no_requirement'
      ? 'No FC send requirement for SKUs linked to this component.'
      : action === 'fully_covered'
        ? 'Current XHZU stock fully covers the FC send plan for this component.'
        : `XHZU stock covers ${coveragePercent}% of the FC component requirement; allocate by velocity until restocked.`

    componentRows.push({
      componentSku,
      currentXhzuComponentStock,
      fcComponentRequirement,
      componentShortage,
      componentSurplus,
      coveragePercent,
      linkedAmazonSkuCount: linkedSkuNorms.size,
      fastestSellingAmazonSku,
      allocatableFinishedUnitsNow,
      shortFinishedUnits,
      amazonRecommendationStatus,
      action,
      reason,
    })
  }

  componentRows.sort((a, b) => b.componentShortage - a.componentShortage)

  // Pass 2: final per-SKU allocatable finished units, bottlenecked by the
  // worst-covered linked component (a combo SKU is only as good as its
  // scarcest part), then split across that SKU's FCs by velocity.
  const csvRows: FcAllocationCsvRow[] = []
  let fcUnitsRequested = 0
  let fcUnitsAllocatableNow = 0
  let finishedUnitsShort = 0
  let allocationPriorityCounter = 0

  const skuRowsSortedByDemand = [...fcRowsBySkuNorm.entries()].sort((a, b) => {
    const demandA = demand30dBySkuNorm.get(a[0]) ?? 0
    const demandB = demand30dBySkuNorm.get(b[0]) ?? 0
    return demandB - demandA
  })

  for (const [skuNorm, fcRows] of skuRowsSortedByDemand) {
    const mappings = componentsByAmazonSku.get(skuNorm) ?? []
    const requiredSendUnits = requiredSendUnitsBySkuNorm.get(skuNorm) ?? 0
    fcUnitsRequested += requiredSendUnits

    let finalAllocatableFinishedUnits = requiredSendUnits
    if (mappings.length > 0) {
      for (const mapping of mappings) {
        const allocatedComponentUnits = allocatedComponentUnitsBySkuByComponent
          .get(mapping.componentSkuNorm)?.get(skuNorm) ?? 0
        const allocatableViaThisComponent = mapping.componentQuantity > 0
          ? Math.floor(allocatedComponentUnits / mapping.componentQuantity)
          : 0
        finalAllocatableFinishedUnits = Math.min(finalAllocatableFinishedUnits, allocatableViaThisComponent)
      }
    }
    finalAllocatableFinishedUnits = Math.max(0, Math.min(finalAllocatableFinishedUnits, requiredSendUnits))
    fcUnitsAllocatableNow += finalAllocatableFinishedUnits
    finishedUnitsShort += Math.max(0, requiredSendUnits - finalAllocatableFinishedUnits)

    const fcAllocationItems = fcRows.map(row => ({
      key: row.fcCode,
      demand: row.demand30d,
      cap: row.suggestedSendQty,
    }))
    const allocatedByFc = allocateWithFloor(fcAllocationItems, finalAllocatableFinishedUnits)

    const recommendation = input.amazonRecommendations.get(skuNorm) ?? null
    const recommendationStatus = recommendationStatusFor(skuNorm, input.amazonRecommendations, input.amazonConnected)
    const skuDemand30d = demand30dBySkuNorm.get(skuNorm) ?? 0
    allocationPriorityCounter += 1
    const priority = allocationPriorityCounter

    const mappingsForCsv = mappings.length > 0 ? mappings : [null]
    for (const mapping of mappingsForCsv) {
      for (const fcRow of fcRows) {
        const allocatedSendUnitsNow = Math.min(allocatedByFc.get(fcRow.fcCode) ?? 0, fcRow.suggestedSendQty)
        const unfulfilledSendUnits = Math.max(0, fcRow.suggestedSendQty - allocatedSendUnitsNow)
        csvRows.push({
          componentSku: mapping?.componentSku ?? 'Not mapped',
          amazonSku: fcRow.amazonSku ?? '',
          fcCode: fcRow.fcCode,
          skuDemand30d,
          fcDemand30d: fcRow.demand30d,
          requiredSendUnits: fcRow.suggestedSendQty,
          componentQtyPerUnit: mapping?.componentQuantity ?? 0,
          componentUnitsRequired: (mapping?.componentQuantity ?? 0) * fcRow.suggestedSendQty,
          currentXhzuComponentStock: mapping
            ? (xhzuStockByComponent.get(mapping.componentSkuNorm) ?? 0)
            : 0,
          allocatedSendUnitsNow,
          unfulfilledSendUnits,
          amazonRecommendedQty: recommendation?.recommendedQty ?? null,
          amazonRecommendationStatus: recommendationStatus,
          allocationPriority: priority,
          reason: unfulfilledSendUnits > 0
            ? 'Component-constrained: allocated by velocity, remainder short until XHZU restock.'
            : 'Fully allocated from current XHZU/component stock.',
        })
      }
    }
  }

  const componentsConstrained = componentRows.filter(row => row.componentShortage > 0).length
  const componentUnitsShort = componentRows.reduce((sum, row) => sum + row.componentShortage, 0)
  const amazonRecommendationsSynced = [...new Set(csvRows.filter(row => row.amazonRecommendationStatus === 'available').map(row => row.amazonSku))].length
  const amazonRecommendationsNotSynced = [...new Set(csvRows.filter(row => row.amazonRecommendationStatus !== 'available').map(row => row.amazonSku))].length

  const summary: FcFulfillmentSummary = {
    fcUnitsRequested,
    fcUnitsAllocatableNow,
    finishedUnitsShort,
    componentUnitsShort,
    componentsConstrained,
    amazonRecommendationsSynced,
    amazonRecommendationsNotSynced,
  }

  return { componentRows, csvRows, summary }
}
