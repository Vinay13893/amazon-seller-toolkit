/**
 * src/lib/pincode-status.ts
 *
 * Shared, pure status-normalization helpers for `pincode_checks`-derived
 * data. Both `available` and `fulfillment_type` are nullable in the DB by
 * design -- null means "not confirmed," never a synonym for a negative
 * result. Every renderer of `pincode_checks` data must go through these
 * helpers instead of a raw truthy/falsy check on the nullable value, so a
 * failed/uncertain check can never be displayed as a confirmed negative
 * result -- the exact bug class already found and fixed for Buy Box status
 * in `b0a1c5b`/`c9ce4b3` (see PINCODE_CHECKER_PRODUCT_AUDIT.md sec4).
 */

// ── Availability ──────────────────────────────────────────────────────────────

export type PincodeAvailabilityState = 'available' | 'unavailable' | 'failed' | 'not_confirmed'

// insertFailedCheck() in api/asins/[asin]/pincode/route.ts always prefixes
// delivery_promise with this exact marker on a thrown-exception failure.
// This is the only structured-enough signal the current schema offers to
// distinguish "the checker call itself failed" from "the checker ran and
// returned an uncertain (non-success) result" -- both cases store
// available: null, since the DB has no separate status/error-code column.
const CHECK_FAILED_MARKER = 'Check failed:'

/**
 * Classifies a pincode_checks row's availability into a seller-facing
 * state. `available` is a nullable boolean at the DB level:
 *   - true  -> confirmed available
 *   - false -> confirmed unavailable
 *   - null  -> uncertain -- further distinguished by whether the row carries
 *              the explicit failure marker (see CHECK_FAILED_MARKER above)
 */
export function classifyPincodeAvailability(
  available: boolean | null | undefined,
  deliveryPromise?: string | null,
): PincodeAvailabilityState {
  if (available === true) return 'available'
  if (available === false) return 'unavailable'
  if (typeof deliveryPromise === 'string' && deliveryPromise.startsWith(CHECK_FAILED_MARKER)) return 'failed'
  return 'not_confirmed'
}

export interface PincodeAvailabilityDisplay {
  state: PincodeAvailabilityState
  label: string
  toneClass: string
}

const AVAILABILITY_DISPLAY: Record<PincodeAvailabilityState, Omit<PincodeAvailabilityDisplay, 'state'>> = {
  available:     { label: 'Available',     toneClass: 'text-green-400' },
  unavailable:   { label: 'Unavailable',   toneClass: 'text-red-400' },
  failed:        { label: 'Check failed',  toneClass: 'text-muted-foreground' },
  not_confirmed: { label: 'Not confirmed', toneClass: 'text-muted-foreground' },
}

/** Convenience wrapper: classify + look up the seller-facing label/tone in one call. */
export function getPincodeAvailabilityDisplay(
  available: boolean | null | undefined,
  deliveryPromise?: string | null,
): PincodeAvailabilityDisplay {
  const state = classifyPincodeAvailability(available, deliveryPromise)
  return { state, ...AVAILABILITY_DISPLAY[state] }
}

// ── Fulfillment (FBA/FBM) ────────────────────────────────────────────────────

export type FulfillmentState = 'fba' | 'fbm' | 'not_confirmed'

/**
 * Classifies a pincode_checks row's fulfillment_type (TEXT, nullable) into
 * a seller-facing state. Only 'FBA'/'FBM' are ever written from a confirmed
 * signal (see api/asins/[asin]/pincode/route.ts) -- any other value,
 * including null/undefined/unrecognized, means fulfillment could not be
 * established and must never be guessed as FBM.
 */
export function classifyFulfillment(fulfillmentType: string | null | undefined): FulfillmentState {
  if (fulfillmentType === 'FBA') return 'fba'
  if (fulfillmentType === 'FBM') return 'fbm'
  return 'not_confirmed'
}

export interface FulfillmentDisplay {
  state: FulfillmentState
  label: string
}

const FULFILLMENT_DISPLAY: Record<FulfillmentState, Omit<FulfillmentDisplay, 'state'>> = {
  fba:           { label: 'FBA (Amazon Fulfilled)' },
  fbm:           { label: 'FBM (Merchant Fulfilled)' },
  not_confirmed: { label: 'Not confirmed' },
}

/** Convenience wrapper: classify + look up the seller-facing label in one call. */
export function getFulfillmentDisplay(fulfillmentType: string | null | undefined): FulfillmentDisplay {
  const state = classifyFulfillment(fulfillmentType)
  return { state, ...FULFILLMENT_DISPLAY[state] }
}
