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
  checkAccess,
  confirmPairing,
  isAllowed,
  isConversationBound,
  loadAccessConfig,
  saveAccessConfig,
  senderIdentity,
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

describe('senderIdentity', () => {
  test('prefers the org staff id', () => {
    expect(
      senderIdentity({ senderStaffId: 'staff-1', senderId: 'op-9' }),
    ).toEqual({
      kind: 'staff',
      raw: 'staff-1',
      key: 'staff-1',
    })
  })

  test('namespaces an external sender so it cannot collide with a staff id', () => {
    expect(senderIdentity({ senderId: 'staff-1' })).toEqual({
      kind: 'external',
      raw: 'staff-1',
      key: 'external:staff-1',
    })
  })

  test('returns null when neither id is present', () => {
    expect(senderIdentity({})).toBeNull()
  })
})

describe('checkAccess', () => {
  const staff = { kind: 'staff' as const, raw: 's1', key: 's1' }
  const external = { kind: 'external' as const, raw: 'e1', key: 'external:e1' }

  test('refuses an unpaired org member', () => {
    expect(checkAccess(staff)).toEqual({ allowed: false, reason: 'unpaired' })
  })

  test('allows a paired org member', () => {
    saveAccessConfig({ policy: 'pairing', allowFrom: ['s1'] })
    expect(checkAccess(staff)).toEqual({ allowed: true })
  })

  test('refuses an external sender before pairing is even offered', () => {
    saveAccessConfig({ policy: 'pairing', allowFrom: ['external:e1'] })
    expect(checkAccess(external)).toEqual({
      allowed: false,
      reason: 'external-not-permitted',
    })
  })

  test('allows an external sender only when opted in AND paired', () => {
    saveAccessConfig({
      policy: 'pairing',
      allowFrom: ['external:e1'],
      allowExternal: true,
    })
    expect(checkAccess(external)).toEqual({ allowed: true })
  })

  test('an external sender opted in but unpaired is still refused', () => {
    saveAccessConfig({ policy: 'pairing', allowFrom: [], allowExternal: true })
    expect(checkAccess(external)).toEqual({
      allowed: false,
      reason: 'unpaired',
    })
  })

  test('a staff id does not grant access to the external entry of the same value', () => {
    saveAccessConfig({
      policy: 'pairing',
      allowFrom: ['e1'],
      allowExternal: true,
    })
    expect(checkAccess(external)).toEqual({
      allowed: false,
      reason: 'unpaired',
    })
  })

  test('disabled policy allows everyone including externals', () => {
    saveAccessConfig({ policy: 'disabled', allowFrom: [] })
    expect(checkAccess(external)).toEqual({ allowed: true })
  })
})

describe('isConversationBound', () => {
  test('handles every conversation when nothing is bound', () => {
    expect(isConversationBound('cid-anything')).toBe(true)
  })

  test('handles only the bound conversations', () => {
    saveAccessConfig({
      policy: 'pairing',
      allowFrom: [],
      boundConversations: ['cid-a', 'cid-b'],
    })
    expect(isConversationBound('cid-a')).toBe(true)
    expect(isConversationBound('cid-c')).toBe(false)
  })

  test('env var overrides the config file', () => {
    saveAccessConfig({
      policy: 'pairing',
      allowFrom: [],
      boundConversations: ['cid-a'],
    })
    process.env.DINGTALK_CONVERSATION_IDS = ' cid-x , cid-y '
    try {
      expect(isConversationBound('cid-x')).toBe(true)
      expect(isConversationBound('cid-a')).toBe(false)
    } finally {
      delete process.env.DINGTALK_CONVERSATION_IDS
    }
  })
})
