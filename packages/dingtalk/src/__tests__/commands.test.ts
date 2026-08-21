import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env.DINGTALK_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'ccb-dt-cmd-'))
  process.env.DINGTALK_STATE_DIR = stateDir
})
afterEach(() => {
  if (previous === undefined) delete process.env.DINGTALK_STATE_DIR
  else process.env.DINGTALK_STATE_DIR = previous
  rmSync(stateDir, { recursive: true, force: true })
})

const { handleChannelCommand } = await import('../commands.js')
const { loadChannelConfig, saveChannelConfig } = await import('../config.js')

describe('handleChannelCommand', () => {
  test('ignores ordinary text', () => {
    expect(handleChannelCommand('帮我跑一下测试')).toBeNull()
  })

  test('ignores an unknown slash command so the agent still sees it', () => {
    // /compact and skills are ccb's, not the channel's — passing them through
    // is what lets isBridgeSafeCommand() decide.
    expect(handleChannelCommand('/compact')).toBeNull()
    expect(handleChannelCommand('/skill:review')).toBeNull()
  })

  test('answers /help', () => {
    expect(handleChannelCommand('/help')?.reply).toContain('/relay')
  })

  test('answers /status with the binding', () => {
    saveChannelConfig({
      ...loadChannelConfig(),
      mode: 'group',
      boundConversationId: 'conv-1',
    })
    const reply = handleChannelCommand('/status')?.reply
    expect(reply).toContain('群聊')
    expect(reply).toContain('conv-1')
  })

  test('a command with a tail stays a question', () => {
    // "/status 一下部署" is a question about deployment, not a status request.
    expect(handleChannelCommand('/status 一下部署')).toBeNull()
  })

  test('/relay lists the switches', () => {
    expect(handleChannelCommand('/relay')?.reply).toContain('toolCalls')
  })

  test('/relay on toggles and persists', () => {
    expect(handleChannelCommand('/relay on toolCalls')?.reply).toContain('打开')
    expect(loadChannelConfig().relay.toolCalls).toBe(true)
  })

  test('/relay off toggles back', () => {
    handleChannelCommand('/relay on toolCalls')
    handleChannelCommand('/relay off toolCalls')
    expect(loadChannelConfig().relay.toolCalls).toBe(false)
  })

  test('rejects an unknown relay key without changing anything', () => {
    const before = loadChannelConfig().relay
    expect(handleChannelCommand('/relay on nonsense')?.reply).toContain('未知')
    expect(loadChannelConfig().relay).toEqual(before)
  })

  test('explains bad /relay usage', () => {
    expect(handleChannelCommand('/relay maybe prompts')?.reply).toContain(
      '用法',
    )
  })

  test('accepts the Chinese aliases', () => {
    expect(handleChannelCommand('/状态')).not.toBeNull()
    expect(handleChannelCommand('/帮助')).not.toBeNull()
  })
})
