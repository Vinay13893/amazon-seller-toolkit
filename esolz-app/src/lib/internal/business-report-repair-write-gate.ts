/**
 * Business Report sales-grain fix — the repair script's write gate (spec
 * Phase 6). Every one of these checks must independently pass before a
 * single row is ever written by scripts/repair-business-report-sku-daily.ts.
 * Dry-run (no writes) is the default outcome of every code path except the
 * single one where ALL of these are simultaneously true.
 *
 * `TOLERANCE_APPROVED_BY_FOUNDER` is hardcoded `false` in this codebase
 * right now — no founder sign-off on a reconciliation tolerance has
 * happened yet (see business-report-reconciliation.ts's
 * PROPOSED_SALES_TOLERANCE_PCT doc comment). That makes a real write
 * impossible from this constant alone, independent of any CLI flag a
 * caller might pass — an extra hard stop on top of the flag/phrase gate
 * below, matching "no production database writes, ever, in this task."
 * Flipping it to `true` is a deliberate, reviewable code change for a
 * human to make once the founder has actually approved a tolerance.
 */
export const TOLERANCE_APPROVED_BY_FOUNDER = false

export const REQUIRED_CONFIRMATION_PHRASE = 'I UNDERSTAND THIS OVERWRITES PRODUCTION SKU SALES DATA'

export type WriteGateVerdict = 'within_tolerance' | 'exceeds_tolerance' | 'unknown'

export type WriteGateInput = {
  /** The high-friction CLI flag (e.g. --execute-write). Absent/false -> dry run, always. */
  executeWriteFlag: boolean
  /** Must equal REQUIRED_CONFIRMATION_PHRASE EXACTLY (case-sensitive, no trimming leniency) — a typo or omission is a hard no, never "close enough." */
  confirmationPhrase: string | null
  /** This date's reconciliation verdict from business-report-reconciliation.ts. */
  reconciliationVerdict: WriteGateVerdict
  /** Whether the tolerance actually used was founder-approved. Always TOLERANCE_APPROVED_BY_FOUNDER in production code paths — a caller-supplied override exists only so this function itself is testable for the day the founder does approve one. */
  toleranceApproved: boolean
  /** Structural validation (business-report-run-outcome.ts) for this date. */
  structuralStatus: 'success' | 'partial_success' | 'failed'
}

export type WriteGateReason =
  | 'dry_run_default_no_execute_write_flag'
  | 'missing_or_incorrect_confirmation_phrase'
  | 'tolerance_not_founder_approved'
  | 'reconciliation_not_within_tolerance'
  | 'structural_validation_did_not_succeed'
  | 'all_checks_passed'

export type WriteGateResult = { writePermitted: boolean; reason: WriteGateReason }

/**
 * Every branch below is a hard stop, evaluated independently — an
 * ambiguous or partially-satisfied combination of inputs (e.g. the flag
 * set but the phrase wrong, or the phrase right but the flag omitted)
 * NEVER falls through to writePermitted: true. Order matters only for
 * which single reason is reported; every check still applies regardless
 * of order.
 */
export function evaluateWriteGate(input: WriteGateInput): WriteGateResult {
  if (!input.executeWriteFlag) return { writePermitted: false, reason: 'dry_run_default_no_execute_write_flag' }
  if (input.confirmationPhrase !== REQUIRED_CONFIRMATION_PHRASE) return { writePermitted: false, reason: 'missing_or_incorrect_confirmation_phrase' }
  if (!input.toleranceApproved) return { writePermitted: false, reason: 'tolerance_not_founder_approved' }
  if (input.structuralStatus !== 'success') return { writePermitted: false, reason: 'structural_validation_did_not_succeed' }
  if (input.reconciliationVerdict !== 'within_tolerance') return { writePermitted: false, reason: 'reconciliation_not_within_tolerance' }
  return { writePermitted: true, reason: 'all_checks_passed' }
}
