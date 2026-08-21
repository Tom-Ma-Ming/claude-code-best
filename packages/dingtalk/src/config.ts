import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir, stateDirPath } from './accounts.js'

/**
 * How this ccb instance talks to DingTalk.
 *
 * `private` — one bound person, in their 1:1 chat with the robot. Nothing from
 * anyone else is acted on, and everything the session emits goes to them.
 *
 * `group` — one bound group. Everyone in it can watch; who may *drive* the
 * session is still governed by the pairing allowlist.
 */
export type ChannelMode = 'private' | 'group'

/** What a terminal session mirrors out to DingTalk ("围观模式"). */
export interface RelayConfig {
  /** Prompts typed in the terminal. */
  prompts: boolean
  /** The agent's reply at the end of each turn. */
  replies: boolean
  /**
   * One "still working" note per run, sent only if the run outlives
   * {@link progressAfterMs}.
   *
   * Time-based rather than tool-based: a run's length is what a spectator
   * actually wants to know about, and a fast run that happened to call thirty
   * tools should stay silent.
   */
  progress: boolean
  /**
   * Broadcast every tool invocation. Off by default — a normal run makes
   * dozens of calls, and relaying them buries the answer.
   */
  toolCalls: boolean
  /** Turn-level failures: the run died on an API error. */
  errors: boolean
  /** Session started / ended. Separate from errors: quitting is not a failure,
   *  and with several projects you need to know *which* one just stopped. */
  session: boolean
}

export interface ChannelConfig {
  mode: ChannelMode
  /** Staff id bound by `ccb dingtalk bind`. Required in private mode. */
  boundUserId?: string
  /** Display name of the bound user, for nicer status lines. */
  boundUserNick?: string
  /** Conversation to send into. Set by bind for both modes. */
  boundConversationId?: string
  relay: RelayConfig
  /** Override for {@link DEFAULT_PROGRESS_AFTER_MS}. */
  progressAfterMs?: number
}

export const DEFAULT_RELAY: RelayConfig = {
  prompts: true,
  replies: true,
  progress: true,
  toolCalls: false,
  errors: true,
  session: true,
}

/** How long a run must last before the single progress note is sent. 0 = off. */
export const DEFAULT_PROGRESS_AFTER_MS = 20_000

/**
 * Unbound default. `mode: private` with no bound user means "not configured
 * yet" — the channel refuses to act until bind runs, rather than defaulting to
 * answering whoever shows up first.
 */
export const DEFAULT_CONFIG: ChannelConfig = {
  mode: 'private',
  relay: { ...DEFAULT_RELAY },
}

function configPath(profile?: string): string {
  return join(stateDirPath(profile), 'config.json')
}

export function loadChannelConfig(profile?: string): ChannelConfig {
  const path = configPath(profile)
  if (!existsSync(path))
    return { ...DEFAULT_CONFIG, relay: { ...DEFAULT_RELAY } }
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<ChannelConfig>
    return {
      mode: parsed.mode === 'group' ? 'group' : 'private',
      boundUserId: parsed.boundUserId,
      boundUserNick: parsed.boundUserNick,
      boundConversationId: parsed.boundConversationId,
      relay: { ...DEFAULT_RELAY, ...(parsed.relay ?? {}) },
      progressAfterMs: parsed.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS,
    }
  } catch {
    return { ...DEFAULT_CONFIG, relay: { ...DEFAULT_RELAY } }
  }
}

export function saveChannelConfig(
  config: ChannelConfig,
  profile?: string,
): void {
  getStateDir(profile)
  writeFileSync(configPath(profile), JSON.stringify(config, null, 2), 'utf-8')
}

export function isBound(config: ChannelConfig): boolean {
  return config.mode === 'private'
    ? Boolean(config.boundUserId && config.boundConversationId)
    : Boolean(config.boundConversationId)
}

/**
 * Whether an inbound message may drive the session.
 *
 * Private mode is deliberately strict on both axes: the right person *and*
 * their 1:1 conversation. A message from the bound user inside some unrelated
 * group is not the bound channel and must not steer the session.
 */
export function acceptsInbound(
  config: ChannelConfig,
  msg: { senderStaffId?: string; conversationId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!isBound(config)) {
    return {
      ok: false,
      reason: 'channel is not bound — run `ccb dingtalk bind`',
    }
  }
  if (msg.conversationId !== config.boundConversationId) {
    return { ok: false, reason: 'message is not from the bound conversation' }
  }
  if (config.mode === 'private' && msg.senderStaffId !== config.boundUserId) {
    return { ok: false, reason: 'sender is not the bound user' }
  }
  return { ok: true }
}

/** Where outbound session traffic goes. Null until bind has run. */
export function outboundTarget(config: ChannelConfig): string | null {
  return isBound(config) ? (config.boundConversationId ?? null) : null
}
