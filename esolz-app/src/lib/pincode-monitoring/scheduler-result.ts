export function mapWorkerResult(httpStatus: number, result: { status?: unknown; ok?: unknown; available?: unknown; delivery_promise?: unknown }) {
  if (httpStatus === 429 || result.status === 'blocked') {
    return { p_check_status: 'blocked', p_availability_status: null, p_delivery_message: null,
      p_error_code: 'amazon_blocked', p_error_message: 'Amazon could not confirm this check. Automatic retry in 48 hours.' }
  }
  if (httpStatus === 200 && result.status === 'success' && result.ok === true && typeof result.available === 'boolean') {
    return { p_check_status: 'success', p_availability_status: result.available ? 'available' : 'unavailable',
      p_delivery_message: typeof result.delivery_promise === 'string' ? result.delivery_promise.slice(0, 2000) : null,
      p_error_code: null, p_error_message: null }
  }
  return { p_check_status: 'failed', p_availability_status: null, p_delivery_message: null,
    p_error_code: 'check_not_confirmed', p_error_message: 'Availability could not be confirmed. Previous confirmed results remain in History.' }
}
