import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateWriteGate,
  REQUIRED_CONFIRMATION_PHRASE,
  TOLERANCE_APPROVED_BY_FOUNDER,
  type WriteGateInput,
} from '../business-report-repair-write-gate'

const basePassingInput: WriteGateInput = {
  executeWriteFlag: true,
  confirmationPhrase: REQUIRED_CONFIRMATION_PHRASE,
  reconciliationVerdict: 'within_tolerance',
  toleranceApproved: true,
  structuralStatus: 'success',
}

describe('TOLERANCE_APPROVED_BY_FOUNDER', () => {
  test('is hardcoded false in this codebase -- no founder sign-off has happened yet', () => {
    assert.equal(TOLERANCE_APPROVED_BY_FOUNDER, false)
  })
})

describe('evaluateWriteGate', () => {
  test('every check satisfied -> write permitted (only reachable state)', () => {
    assert.deepEqual(evaluateWriteGate(basePassingInput), { writePermitted: true, reason: 'all_checks_passed' })
  })

  test('the default/omitted case: executeWriteFlag=false -> dry run, regardless of everything else', () => {
    const result = evaluateWriteGate({ ...basePassingInput, executeWriteFlag: false })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'dry_run_default_no_execute_write_flag')
  })

  test('flag set but confirmation phrase missing (null) -> blocked', () => {
    const result = evaluateWriteGate({ ...basePassingInput, confirmationPhrase: null })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'missing_or_incorrect_confirmation_phrase')
  })

  test('flag set but confirmation phrase is a near-miss typo -> blocked, no leniency', () => {
    const result = evaluateWriteGate({ ...basePassingInput, confirmationPhrase: REQUIRED_CONFIRMATION_PHRASE + ' ' })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'missing_or_incorrect_confirmation_phrase')
  })

  test('flag set but confirmation phrase is lowercase -> blocked, case-sensitive', () => {
    const result = evaluateWriteGate({ ...basePassingInput, confirmationPhrase: REQUIRED_CONFIRMATION_PHRASE.toLowerCase() })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'missing_or_incorrect_confirmation_phrase')
  })

  test('flag and phrase both correct but tolerance not approved -> blocked', () => {
    const result = evaluateWriteGate({ ...basePassingInput, toleranceApproved: false })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'tolerance_not_founder_approved')
  })

  test('everything else correct but structural validation is only partial_success -> blocked', () => {
    const result = evaluateWriteGate({ ...basePassingInput, structuralStatus: 'partial_success' })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'structural_validation_did_not_succeed')
  })

  test('everything else correct but structural validation failed -> blocked', () => {
    const result = evaluateWriteGate({ ...basePassingInput, structuralStatus: 'failed' })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'structural_validation_did_not_succeed')
  })

  test('everything else correct but reconciliation exceeds tolerance -> blocked', () => {
    const result = evaluateWriteGate({ ...basePassingInput, reconciliationVerdict: 'exceeds_tolerance' })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'reconciliation_not_within_tolerance')
  })

  test('everything else correct but reconciliation verdict is unknown -> blocked, never treated as passing', () => {
    const result = evaluateWriteGate({ ...basePassingInput, reconciliationVerdict: 'unknown' })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'reconciliation_not_within_tolerance')
  })

  test('running this repo\'s ACTUAL hardcoded TOLERANCE_APPROVED_BY_FOUNDER constant through the gate always blocks -- proves no write is possible in this codebase today regardless of CLI flags', () => {
    const result = evaluateWriteGate({ ...basePassingInput, toleranceApproved: TOLERANCE_APPROVED_BY_FOUNDER })
    assert.equal(result.writePermitted, false)
    assert.equal(result.reason, 'tolerance_not_founder_approved')
  })
})
