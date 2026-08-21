import { DEFAULT_BASE_URL, OAPI_BASE_URL } from './accounts.js'
import type {
  AccessTokenResp,
  DownloadFileResp,
  StreamConnectionResp,
  UploadMediaResp,
} from './types.js'
import { ROBOT_MESSAGE_TOPIC } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Turn DingTalk's error bodies into something a user can act on.
 *
 * `robot 不存在` is the worst offender: it is returned when the robot simply
 * cannot post to *that conversation* — the robotCode may be perfectly valid —
 * so taking it at face value sends people to re-check a credential that was
 * never wrong.
 */
export function explainDingtalkError(status: number, body: string): string {
  const raw = `HTTP ${status}${body ? `: ${body}` : ''}`

  if (body.includes('robot 不存在') || body.includes('resource.not.found')) {
    return [
      'DingTalk refused the send: the robot cannot post to that conversation.',
      'Despite the wording, this is usually NOT a bad robotCode — check that:',
      '  · the robot is still a member of that group, and',
      '  · the binding points at the right conversation (`ccb dingtalk status`).',
      `Re-bind with \`ccb dingtalk bind\` from the conversation you want.`,
      `(${raw})`,
    ].join('\n')
  }

  if (body.includes('invalidClientIdOrSecret')) {
    return `AppKey or AppSecret is wrong. Re-run \`ccb dingtalk login\`. (${raw})`
  }

  if (body.includes('Forbidden.AccessDenied') || body.includes('permission')) {
    return [
      'DingTalk denied the call — the app is probably missing a permission.',
      'Check 权限管理: qyapi_robot_sendmsg is required, qyapi_media_upload for files.',
      `(${raw})`,
    ].join('\n')
  }

  return raw
}

/**
 * Access tokens are valid for 7200s. DingTalk rate-limits the token endpoint
 * hard, so cache per appKey and refresh a minute early rather than on expiry.
 */
const REFRESH_SKEW_MS = 60_000
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

export function clearTokenCacheForTests(): void {
  tokenCache.clear()
}

async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      // undici collapses every transport failure into "fetch failed" and hides
      // the real reason (DNS, TLS, ECONNREFUSED, a global dispatcher) on
      // `cause`. Surfacing it is the difference between a useful error and a
      // user assuming their credentials are wrong.
      const cause = (error as { cause?: { code?: string; message?: string } })
        .cause
      const detail = cause?.code || cause?.message
      const host = new URL(url).host
      throw new Error(
        `Could not reach ${host}: ${error instanceof Error ? error.message : String(error)}` +
          (detail ? ` (${detail})` : ''),
        { cause: error },
      )
    }

    if (!response.ok) {
      // DingTalk puts the useful part in the body, not the status line.
      const body = await response.text().catch(() => '')
      throw new Error(explainDingtalkError(response.status, body))
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

function jsonPost(body: unknown, token?: string): RequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['x-acs-dingtalk-access-token'] = token
  }
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

/** Fetch (or reuse) an app access token. */
export async function getAccessToken(params: {
  appKey: string
  appSecret: string
  baseUrl?: string
  signal?: AbortSignal
}): Promise<string> {
  const { appKey, appSecret, baseUrl = DEFAULT_BASE_URL, signal } = params

  const cached = tokenCache.get(appKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token
  }

  const resp = await request<AccessTokenResp>(
    `${baseUrl}/v1.0/oauth2/accessToken`,
    jsonPost({ appKey, appSecret }),
    DEFAULT_TIMEOUT_MS,
    signal,
  )

  if (!resp.accessToken) {
    throw new Error(
      `Failed to get access token: ${resp.code || 'unknown'} ${resp.message || ''}`.trim(),
    )
  }

  tokenCache.set(appKey, {
    token: resp.accessToken,
    expiresAt: Date.now() + (resp.expireIn ?? 7200) * 1000 - REFRESH_SKEW_MS,
  })
  return resp.accessToken
}

/**
 * Open a Stream-mode connection slot. Returns the WebSocket endpoint plus a
 * single-use ticket; both expire quickly, so call this immediately before
 * dialing the socket (and again on every reconnect).
 */
export async function openStreamConnection(params: {
  appKey: string
  appSecret: string
  baseUrl?: string
  ua?: string
  signal?: AbortSignal
}): Promise<{ endpoint: string; ticket: string }> {
  const {
    appKey,
    appSecret,
    baseUrl = DEFAULT_BASE_URL,
    ua = 'ccb-dingtalk/1.0.0',
    signal,
  } = params

  const resp = await request<StreamConnectionResp>(
    `${baseUrl}/v1.0/gateway/connections/open`,
    jsonPost({
      clientId: appKey,
      clientSecret: appSecret,
      subscriptions: [{ type: 'CALLBACK', topic: ROBOT_MESSAGE_TOPIC }],
      ua,
    }),
    DEFAULT_TIMEOUT_MS,
    signal,
  )

  if (!resp.endpoint || !resp.ticket) {
    throw new Error(
      `Failed to open stream connection: ${resp.code || 'unknown'} ${resp.message || ''}`.trim(),
    )
  }
  return { endpoint: resp.endpoint, ticket: resp.ticket }
}

