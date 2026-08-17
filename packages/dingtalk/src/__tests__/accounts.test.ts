import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'DINGTALK_STATE_DIR',
  'DINGTALK_PROFILE',
  'DINGTALK_APP_KEY',
  'DINGTALK_APP_SECRET',
  'DINGTALK_ROBOT_CODE',
  'DINGTALK_BASE_URL',
]

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  stateDir = mkdtempSync(join(tmpdir(), 'ccb-dingtalk-accounts-'))
  process.env.DINGTALK_STATE_DIR = stateDir
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(stateDir, { recursive: true, force: true })
})

const {
  activeProfile,
  assertValidProfileName,
  clearAccount,
  DEFAULT_BASE_URL,
  getStateDir,
  listProfiles,
  loadAccount,
  saveAccount,
} = await import('../accounts.js')

describe('loadAccount', () => {
  test('returns null when nothing is configured', () => {
    expect(loadAccount()).toBeNull()
  })

  test('reads credentials written by saveAccount', () => {
    saveAccount({
      appKey: 'key',
      appSecret: 'secret',
      robotCode: 'robot',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(loadAccount()).toMatchObject({
      appKey: 'key',
      appSecret: 'secret',
      robotCode: 'robot',
    })
  })

  test('defaults robotCode to appKey when absent', () => {
    writeFileSync(
      join(stateDir, 'account.json'),
      JSON.stringify({ appKey: 'key', appSecret: 'secret' }),
    )
    expect(loadAccount()?.robotCode).toBe('key')
  })

  test('env vars take precedence over the account file', () => {
    saveAccount({
      appKey: 'file-key',
      appSecret: 'file-secret',
      robotCode: 'file-robot',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: 'x',
    })
    process.env.DINGTALK_APP_KEY = 'env-key'
    process.env.DINGTALK_APP_SECRET = 'env-secret'
    expect(loadAccount()).toMatchObject({
      appKey: 'env-key',
      appSecret: 'env-secret',
      savedAt: 'env',
    })
  })

  test('ignores a half-configured env (key without secret)', () => {
    process.env.DINGTALK_APP_KEY = 'env-key'
    expect(loadAccount()).toBeNull()
  })

  test('returns null on a file missing appSecret', () => {
    writeFileSync(
      join(stateDir, 'account.json'),
      JSON.stringify({ appKey: 'k' }),
    )
    expect(loadAccount()).toBeNull()
  })

  test('returns null on malformed JSON rather than throwing', () => {
    writeFileSync(join(stateDir, 'account.json'), 'not json')
    expect(loadAccount()).toBeNull()
  })
})

describe('saveAccount', () => {
  test('writes the credential file as owner-only', () => {
    saveAccount({
      appKey: 'key',
      appSecret: 'secret',
      robotCode: 'robot',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: 'x',
    })
    const mode = statSync(join(stateDir, 'account.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('clearAccount', () => {
  test('removes stored credentials', () => {
    saveAccount({
      appKey: 'key',
      appSecret: 'secret',
      robotCode: 'robot',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: 'x',
    })
    clearAccount()
    expect(loadAccount()).toBeNull()
  })

  test('is a no-op when nothing is stored', () => {
    expect(() => clearAccount()).not.toThrow()
  })
})

describe('profiles', () => {
  const CHANNEL_ROOT = 'DINGTALK_STATE_DIR'

  test('default profile keeps using the channel root', () => {
    delete process.env.DINGTALK_PROFILE
    expect(getStateDir()).toBe(stateDir)
  })

  test('a named profile gets its own directory', () => {
    delete process.env[CHANNEL_ROOT]
    try {
      const dir = getStateDir('projectA')
      expect(dir).toContain(
        join('channels', 'dingtalk', 'profiles', 'projectA'),
      )
    } finally {
      process.env[CHANNEL_ROOT] = stateDir
    }
  })

  test('DINGTALK_STATE_DIR still overrides a profile outright', () => {
    process.env.DINGTALK_PROFILE = 'projectA'
    try {
      expect(getStateDir()).toBe(stateDir)
    } finally {
      delete process.env.DINGTALK_PROFILE
    }
  })

  test('activeProfile reads DINGTALK_PROFILE and trims it', () => {
    process.env.DINGTALK_PROFILE = '  projectB  '
    try {
      expect(activeProfile()).toBe('projectB')
    } finally {
      delete process.env.DINGTALK_PROFILE
    }
  })

  test('activeProfile is undefined when unset or blank', () => {
    delete process.env.DINGTALK_PROFILE
    expect(activeProfile()).toBeUndefined()
    process.env.DINGTALK_PROFILE = '   '
    try {
      expect(activeProfile()).toBeUndefined()
    } finally {
      delete process.env.DINGTALK_PROFILE
    }
  })

  test.each([
    '../escape',
    'a/b',
    '.hidden',
    '',
    'has space',
  ])('rejects unsafe profile name %p', name => {
    expect(() => assertValidProfileName(name)).toThrow('Invalid profile name')
  })

  test.each([
    'projectA',
    'proj-1',
    'proj_1',
    'a.b',
    '9lives',
  ])('accepts profile name %p', name => {
    expect(() => assertValidProfileName(name)).not.toThrow()
  })

  test('profiles are isolated from each other', () => {
    delete process.env[CHANNEL_ROOT]
    try {
      saveAccount(
        {
          appKey: 'a',
          appSecret: 's',
          robotCode: 'r',
          baseUrl: DEFAULT_BASE_URL,
          savedAt: 'x',
        },
        'isoTestA',
      )
      saveAccount(
        {
          appKey: 'b',
          appSecret: 't',
          robotCode: 'q',
          baseUrl: DEFAULT_BASE_URL,
          savedAt: 'y',
        },
        'isoTestB',
      )
      expect(loadAccount('isoTestA')?.appKey).toBe('a')
      expect(loadAccount('isoTestB')?.appKey).toBe('b')
      expect(listProfiles()).toEqual(
        expect.arrayContaining(['isoTestA', 'isoTestB']),
      )
    } finally {
      clearAccount('isoTestA')
      clearAccount('isoTestB')
      process.env[CHANNEL_ROOT] = stateDir
    }
  })
})
