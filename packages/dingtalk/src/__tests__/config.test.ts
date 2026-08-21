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
  isMirrorOnly,
  outboundTarget,
  relayTargets,
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

describe('spectator groups', () => {
  const BOUND = {
    ...PRIVATE,
    mirrorConversations: ['group-a', 'group-b'],
  }

  test('relayTargets includes the bound conversation and every mirror', () => {
    expect(relayTargets(BOUND)).toEqual(['conv-1', 'group-a', 'group-b'])
  })

  test('relayTargets de-duplicates', () => {
    expect(
      relayTargets({ ...PRIVATE, mirrorConversations: ['conv-1', 'group-a'] }),
    ).toEqual(['conv-1', 'group-a'])
  })

  test('relayTargets is empty while unbound', () => {
    expect(relayTargets(loadChannelConfig())).toEqual([])
  })

  test('a mirror group is spectator-only', () => {
    expect(isMirrorOnly(BOUND, 'group-a')).toBe(true)
  })

  test('the bound conversation is never spectator-only', () => {
    expect(isMirrorOnly(BOUND, 'conv-1')).toBe(false)
  })

  test('an unrelated conversation is not a spectator group', () => {
    expect(isMirrorOnly(BOUND, 'somewhere-else')).toBe(false)
  })
})

describe('config migration', () => {
  test('drops relay keys that no longer exist', () => {
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({
        mode: 'group',
        boundConversationId: 'c',
        relay: { toolStatus: true, prompts: false },
      }),
    )
    const relay = loadChannelConfig().relay
    expect(relay).not.toHaveProperty('toolStatus')
    expect(relay.prompts).toBe(false)
    expect(relay.toolCalls).toBe(false)
  })

  test('ignores non-boolean relay values', () => {
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ relay: { prompts: 'yes', replies: 0 } }),
    )
    const relay = loadChannelConfig().relay
    expect(relay.prompts).toBe(true)
    expect(relay.replies).toBe(true)
  })
})
