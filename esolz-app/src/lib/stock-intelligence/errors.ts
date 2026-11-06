export type StockSheetsStage =
  | 'configuration'
  | 'jwt_signing'
  | 'google_token_exchange'
  | 'google_spreadsheet_metadata'
  | 'google_worksheet_values'
  | 'response_processing'

export type StockSheetsErrorCode =
  | 'configuration_required'
  | 'authentication_failed'
  | 'permission_denied'
  | 'not_found'
  | 'upstream_error'
  | 'internal_error'

export class StockSheetsError extends Error {
  constructor(
    readonly code: StockSheetsErrorCode,
    readonly safeMessage: string,
    readonly status: number,
    readonly stage: StockSheetsStage = 'response_processing',
    readonly safeCode: string = code,
    readonly upstreamStatus?: number,
  ) {
    super(safeMessage)
  }
}

// Only these platform codes may reach diagnostics. Never serialize an Error,
// its message/cause, a request, configuration, or a Google response body.
const SAFE_CODES = new Set([
  'ERR_OSSL_UNSUPPORTED', 'ERR_OSSL_PEM_NO_START_LINE',
  'ERR_OSSL_ASN1_WRONG_TAG', 'ERR_OSSL_ASN1_TOO_LONG',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
])

export function classifyStockSheetsError(error: unknown, stage: StockSheetsStage): StockSheetsError {
  if (error instanceof StockSheetsError) return error
  const candidate = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null
  const rawCode = candidate?.code ?? candidate?.cause?.code
  const safeCode = typeof rawCode === 'string' && SAFE_CODES.has(rawCode) ? rawCode : 'unexpected_error'
  if (stage === 'jwt_signing') {
    return new StockSheetsError('configuration_required',
      'Google Sheets signing configuration is invalid. Ask an administrator to check it.',
      503, stage, safeCode)
  }
  if (stage.startsWith('google_') && (candidate?.name === 'TypeError' || safeCode !== 'unexpected_error')) {
    return new StockSheetsError('upstream_error', 'Google Sheets could not be reached. Please retry.',
      503, stage, safeCode === 'unexpected_error' ? 'network_failure' : safeCode)
  }
  return new StockSheetsError('internal_error',
    'Stock data could not be processed. Please retry or contact an administrator.',
    500, stage, candidate?.name === 'SyntaxError' ? 'invalid_json' : safeCode)
}

export async function atStockSheetsStage<T>(stage: StockSheetsStage, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw classifyStockSheetsError(error, stage)
  }
}

export function stockSheetsFailure(error: unknown) {
  const failure = classifyStockSheetsError(error, 'response_processing')
  console.error('[stock-intelligence]', JSON.stringify({
    stage: failure.stage,
    category: failure.code,
    code: failure.safeCode,
    httpStatus: failure.upstreamStatus,
  }))
  return {
    status: failure.status,
    body: {
      status: failure.code === 'configuration_required' ? 'configuration_required' as const : 'unavailable' as const,
      code: failure.code,
      message: failure.safeMessage,
    },
  }
}
