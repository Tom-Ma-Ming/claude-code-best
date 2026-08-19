import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
let fakeHome: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'HOME',
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
  // Sandbox the home-relative path too: several tests below drop
  // DINGTALK_STATE_DIR on purpose to exercise channelRoot(), which resolves
  // through os.homedir(). Without this they create dirs in the real ~/.ccb.
  fakeHome = mkdtempSync(join(tmpdir(), 'ccb-dingtalk-home-'))
  process.env.HOME = fakeHome
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
})

const {
  activeProfile,
  assertValidProfileName,
  clearAccount,
  DEFAULT_BASE_URL,
  getStateDir,
  listProfiles,
  stateDirPath,
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
    expect(stateDirPath()).toBe(stateDir)
  })

  test('a named profile gets its own directory', () => {
    delete process.env[CHANNEL_ROOT]
    try {
      // stateDirPath is pure. getStateDir() mkdirs, and os.homedir() ignores a
      // test-set $HOME under Bun, so calling it here would litter the real ~/.ccb.
      expect(stateDirPath('projectA')).toContain(
        join('channels', 'dingtalk', 'profiles', 'projectA'),
      )
    } finally {
      process.env[CHANNEL_ROOT] = stateDir
    }
  })

  test('DINGTALK_STATE_DIR still overrides a profile outright', () => {
    process.env.DINGTALK_PROFILE = 'projectA'
    try {
      expect(stateDirPath()).toBe(stateDir)
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

  test('distinct profiles resolve to distinct directories', () => {
    delete process.env[CHANNEL_ROOT]
    try {
      const a = stateDirPath('isoA')
      const b = stateDirPath('isoB')
      expect(a).not.toBe(b)
      expect(a.endsWith(join('profiles', 'isoA'))).toBe(true)
      expect(b.endsWith(join('profiles', 'isoB'))).toBe(true)
    } finally {
      process.env[CHANNEL_ROOT] = stateDir
    }
  })

  test('credentials round-trip per state dir without leaking across', () => {
    const dirA = join(stateDir, 'a')
    const dirB = join(stateDir, 'b')

    process.env[CHANNEL_ROOT] = dirA
    saveAccount({
      appKey: 'a',
      appSecret: 's',
      robotCode: 'r',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: 'x',
    })
    process.env[CHANNEL_ROOT] = dirB
    saveAccount({
      appKey: 'b',
      appSecret: 't',
      robotCode: 'q',
      baseUrl: DEFAULT_BASE_URL,
      savedAt: 'y',
    })

    process.env[CHANNEL_ROOT] = dirA
    expect(loadAccount()?.appKey).toBe('a')
    process.env[CHANNEL_ROOT] = dirB
    expect(loadAccount()?.appKey).toBe('b')
    process.env[CHANNEL_ROOT] = stateDir
  })
})

describe('env credentials vs named profiles', () => {
  test('env configures the unnamed default profile', () => {
    delete process.env.DINGTALK_STATE_DIR
    delete process.env.DINGTALK_PROFILE
    process.env.DINGTALK_APP_KEY = 'env-key'
    process.env.DINGTALK_APP_SECRET = 'env-secret'
    try {
      expect(loadAccount()?.appKey).toBe('env-key')
    } finally {
      process.env.DINGTALK_STATE_DIR = stateDir
    }
  })

  test('env does NOT shadow an explicitly named profile', () => {
    process.env.DINGTALK_APP_KEY = 'env-key'
    process.env.DINGTALK_APP_SECRET = 'env-secret'
    // The named profile has nothing stored, so it must read as unconfigured —
    // not as "already configured" from the env of some other project.
    expect(loadAccount('projectB')).toBeNull()
  })

  test('env does NOT shadow DINGTALK_PROFILE either', () => {
    process.env.DINGTALK_APP_KEY = 'env-key'
    process.env.DINGTALK_APP_SECRET = 'env-secret'
    process.env.DINGTALK_PROFILE = 'projectB'
    delete process.env.DINGTALK_STATE_DIR
    try {
      expect(loadAccount()).toBeNull()
    } finally {
      process.env.DINGTALK_STATE_DIR = stateDir
    }
  })
})
