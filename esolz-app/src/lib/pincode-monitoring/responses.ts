/**
 * Pincode Monitoring P0-B — shared response shaping.
 *
 * This codebase has no cross-cutting error-response helper anywhere
 * (confirmed by the pre-implementation research pass: three different local
 * `safeError()` shapes exist across `keywords/*`, `scraping/pincode-
 * availability/*`, `brand-analytics/search-terms/*`, none shared). This
 * module is this feature's own single convention, used by every Pincode
 * Monitoring route — deliberately centralized here (unlike the rest of the
 * codebase's per-file `safeError`) because eight routes share the exact
 * same four RPCs' result shapes; duplicating the mapping eight times would
 * be a real correctness risk (the "make concurrency/contract claims exact"
 * lesson from the P0-A review rounds applies here too — one mapping, one
 * place it can be wrong, not eight).
 *
 * Every quota-shaped error below reproduces PINCODE_UNIFIED_PAGE_DATA_MODEL.md
 * sec2b/sec2c's LOCKED response shape exactly (errorCode + the same field
 * names) — those two shapes are not this PR's choice, they were fixed by
 * the approved spec. Every other status code (404 for not-found/scope-
 * mismatch, 409 for check-in-progress/invalid-status conflicts, 422 for
 * listing-verification-failed, 429 for cooldown, 202 for genuinely queued)
 * is this PR's own implementation decision where the spec did not pin one
 * down — called out explicitly in the PR description, not silently assumed.
 */
import { NextResponse } from 'next/server'

export function jsonError(status: number, errorCode: string, error: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ error, errorCode, ...details }, { status })
}

export function jsonOk(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status })
}

/**
 * Correction 7 (PR #55 review round): converts an unexpected error (a
 * thrown Postgres/PostgREST error surfaced by a data-access module, a
 * network failure, anything not already a typed RPC-result branch) into a
 * clean, generic customer-facing response — the raw error (which may
 * contain table/column names, constraint names, or other internal detail)
 * is logged server-side via `console.error` for diagnosis, never returned
 * in the HTTP response body. Every P0-B route that calls a non-RPC data-
 * access function (tracker.ts, defaults.ts's read path) wraps the call
 * with this, matching the same "never leak internals" discipline already
 * applied to `PincodeRpcTransportError` at every RPC call site.
 */
export function internalError(context: string, error: unknown) {
  console.error(`[pincode-monitoring] ${context}:`, error)
  return jsonError(500, 'internal_error', 'Something went wrong — try again.')
}

// ── enroll_pincode_monitored_products ───────────────────────────────────────

export type EnrollRpcResult =
  | { result: 'invalid_parameters'; reason: string; asin?: string; pincode?: string }
  | { result: 'listing_verification_failed'; asin: string; reason?: string }
  | { result: 'quota_exceeded'; currentActiveTargets: number; requestedAdditionalTargets: number; limit: number }
  | { result: 'success'; currentActiveTargets: number; requestedAdditionalTargets: number }

export function mapEnrollResult(rpcResult: EnrollRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_parameters':
      return jsonError(400, 'invalid_parameters', 'The enrollment request was invalid.', {
        reason: rpcResult.reason,
        ...(rpcResult.asin ? { asin: rpcResult.asin } : {}),
        ...(rpcResult.pincode ? { pincode: rpcResult.pincode } : {}),
      })
    case 'listing_verification_failed':
      return jsonError(422, 'listing_verification_failed', 'The referenced listing could not be verified against the requested ASIN.', {
        asin: rpcResult.asin,
        ...(rpcResult.reason ? { reason: rpcResult.reason } : {}),
      })
    case 'quota_exceeded':
      return jsonError(409, 'pincode_tracking_quota_exceeded', 'Enrollment would exceed the workspace pincode-tracking quota.', {
        currentActiveTargets: rpcResult.currentActiveTargets,
        requestedAdditionalTargets: rpcResult.requestedAdditionalTargets,
        limit: rpcResult.limit,
      })
    case 'success':
      return jsonOk({
        result: 'success',
        currentActiveTargets: rpcResult.currentActiveTargets,
        requestedAdditionalTargets: rpcResult.requestedAdditionalTargets,
      })
  }
}

