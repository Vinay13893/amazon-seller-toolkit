/**
 * src/lib/review-requests/policy.ts
 *
 * Pure, DB-free decision logic for the Review Request Automation state
 * machine (see REVIEW_REQUEST_AUTOMATION_SPEC.md and migration 059's
 * comment block for the full status model). No Supabase or Amazon client
 * imports here — everything in this file is a pure function so it can be
 * unit-tested without any live credentials or network access.
 */

export type SolicitationStatus =
  | 'pending'
  | 'too_early'
  | 'not_eligible_retryable'
  | 'eligible_dry_run'
  | 'failed_retryable'
  | 'checking'
  | 'send_claimed'
  | 'sent'
  | 'already_solicited'
  | 'expired'
  | 'ineligible_terminal'
  | 'failed_terminal'

export const TERMINAL_STATUSES: readonly SolicitationStatus[] = [
  'sent', 'already_solicited', 'expired', 'ineligible_terminal', 'failed_terminal',
]

// Statuses this dry-run PR must never write. 'sent' and 'send_claimed' are
// reserved for a future PR that actually implements sending; a dry-run
// catch-up has no business ever setting either one.
export const PROTECTED_STATUSES: readonly SolicitationStatus[] = ['sent', 'send_claimed']

// Statuses a row may be in while eligible to be selected as a "due
// candidate" for an eligibility check. Excludes terminal statuses and the
// two in-flight/protected statuses ('checking' is being worked by someone
// right now; 'send_claimed'/'sent' are out of scope for this PR entirely).
export const DUE_CANDIDATE_STATUSES: readonly SolicitationStatus[] = [
  'pending', 'too_early', 'not_eligible_retryable', 'eligible_dry_run', 'failed_retryable',
]

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

export function isProtectedStatus(status: string): boolean {
  return (PROTECTED_STATUSES as readonly string[]).includes(status)
}

// ── Eligibility outcome classification ──────────────────────────────────────

/**
 * Maps a successful Solicitations GET response to a status.
 *
 * Deliberately conservative: this PR never assigns 'too_early',
 * 'already_solicited', 'expired', or 'ineligible_terminal' from a GET-only
 * signal, because a plain GET eligibility response gives no way to
 * distinguish those from each other with confidence -- doing so would mean
 * inventing an Amazon reason. All 4 remain valid, supported statuses in the
 * schema/repository for a future PR that has real evidence (e.g. an actual
 * POST attempt returning an explicit "already solicited" error) -- they are
 * simply never reached by this dry-run catch-up's own decision logic.
 */
export function classifyEligibilityOutcome(actionsPresent: boolean): 'eligible_dry_run' | 'not_eligible_retryable' {
  return actionsPresent ? 'eligible_dry_run' : 'not_eligible_retryable'
}

/**
 * Maps a failed Solicitations GET call to a status. Always failed_retryable
 * in this PR -- per "when uncertain, do not send" / "do not invent Amazon
 * eligibility reasons," a failed GET call is evidence about the call, not
 * evidence that the order itself is permanently ineligible.
 */
export function classifySolicitationsError(statusCode: number, amazonErrorCode: string | null): 'failed_retryable' {
  void statusCode // reserved for future refinement -- see doc comment above
  void amazonErrorCode
  return 'failed_retryable'
}

// ── Retry scheduling policy ──────────────────────────────────────────────────
// Conservative, documented, and centralized here so no caller can
// accidentally create a tight retry loop. All non-terminal, non-dry-run-
// eligible statuses get a multi-day/hour delay, never an immediate retry.

export const NOT_ELIGIBLE_RETRY_DAYS = 3
export const TOO_EARLY_RETRY_DAYS = 3
export const FAILED_RETRYABLE_RETRY_HOURS = 24

/**
 * Computes the next_check_at value for a status transition.
 *
 * - Terminal statuses always get next_check_at = null (schema-level
 *   guarantee, enforced here rather than trusted from callers).
 * - eligible_dry_run also gets next_check_at = null: per spec, a dry-run-
 *   eligible row is a historical signal for catch-up reporting, not
 *   something to keep re-polling. Any future live send must re-run GET
 *   eligibility immediately before POST regardless of this value.
 * - Everything else gets a conservative, multi-unit delay -- never an
 *   immediate/same-run recheck.
 */
export function computeNextCheckAt(status: SolicitationStatus, nowIso: string): string | null {
  if (isTerminalStatus(status)) return null
  if (status === 'eligible_dry_run') return null
  const now = new Date(nowIso).getTime()
  if (status === 'failed_retryable') {
    return new Date(now + FAILED_RETRYABLE_RETRY_HOURS * 60 * 60 * 1000).toISOString()
  }
  if (status === 'too_early') {
    return new Date(now + TOO_EARLY_RETRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
  }
  if (status === 'not_eligible_retryable') {
    return new Date(now + NOT_ELIGIBLE_RETRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
  }
  // pending / checking / send_claimed / sent are not reached via this
  // function in practice (pending is only ever an initial insert value;
  // checking/send_claimed/sent are handled by their own dedicated repository
  // functions), but return null defensively rather than guessing a delay.
  return null
}

// ── Sanitized eligibility evidence ──────────────────────────────────────────

export interface SanitizedEligibilityEvidence {
  actionNames: string[]
  checkedAt: string
  sanitizedReason: string | null
  amazonStatusCode: number | null
  amazonErrorCode: string | null
}

/**
 * Builds the ONLY object shape ever allowed to be written to
 * last_eligibility_response. Strictly an allowlist -- callers cannot smuggle
 * extra fields through, since this function's return type is exhaustive and
 * nothing else is ever passed to the repository's write call.
 *
 * Never accepts or forwards a raw API response body, buyer name, address,
 * phone, or email -- there is no parameter for any of those, by design.
 */
export function buildSanitizedEligibilityEvidence(input: {
  actionNames: string[]
  checkedAt: string
  sanitizedReason?: string | null
  amazonStatusCode?: number | null
  amazonErrorCode?: string | null
}): SanitizedEligibilityEvidence {
  return {
    actionNames: [...input.actionNames],
    checkedAt: input.checkedAt,
    sanitizedReason: input.sanitizedReason ?? null,
    amazonStatusCode: input.amazonStatusCode ?? null,
    amazonErrorCode: input.amazonErrorCode ?? null,
  }
}
