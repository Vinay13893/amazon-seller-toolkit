export const EASYHOME_STOCK_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'

type StockIntelligenceAccessEvidence = {
  authenticated: boolean
  internalAuthorized: boolean
  membershipWorkspaceId: string | null
  lookupFailed: boolean
}

export function canAccessStockIntelligence(evidence: StockIntelligenceAccessEvidence): boolean {
  return evidence.authenticated
    && evidence.internalAuthorized
    && !evidence.lookupFailed
    && evidence.membershipWorkspaceId === EASYHOME_STOCK_WORKSPACE_ID
}
