import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'DINGTALK_STATE_DIR',
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

const { clearAccount, DEFAULT_BASE_URL, loadAccount, saveAccount } =
  await import('../accounts.js')

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
