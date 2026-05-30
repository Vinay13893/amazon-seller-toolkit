const RUNTIME_FAILURE_PATTERNS = [
  /spawn\s+python/i,
  /enoent/i,
  /stack/i,
  /child_process/i,
  /traceback/i,
  /internal\s+server/i,
  /scrape_bsr\.py/i,
  /check_buybox\.py/i,
  /check_pincode\.py/i,
  /rank_check_adapter\.py/i,
  /python3?\s+not found/i,
  /playwright/i,
  /checker worker/i,
  /CHECKER_WORKER_URL/i,
  /checker_unavailable/i,
]

export const SAFE_CHECKER_UNAVAILABLE_MESSAGE = 'Live checker could not complete this check. This does not mean the product has an issue.'

/** @deprecated use SAFE_CHECKER_UNAVAILABLE_MESSAGE */
export const SAFE_KEYWORD_RUNTIME_MESSAGE = SAFE_CHECKER_UNAVAILABLE_MESSAGE

export function sanitizeCheckerError(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null
  if (RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    return SAFE_CHECKER_UNAVAILABLE_MESSAGE
  }
  return errorMessage
}

/** Returns true if the error_message or status indicates a system/infra failure
 *  rather than a real product issue. */
export function isCheckerUnavailableStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return status === 'checker_unavailable' || status === 'failed'
}
