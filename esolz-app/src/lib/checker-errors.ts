const KEYWORD_RUNTIME_FAILURE_PATTERNS = [
  /spawn\s+python/i,
  /enoent/i,
  /stack/i,
  /child_process/i,
  /traceback/i,
  /internal\s+server/i,
]

const SAFE_KEYWORD_RUNTIME_MESSAGE = 'Keyword rank checker was unavailable for this check.'

export function sanitizeCheckerError(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null
  if (KEYWORD_RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    return SAFE_KEYWORD_RUNTIME_MESSAGE
  }
  return errorMessage
}
