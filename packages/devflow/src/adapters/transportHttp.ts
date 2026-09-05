import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { parseEnvelope } from '../envelope.js'
import type { InboxServer, Peer, Transport } from '../ports.js'
import type { Envelope } from '../types.js'

export const INBOX_PATH = '/devflow/inbox'
const MAX_BODY_BYTES = 1_000_000

/** Coordinator → worker over plain HTTP with a shared bearer token. */
export class HttpTransport implements Transport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(peer: Peer, envelope: Envelope): Promise<void> {
    const url = `${peer.endpoint.replace(/\/$/, '')}${INBOX_PATH}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (peer.token) headers.Authorization = `Bearer ${peer.token}`
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code
      throw new Error(
        `Could not reach ${peer.key} at ${peer.endpoint}${cause ? ` (${cause})` : ''}. Is \`ccb devflow serve\` running there?`,
        { cause: error },
      )
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(
        `${peer.key} rejected the envelope: HTTP ${resp.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
      )
    }
  }
}

/**
 * Worker inbox. One endpoint, one token, JSON in — deliberately boring so it
 * can sit on an intranet without a reverse proxy. Bind to `127.0.0.1` when
 * a tunnel or proxy is in front of it.
 */
export class HttpInboxServer implements InboxServer {
  constructor(
    private readonly options: { host?: string; port: number; token: string },
  ) {}

  async start(
    onEnvelope: (envelope: Envelope) => Promise<void>,
  ): Promise<{ address: string; stop(): Promise<void> }> {
    const { host = '0.0.0.0', port, token } = this.options

    const server = createServer(
      (req, res) => void this.handle(req, res, token, onEnvelope),
    )

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve())
    })

    const bound = server.address()
    const actualPort = typeof bound === 'object' && bound ? bound.port : port
    return {
      address: `http://${host}:${actualPort}${INBOX_PATH}`,
      stop: () =>
        new Promise<void>((resolve, reject) =>
          server.close(err => (err ? reject(err) : resolve())),
        ),
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    onEnvelope: (envelope: Envelope) => Promise<void>,
  ): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && req.url === '/devflow/health') {
      reply(200, { ok: true })
      return
    }
    if (req.method !== 'POST' || req.url !== INBOX_PATH) {
      reply(404, { error: 'not found' })
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(401, { error: 'bad token' })
      return
    }

    let raw = ''
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: 'body too large' })
        return
      }
      raw += chunk
    }

    let envelope: Envelope
    try {
      envelope = parseEnvelope(JSON.parse(raw))
    } catch (error) {
      reply(400, {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    try {
      await onEnvelope(envelope)
      reply(200, { ok: true, id: envelope.id })
    } catch (error) {
      reply(500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
