export const TODAY_SHIPMENT_METRIC_LABEL = 'Shipment alerts'

export type SourceStatusTone = 'success' | 'warning' | 'danger' | 'neutral'

const SUCCESS_STATUSES = new Set([
  'active',
  'closed',
  'complete',
  'completed',
  'done',
  'healthy',
  'ok',
  'success',
  'successful',
])

export function getSourceStatusTone(value: string): SourceStatusTone {
  const normalized = value.trim().toLocaleLowerCase()
  if (normalized.includes('error') || normalized.includes('failed')) return 'danger'
  if (normalized.includes('warning') || normalized.includes('blocked')) return 'warning'
  if (SUCCESS_STATUSES.has(normalized)) return 'success'
  return 'neutral'
}