// ── set_pincode_tracking_state ──────────────────────────────────────────────

export type SetTrackingStateRpcResult =
  | { result: 'invalid_parameters'; reason: string }
  | { result: 'not_found_or_scope_mismatch'; requestedCount: number; validCount: number }
  | { result: 'invalid_status'; reason: string }
  | { result: 'quota_exceeded'; currentActiveTargets: number; requestedAdditionalTargets: number; limit: number }
  | { result: 'check_in_progress'; targetIds: string[] }
  | { result: 'success'; action: 'pause' | 'resume'; targetCount: number }

export function mapSetTrackingStateResult(rpcResult: SetTrackingStateRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_parameters':
      return jsonError(400, 'invalid_parameters', 'The pause/resume request was invalid.', { reason: rpcResult.reason })
    case 'not_found_or_scope_mismatch':
      return jsonError(404, 'not_found_or_scope_mismatch', 'One or more target IDs do not exist in this workspace/marketplace.', {
        requestedCount: rpcResult.requestedCount,
        validCount: rpcResult.validCount,
      })
    case 'invalid_status':
      return jsonError(409, 'invalid_status', 'This product cannot be resumed in its current state.', { reason: rpcResult.reason })
    case 'quota_exceeded':
      return jsonError(409, 'pincode_tracking_quota_exceeded', 'Resuming would exceed the workspace pincode-tracking quota.', {
        currentActiveTargets: rpcResult.currentActiveTargets,
        requestedAdditionalTargets: rpcResult.requestedAdditionalTargets,
        limit: rpcResult.limit,
      })
    case 'check_in_progress':
      return jsonError(409, 'check_in_progress', 'One or more selected targets are currently being checked — try again in a moment.', {
        targetIds: rpcResult.targetIds,
      })
    case 'success':
      return jsonOk({ result: 'success', action: rpcResult.action, targetCount: rpcResult.targetCount })
  }
}

// ── remove_pincode_monitored_products ───────────────────────────────────────

export type RemoveRpcResult =
  | { result: 'invalid_parameters'; reason: string }
  | { result: 'not_found_or_scope_mismatch'; requestedCount: number; validCount: number }
  | { result: 'success'; productCount: number }

export function mapRemoveResult(rpcResult: RemoveRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_parameters':
      return jsonError(400, 'invalid_parameters', 'The remove request was invalid.', { reason: rpcResult.reason })
    case 'not_found_or_scope_mismatch':
      return jsonError(404, 'not_found_or_scope_mismatch', 'One or more product IDs do not exist in this workspace/marketplace.', {
        requestedCount: rpcResult.requestedCount,
        validCount: rpcResult.validCount,
      })
    case 'success':
      return jsonOk({ result: 'success', productCount: rpcResult.productCount })
  }
}

// ── replace_pincode_product_targets (Correction 2, PR #55 review round) ────

export type ReplaceProductTargetsRpcResult =
  | { result: 'invalid_parameters'; reason: string; pincode?: string }
  | { result: 'not_found_or_scope_mismatch' }
  | { result: 'invalid_status'; reason: string }
  | { result: 'quota_exceeded'; currentActiveTargets: number; requestedAdditionalTargets: number; limit: number }
  | { result: 'success'; addedCount: number; reconfiguredCount: number; unconfiguredCount: number; targetCount: number }

export function mapReplaceProductTargetsResult(rpcResult: ReplaceProductTargetsRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_parameters':
      return jsonError(400, 'invalid_parameters', 'The pincode-list update was invalid.', {
        reason: rpcResult.reason,
        ...(rpcResult.pincode ? { pincode: rpcResult.pincode } : {}),
      })
    case 'not_found_or_scope_mismatch':
      return jsonError(404, 'not_found_or_scope_mismatch', 'This product does not exist in the given workspace/marketplace.')
    case 'invalid_status':
      return jsonError(409, 'invalid_status', 'This product\'s pincode list cannot be edited in its current state.', { reason: rpcResult.reason })
    case 'quota_exceeded':
      return jsonError(409, 'pincode_tracking_quota_exceeded', 'This pincode-list update would exceed the workspace pincode-tracking quota.', {
        currentActiveTargets: rpcResult.currentActiveTargets,
        requestedAdditionalTargets: rpcResult.requestedAdditionalTargets,
        limit: rpcResult.limit,
      })
    case 'success':
      return jsonOk({
        result: 'success',
        addedCount: rpcResult.addedCount,
        reconfiguredCount: rpcResult.reconfiguredCount,
        unconfiguredCount: rpcResult.unconfiguredCount,
        targetCount: rpcResult.targetCount,
      })
  }
}

