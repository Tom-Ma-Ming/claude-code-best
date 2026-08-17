/** Mirrors ChannelPermissionRequestParams from src/services/mcp/channelNotification.ts */
export interface ChannelPermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  channel_context?: {
    source_server?: string
    chat_id?: string
  }
}

export type PendingPermissionRequest = ChannelPermissionRequestParams & {
  chatId: string
  sessionWebhook?: string
  createdAt: number
  expiresAt: number
}

export type ActivePermissionChat = {
  chatId: string
  sessionWebhook?: string
  updatedAt: number
}

const PENDING_PERMISSION_TTL_MS = 15 * 60 * 1000

const pendingPermissions = new Map<string, PendingPermissionRequest>()
let activePermissionChat: ActivePermissionChat | null = null

function pruneExpiredPendingPermissions(now = Date.now()): void {
  for (const [requestId, entry] of pendingPermissions.entries()) {
    if (entry.expiresAt <= now) {
      pendingPermissions.delete(requestId)
    }
  }
}

export function setActivePermissionChat(
  chatId: string,
  sessionWebhook?: string,
): void {
  activePermissionChat = { chatId, sessionWebhook, updatedAt: Date.now() }
}

export function getActivePermissionChat(): ActivePermissionChat | null {
  return activePermissionChat
}

export function savePendingPermission(
  request: ChannelPermissionRequestParams,
  chatId: string,
  sessionWebhook?: string,
): PendingPermissionRequest {
  pruneExpiredPendingPermissions()
  const entry: PendingPermissionRequest = {
    ...request,
    chatId,
    sessionWebhook,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_PERMISSION_TTL_MS,
  }
  pendingPermissions.set(request.request_id.toLowerCase(), entry)
  return entry
}

/**
 * Redeem an approval/denial.
 *
 * The `fromChatId` check is the security boundary: an approval is only valid
 * from the same conversation the request was posted to, so a user in an
 * unrelated group cannot approve someone else's tool call by guessing an ID.
 */
export function consumePendingPermission(
  requestId: string,
  fromChatId: string,
): PendingPermissionRequest | null {
  pruneExpiredPendingPermissions()
  const key = requestId.toLowerCase()
  const entry = pendingPermissions.get(key)
  if (!entry) return null
  if (entry.chatId !== fromChatId) return null
  pendingPermissions.delete(key)
  return entry
}

export function clearPermissionStateForTests(): void {
  pendingPermissions.clear()
  activePermissionChat = null
}
