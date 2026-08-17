import WebSocket from 'ws'
import { openStreamConnection } from './api.js'
import { ROBOT_MESSAGE_TOPIC, StreamFrameType } from './types.js'
import type { StreamAck, StreamFrame } from './types.js'

/**
 * DingTalk Stream mode client.
 *
 * Stream mode inverts the usual webhook setup: the client dials out over
 * WebSocket and DingTalk pushes callbacks down it, so no public IP, domain,
 * or tunnel is needed. The tradeoff is that the connection is ours to keep
 * alive — hence the ping handling and reconnect loop below.
 *
 * Implemented directly on `ws` (already a dependency) rather than pulling in
 * `dingtalk-stream`, which is beta-only and would add a second WS stack.
 */

/** Reconnect backoff, capped so a long outage doesn't strand the session. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

export interface StreamClientParams {
  appKey: string
  appSecret: string
  baseUrl?: string
  /** Invoked for each robot message. Resolve to ACK; throw to NACK. */
  onMessage: (payload: unknown) => Promise<void>
  abortSignal: AbortSignal
  /** Injection seam for tests. */
  connect?: (url: string) => WebSocketLike
}

/** The slice of the `ws` surface this client actually uses. */
export interface WebSocketLike {
  on(event: 'open', cb: () => void): unknown
  on(event: 'message', cb: (data: unknown) => void): unknown
  on(event: 'close', cb: () => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  send(data: string): void
  close(): void
}

export function buildAck(
  messageId: string,
  body: unknown = { status: 'SUCCESS' },
): StreamAck {
  return {
    code: 200,
    headers: { messageId, contentType: 'application/json' },
    message: 'OK',
    data: JSON.stringify(body),
  }
}

/**
 * Route one inbound frame.
 *
 * Exported separately from the socket plumbing so the dispatch rules are
 * unit-testable without standing up a WebSocket.
 */
export async function handleFrame(
  frame: StreamFrame,
  handlers: {
    onMessage: (payload: unknown) => Promise<void>
    send: (ack: StreamAck) => void
    onDisconnect: () => void
  },
): Promise<void> {
  const { topic } = frame.headers
  const messageId = frame.headers.messageId

  if (frame.type === StreamFrameType.SYSTEM) {
    if (topic === 'ping') {
      // Echo the payload back verbatim — the gateway matches on it.
      handlers.send(buildAck(messageId, safeParse(frame.data)))
      return
    }
    if (topic === 'disconnect') {
      handlers.onDisconnect()
      return
    }
    handlers.send(buildAck(messageId))
    return
  }

  if (topic === ROBOT_MESSAGE_TOPIC) {
    // ACK first: DingTalk redelivers on a slow ACK, which would double-run
    // whatever the agent decides to do with the message.
    handlers.send(buildAck(messageId))
    await handlers.onMessage(safeParse(frame.data))
    return
  }

  handlers.send(buildAck(messageId))
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return {}
  }
}

export function parseFrame(raw: unknown): StreamFrame | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf-8')
          : String(raw)
    const parsed = JSON.parse(text) as StreamFrame
    if (!parsed?.headers?.messageId) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Connect and keep reconnecting until `abortSignal` fires.
 *
 * Resolves only on abort — callers run this as the process's main loop.
 */
export async function runStreamClient(
  params: StreamClientParams,
): Promise<void> {
  const {
    appKey,
    appSecret,
    baseUrl,
    onMessage,
    abortSignal,
    connect = (url: string) => new WebSocket(url) as unknown as WebSocketLike,
  } = params

  let attempt = 0

  while (!abortSignal.aborted) {
    try {
      const { endpoint, ticket } = await openStreamConnection({
        appKey,
        appSecret,
        baseUrl,
        signal: abortSignal,
      })

      await new Promise<void>((resolve, reject) => {
        const ws = connect(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)
        let settled = false

        const finish = (err?: Error): void => {
          if (settled) return
          settled = true
          abortSignal.removeEventListener('abort', onAbort)
          try {
            ws.close()
          } catch {
            // already closing
          }
          if (err) reject(err)
          else resolve()
        }

        const onAbort = (): void => finish()
        abortSignal.addEventListener('abort', onAbort, { once: true })

        ws.on('open', () => {
          attempt = 0
          process.stderr.write('[dingtalk] Stream connected.\n')
        })

        ws.on('message', (data: unknown) => {
          const frame = parseFrame(data)
          if (!frame) return
          void handleFrame(frame, {
            onMessage,
            send: ack => {
              try {
                ws.send(JSON.stringify(ack))
              } catch (error) {
                process.stderr.write(`[dingtalk] ACK failed: ${error}\n`)
              }
            },
            onDisconnect: () => {
              process.stderr.write(
                '[dingtalk] Gateway asked us to reconnect.\n',
              )
              finish()
            },
          }).catch(error => {
            process.stderr.write(
              `[dingtalk] Message handler threw: ${error instanceof Error ? error.message : String(error)}\n`,
            )
          })
        })

        ws.on('close', () => finish())
        ws.on('error', (err: Error) => finish(err))
      })
    } catch (error) {
      if (abortSignal.aborted) break
      process.stderr.write(
        `[dingtalk] Stream error: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }

    if (abortSignal.aborted) break

    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
    attempt += 1
    process.stderr.write(`[dingtalk] Reconnecting in ${delay}ms...\n`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  process.stderr.write('[dingtalk] Stream client stopped.\n')
}
