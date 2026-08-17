import { getAccessToken } from './api.js'
import { categoryForMsgType, downloadInboundFile } from './media.js'
import { addPendingPairing, isAllowed } from './pairing.js'
import {
  consumePendingPermission,
  setActivePermissionChat,
} from './permissions.js'
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

  // senderStaffId is empty for external contacts; senderId always exists.
  const senderId = msg.senderStaffId || msg.senderId
  if (!senderId) return

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

  if (!isAllowed(senderId)) {
    const code = addPendingPairing(senderId)
    try {
      await sendText({
        account: ctx.account,
        target,
        text: [
          'This robot is not paired with you yet.',
          '',
          `Your pairing code is: ${code}`,
          '',
          'Ask the operator to confirm on the machine running ccb:',
          `  ccb dingtalk access pair ${code}`,
        ].join('\n'),
        signal: ctx.signal,
      })
    } catch (error) {
      process.stderr.write(
        `[dingtalk] Failed to send pairing code: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    return
  }

  setActivePermissionChat(chatId, msg.sessionWebhook)

  const rawText = extractText(msg)
  const text =
    conversationType === ConversationType.GROUP
      ? stripAtMention(rawText, ctx.robotNick)
      : rawText.trim()

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
    messageId: String(msg.msgId || ''),
    text: text || '(media attachment)',
    conversationType,
    attachmentPath,
    attachmentType,
  })
}
