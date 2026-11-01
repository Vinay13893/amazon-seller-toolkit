export type BuyBoxDisplayInput = {
  buy_box_detected: boolean | null
  page_status: string | null
}

export type BuyBoxDisplayState = 'detected' | 'not_detected' | 'blocked' | 'unknown'

export function getBuyBoxDisplayState(result: BuyBoxDisplayInput): BuyBoxDisplayState {
  if (result.buy_box_detected === true) return 'detected'
  if (result.buy_box_detected === false && result.page_status === 'product') return 'not_detected'
  if (result.page_status === 'blocked') return 'blocked'
  return 'unknown'
}

export function getBuyBoxDisplayLabel(result: BuyBoxDisplayInput): string {
  const state = getBuyBoxDisplayState(result)
  if (state === 'detected') return 'Detected'
  if (state === 'not_detected') return 'Not detected'
  if (state === 'blocked') return 'Blocked'
  return 'Unknown'
}

export function getBuyBoxCsvValue(result: BuyBoxDisplayInput): string {
  const state = getBuyBoxDisplayState(result)
  if (state === 'detected') return 'Yes'
  if (state === 'not_detected') return 'No'
  if (state === 'blocked') return 'Blocked'
  return 'Unknown'
}

export function getMissingSignalLabel(pageStatus: string | null): string {
  if (pageStatus === 'product') return 'Not detected'
  if (pageStatus === 'blocked') return 'Blocked'
  return 'Unknown'
}

export function getBuyBoxReason(errorCode: string | null, pageStatus: string | null): string {
  if (errorCode) return errorCode
  if (pageStatus === 'blocked') return 'blocked_or_captcha'
  if (pageStatus !== 'product') return 'unknown_page_state'
  return 'No issue reported'
}
