import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir } from './accounts.js'

export interface AccessConfig {
  /**
   * pairing   — unknown senders get a code they must have an operator confirm
   * allowlist — same storage, but no codes are handed out (manual edits only)
   * disabled  — no access control at all
   */
  policy: 'pairing' | 'allowlist' | 'disabled'
  /** Sender IDs (staff IDs) permitted to drive the session. */
  allowFrom: string[]
}

interface PendingEntry {
  senderId: string
  expiresAt: number
}

const PAIRING_TTL_MS = 10 * 60 * 1000

function configPath(): string {
  return join(getStateDir(), 'access.json')
}

function pendingPath(): string {
  return join(getStateDir(), 'pending-pairings.json')
}

function loadPending(): Record<string, PendingEntry> {
  const path = pendingPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      PendingEntry
    >
  } catch {
    return {}
  }
}

function savePending(data: Record<string, PendingEntry>): void {
  writeFileSync(pendingPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function loadAccessConfig(): AccessConfig {
  const path = configPath()
  if (!existsSync(path)) {
    // Default closed: a robot reachable by the whole org must not execute
    // tool calls for anyone who happens to find it.
    return { policy: 'pairing', allowFrom: [] }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccessConfig
  } catch {
    return { policy: 'pairing', allowFrom: [] }
  }
}

export function saveAccessConfig(config: AccessConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
}

export function isAllowed(senderId: string): boolean {
  const config = loadAccessConfig()
  if (config.policy === 'disabled') return true
  return config.allowFrom.includes(senderId)
}

/** Issue (or re-issue) a pairing code for an unrecognized sender. */
export function addPendingPairing(senderId: string): string {
  const pending = loadPending()
  const now = Date.now()

  for (const code of Object.keys(pending)) {
    if (pending[code]!.expiresAt < now) {
      delete pending[code]
    }
  }

  // Re-issue the same code so a sender spamming the robot doesn't generate a
  // new pending entry per message.
  for (const [code, entry] of Object.entries(pending)) {
    if (entry.senderId === senderId) {
      savePending(pending)
      return code
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000))
  pending[code] = { senderId, expiresAt: now + PAIRING_TTL_MS }
  savePending(pending)
  return code
}

export function confirmPairing(code: string): string | null {
  const pending = loadPending()
  const entry = pending[code]
  if (!entry || entry.expiresAt < Date.now()) {
    delete pending[code]
    savePending(pending)
    return null
  }

  delete pending[code]
  savePending(pending)

  const config = loadAccessConfig()
  if (!config.allowFrom.includes(entry.senderId)) {
    config.allowFrom.push(entry.senderId)
    saveAccessConfig(config)
  }

  return entry.senderId
}
