import { getAccessToken } from './api.js'
import { handleChannelCommand } from './commands.js'
import {
  acceptsInbound,
  isBound,
  isMirrorOnly,
  loadChannelConfig,
} from './config.js'
import { categoryForMsgType, downloadInboundFile } from './media.js'
import {
  addPendingPairing,
  checkAccess,
  isConversationBound,
  senderIdentity,
} from './pairing.js'
import { consumePendingPermission } from './permissions.js'
import { sendText } from './send.js'
import { ConversationType, InboundMsgType } from './types.js'
import type { AccountData } from './accounts.js'
import type { DingtalkMessage, ParsedMessage } from './types.js'

// Matches the canonical definition in src/services/mcp/channelPermissions.ts.
// The 5-letter class excludes `l` to avoid 1/l confusion when read off a phone.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export type PermissionBehavior = 'allow' | 'deny'

export interface PermissionResponse {
  requestId: string
  behavior: PermissionBehavior
  fromChatId: string
}

export type OnMessageCallback = (msg: ParsedMessage) => Promise<void>
export type OnPermissionResponseCallback = (
  response: PermissionResponse,
) => Promise<void>

/**
 * Live session webhooks, keyed by conversation.
 *
 * Lets `reply` answer a conversation without an access token, and lets a
 * permission prompt reach the chat that triggered it.
 */
const sessionWebhooks = new Map<
  string,
  { webhook: string; expiresAt: number }
>()

export function getSessionWebhook(chatId: string): string | undefined {
  const entry = sessionWebhooks.get(chatId)
  if (!entry) return undefined
  if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
    sessionWebhooks.delete(chatId)
    return undefined
  }
  return entry.webhook
}

export function rememberSessionWebhook(
  chatId: string,
  webhook: string,
  expiresAt = 0,
): void {
  sessionWebhooks.set(chatId, { webhook, expiresAt })
}

export function clearMonitorStateForTests(): void {
  sessionWebhooks.clear()
}

export function extractPermissionReply(
  text: string,
): { behavior: PermissionBehavior; requestId: string } | null {
  const match = PERMISSION_REPLY_RE.exec(text)
  if (!match) return null
  const verb = match[1]!.toLowerCase()
  return {
    behavior: verb === 'y' || verb === 'yes' ? 'allow' : 'deny',
    requestId: match[2]!,
  }
}

/**
 * DingTalk prefixes group messages with the @-mention text. Strip it so the
 * agent sees the actual instruction rather than its own name.
 */
export function stripAtMention(text: string, robotNick?: string): string {
  let result = text
  if (robotNick) {
    result = result.split(`@${robotNick}`).join(' ')
  }
  return (
    result
      .replace(/^\s*@\S+\s*/, '')
      // Removing a mid-sentence mention leaves a gap. Collapse runs of spaces
      // and tabs only — newlines carry meaning in pasted code and logs.
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  )
}

/** Pull the human-readable text out of any inbound message shape. */
export function extractText(msg: DingtalkMessage): string {
  if (msg.text?.content) return msg.text.content
  if (msg.richText) {
    return msg.richText
      .map(part => part.text ?? '')
      .filter(Boolean)
      .join('')
  }
  // DingTalk transcribes voice server-side; surface it as text so the agent
  // can act on a spoken instruction without a local STT pass.
  if (msg.content?.recognition) {
    return `[Voice transcription]: ${msg.content.recognition}`
  }
  return ''
}

export interface ProcessContext {
  account: AccountData
  onMessage: OnMessageCallback
  onPermissionResponse?: OnPermissionResponseCallback
  robotNick?: string
  signal?: AbortSignal
}

/**
 * Turn one raw Stream payload into either a permission response, a pairing
 * challenge, or a channel message.
 */
