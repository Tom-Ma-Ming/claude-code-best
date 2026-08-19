import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir, loadAccount, stateDirPath } from './accounts.js'
import { loadChannelConfig, outboundTarget } from './config.js'
import { sendMarkdown, sendText } from './send.js'
import { ConversationType } from './types.js'
import type { RelayConfig } from './config.js'

/**
 * Terminal → DingTalk mirroring ("围观模式").
 *
 * Driven by ccb's own hooks rather than anything inside the REPL: every hook
 * receives session_id / transcript_path / cwd, which is enough to reconstruct
 * what happened without the channel needing to observe the session directly.
 */

/** Hook payload fields this module relies on. Extra keys are ignored. */
export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  // UserPromptSubmit
  prompt?: string
  // PreToolUse / PostToolUse / PostToolUseFailure
  tool_name?: string
  tool_input?: unknown
  error?: string
  error_type?: string
  is_interrupt?: boolean
  is_timeout?: boolean
  // Notification
  message?: string
  notification_type?: string
  // SessionEnd
  reason?: string
}

/** Which relay switch governs an event. */
export function relayCategory(event: string): keyof RelayConfig | null {
  switch (event) {
    case 'UserPromptSubmit':
      return 'prompts'
    case 'Stop':
      return 'replies'
    case 'PreToolUse':
    case 'PostToolUse':
      return 'toolStatus'
    case 'PostToolUseFailure':
    case 'StopFailure':
    case 'SessionEnd':
      return 'errors'
    default:
      return null
  }
}

/**
 * Tools that fire constantly and say nothing a spectator can act on. They are
 * still counted, so an update reads "…and 14 others", but they never trigger a
 * message on their own.
 */
const QUIET_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'TaskList',
  'TaskGet',
  'NotebookRead',
  'SearchExtraTools',
])

/**
 * Minimum gap between tool-status messages.
 *
 * PreToolUse fires per tool call, and a single turn routinely makes dozens —
 * relaying each one floods the chat. Status is coalesced into at most one
 * message per window, carrying the current tool plus how many went by since
 * the last update.
 */
const TOOL_STATUS_THROTTLE_MS = 45_000

interface RelayState {
  lastToolStatusAt: number
  skipped: number
}

function relayStatePath(): string {
  return join(stateDirPath(), 'relay-state.json')
}

function loadRelayState(): RelayState {
  const path = relayStatePath()
  if (!existsSync(path)) return { lastToolStatusAt: 0, skipped: 0 }
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<RelayState>
    return {
      lastToolStatusAt: parsed.lastToolStatusAt ?? 0,
      skipped: parsed.skipped ?? 0,
    }
  } catch {
    return { lastToolStatusAt: 0, skipped: 0 }
  }
}

function saveRelayState(state: RelayState): void {
  try {
    getStateDir()
    writeFileSync(relayStatePath(), JSON.stringify(state), 'utf-8')
  } catch {
    // Throttling is best-effort; a failed write must not break the hook.
  }
}

export function resetRelayStateForTests(): void {
  saveRelayState({ lastToolStatusAt: 0, skipped: 0 })
}

/**
 * Decide whether this tool call should produce a status message.
 *
 * Each hook invocation is its own process, so the window is tracked on disk
 * rather than in memory.
 */
export function shouldSendToolStatus(
  toolName: string,
  now: number,
  state: RelayState,
  throttleMs = TOOL_STATUS_THROTTLE_MS,
):
  | { send: false; state: RelayState }
  | { send: true; skipped: number; state: RelayState } {
  if (QUIET_TOOLS.has(toolName)) {
    return { send: false, state: { ...state, skipped: state.skipped + 1 } }
  }
  // 0 means "never sent" — without this the first status of a session is
  // suppressed whenever `now` happens to be smaller than the window.
  if (
    state.lastToolStatusAt !== 0 &&
    now - state.lastToolStatusAt < throttleMs
  ) {
    return { send: false, state: { ...state, skipped: state.skipped + 1 } }
  }
  return {
    send: true,
    skipped: state.skipped,
    state: { lastToolStatusAt: now, skipped: 0 },
  }
}

const MAX_PREVIEW = 300

function preview(value: unknown, limit = MAX_PREVIEW): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? '') || ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Last assistant text in a JSONL transcript.
 *
 * Read backwards-ish (parse all, take the last match) because a turn's final
 * message is what a spectator wants, and transcripts are small enough that
 * streaming from the end is not worth the complexity.
 */
