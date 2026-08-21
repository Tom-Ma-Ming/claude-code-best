import { loadAccount } from './accounts.js'
import {
  loadChannelConfig,
  saveChannelConfig,
  type ChannelMode,
} from './config.js'
import { sendText } from './send.js'
import { runStreamClient } from './stream.js'
import { ConversationType } from './types.js'
import type { DingtalkMessage } from './types.js'

export interface BindResult {
  senderStaffId?: string
  senderId?: string
  senderNick?: string
  conversationId: string
  conversationType: string
  conversationTitle?: string
}

/**
 * Wait for the next inbound message and report who sent it from where.
 *
 * DingTalk publishes no deep link that opens an internal-app robot's chat, so
 * there is nothing meaningful to put in a QR code — the operator finds the
 * robot by name and sends one message, which carries the same identity a scan
 * would have.
 */
export async function waitForFirstMessage(params: {
  timeoutMs?: number
  onWaiting?: () => void
}): Promise<BindResult | null> {
  const account = loadAccount()
  if (!account)
    throw new Error('No credentials. Run `ccb dingtalk login` first.')

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? 180_000,
  )

  let result: BindResult | null = null

  const stream = runStreamClient({
    appKey: account.appKey,
    appSecret: account.appSecret,
    baseUrl: account.baseUrl,
    abortSignal: controller.signal,
    onMessage: async payload => {
      if (result) return
      const msg = payload as DingtalkMessage
      if (!msg.conversationId) return
      result = {
        senderStaffId: msg.senderStaffId,
        senderId: msg.senderId,
        senderNick: msg.senderNick,
        conversationId: msg.conversationId,
        conversationType: msg.conversationType || ConversationType.SINGLE,
        conversationTitle: msg.conversationTitle,
      }
      controller.abort()
    },
  })

  params.onWaiting?.()
  await stream
  clearTimeout(timeout)
  return result
}

/**
 * Persist a binding.
 *
 * The mode is taken from what actually arrived rather than asked for up front:
 * a message from a group can only mean group mode, and DingTalk reports even a
 * two-person group as `group`, so inferring is more reliable than trusting the
 * operator's mental model of which chat they used.
 */
/**
 * Confirm the binding by actually sending to it.
 *
 * Recording a binding that cannot be delivered to is worse than failing: the
 * inbound path keeps working (replies ride the session webhook), so the break
 * only shows up later as relayed messages silently vanishing.
 */
export async function verifyBinding(
  result: BindResult,
  mode: ChannelMode,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const account = loadAccount()
  if (!account) return { ok: false, reason: 'no credentials' }

  try {
    await sendText({
      account,
      target: {
        chatId: result.conversationId,
        conversationType:
          mode === 'group' ? ConversationType.GROUP : ConversationType.SINGLE,
        senderId: result.senderStaffId,
      },
      text: '✅ ccb 已绑定到这个会话。',
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function applyBinding(
  result: BindResult,
  profile?: string,
  modeOverride?: ChannelMode,
): { mode: ChannelMode; warning?: string } {
  const inferred: ChannelMode =
    result.conversationType === ConversationType.GROUP ? 'group' : 'private'
  const mode = modeOverride ?? inferred

  let warning: string | undefined
  if (mode === 'private' && inferred === 'group') {
    warning =
      'That message came from a group, but private mode was requested. ' +
      'Private mode only accepts the bound 1:1 conversation, so this binding will ignore the group.'
  }
  if (mode === 'private' && !result.senderStaffId) {
    warning =
      'The sender has no senderStaffId (external contact). Private mode binds ' +
      'on the org staff id, so this binding cannot be completed reliably.'
  }

  const config = loadChannelConfig(profile)
  saveChannelConfig(
    {
      ...config,
      mode,
      boundUserId: result.senderStaffId,
      boundUserNick: result.senderNick,
      boundConversationId: result.conversationId,
    },
    profile,
  )

  return { mode, warning }
}
