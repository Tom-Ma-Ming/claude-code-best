import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseEnvelope } from '../envelope.js'
import type { InboxServer, Peer, Transport } from '../ports.js'
import type { Envelope } from '../types.js'

/**
 * Envelopes as files in a directory. `peer.endpoint` is a path. Useful on a
 * shared drive, and for running coordinator and worker on the same laptop.
 */
export class FileTransport implements Transport {
  async send(peer: Peer, envelope: Envelope): Promise<void> {
    if (!existsSync(peer.endpoint))
      mkdirSync(peer.endpoint, { recursive: true })
    const tmp = join(peer.endpoint, `.${envelope.id}.tmp`)
    writeFileSync(tmp, JSON.stringify(envelope, null, 2))
    // rename is atomic on the same filesystem, so a poller never sees a half-written file.
    renameSync(tmp, join(peer.endpoint, `${envelope.id}.json`))
  }
}

export class FileInboxServer implements InboxServer {
  constructor(
    private readonly options: { dir: string; pollIntervalMs?: number },
  ) {}

  async start(
    onEnvelope: (envelope: Envelope) => Promise<void>,
  ): Promise<{ address: string; stop(): Promise<void> }> {
    const { dir, pollIntervalMs = 2000 } = this.options
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const done = join(dir, 'processed')
    if (!existsSync(done)) mkdirSync(done, { recursive: true })

    const tick = async () => {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const path = join(dir, name)
        try {
          await onEnvelope(
            parseEnvelope(JSON.parse(readFileSync(path, 'utf-8'))),
          )
          renameSync(path, join(done, name))
        } catch (error) {
          process.stderr.write(
            `[devflow] inbox file ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          renameSync(path, join(done, `${name}.failed`))
        }
      }
    }

    await tick()
    const timer = setInterval(() => void tick(), pollIntervalMs)
    return {
      address: dir,
      stop: async () => clearInterval(timer),
    }
  }
}
