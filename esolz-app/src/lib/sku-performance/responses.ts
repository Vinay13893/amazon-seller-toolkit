/**
 * SKU Performance P1-B — shared response shaping.
 *
 * Mirrors `esolz-app/src/lib/pincode-monitoring/responses.ts`'s convention
 * (this codebase has no cross-cutting response helper — each feature keeps
 * its own, deliberately, so one feature's RPC-result shape changes never
 * ripple into another's routes).
 */
import { NextResponse } from 'next/server'

export function jsonError(status: number, errorCode: string, error: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ error, errorCode, ...details }, { status })
}

export function jsonOk(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status })
}

/** Converts an unexpected thrown error into a generic response; the raw error is logged server-side only. */
export function internalError(context: string, error: unknown) {
  console.error(`[sku-performance] ${context}:`, error)
  return jsonError(500, 'internal_error', 'Something went wrong — try again.')
}

/**
 * Both RPCs return `{ result: 'invalid_parameters', reason: string, ... }`
 * on a validation failure — this maps that shared shape to a 400 once,
 * rather than duplicating the mapping in both routes.
 */
export function mapInvalidParameters(rpcResult: { reason?: string }) {
  return jsonError(400, 'invalid_parameters', 'One or more request parameters were invalid.', {
    reason: rpcResult.reason,
  })
}
