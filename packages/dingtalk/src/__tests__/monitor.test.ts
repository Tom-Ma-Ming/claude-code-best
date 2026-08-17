import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
let previousStateDir: string | undefined

beforeEach(() => {
  previousStateDir = process.env.DINGTALK_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'ccb-dingtalk-test-'))
  process.env.DINGTALK_STATE_DIR = stateDir
})

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.DINGTALK_STATE_DIR
  else process.env.DINGTALK_STATE_DIR = previousStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

const {
  clearMonitorStateForTests,
  extractPermissionReply,
  extractText,
  getSessionWebhook,
  rememberSessionWebhook,
  stripAtMention,
} = await import('../monitor.js')

describe('extractPermissionReply', () => {
  test.each([
    ['yes abcde', 'allow', 'abcde'],
    ['y abcde', 'allow', 'abcde'],
    ['no abcde', 'deny', 'abcde'],
    ['n abcde', 'deny', 'abcde'],
    ['  YES  ABCDE  ', 'allow', 'ABCDE'],
  ])('parses %p', (input, behavior, requestId) => {
    expect(extractPermissionReply(input)).toEqual({
      behavior: behavior as 'allow' | 'deny',
      requestId,
    })
  })

  test.each([
    'yes',
    'yes abcdef',
    'yes abcd',
    'maybe abcde',
    'please run yes abcde',
    // `l` is excluded from the id alphabet to avoid 1/l confusion.
    'yes ablde',
  ])('rejects %p', input => {
    expect(extractPermissionReply(input)).toBeNull()
  })
})

describe('stripAtMention', () => {
  test('removes the leading @mention added by group chats', () => {
    expect(stripAtMention('@ccb-bot run the tests')).toBe('run the tests')
  })

  test('removes a named mention anywhere in the text', () => {
    expect(stripAtMention('hey @ccb-bot deploy', 'ccb-bot')).toBe('hey deploy')
  })

  test('keeps newlines intact when collapsing the mention gap', () => {
    expect(stripAtMention('@ccb-bot fix:\n\n  const x = 1')).toBe(
      'fix:\n\n const x = 1',
    )
  })

  test('leaves 1:1 text untouched', () => {
    expect(stripAtMention('run the tests')).toBe('run the tests')
  })
})

describe('extractText', () => {
  test('reads a plain text message', () => {
    expect(extractText({ text: { content: 'hello' } })).toBe('hello')
  })

  test('concatenates richText segments', () => {
    expect(
      extractText({
        richText: [{ text: 'a' }, { downloadCode: 'x' }, { text: 'b' }],
      }),
    ).toBe('ab')
  })

  test('surfaces DingTalk voice transcription as text', () => {
    expect(extractText({ content: { recognition: 'open the door' } })).toBe(
      '[Voice transcription]: open the door',
    )
  })

  test('returns empty string when there is nothing readable', () => {
    expect(
      extractText({ msgtype: 'picture', content: { downloadCode: 'z' } }),
    ).toBe('')
  })
})

describe('session webhook cache', () => {
  afterEach(() => clearMonitorStateForTests())

  test('returns a remembered webhook', () => {
    rememberSessionWebhook('conv-1', 'https://example.test/hook')
    expect(getSessionWebhook('conv-1')).toBe('https://example.test/hook')
  })

  test('treats expiry 0 as no expiry', () => {
    rememberSessionWebhook('conv-1', 'https://example.test/hook', 0)
    expect(getSessionWebhook('conv-1')).toBe('https://example.test/hook')
  })

  test('drops an expired webhook so callers fall back to the token API', () => {
    rememberSessionWebhook(
      'conv-1',
      'https://example.test/hook',
      Date.now() - 1,
    )
    expect(getSessionWebhook('conv-1')).toBeUndefined()
  })

  test('returns undefined for an unknown conversation', () => {
    expect(getSessionWebhook('nope')).toBeUndefined()
  })
})
