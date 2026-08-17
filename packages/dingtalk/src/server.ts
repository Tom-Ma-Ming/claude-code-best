import { existsSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { loadAccount } from './accounts.js'
import {
  getSessionWebhook,
  processMessage,
  type PermissionResponse,
} from './monitor.js'
import {
  getActivePermissionChat,
  savePendingPermission,
} from './permissions.js'
import { sendMarkdown, sendMediaFile, sendText } from './send.js'
import { runStreamClient } from './stream.js'
import { ConversationType } from './types.js'
import type { AccountData } from './accounts.js'
import type { ChannelPermissionRequestParams } from './permissions.js'
import type { DingtalkMessage, ParsedMessage } from './types.js'

export interface DingtalkServerDeps {
  enableConfigs(): void
  initializeAnalyticsSink(): void
  shutdownDatadog(): Promise<void>
  shutdown1PEventLogging(): Promise<void>
  logForDebugging(message: string): void
  registerPermissionHandler(
    server: Server,
    handler: (request: ChannelPermissionRequestParams) => Promise<void>,
  ): void
}

function formatPermissionRequestMessage(
  request: ChannelPermissionRequestParams,
): string {
  return [
    'Claude Code needs your approval.',
    '',
    `Tool: ${request.tool_name}`,
    `Reason: ${request.description}`,
    `Input: ${request.input_preview}`,
    '',
    `Reply with: yes ${request.request_id}`,
    `Or deny with: no ${request.request_id}`,
  ].join('\n')
}

/**
 * Conversation type per chat, learned from inbound messages.
 *
 * Needed because the reply path picks a different endpoint for group vs 1:1,
 * and the `reply` tool only receives a chat_id.
 */
const conversationTypes = new Map<string, string>()
const senderIds = new Map<string, string>()

export function rememberConversation(
  chatId: string,
  conversationType: string,
  senderId: string,
): void {
  conversationTypes.set(chatId, conversationType)
  senderIds.set(chatId, senderId)
}

function targetFor(chatId: string): {
  chatId: string
  conversationType: string
  sessionWebhook?: string
  senderId?: string
} {
  return {
    chatId,
    conversationType: conversationTypes.get(chatId) ?? ConversationType.SINGLE,
    sessionWebhook: getSessionWebhook(chatId),
    senderId: senderIds.get(chatId),
  }
}

export function createDingtalkMcpServer(version: string): Server {
  const server = new Server(
    { name: 'dingtalk', version },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions: [
        'Messages from DingTalk arrive as <channel source="plugin:dingtalk:dingtalk" chat_id="..." sender_id="..." conversation_type="single|group" conversation_title="...">.',
        '',
        'Each distinct chat_id is a SEPARATE conversation with a different audience:',
        '  · conversation_type="single" is a private 1:1 chat with one person.',
        '  · conversation_type="group" is a group chat; conversation_title names it.',
        '',
        'Always reply with the reply tool using the chat_id of the message you are',
        "answering. Never send one conversation's reply to another chat_id, and do",
        'not repeat what was said in one conversation into another — participants',
        'cannot see each other and may not be entitled to that content.',
        '',
        'Use absolute paths for file attachments.',
      ].join('\n'),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply to a DingTalk message. Pass the chat_id from the channel tag.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: {
              type: 'string',
              description: 'The chat_id from the channel notification',
            },
            text: { type: 'string', description: 'The reply text' },
            markdown: {
              type: 'boolean',
              description:
                'Render as a DingTalk markdown card instead of plain text',
            },
            title: {
              type: 'string',
              description: 'Card title, used only when markdown is true',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional absolute file paths to attach',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params
    const account = loadAccount()
    if (!account) {
      return {
        content: [
          {
            type: 'text',
            text: 'DingTalk not configured. Run `ccb dingtalk login` first.',
          },
        ],
        isError: true,
      }
    }

    if (name !== 'reply') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
    }

    const chatId = typeof args?.chat_id === 'string' ? args.chat_id : ''
    const text = typeof args?.text === 'string' ? args.text : ''
    const useMarkdown = args?.markdown === true
    const title = typeof args?.title === 'string' ? args.title : 'Claude Code'
    const files = Array.isArray(args?.files)
      ? args.files.filter((v): v is string => typeof v === 'string')
      : undefined

    if (!chatId || !text) {
      return {
        content: [{ type: 'text', text: 'Missing chat_id or text parameter.' }],
        isError: true,
      }
    }

    const target = targetFor(chatId)

    try {
      if (useMarkdown) {
        await sendMarkdown({ account, target, title, text })
      } else {
        await sendText({ account, target, text })
      }

      if (files && files.length > 0) {
        for (const filePath of files) {
          if (!existsSync(filePath)) {
            return {
              content: [{ type: 'text', text: `File not found: ${filePath}` }],
              isError: true,
            }
          }
          await sendMediaFile({ account, target, filePath })
        }
        return {
          content: [{ type: 'text', text: 'Message sent with attachments.' }],
        }
      }

      return { content: [{ type: 'text', text: 'Message sent.' }] }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to send: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

export async function runDingtalkMcpServer(
  version: string,
  deps: DingtalkServerDeps,
): Promise<void> {
  deps.enableConfigs()
  deps.initializeAnalyticsSink()

  const account = loadAccount()
  if (!account) {
    process.stderr.write(
      '[dingtalk] No credentials configured. Run `ccb dingtalk login` to connect your DingTalk app.\n',
    )
    await Promise.all([deps.shutdown1PEventLogging(), deps.shutdownDatadog()])
    process.exit(1)
  }

  const server = createDingtalkMcpServer(version)
  const transport = new StdioServerTransport()

  deps.registerPermissionHandler(server, async request => {
    const requestedChatId = request.channel_context?.chat_id
    const chatId = requestedChatId ?? getActivePermissionChat()?.chatId

    if (!chatId) {
      deps.logForDebugging(
        `[DingTalk MCP] No active chat available for permission request ${request.request_id}`,
      )
      return
    }

    try {
      savePendingPermission(request, chatId, getSessionWebhook(chatId))
      await sendText({
        account,
        target: targetFor(chatId),
        text: formatPermissionRequestMessage(request),
      })
    } catch (error) {
      process.stderr.write(
        `[dingtalk] Failed to relay permission request ${request.request_id}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  })

  await server.connect(transport)

  const controller = new AbortController()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    if (!controller.signal.aborted) {
      controller.abort()
    }
    await Promise.all([deps.shutdown1PEventLogging(), deps.shutdownDatadog()])
    process.exit(0)
  }

  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())
  process.on('SIGINT', () => void shutdownAndExit())
  process.on('SIGTERM', () => void shutdownAndExit())
  process.on('SIGHUP', () => void shutdownAndExit())

  // The MCP host may die without closing stdio (SIGKILL); without this the
  // stream client would keep the socket open forever.
  const ppid = process.ppid
  const parentCheck = setInterval(() => {
    try {
      process.kill(ppid, 0)
    } catch {
      process.stderr.write(
        '[dingtalk] Parent process exited, shutting down...\n',
      )
      clearInterval(parentCheck)
      void shutdownAndExit()
    }
  }, 5000)

  const onMessage = async (msg: ParsedMessage): Promise<void> => {
    rememberConversation(msg.chatId, msg.conversationType, msg.senderId)
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: msg.text,
        meta: {
          chat_id: msg.chatId,
          sender_id: msg.senderId,
          message_id: msg.messageId,
          // Without these the model sees two opaque chat_ids and cannot tell a
          // private chat from a group, which is how replies end up in the
          // wrong conversation.
          conversation_type:
            msg.conversationType === ConversationType.GROUP
              ? 'group'
              : 'single',
          ...(msg.conversationTitle && {
            conversation_title: msg.conversationTitle,
          }),
          ...(msg.senderNick && { sender_name: msg.senderNick }),
          ...(msg.attachmentPath && { attachment_path: msg.attachmentPath }),
          ...(msg.attachmentType && { attachment_type: msg.attachmentType }),
        },
      },
    })
  }

  const onPermissionResponse = async (
    response: PermissionResponse,
  ): Promise<void> => {
    await server.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: response.requestId,
        behavior: response.behavior,
      },
    })
  }

  deps.logForDebugging('[DingTalk MCP] Starting stream client')
  await runStreamClient({
    appKey: account.appKey,
    appSecret: account.appSecret,
    baseUrl: account.baseUrl,
    abortSignal: controller.signal,
    onMessage: async payload => {
      await processMessage(payload as DingtalkMessage, {
        account: account as AccountData,
        onMessage,
        onPermissionResponse,
        signal: controller.signal,
      })
    },
  })

  clearInterval(parentCheck)
  await shutdownAndExit()
}
