// DingTalk (钉钉) types — Stream mode robot callbacks + Open API v1.0.
//
// References:
//   Stream gateway   POST https://api.dingtalk.com/v1.0/gateway/connections/open
//   Robot callback   topic /v1.0/im/bot/messages/get
//   Send (1:1)       POST /v1.0/robot/oToMessages/batchSend
//   Send (group)     POST /v1.0/robot/groupMessages/send
//   File download    POST /v1.0/robot/messageFiles/download

/** `conversationType` on an inbound robot message. */
export enum ConversationType {
  /** 1:1 chat with the robot. */
  SINGLE = '1',
  /** Group chat the robot was @-mentioned in. */
  GROUP = '2',
}

/** `msgtype` on an inbound robot message. */
export enum InboundMsgType {
  TEXT = 'text',
  PICTURE = 'picture',
  RICH_TEXT = 'richText',
  AUDIO = 'audio',
  VIDEO = 'video',
  FILE = 'file',
}

/**
 * `msgKey` for outbound messages. DingTalk requires a sample-card key plus a
 * JSON-encoded `msgParam` whose shape depends on the key.
 */
export enum OutboundMsgKey {
  TEXT = 'sampleText',
  MARKDOWN = 'sampleMarkdown',
  IMAGE = 'sampleImageMsg',
  FILE = 'sampleFile',
  VIDEO = 'sampleVideo',
  AUDIO = 'sampleAudio',
}

/** Frame types on the Stream WebSocket. */
export enum StreamFrameType {
  SYSTEM = 'SYSTEM',
  EVENT = 'EVENT',
  CALLBACK = 'CALLBACK',
}

export const ROBOT_MESSAGE_TOPIC = '/v1.0/im/bot/messages/get'

/** Envelope for every frame the Stream gateway pushes down the socket. */
export interface StreamFrame {
  specVersion?: string
  type: string
  headers: {
    messageId: string
    topic: string
    contentType?: string
    time?: string
    eventType?: string
    [key: string]: string | undefined
  }
  /** JSON-encoded payload; shape depends on `headers.topic`. */
  data: string
}

/** Reply frame the client must send back to ACK a CALLBACK/EVENT frame. */
export interface StreamAck {
  code: number
  headers: { messageId: string; contentType: string }
  message: string
  data: string
}

/** Response from POST /v1.0/gateway/connections/open. */
export interface StreamConnectionResp {
  endpoint?: string
  ticket?: string
  code?: string
  message?: string
  requestid?: string
}

/**
 * Inbound robot message (the JSON inside `StreamFrame.data` for
 * topic `/v1.0/im/bot/messages/get`).
 */
export interface DingtalkMessage {
  msgId?: string
  msgtype?: string
  /** Stable ID for the conversation — the reply target for both 1:1 and group. */
  conversationId?: string
  conversationType?: string
  conversationTitle?: string
  /** userId of the sender within the org. Empty for external contacts. */
  senderStaffId?: string
  /** Opaque sender ID, always present. */
  senderId?: string
  senderNick?: string
  robotCode?: string
  chatbotCorpId?: string
  chatbotUserId?: string
  /** Short-lived webhook (~1.5h) that replies without needing an access token. */
  sessionWebhook?: string
  /** Epoch ms after which `sessionWebhook` stops working. */
  sessionWebhookExpiredTime?: number
  createAt?: number
  isAdmin?: boolean
  isInAtList?: boolean
  text?: { content?: string }
  content?: InboundContent
  /** Present on richText messages. */
  richText?: Array<{ text?: string; downloadCode?: string; type?: string }>
}

/** `content` block on picture / audio / video / file messages. */
export interface InboundContent {
  downloadCode?: string
  fileName?: string
  fileType?: string
  fileSize?: number
  /** Audio only — DingTalk's own speech-to-text result. */
  recognition?: string
  duration?: number
}

/** Response from POST /v1.0/oauth2/accessToken. */
export interface AccessTokenResp {
  accessToken?: string
  expireIn?: number
  code?: string
  message?: string
}

/** Response from POST /v1.0/robot/messageFiles/download. */
export interface DownloadFileResp {
  downloadUrl?: string
  code?: string
  message?: string
}

/** Response from POST /media/upload (legacy oapi endpoint). */
export interface UploadMediaResp {
  errcode?: number
  errmsg?: string
  media_id?: string
  type?: string
  created_at?: number
}

/** Normalized message handed to the MCP layer. */
export interface ParsedMessage {
  /** Reply target — `conversationId`. */
  chatId: string
  /** Who sent it — `senderStaffId` when available, else `senderId`. */
  senderId: string
  senderNick?: string
  /** Group name; absent for 1:1 chats. */
  conversationTitle?: string
  messageId: string
  text: string
  conversationType: string
  attachmentPath?: string
  attachmentType?: string
}