/**
 * Reply through the inbound message's `sessionWebhook`.
 *
 * Preferred over the token-based endpoints: no access token, no extra API
 * permission scopes, and it addresses 1:1 and group chats identically. The
 * catch is the ~1.5h expiry, which is why callers fall back to
 * {@link sendToConversation} once the webhook goes stale.
 */
export async function sendViaWebhook(params: {
  webhook: string
  body: unknown
  signal?: AbortSignal
}): Promise<{ errcode?: number; errmsg?: string }> {
  return request<{ errcode?: number; errmsg?: string }>(
    params.webhook,
    jsonPost(params.body),
    DEFAULT_TIMEOUT_MS,
    params.signal,
  )
}

/**
 * Proactive send, used when there is no live `sessionWebhook` (expired, or the
 * send was not triggered by an inbound message).
 *
 * Requires the `qyapi_robot_sendmsg` permission on the app.
 */
export async function sendToConversation(params: {
  token: string
  robotCode: string
  /** Group `openConversationId`, or undefined for a 1:1 send. */
  openConversationId?: string
  /** Recipient staff IDs — required for 1:1 sends. */
  userIds?: string[]
  msgKey: string
  msgParam: Record<string, unknown>
  baseUrl?: string
  signal?: AbortSignal
}): Promise<unknown> {
  const {
    token,
    robotCode,
    openConversationId,
    userIds,
    msgKey,
    msgParam,
    baseUrl = DEFAULT_BASE_URL,
    signal,
  } = params

  // msgParam is a JSON *string*, not an object — DingTalk rejects the object form.
  const encodedParam = JSON.stringify(msgParam)

  if (openConversationId) {
    return request(
      `${baseUrl}/v1.0/robot/groupMessages/send`,
      jsonPost(
        { robotCode, openConversationId, msgKey, msgParam: encodedParam },
        token,
      ),
      DEFAULT_TIMEOUT_MS,
      signal,
    )
  }

  if (!userIds || userIds.length === 0) {
    throw new Error(
      'sendToConversation requires openConversationId (group) or userIds (1:1)',
    )
  }

  return request(
    `${baseUrl}/v1.0/robot/oToMessages/batchSend`,
    jsonPost({ robotCode, userIds, msgKey, msgParam: encodedParam }, token),
    DEFAULT_TIMEOUT_MS,
    signal,
  )
}

/** Resolve an inbound attachment's `downloadCode` into a temporary URL. */
export async function getFileDownloadUrl(params: {
  token: string
  robotCode: string
  downloadCode: string
  baseUrl?: string
  signal?: AbortSignal
}): Promise<string> {
  const {
    token,
    robotCode,
    downloadCode,
    baseUrl = DEFAULT_BASE_URL,
    signal,
  } = params

  const resp = await request<DownloadFileResp>(
    `${baseUrl}/v1.0/robot/messageFiles/download`,
    jsonPost({ downloadCode, robotCode }, token),
    DEFAULT_TIMEOUT_MS,
    signal,
  )

  if (!resp.downloadUrl) {
    throw new Error(
      `Failed to resolve download URL: ${resp.code || 'unknown'} ${resp.message || ''}`.trim(),
    )
  }
  return resp.downloadUrl
}

/**
 * Upload an outbound attachment and get back a `media_id`.
 *
 * Note this is the legacy oapi host with the token in the query string — there
 * is no v1.0 equivalent, so the two hosts coexist by necessity.
 */
export async function uploadMedia(params: {
  token: string
  /** DingTalk's own categories, not MIME types. */
  type: 'image' | 'voice' | 'video' | 'file'
  fileName: string
  data: Uint8Array
  oapiBaseUrl?: string
  signal?: AbortSignal
}): Promise<string> {
  const {
    token,
    type,
    fileName,
    data,
    oapiBaseUrl = OAPI_BASE_URL,
    signal,
  } = params

  const form = new FormData()
  form.append('type', type)
  form.append(
    'media',
    new Blob([data as unknown as BlobPart], {
      type: 'application/octet-stream',
    }),
    fileName,
  )

  const resp = await request<UploadMediaResp>(
    `${oapiBaseUrl}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
    { method: 'POST', body: form },
    60_000,
    signal,
  )

  if (resp.errcode !== 0 || !resp.media_id) {
    throw new Error(
      `Media upload failed: errcode=${resp.errcode} ${resp.errmsg || ''}`.trim(),
    )
  }
  return resp.media_id
}
