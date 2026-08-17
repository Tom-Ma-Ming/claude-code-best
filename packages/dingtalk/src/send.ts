import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  getAccessToken,
  sendToConversation,
  sendViaWebhook,
  uploadMedia,
} from './api.js'
import { guessMediaCategory } from './media.js'
import { ConversationType, OutboundMsgKey } from './types.js'
import type { AccountData } from './accounts.js'

/**
 * DingTalk caps a single text message well below what a coding agent will
 * happily emit. Split rather than let the API truncate mid-sentence.
 */
const MAX_TEXT_LENGTH = 4000

export function splitText(text: string, limit = MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Prefer a paragraph break, then a line break, then a hard cut.
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Where a reply should go, and how it can get there. */
export interface SendTarget {
  chatId: string
  conversationType: string
  /** Live session webhook, when the send is a reply to a recent message. */
  sessionWebhook?: string
  /** Staff ID — needed for token-based 1:1 sends. */
  senderId?: string
}

async function tokenFor(account: AccountData): Promise<string> {
  return getAccessToken({
    appKey: account.appKey,
    appSecret: account.appSecret,
    baseUrl: account.baseUrl,
  })
}

/**
 * Send one payload, preferring the session webhook and falling back to the
 * token API when it is absent or rejected.
 *
 * The fallback matters in practice: `sessionWebhook` dies after ~1.5h, which
 * is well inside the lifetime of a long agent session.
 */
async function deliver(params: {
  account: AccountData
  target: SendTarget
  /** Webhook-shaped body (msgtype/text/markdown). */
  webhookBody: Record<string, unknown>
  /** Token-API equivalent. */
  msgKey: string
  msgParam: Record<string, unknown>
  signal?: AbortSignal
}): Promise<void> {
  const { account, target, webhookBody, msgKey, msgParam, signal } = params

  if (target.sessionWebhook) {
    try {
      const resp = await sendViaWebhook({
        webhook: target.sessionWebhook,
        body: webhookBody,
        signal,
      })
      if (!resp.errcode) return
      process.stderr.write(
        `[dingtalk] sessionWebhook rejected (errcode=${resp.errcode} ${resp.errmsg || ''}), falling back to token API\n`,
      )
    } catch (error) {
      process.stderr.write(
        `[dingtalk] sessionWebhook failed (${error instanceof Error ? error.message : String(error)}), falling back to token API\n`,
      )
    }
  }

  const token = await tokenFor(account)
  const isGroup = target.conversationType === ConversationType.GROUP

  await sendToConversation({
    token,
    robotCode: account.robotCode,
    openConversationId: isGroup ? target.chatId : undefined,
    userIds: isGroup ? undefined : target.senderId ? [target.senderId] : [],
    msgKey,
    msgParam,
    baseUrl: account.baseUrl,
    signal,
  })
}

export async function sendText(params: {
  account: AccountData
  target: SendTarget
  text: string
  signal?: AbortSignal
}): Promise<void> {
  const { account, target, text, signal } = params
  for (const chunk of splitText(text)) {
    await deliver({
      account,
      target,
      webhookBody: { msgtype: 'text', text: { content: chunk } },
      msgKey: OutboundMsgKey.TEXT,
      msgParam: { content: chunk },
      signal,
    })
  }
}

export async function sendMarkdown(params: {
  account: AccountData
  target: SendTarget
  title: string
  text: string
  signal?: AbortSignal
}): Promise<void> {
  const { account, target, title, text, signal } = params
  for (const chunk of splitText(text)) {
    await deliver({
      account,
      target,
      webhookBody: { msgtype: 'markdown', markdown: { title, text: chunk } },
      msgKey: OutboundMsgKey.MARKDOWN,
      msgParam: { title, text: chunk },
      signal,
    })
  }
}

/**
 * Upload a local file and post it to the conversation.
 *
 * Always goes through the token API — the session webhook cannot carry
 * media_id payloads.
 */
export async function sendMediaFile(params: {
  account: AccountData
  target: SendTarget
  filePath: string
  signal?: AbortSignal
}): Promise<void> {
  const { account, target, filePath, signal } = params

  const category = guessMediaCategory(filePath)
  const fileName = basename(filePath)
  const data = new Uint8Array(await readFile(filePath))
  const token = await tokenFor(account)

  const mediaId = await uploadMedia({
    token,
    type: category,
    fileName,
    data,
    signal,
  })

  const { msgKey, msgParam } = mediaPayload(category, mediaId, fileName)
  const isGroup = target.conversationType === ConversationType.GROUP

  await sendToConversation({
    token,
    robotCode: account.robotCode,
    openConversationId: isGroup ? target.chatId : undefined,
    userIds: isGroup ? undefined : target.senderId ? [target.senderId] : [],
    msgKey,
    msgParam,
    baseUrl: account.baseUrl,
    signal,
  })
}

export function mediaPayload(
  category: string,
  mediaId: string,
  fileName: string,
): { msgKey: string; msgParam: Record<string, unknown> } {
  switch (category) {
    case 'image':
      return {
        msgKey: OutboundMsgKey.IMAGE,
        msgParam: { photoURL: mediaId },
      }
    case 'voice':
      return {
        msgKey: OutboundMsgKey.AUDIO,
        msgParam: { mediaId, duration: '0' },
      }
    case 'video':
      return {
        msgKey: OutboundMsgKey.VIDEO,
        msgParam: { videoMediaId: mediaId, videoType: 'mp4', duration: '0' },
      }
    default: {
      // `split('.').pop()` returns the whole name for extensionless files
      // (LICENSE, Makefile), which DingTalk rejects as a fileType.
      const dot = fileName.lastIndexOf('.')
      const ext = dot > 0 ? fileName.slice(dot + 1) : ''
      return {
        msgKey: OutboundMsgKey.FILE,
        msgParam: { mediaId, fileName, fileType: ext || 'txt' },
      }
    }
  }
}