export function lastAssistantText(transcriptPath: string): string | null {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return null
  }

  let found: string | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: {
      type?: string
      message?: { role?: string; content?: unknown }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') {
      continue
    }
    const content = entry.message?.content
    const text = Array.isArray(content)
      ? content
          .filter(
            (b): b is { type: string; text: string } =>
              typeof b === 'object' &&
              b !== null &&
              (b as { type?: string }).type === 'text',
          )
          .map(b => b.text)
          .join('\n')
          .trim()
      : typeof content === 'string'
        ? content.trim()
        : ''
    if (text) found = text
  }
  return found
}

/**
 * Whether a prompt arrived through this channel rather than the terminal.
 *
 * Channel messages are injected as `<channel source="plugin:dingtalk:...">`.
 * Mirroring one back is an echo: the person who typed it in DingTalk sees
 * their own message quoted at them, and in group mode the whole group sees
 * every instruction twice. Only terminal input is worth relaying.
 */
export function isChannelEcho(prompt: string): boolean {
  return /<channel\b[^>]*\bsource\s*=\s*"plugin:dingtalk[:@"]/i.test(prompt)
}

/** Render a hook payload as the line a spectator should see, or null to skip. */
export function formatRelay(
  payload: HookPayload,
  skippedSinceLast = 0,
): {
  text: string
  markdown: boolean
  title: string
} | null {
  const event = payload.hook_event_name ?? ''

  switch (event) {
    case 'UserPromptSubmit': {
      const prompt = (payload.prompt ?? '').trim()
      if (!prompt) return null
      if (isChannelEcho(prompt)) return null
      return {
        text: `**🧑 你**\n\n${prompt}`,
        markdown: true,
        title: '你的指令',
      }
    }

    case 'Stop': {
      const reply = payload.transcript_path
        ? lastAssistantText(payload.transcript_path)
        : null
      if (!reply) return null
      return {
        text: `**🤖 ccb**\n\n${reply}`,
        markdown: true,
        title: 'ccb 回复',
      }
    }

    case 'PreToolUse': {
      if (!payload.tool_name) return null
      const others = skippedSinceLast > 0 ? `  (+${skippedSinceLast} 个)` : ''
      return {
        text: `⏳ ${payload.tool_name}  ${preview(payload.tool_input, 120)}${others}`,
        markdown: false,
        title: '执行中',
      }
    }

    case 'PostToolUse':
      // Success is already implied by the next status line or the final reply;
      // echoing every completion doubles the traffic for no new information.
      return null

    case 'PostToolUseFailure': {
      const kind = payload.is_timeout
        ? 'timed out'
        : payload.is_interrupt
          ? 'interrupted'
          : (payload.error_type ?? 'failed')
      return {
        text: `**❌ ${payload.tool_name ?? 'tool'} ${kind}**\n\n${preview(payload.error)}`,
        markdown: true,
        title: '工具出错',
      }
    }

    case 'StopFailure':
      return {
        text: `**⚠️ 这一轮因错误结束**\n\n${payload.error ?? 'unknown'}`,
        markdown: true,
        title: '轮次中断',
      }

    case 'SessionEnd':
      return {
        text: `🔚 会话结束${payload.reason ? `（${payload.reason}）` : ''}`,
        markdown: false,
        title: '会话结束',
      }

    default:
      return null
  }
}

/**
 * Deliver one relay message to the bound conversation.
 *
 * Silently does nothing when the channel is unbound or the category is off —
 * a hook must never fail the turn it is attached to.
 */
export async function relayHookPayload(payload: HookPayload): Promise<void> {
  const event = payload.hook_event_name ?? ''
  const category = relayCategory(event)
  if (!category) return

  const config = loadChannelConfig()
  if (!config.relay[category]) return

  const chatId = outboundTarget(config)
  if (!chatId) return

  const account = loadAccount()
  if (!account) return

  let skipped = 0
  if (category === 'toolStatus') {
    const decision = shouldSendToolStatus(
      payload.tool_name ?? '',
      Date.now(),
      loadRelayState(),
    )
    saveRelayState(decision.state)
    if (!decision.send) return
    skipped = decision.skipped
  }

  const rendered = formatRelay(payload, skipped)
  if (!rendered) return

  const target = {
    chatId,
    conversationType:
      config.mode === 'group'
        ? ConversationType.GROUP
        : ConversationType.SINGLE,
    senderId: config.boundUserId,
  }

  if (rendered.markdown) {
    await sendMarkdown({
      account,
      target,
      title: rendered.title,
      text: rendered.text,
    })
  } else {
    await sendText({ account, target, text: rendered.text })
  }
}
