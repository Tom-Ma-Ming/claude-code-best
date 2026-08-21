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
  sendImage,
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

// Channel binding & modes
export {
  acceptsInbound,
  DEFAULT_CONFIG,
  DEFAULT_RELAY,
  isBound,
  loadChannelConfig,
  outboundTarget,
  saveChannelConfig,
} from './config.js'
export {
  DEFAULT_PROGRESS_AFTER_MS,
  isMirrorOnly,
  relayTargets,
} from './config.js'
export type {
  ChannelConfig,
  ChannelMode,
  GroupMode,
  RelayConfig,
} from './config.js'
export { handleChannelCommand } from './commands.js'
export type { ChannelCommandResult } from './commands.js'
export { applyBinding, waitForFirstMessage } from './bind.js'
export type { BindResult } from './bind.js'

// Terminal → DingTalk relay
export {
  formatRelay,
  lastAssistantText,
  beginRun,
  relayCategory,
  relayHookPayload,
  shouldSendProgress,
} from './relay.js'
export type { HookPayload } from './relay.js'
export {
  buildRelayHooks,
  HOOK_MARKER,
  installRelayHooks,
  RELAY_HOOK_EVENTS,
  relayHooksInstalled,
  uninstallRelayHooks,
} from './hooks.js'
export type { RelayHookEvent } from './hooks.js'

// MCP server
export { createDingtalkMcpServer, runDingtalkMcpServer } from './server.js'
export type { DingtalkServerDeps } from './server.js'

// CLI
export { handleDingtalkCli } from './cli.js'