// ── replace_workspace_default_pincodes (Correction 3, PR #55 review round) ─

export type ReplaceDefaultsRpcResult =
  | { result: 'invalid_parameters'; reason: string; pincode?: string }
  | { result: 'success'; defaults: { id: string; pincode: string; displayOrder: number }[] }

export function mapReplaceDefaultsResult(rpcResult: ReplaceDefaultsRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_parameters':
      return jsonError(400, 'invalid_parameters', 'The default-pincode list was invalid.', {
        reason: rpcResult.reason,
        ...(rpcResult.pincode ? { pincode: rpcResult.pincode } : {}),
      })
    case 'success':
      return jsonOk({ defaults: rpcResult.defaults })
  }
}

// ── queue_pincode_manual_check ──────────────────────────────────────────────

export type QueueManualCheckRpcResult =
  | { result: 'invalid_status'; reason: string }
  | { result: 'checking' }
  | { result: 'already_queued'; manual_request_token: string }
  | { result: 'cooldown'; retry_after_seconds: number }
  | { result: 'quota_exceeded'; currentOutstanding: number; limit: number }
  | { result: 'queued'; manual_request_token: string }

const NOT_FOUND_REASONS = new Set(['not_found_or_wrong_workspace', 'workspace_marketplace_mismatch'])
// `target_unconfigured` (064 migration's `queue_pincode_manual_check` check)
// belongs here, not in the 400 fallback below: the request's parameters are
// valid, the target simply is no longer configured for monitoring -- a 409
// state conflict, the same class of fact as the other conflict reasons.
const CONFLICT_REASONS = new Set(['product_archived_or_removed', 'paused_requires_resume', 'failed_requires_resume', 'target_unconfigured'])

export function mapQueueManualCheckResult(rpcResult: QueueManualCheckRpcResult) {
  switch (rpcResult.result) {
    case 'invalid_status': {
      if (NOT_FOUND_REASONS.has(rpcResult.reason)) {
        return jsonError(404, 'not_found', 'The requested pincode target was not found in this workspace.', { reason: rpcResult.reason })
      }
      if (rpcResult.reason === 'target_unconfigured') {
        return jsonError(409, 'invalid_status', 'This pincode is no longer configured for monitoring. Add it back to the product\'s pincode list before requesting a check.', { reason: rpcResult.reason })
      }
      if (CONFLICT_REASONS.has(rpcResult.reason)) {
        return jsonError(409, 'invalid_status', 'This target cannot be manually checked in its current state.', { reason: rpcResult.reason })
      }
      return jsonError(400, 'invalid_parameters', 'The manual-check request was invalid.', { reason: rpcResult.reason })
    }
    case 'checking':
      // Already claimed and in flight -- not an error, a genuinely queued
      // request already exists (PRODUCT_SPEC.md sec12 #8: "duplicate manual
      // requests for the same target are coalesced").
      return jsonOk({ result: 'checking' })
    case 'already_queued':
      return jsonOk({ result: 'already_queued', manualRequestToken: rpcResult.manual_request_token })
    case 'cooldown':
      return NextResponse.json(
        { error: 'This target was checked too recently — try again shortly.', errorCode: 'pincode_manual_check_cooldown', retryAfterSeconds: rpcResult.retry_after_seconds },
        { status: 429, headers: { 'Retry-After': String(Math.max(0, rpcResult.retry_after_seconds)) } },
      )
    case 'quota_exceeded':
      return jsonError(409, 'pincode_manual_queue_limit_reached', 'The workspace has reached its outstanding manual-check limit.', {
        currentOutstanding: rpcResult.currentOutstanding,
        limit: rpcResult.limit,
      })
    case 'queued':
      return jsonOk({ result: 'queued', manualRequestToken: rpcResult.manual_request_token }, 202)
  }
}
