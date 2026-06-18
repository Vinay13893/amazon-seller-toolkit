import 'server-only'

export const INTERNAL_TEST_PLAN_NAME = 'Internal Test'
export const INTERNAL_TEST_ASIN_LIMIT = 999999

const INTERNAL_TEST_EMAILS = new Set([
  'test2026@sociomonkey.com',
])

export function isInternalTestAccount(email: string | null | undefined): boolean {
  return INTERNAL_TEST_EMAILS.has(email?.trim().toLowerCase() ?? '')
}