export async function processMessage(
  msg: DingtalkMessage,
  ctx: ProcessContext,
): Promise<void> {
  const chatId = msg.conversationId
  if (!chatId) return

  // Several ccb instances sharing one robot each get their own Stream
  // connection; a bound instance ignores conversations that are not its own.
  if (!isConversationBound(chatId)) {
    process.stderr.write(
      `[dingtalk] Ignoring message from unbound conversation ${chatId}\n`,
    )
    return
  }

  // The channel binding is the outer gate: in private mode only the bound
  // person's 1:1 chat drives the session, in group mode only the bound group.
  // Everything downstream (pairing, permissions) operates inside that scope.
  const channel = loadChannelConfig()

  // Spectator groups are read-only by construction: they see the mirror, but
  // nothing typed there reaches the agent. Adding the bot to a wide team group
  // must never hand that group the ability to run commands.
  if (isMirrorOnly(channel, chatId)) {
    process.stderr.write(
      `[dingtalk] Ignoring input from mirror-only group ${chatId}\n`,
    )
    return
  }

  const verdict = acceptsInbound(channel, msg)
  if (!verdict.ok) {
    process.stderr.write(`[dingtalk] Rejected inbound: ${verdict.reason}\n`)
    // An unbound channel is an operator error, not a stranger knocking — say so
    // in the chat so it is discoverable without reading stderr.
    if (!isBound(channel) && msg.sessionWebhook) {
      try {
        await sendText({
          account: ctx.account,
          target: {
            chatId,
            conversationType: msg.conversationType || ConversationType.SINGLE,
            sessionWebhook: msg.sessionWebhook,
            senderId: msg.senderStaffId || msg.senderId,
          },
          text: 'This ccb channel is not bound yet. Run `ccb dingtalk bind` on the machine running ccb, then send this message again.',
          signal: ctx.signal,
        })
      } catch {
        // best-effort notice
      }
    }
    return
  }

  // senderStaffId (org userId) is absent for external contacts and for members
  // of other orgs in a shared group — those fall back to the opaque senderId,
  // kept in a separate namespace so the two can never collide.
  const identity = senderIdentity(msg)
  if (!identity) return
  const senderId = identity.raw

  if (msg.sessionWebhook) {
    rememberSessionWebhook(
      chatId,
      msg.sessionWebhook,
      msg.sessionWebhookExpiredTime ?? 0,
    )
  }

  const conversationType = msg.conversationType || ConversationType.SINGLE
  const target = {
    chatId,
    conversationType,
    sessionWebhook: msg.sessionWebhook,
    senderId,
  }

  const access = checkAccess(identity)
  if (!access.allowed) {
    // An external sender is refused outright rather than offered a code: a
    // pairing code implies the identity is worth binding, and an opaque
    // senderId is not one we can vouch for.
    let text: string
    if (access.reason === 'external-not-permitted') {
      text = [
        'This robot only accepts messages from members of its own organization.',
        '',
        'If you are the operator and want to allow external senders, set',
        '"allowExternal": true in ~/.ccb/channels/dingtalk/access.json.',
      ].join('\n')
    } else {
      const code = addPendingPairing(identity.key)
      text = [
        'This robot is not paired with you yet.',
        '',
        `Your pairing code is: ${code}`,
        '',
        'Ask the operator to confirm on the machine running ccb:',
        `  ccb dingtalk access pair ${code}`,
      ].join('\n')
    }

    try {
      await sendText({ account: ctx.account, target, text, signal: ctx.signal })
    } catch (error) {
      process.stderr.write(
        `[dingtalk] Failed to send access notice: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    return
  }

  const rawText = extractText(msg)
  const text =
    conversationType === ConversationType.GROUP
      ? stripAtMention(rawText, ctx.robotNick)
      : rawText.trim()

  // Channel commands are answered here rather than by the agent: the binding
  // and relay switches are known only to this process, and answering locally
  // also works while the agent is mid-run.
  if (text) {
    const handled = handleChannelCommand(text)
    if (handled) {
      try {
        await sendText({
          account: ctx.account,
          target,
          text: handled.reply,
          signal: ctx.signal,
        })
      } catch (error) {
        process.stderr.write(
          `[dingtalk] Failed to answer channel command: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
      return
    }
  }

  // A permission verdict is a control message, not a prompt — consume it and
  // return so it never reaches the model as user input.
  if (text && ctx.onPermissionResponse) {
    const reply = extractPermissionReply(text)
    if (reply) {
      const pending = consumePendingPermission(reply.requestId, chatId)
      if (pending) {
        await ctx.onPermissionResponse({
          requestId: pending.request_id,
          behavior: reply.behavior,
          fromChatId: chatId,
        })
        return
      }
    }
  }

  let attachmentPath: string | undefined
  let attachmentType: string | undefined

  const category = categoryForMsgType(msg.msgtype || InboundMsgType.TEXT)
  if (category && msg.content?.downloadCode) {
    const token = await getAccessToken({
      appKey: ctx.account.appKey,
      appSecret: ctx.account.appSecret,
      baseUrl: ctx.account.baseUrl,
      signal: ctx.signal,
    })
    const downloaded = await downloadInboundFile({
      token,
      robotCode: msg.robotCode || ctx.account.robotCode,
      downloadCode: msg.content.downloadCode,
      category,
      fileName: msg.content.fileName,
      baseUrl: ctx.account.baseUrl,
      signal: ctx.signal,
    })
    if (downloaded) {
      attachmentPath = downloaded.path
      attachmentType = downloaded.type
    }
  }

  if (!text && !attachmentPath) return

  await ctx.onMessage({
    chatId,
    senderId,
    senderNick: msg.senderNick,
    conversationTitle: msg.conversationTitle,
    messageId: String(msg.msgId || ''),
    text: text || '(media attachment)',
    conversationType,
    attachmentPath,
    attachmentType,
  })
}
