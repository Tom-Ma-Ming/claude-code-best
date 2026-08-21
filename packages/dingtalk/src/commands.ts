import {
  loadChannelConfig,
  saveChannelConfig,
  type ChannelConfig,
  type RelayConfig,
} from './config.js'

/**
 * Commands the channel answers itself.
 *
 * Anything about the channel — who it is bound to, what gets mirrored — is
 * known here and nowhere else, so answering locally is both faster and the
 * only way to get a reply while the agent is busy.
 *
 * Commands that act on the *session* (compact, clear, skills) are deliberately
 * not handled here: they go through as ordinary input and ccb's own slash
 * dispatch runs them, filtered by isBridgeSafeCommand().
 */

const RELAY_KEYS = [
  'prompts',
  'replies',
  'progress',
  'toolCalls',
  'errors',
  'session',
] as const

type RelayKey = (typeof RELAY_KEYS)[number]

function isRelayKey(v: string): v is RelayKey {
  return (RELAY_KEYS as readonly string[]).includes(v)
}

export interface ChannelCommandResult {
  /** Text to send back to the asker. */
  reply: string
}

function statusText(config: ChannelConfig): string {
  const on = RELAY_KEYS.filter(k => config.relay[k]).join(', ') || '(全部关闭)'
  const mirrors = config.mirrorConversations ?? []
  return [
    `模式：${config.mode === 'group' ? '群聊' : '私聊'}`,
    config.boundUserId
      ? `绑定用户：${config.boundUserNick || config.boundUserId}`
      : '绑定用户：(无)',
    `驱动会话：${config.boundConversationId || '(未绑定)'}`,
    `围观群：${mirrors.length > 0 ? `${mirrors.length} 个` : '(无)'}`,
    `转发开启：${on}`,
  ].join('\n')
}

function helpText(): string {
  return [
    '频道命令（由机器人直接回答，agent 忙碌时也能用）：',
    '  /help            这份帮助',
    '  /status          绑定与转发状态',
    '  /relay           查看转发开关',
    '  /relay on <项>   打开，如 /relay on toolCalls',
    '  /relay off <项>  关闭',
    `  可选项：${RELAY_KEYS.join(' / ')}`,
    '',
    '其余内容会作为提示交给 agent。ccb 的部分斜杠命令也可用：',
    '  /compact  /clear  /cost  /summary  /files  以及各类 skill',
  ].join('\n')
}

/**
 * Try to handle a message as a channel command.
 *
 * Returns null when the message is not one, so the caller passes it to the
 * agent unchanged. Only a leading `/` is considered, and only the exact verbs
 * below — `/status 一下部署` stays the question it is rather than being
 * swallowed as a command.
 */
export function handleChannelCommand(
  text: string,
  profile?: string,
): ChannelCommandResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const [verb, ...rest] = trimmed.slice(1).split(/\s+/)
  const lower = (verb ?? '').toLowerCase()

  if (lower === 'help' || lower === 'commands' || lower === '帮助') {
    if (rest.length > 0) return null
    return { reply: helpText() }
  }

  if (lower === 'status' || lower === '状态') {
    if (rest.length > 0) return null
    return { reply: statusText(loadChannelConfig(profile)) }
  }

  if (lower === 'relay' || lower === '转发') {
    const config = loadChannelConfig(profile)

    if (rest.length === 0) {
      const lines = RELAY_KEYS.map(
        k => `  ${config.relay[k] ? '开' : '关'}  ${k}`,
      )
      return { reply: ['转发开关：', ...lines].join('\n') }
    }

    const [state, key] = rest
    if ((state !== 'on' && state !== 'off') || !key) {
      return { reply: `用法：/relay on|off <${RELAY_KEYS.join('|')}>` }
    }
    if (!isRelayKey(key)) {
      return { reply: `未知的转发项「${key}」。可选：${RELAY_KEYS.join(', ')}` }
    }

    const relay: RelayConfig = { ...config.relay, [key]: state === 'on' }
    saveChannelConfig({ ...config, relay }, profile)
    return { reply: `已${state === 'on' ? '打开' : '关闭'} ${key}` }
  }

  return null
}
