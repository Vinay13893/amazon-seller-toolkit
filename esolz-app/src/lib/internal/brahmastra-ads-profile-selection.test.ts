import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveBrahmastraProfile,
  resolveBrahmastraSyncProfiles,
} from './brahmastra-ads-profile-selection'

const p = (profileId: string, brahmastraSyncEnabled: boolean, isPrimary = false) => ({
  profileId,
  brahmastraSyncEnabled,
  isPrimary,
})

test('sync covers every enabled profile, not just one', () => {
  const result = resolveBrahmastraSyncProfiles([p('emount', true, true), p('sra', true), p('easyhome', true), p('other', false)])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual([...result.profileIds].sort(), ['easyhome', 'emount', 'sra'])
})

test('sync does not block when several are enabled and none is primary', () => {
  assert.equal(resolveBrahmastraProfile([p('a', true), p('b', true)]).ok, false)
  const result = resolveBrahmastraSyncProfiles([p('a', true), p('b', true)])
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.profileIds.length, 2)
})

test('sync lists the primary profile first', () => {
  const result = resolveBrahmastraSyncProfiles([p('sra', true), p('emount', true, true)])
  assert.equal(result.ok && result.profileIds[0], 'emount')
})

test('sync never falls back to disabled profiles', () => {
  const result = resolveBrahmastraSyncProfiles([p('a', false), p('b', false)])
  assert.equal(result.ok, false)
})

test('dashboard single-profile selection is unchanged', () => {
  const result = resolveBrahmastraProfile([p('emount', true, true), p('sra', true)])
  assert.deepEqual(result, { ok: true, profileId: 'emount' })
})
