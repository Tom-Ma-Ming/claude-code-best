import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env.DINGTALK_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'ccb-dingtalk-config-'))
  process.env.DINGTALK_STATE_DIR = stateDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.DINGTALK_STATE_DIR
  else process.env.DINGTALK_STATE_DIR = previous
  rmSync(stateDir, { recursive: true, force: true })
})

const {
  acceptsInbound,
  isBound,
  loadChannelConfig,
  outboundTarget,
  saveChannelConfig,
} = await import('../config.js')

const PRIVATE = {
  mode: 'private' as const,
  boundUserId: 'staff-1',
  boundConversationId: 'conv-1',
  relay: {
    prompts: true,
    replies: true,
    progress: true,
    toolCalls: false,
    errors: true,
    session: true,
  },
}
const GROUP = {
  mode: 'group' as const,
  boundConversationId: 'conv-g',
  relay: {
    prompts: true,
    replies: true,
    progress: true,
    toolCalls: false,
    errors: true,
    session: true,
  },
}

describe('loadChannelConfig', () => {
  test('defaults to unbound private mode', () => {
    const c = loadChannelConfig()
    expect(c.mode).toBe('private')
    expect(isBound(c)).toBe(false)
  })

  test('round-trips a saved config', () => {
    saveChannelConfig(PRIVATE)
    expect(loadChannelConfig()).toMatchObject({
      mode: 'private',
      boundUserId: 'staff-1',
      boundConversationId: 'conv-1',
    })
  })

  test('fills missing relay keys from defaults', () => {
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ mode: 'group', relay: { prompts: false } }),
    )
    const c = loadChannelConfig()
    expect(c.relay).toEqual({
      prompts: false,
      replies: true,
      progress: true,
      toolCalls: false,
      errors: true,
      session: true,
    })
  })

  test('falls back to defaults on malformed JSON', () => {
    writeFileSync(join(stateDir, 'config.json'), 'not json')
    expect(isBound(loadChannelConfig())).toBe(false)
  })
})

describe('isBound', () => {
  test('private mode needs both a user and a conversation', () => {
    expect(isBound({ ...PRIVATE, boundUserId: undefined })).toBe(false)
    expect(isBound({ ...PRIVATE, boundConversationId: undefined })).toBe(false)
    expect(isBound(PRIVATE)).toBe(true)
  })

  test('group mode needs only a conversation', () => {
    expect(isBound(GROUP)).toBe(true)
  })
})

describe('acceptsInbound', () => {
  test('refuses everything while unbound', () => {
    const r = acceptsInbound(loadChannelConfig(), {
      senderStaffId: 's',
      conversationId: 'c',
    })
    expect(r).toEqual({
      ok: false,
      reason: expect.stringContaining('not bound'),
    })
  })

  test('private mode accepts the bound user in the bound chat', () => {
    expect(
      acceptsInbound(PRIVATE, {
        senderStaffId: 'staff-1',
        conversationId: 'conv-1',
      }),
    ).toEqual({ ok: true })
  })

  test('private mode refuses another person in the bound chat', () => {
    expect(
      acceptsInbound(PRIVATE, {
        senderStaffId: 'staff-2',
        conversationId: 'conv-1',
      }).ok,
    ).toBe(false)
  })

  test('private mode refuses the bound user from a different conversation', () => {
    expect(
      acceptsInbound(PRIVATE, {
        senderStaffId: 'staff-1',
        conversationId: 'some-group',
      }).ok,
    ).toBe(false)
  })

  test('group mode accepts anyone in the bound group', () => {
    expect(
      acceptsInbound(GROUP, {
        senderStaffId: 'whoever',
        conversationId: 'conv-g',
      }),
    ).toEqual({ ok: true })
  })

  test('group mode refuses other groups', () => {
    expect(
      acceptsInbound(GROUP, {
        senderStaffId: 'whoever',
        conversationId: 'other',
      }).ok,
    ).toBe(false)
  })
})

describe('outboundTarget', () => {
  test('is the bound conversation', () => {
    expect(outboundTarget(PRIVATE)).toBe('conv-1')
    expect(outboundTarget(GROUP)).toBe('conv-g')
  })

  test('is null while unbound — never a guess', () => {
    expect(outboundTarget(loadChannelConfig())).toBeNull()
  })
})
