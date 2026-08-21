import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir, stateDirPath } from './accounts.js'

export interface AccessConfig {
  /**
   * pairing   — unknown senders get a code they must have an operator confirm
   * allowlist — same storage, but no codes are handed out (manual edits only)
   * disabled  — no access control at all
   */
  policy: 'pairing' | 'allowlist' | 'disabled'
  /** Namespaced sender identities permitted to drive the session. */
  allowFrom: string[]
  /**
   * Conversations this instance handles. Empty/absent means all of them.
   * Set when several ccb instances share one robot so each only acts on its
   * own group. See isConversationBound() for why this is a guard, not a router.
   */
  boundConversations?: string[]
  /**
   * Whether senders with no `senderStaffId` (external contacts, members of
   * other orgs in a shared group) may pair at all. Default false.
   *
   * Off by default because their identity is an opaque per-app `senderId`
   * whose long-term stability and uniqueness DingTalk does not document.
   * Pairing one means trusting an identifier we cannot verify is durable.
   */
  allowExternal?: boolean
}

/**
 * Which identifier a message's sender is known by.
 *
 * `staff` is the org userId from `senderStaffId` — the identity we can trust.
 * `external` is the opaque `senderId`, present when the sender is outside the
 * org. The two live in different ID spaces, so they are namespaced apart to
 * make a collision between them structurally impossible.
 */
export type SenderKind = 'staff' | 'external'

export interface SenderIdentity {
  kind: SenderKind
  /** Raw value as it appeared on the message. */
  raw: string
  /** Namespaced form — this is what goes in `allowFrom`. */
  key: string
}

const EXTERNAL_PREFIX = 'external:'

export function senderIdentity(msg: {
  senderStaffId?: string
  senderId?: string
}): SenderIdentity | null {
  if (msg.senderStaffId) {
    return { kind: 'staff', raw: msg.senderStaffId, key: msg.senderStaffId }
  }
  if (msg.senderId) {
    return {
      kind: 'external',
      raw: msg.senderId,
      key: `${EXTERNAL_PREFIX}${msg.senderId}`,
    }
  }
  return null
}

interface PendingEntry {
  /** Namespaced identity key, not the raw sender id. */
  senderId: string
  expiresAt: number
}

const PAIRING_TTL_MS = 10 * 60 * 1000

function configPath(): string {
  return join(stateDirPath(), 'access.json')
}

function pendingPath(): string {
  return join(stateDirPath(), 'pending-pairings.json')
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
  getStateDir()
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
  getStateDir()
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unpaired' | 'external-not-permitted' }

/**
 * Decide whether a sender may drive the session.
 *
 * External senders (no `senderStaffId`) are refused outright unless the
 * operator opted in — see {@link AccessConfig.allowExternal}. Refusing before
 * the pairing step matters: handing out a pairing code implies the identity is
 * worth binding, and an opaque `senderId` is not one we can vouch for.
 */
export function checkAccess(identity: SenderIdentity): AccessDecision {
  const config = loadAccessConfig()
  if (config.policy === 'disabled') return { allowed: true }
  if (identity.kind === 'external' && !config.allowExternal) {
    return { allowed: false, reason: 'external-not-permitted' }
  }
  return config.allowFrom.includes(identity.key)
    ? { allowed: true }
    : { allowed: false, reason: 'unpaired' }
}

export function isAllowed(identityKey: string): boolean {
  const config = loadAccessConfig()
  if (config.policy === 'disabled') return true
  return config.allowFrom.includes(identityKey)
}

/**
 * Conversations this instance is bound to, from `boundConversations` in
 * access.json or the `DINGTALK_CONVERSATION_IDS` env var (comma-separated).
 *
 * Empty means "handle everything" — the single-project default.
 */
export function boundConversations(): string[] {
  const fromEnv = process.env.DINGTALK_CONVERSATION_IDS
  if (fromEnv) {
    return fromEnv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  const config = loadAccessConfig()
  return config.boundConversations ?? []
}

/**
 * Whether this instance should handle a conversation.
 *
 * This is a single-instance guard, NOT a way to shard one robot across several
 * ccb instances.
 *
 * Measured 2026-08-17: DingTalk accepts multiple concurrent Stream connections
 * for one clientId, but delivers each inbound message to exactly ONE of them —
 * it load-balances rather than broadcasts. So two instances sharing an AppKey
 * do not both see a message; whichever connection receives it is the only one
 * that can act, and filtering there drops the message instead of forwarding it.
 *
 * For several projects, give each its own DingTalk app (its own AppKey). Use
 * this list only to make one instance ignore conversations it should not serve.
 */
export function isConversationBound(conversationId: string): boolean {
  const bound = boundConversations()
  return bound.length === 0 || bound.includes(conversationId)
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
