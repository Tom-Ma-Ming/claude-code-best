import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
let previousStateDir: string | undefined

beforeEach(() => {
  previousStateDir = process.env.DINGTALK_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'ccb-dingtalk-pairing-'))
  process.env.DINGTALK_STATE_DIR = stateDir
})

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.DINGTALK_STATE_DIR
  else process.env.DINGTALK_STATE_DIR = previousStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

const {
  addPendingPairing,
  confirmPairing,
  isAllowed,
  loadAccessConfig,
  saveAccessConfig,
} = await import('../pairing.js')

describe('loadAccessConfig', () => {
  test('defaults to closed so an org-wide robot cannot be driven by anyone', () => {
    expect(loadAccessConfig()).toEqual({ policy: 'pairing', allowFrom: [] })
  })
})

describe('isAllowed', () => {
  test('denies an unknown sender under the default policy', () => {
    expect(isAllowed('staff-1')).toBe(false)
  })

  test('allows a paired sender', () => {
    saveAccessConfig({ policy: 'pairing', allowFrom: ['staff-1'] })
    expect(isAllowed('staff-1')).toBe(true)
    expect(isAllowed('staff-2')).toBe(false)
  })

  test('allows everyone when the policy is disabled', () => {
    saveAccessConfig({ policy: 'disabled', allowFrom: [] })
    expect(isAllowed('anyone')).toBe(true)
  })
})

describe('addPendingPairing', () => {
  test('issues a six-digit code', () => {
    expect(addPendingPairing('staff-1')).toMatch(/^\d{6}$/)
  })

  test('re-issues the same code so repeat messages do not pile up', () => {
    const first = addPendingPairing('staff-1')
    expect(addPendingPairing('staff-1')).toBe(first)
  })

  test('issues distinct codes to distinct senders', () => {
    expect(addPendingPairing('staff-1')).not.toBe(addPendingPairing('staff-2'))
  })
})

describe('confirmPairing', () => {
  test('adds the sender to the allowlist', () => {
    const code = addPendingPairing('staff-1')
    expect(confirmPairing(code)).toBe('staff-1')
    expect(isAllowed('staff-1')).toBe(true)
  })

  test('rejects an unknown code', () => {
    expect(confirmPairing('000000')).toBeNull()
  })

  test('cannot be replayed', () => {
    const code = addPendingPairing('staff-1')
    confirmPairing(code)
    expect(confirmPairing(code)).toBeNull()
  })

  test('does not duplicate an already-paired sender', () => {
    confirmPairing(addPendingPairing('staff-1'))
    saveAccessConfig(loadAccessConfig())
    confirmPairing(addPendingPairing('staff-1'))
    expect(loadAccessConfig().allowFrom).toEqual(['staff-1'])
  })
})
