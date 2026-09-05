import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import type { Requirement } from '../types.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devflow-store-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const req: Requirement = {
  id: 'REQ/1',
  title: 'login',
  owners: ['u1'],
  createdAt: '2026-09-01T00:00:00Z',
}

describe('Store', () => {
  test('track is idempotent and records history', () => {
    const store = new Store(dir)
    const first = store.track(req, 'discovered')
    const again = store.track({ ...req, title: 'changed' }, 'discovered')
    expect(again.requirement.title).toBe('login')
    expect(first.history).toHaveLength(1)
    expect(store.list()).toHaveLength(1)
  })

  test('transition enforces the state machine and appends events', () => {
    const store = new Store(dir)
    store.track(req, 'discovered')
    store.transition(req.id, 'notified')
    expect(() => store.transition(req.id, 'dispatched')).toThrow(
      /Invalid transition/,
    )
    const item = store.transition(req.id, 'confirmed', 'by staff-a', {
      assignee: 'a',
    })
    expect(item.assignee).toBe('a')
    expect(item.history.map(h => h.to)).toEqual([
      'discovered',
      'notified',
      'confirmed',
    ])
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(events).toHaveLength(3)
  })

  test('ids with slashes are safe file names', () => {
    const store = new Store(dir)
    store.track(req, 'received')
    expect(store.get('REQ/1')?.requirement.id).toBe('REQ/1')
  })
})
