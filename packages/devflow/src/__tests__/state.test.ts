import { describe, expect, test } from 'bun:test'
import {
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
} from '../state.js'

describe('state machine', () => {
  test('coordinator path ends at dispatched', () => {
    expect(canTransition('discovered', 'notified')).toBe(true)
    expect(canTransition('notified', 'confirmed')).toBe(true)
    expect(canTransition('confirmed', 'dispatched')).toBe(true)
    expect(isTerminal('dispatched')).toBe(true)
  })

  test('worker cannot plan before review approval', () => {
    expect(canTransition('review_pending', 'planned')).toBe(false)
    expect(() => assertTransition('review_pending', 'planned')).toThrow(
      /Allowed: review_approved, review_rejected/,
    )
  })

  test('rejected review can be resubmitted', () => {
    expect(nextStates('review_rejected')).toEqual(['review_pending'])
  })

  test('testing loops back to developing', () => {
    expect(canTransition('testing', 'developing')).toBe(true)
    expect(canTransition('awaiting_acceptance', 'developing')).toBe(true)
  })
})
