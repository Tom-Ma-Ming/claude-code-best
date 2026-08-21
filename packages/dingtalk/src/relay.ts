import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getStateDir, loadAccount, stateDirPath } from './accounts.js'
import {
  DEFAULT_PROGRESS_AFTER_MS,
  loadChannelConfig,
  relayTargets,
} from './config.js'
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
      // PreToolUse is the only per-tool signal we get, so it doubles as the
      // clock that decides whether a run has become slow enough to announce.
      return 'toolCalls'
    case 'PostToolUseFailure':
      // A failed tool is usually recovered from within the same run; only the
      // turn dying is worth interrupting a chat for.
      return 'toolCalls'
    case 'StopFailure':
      return 'errors'
    case 'SessionStart':
    case 'SessionEnd':
      return 'session'
    default:
      return null
  }
}

/**
 * Per-run relay state.
 *
 * Each hook invocation is its own process, so "has this run already reported
 * progress" lives on disk keyed by session.
 */
interface RelayState {
  /** Session whose run is in flight. */
  runSession: string
  /** When that run started (UserPromptSubmit). */
  runStartedAt: number
  /** Whether the single progress note has already gone out for this run. */
  progressSent: boolean
  /** Tool calls seen in this run, reported alongside the progress note. */
  toolCount: number
}

const EMPTY_STATE: RelayState = {
  runSession: '',
  runStartedAt: 0,
  progressSent: false,
  toolCount: 0,
}

function relayStatePath(): string {
  return join(stateDirPath(), 'relay-state.json')
}

function loadRelayState(): RelayState {
  const path = relayStatePath()
  if (!existsSync(path)) return { ...EMPTY_STATE }
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<RelayState>
    return { ...EMPTY_STATE, ...parsed }
  } catch {
    return { ...EMPTY_STATE }
  }
}

function saveRelayState(state: RelayState): void {
  try {
    getStateDir()
    writeFileSync(relayStatePath(), JSON.stringify(state), 'utf-8')
  } catch {
    // Progress tracking is best-effort; a failed write must not break the hook.
  }
}

export function resetRelayStateForTests(): void {
  saveRelayState({ ...EMPTY_STATE })
}

/**
 * Decide whether a tool call should trigger the run's progress note.
 *
 * Exactly one note per run, and only once the run has outlived
 * `progressAfterMs`. A fast run that happened to call thirty tools stays
 * silent — what a spectator wants to know is that something is taking a
 * while, not what it is doing.
 */
export function shouldSendProgress(params: {
  sessionId: string
  now: number
  state: RelayState
  progressAfterMs: number
}):
  | { send: false; state: RelayState }
  | { send: true; elapsedMs: number; toolCount: number; state: RelayState } {
  const { sessionId, now, state, progressAfterMs } = params
  const sameRun = state.runSession === sessionId && state.runStartedAt > 0
  const base: RelayState = sameRun
    ? { ...state, toolCount: state.toolCount + 1 }
    : {
        runSession: sessionId,
        runStartedAt: now,
        progressSent: false,
        toolCount: 1,
      }

  if (progressAfterMs <= 0) return { send: false, state: base }
  if (base.progressSent) return { send: false, state: base }
  if (now - base.runStartedAt < progressAfterMs)
    return { send: false, state: base }

  return {
    send: true,
    elapsedMs: now - base.runStartedAt,
    toolCount: base.toolCount,
    state: { ...base, progressSent: true },
  }
}

/** Mark the start of a run so the progress clock is anchored to the prompt. */
export function beginRun(sessionId: string, now: number): RelayState {
  return {
    runSession: sessionId,
    runStartedAt: now,
    progressSent: false,
    toolCount: 0,
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
  progress?: { elapsedMs: number; toolCount: number },
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
      // Rendered only when shouldSendProgress() let it through, i.e. the run
      // has been going a while. Carries no tool name and no tool_input: the
      // command line and the diff are the work itself, and a progress ping
      // must not broadcast them to whoever is watching the chat.
      const secs = Math.round((progress?.elapsedMs ?? 0) / 1000)
      const tools = progress?.toolCount ?? 0
      return {
        text: `⏳ 任务还在进行中（${secs}s，${tools} 个工具），完成后会把结果发给你。`,
        markdown: false,
        title: '处理中',
      }
    }

    case 'PostToolUse':
      // Success is implied by the final reply; echoing every completion
      // doubles the traffic for no new information.
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

    case 'SessionStart': {
      const where = payload.cwd ? basename(payload.cwd) : ''
      return {
        text: `▶️ 会话开始${where ? ` · ${where}` : ''}`,
        markdown: false,
        title: '会话开始',
      }
    }

    case 'SessionEnd': {
      // Name the project: with one robot per project you still end up watching
      // several chats, and "会话结束" alone does not say which one stopped.
      const where = payload.cwd ? basename(payload.cwd) : ''
      const why = payload.reason ? `（${payload.reason}）` : ''
      return {
        text: `🔚 会话结束${where ? ` · ${where}` : ''}${why}`,
        markdown: false,
        title: '会话结束',
      }
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

  // Fan out to the driving conversation and every spectator group.
  const targets = relayTargets(config)
  if (targets.length === 0) return

  const account = loadAccount()
  if (!account) return

  // A prompt anchors the run clock: the progress note measures how long the
  // run has taken, not how long since the last tool.
  if (event === 'UserPromptSubmit') {
    saveRelayState(beginRun(payload.session_id ?? '', Date.now()))
  }

  let progress: { elapsedMs: number; toolCount: number } | undefined
  if (event === 'PreToolUse') {
    if (!config.relay.progress) return
    const decision = shouldSendProgress({
      sessionId: payload.session_id ?? '',
      now: Date.now(),
      state: loadRelayState(),
      progressAfterMs: config.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS,
    })
    saveRelayState(decision.state)
    if (!decision.send) return
    progress = { elapsedMs: decision.elapsedMs, toolCount: decision.toolCount }
  }

  const rendered = formatRelay(payload, progress)
  if (!rendered) return

  for (const chatId of targets) {
    const target = {
      chatId,
      conversationType:
        chatId === config.boundConversationId && config.mode === 'private'
          ? ConversationType.SINGLE
          : ConversationType.GROUP,
      senderId: config.boundUserId,
    }
    try {
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
    } catch (error) {
      // One unreachable spectator group must not stop the others.
      process.stderr.write(
        `[dingtalk] relay to ${chatId} failed: ${error instanceof Error ? error.message : String(error)}
`,
      )
    }
  }
}
