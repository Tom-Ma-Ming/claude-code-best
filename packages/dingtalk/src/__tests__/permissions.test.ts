import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearPermissionStateForTests,
  consumePendingPermission,
  getActivePermissionChat,
  savePendingPermission,
  setActivePermissionChat,
} from '../permissions.js'
import type { ChannelPermissionRequestParams } from '../permissions.js'

function request(id = 'abcde'): ChannelPermissionRequestParams {
  return {
    request_id: id,
    tool_name: 'Bash',
    description: 'Run the test suite',
    input_preview: 'bun test',
  }
}

afterEach(() => clearPermissionStateForTests())

describe('savePendingPermission / consumePendingPermission', () => {
  test('redeems a pending request from the originating chat', () => {
    savePendingPermission(request(), 'conv-1')
    const consumed = consumePendingPermission('abcde', 'conv-1')
    expect(consumed?.request_id).toBe('abcde')
  })

  test('matches the request id case-insensitively', () => {
    savePendingPermission(request('AbCdE'), 'conv-1')
    expect(consumePendingPermission('abcde', 'conv-1')?.chatId).toBe('conv-1')
  })

  test('refuses approval from a different conversation', () => {
    savePendingPermission(request(), 'conv-1')
    expect(consumePendingPermission('abcde', 'conv-2')).toBeNull()
  })

  test('leaves the request pending after a rejected cross-chat attempt', () => {
    savePendingPermission(request(), 'conv-1')
    consumePendingPermission('abcde', 'conv-2')
    expect(consumePendingPermission('abcde', 'conv-1')?.request_id).toBe(
      'abcde',
    )
  })

  test('can only be redeemed once', () => {
    savePendingPermission(request(), 'conv-1')
    expect(consumePendingPermission('abcde', 'conv-1')).not.toBeNull()
    expect(consumePendingPermission('abcde', 'conv-1')).toBeNull()
  })

  test('returns null for an unknown request id', () => {
    expect(consumePendingPermission('zzzzz', 'conv-1')).toBeNull()
  })

  test('carries the session webhook through for the reply path', () => {
    const saved = savePendingPermission(
      request(),
      'conv-1',
      'https://hook.test',
    )
    expect(saved.sessionWebhook).toBe('https://hook.test')
  })
})

describe('active permission chat', () => {
  test('starts unset', () => {
    expect(getActivePermissionChat()).toBeNull()
  })

  test('tracks the most recent chat', () => {
    setActivePermissionChat('conv-1', 'https://hook.test')
    setActivePermissionChat('conv-2')
    expect(getActivePermissionChat()?.chatId).toBe('conv-2')
    expect(getActivePermissionChat()?.sessionWebhook).toBeUndefined()
  })
})
