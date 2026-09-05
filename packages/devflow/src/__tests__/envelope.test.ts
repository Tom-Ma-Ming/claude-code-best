import { describe, expect, test } from 'bun:test'
import { parseEnvelope } from '../envelope.js'

const dispatch = {
  kind: 'devflow/dispatch',
  version: 1,
  id: 'e1',
  sentAt: '2026-09-01T00:00:00Z',
  from: 'r',
  requirement: {
    id: 'REQ-1',
    title: 't',
    owners: [],
    createdAt: '2026-09-01T00:00:00Z',
  },
  assignee: 'a',
}

describe('parseEnvelope', () => {
  test('accepts a well-formed dispatch', () => {
    expect(parseEnvelope(dispatch).kind).toBe('devflow/dispatch')
  })

  test.each([
    [{ ...dispatch, kind: 'devflow/nope' }, /unknown envelope kind/],
    [{ ...dispatch, version: 2 }, /version/],
    [{ ...dispatch, from: '' }, /from/],
    [{ ...dispatch, requirement: { id: 1 } }, /requirement/],
    [{ ...dispatch, assignee: undefined }, /assignee/],
    [
      {
        kind: 'devflow/ack',
        version: 1,
        id: 'x',
        sentAt: 's',
        from: 'a',
        dispatchId: 'e1',
      },
      /requirementId/,
    ],
  ])('rejects %p', (value, message) => {
    expect(() => parseEnvelope(value)).toThrow(message)
  })
})
