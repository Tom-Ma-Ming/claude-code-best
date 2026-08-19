// @claude-code-best/dingtalk — DingTalk (钉钉) channel integration, Stream mode.

// Types
export {
  ConversationType,
  InboundMsgType,
  OutboundMsgKey,
  StreamFrameType,
  ROBOT_MESSAGE_TOPIC,
} from './types.js'
export type {
  AccessTokenResp,
  DingtalkMessage,
  DownloadFileResp,
  InboundContent,
  ParsedMessage,
  StreamAck,
  StreamConnectionResp,
  StreamFrame,
  UploadMediaResp,
} from './types.js'

// Account / credential storage
export {
  DEFAULT_BASE_URL,
  OAPI_BASE_URL,
  clearAccount,
  getStateDir,
  loadAccount,
  saveAccount,
} from './accounts.js'
export type { AccountData } from './accounts.js'

// API client
export {
  clearTokenCacheForTests,
  getAccessToken,
  getFileDownloadUrl,
  openStreamConnection,
  sendToConversation,
  sendViaWebhook,
  uploadMedia,
} from './api.js'

// Pairing / access control
export {
  addPendingPairing,
  confirmPairing,
  isAllowed,
  loadAccessConfig,
  saveAccessConfig,
} from './pairing.js'
export type { AccessConfig } from './pairing.js'

// Permission relay
export {
  clearPermissionStateForTests,
  consumePendingPermission,
  savePendingPermission,
} from './permissions.js'
export type {
  ChannelPermissionRequestParams,
  PendingPermissionRequest,
} from './permissions.js'

// Media
export {
  categoryForMsgType,
  downloadInboundFile,
  guessMediaCategory,
} from './media.js'
export type { MediaCategory } from './media.js'

// Sending
export {
  mediaPayload,
  sendMarkdown,
  sendMediaFile,
  sendText,
  splitText,
} from './send.js'
export type { SendTarget } from './send.js'

// Stream transport
export { buildAck, handleFrame, parseFrame, runStreamClient } from './stream.js'
export type { StreamClientParams, WebSocketLike } from './stream.js'

// Inbound processing
export {
  clearMonitorStateForTests,
  extractPermissionReply,
  extractText,
  getSessionWebhook,
  processMessage,
  rememberSessionWebhook,
  stripAtMention,
} from './monitor.js'
export type {
  OnMessageCallback,
  OnPermissionResponseCallback,
  PermissionBehavior,
  PermissionResponse,
  ProcessContext,
} from './monitor.js'

// MCP server
export { createDingtalkMcpServer, runDingtalkMcpServer } from './server.js'
export type { DingtalkServerDeps } from './server.js'

// CLI
export { handleDingtalkCli } from './cli.js'
