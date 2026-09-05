import { randomUUID } from 'node:crypto'
import { ENVELOPE_KINDS, type Envelope, type Requirement } from './types.js'

export function newId(): string {
  return randomUUID()
}

export function isRequirement(value: unknown): value is Requirement {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    Array.isArray(r.owners) &&
    typeof r.createdAt === 'string'
  )
}

/**
 * Reject anything that is not a well-formed envelope before it reaches a
 * handler. The inbox is a network-facing endpoint, so the shape is checked
 * field by field rather than trusted.
 */
export function parseEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== 'object') {
    throw new Error('envelope must be an object')
  }
  const e = value as Record<string, unknown>
  if (typeof e.kind !== 'string' || !ENVELOPE_KINDS.has(e.kind)) {
    throw new Error(`unknown envelope kind: ${String(e.kind)}`)
  }
  if (e.version !== 1) throw new Error('unsupported envelope version')
  for (const key of ['id', 'sentAt', 'from'] as const) {
    if (typeof e[key] !== 'string' || !e[key]) {
      throw new Error(`envelope.${key} is required`)
    }
  }
  if (e.kind === 'devflow/dispatch') {
    if (!isRequirement(e.requirement)) {
      throw new Error('dispatch.requirement is malformed')
    }
    if (typeof e.assignee !== 'string' || !e.assignee) {
      throw new Error('dispatch.assignee is required')
    }
  } else {
    if (
      typeof e.dispatchId !== 'string' ||
      typeof e.requirementId !== 'string'
    ) {
      throw new Error('ack needs dispatchId and requirementId')
    }
    if (typeof e.accepted !== 'boolean')
      throw new Error('ack.accepted is required')
  }
  return value as Envelope
}
