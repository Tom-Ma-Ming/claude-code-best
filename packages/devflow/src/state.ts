import type { FlowState } from './types.js'

/**
 * Allowed transitions. Anything not listed is a bug in the caller, not a
 * judgement call, so `assertTransition` throws rather than warns.
 *
 * `review_rejected → review_pending` exists because a rejected requirement is
 * usually edited and resubmitted rather than abandoned.
 */
const TRANSITIONS: Record<FlowState, readonly FlowState[]> = {
  // coordinator
  discovered: ['notified', 'declined'],
  notified: ['confirmed', 'declined'],
  confirmed: ['dispatched', 'declined'],
  dispatched: [],
  declined: [],
  // worker
  received: ['accepted', 'review_pending'],
  accepted: ['review_pending'],
  review_pending: ['review_approved', 'review_rejected'],
  review_approved: ['planned'],
  review_rejected: ['review_pending'],
  planned: ['developing'],
  developing: ['testing'],
  testing: ['developing', 'awaiting_acceptance'],
  awaiting_acceptance: ['acceptance_passed', 'developing'],
  acceptance_passed: ['released'],
  released: [],
}

export function canTransition(from: FlowState, to: FlowState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: FlowState, to: FlowState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid transition ${from} → ${to}. Allowed: ${
        TRANSITIONS[from]?.join(', ') || '(terminal)'
      }`,
    )
  }
}

export function nextStates(from: FlowState): readonly FlowState[] {
  return TRANSITIONS[from] ?? []
}

export function isTerminal(state: FlowState): boolean {
  return nextStates(state).length === 0
}

export function isFlowState(value: string): value is FlowState {
  return Object.hasOwn(TRANSITIONS, value)
}
