import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileManagementSystem } from '../adapters/managementFile.js'
import { HttpInboxServer, HttpTransport } from '../adapters/transportHttp.js'
import { FileInboxServer, FileTransport } from '../adapters/transportFile.js'
import type { DevflowConfig } from '../config.js'
import { Coordinator, parseDecisionReply } from '../coordinator.js'
import type { Notifier } from '../ports.js'
import { Store } from '../store.js'
import type { Envelope } from '../types.js'
import { Worker } from '../worker.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devflow-pipe-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seedManagement(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'requirements.json'),
    JSON.stringify([
      {
        id: 'REQ-1',
        title: '登录页改版',
        description: '支持扫码',
        owners: ['u-a'],
        createdAt: '2026-09-01T00:00:00Z',
        review: 'pending',
      },
    ]),
  )
}

class RecordingNotifier implements Notifier {
  calls: Array<{ title: string; atUserIds?: string[] }> = []
  async announce(p: { title: string; text: string; atUserIds?: string[] }) {
    this.calls.push({ title: p.title, atUserIds: p.atUserIds })
  }
}

function coordinatorConfig(endpoint: string, token?: string): DevflowConfig {
  return {
    role: 'coordinator',
    machine: 'r',
    managementSystem: { type: 'file', dir: join(root, 'pm') },
    roster: {
      a: {
        name: 'A',
        managementUserId: 'u-a',
        dingtalkUserId: 'staff-a',
        endpoint,
        token,
      },
      b: { name: 'B', managementUserId: 'u-b', dingtalkUserId: 'staff-b' },
    },
    dingtalk: { conversationId: 'cid-team' },
  }
}

function workerConfig(): DevflowConfig {
  return {
    role: 'worker',
    machine: 'a',
    managementSystem: { type: 'file', dir: join(root, 'pm') },
    roster: { a: { name: 'A', managementUserId: 'u-a' } },
    inbox: { port: 0, token: 'secret' },
  }
}

describe('coordinator', () => {
  test('poll announces once and mentions the owner on the roster', async () => {
    const pm = join(root, 'pm')
    const management = new FileManagementSystem(pm)
    seedManagement(pm)
    const notifier = new RecordingNotifier()
    const c = new Coordinator({
      config: coordinatorConfig(join(root, 'inbox-a')),
      store: new Store(join(root, 'r')),
      management,
      notifier,
      transport: new FileTransport(),
    })
    const first = await c.poll()
    expect(first.notified).toEqual(['REQ-1'])
    expect(notifier.calls[0]?.atUserIds).toEqual(['staff-a'])
    const second = await c.poll()
    expect(second.discovered).toHaveLength(0)
    expect(notifier.calls).toHaveLength(1)
  })

  test('reply parsing only matches decision shapes', () => {
    expect(parseDecisionReply('是 REQ-1')).toEqual({
      decision: 'yes',
      requirementId: 'REQ-1',
    })
    expect(parseDecisionReply('  否 REQ-1 ')).toEqual({
      decision: 'no',
      requirementId: 'REQ-1',
    })
    expect(parseDecisionReply('yes REQ-1')).toEqual({
      decision: 'yes',
      requirementId: 'REQ-1',
    })
    expect(parseDecisionReply('是的我觉得可以')).toBeNull()
    expect(parseDecisionReply('REQ-1')).toBeNull()
  })

  test('confirm picks the replier when on the roster, else an owner with an endpoint', async () => {
    const pm = join(root, 'pm')
    seedManagement(pm)
    const store = new Store(join(root, 'r'))
    const c = new Coordinator({
      config: coordinatorConfig(join(root, 'inbox-a')),
      store,
      management: new FileManagementSystem(pm),
      notifier: new RecordingNotifier(),
      transport: new FileTransport(),
    })
    await c.poll()
    // staff-b is on the roster but has no endpoint → falls back to owner a
    expect(() =>
      c.confirm({ requirementId: 'REQ-1', by: 'staff-b' }),
    ).not.toThrow()
    expect(store.get('REQ-1')?.assignee).toBe('b')
  })
})

describe('hand-off over HTTP', () => {
  test('dispatch lands in the worker store and duplicates are ignored', async () => {
    const pm = join(root, 'pm')
    seedManagement(pm)
    const workerStore = new Store(join(root, 'a'))
    const worker = new Worker({
      config: workerConfig(),
      store: workerStore,
      management: new FileManagementSystem(pm),
    })
    const inbox = new HttpInboxServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    })
    const received: Envelope[] = []
    const server = await inbox.start(async env => {
      received.push(env)
      await worker.receive(env)
    })
    const endpoint = server.address.replace(/\/devflow\/inbox$/, '')
    try {
      const rStore = new Store(join(root, 'r'))
      const c = new Coordinator({
        config: coordinatorConfig(endpoint, 'secret'),
        store: rStore,
        management: new FileManagementSystem(pm),
        notifier: new RecordingNotifier(),
        transport: new HttpTransport(),
      })
      await c.poll()
      const envelope = await c.accept({ requirementId: 'REQ-1', by: 'staff-a' })
      expect(envelope.assignee).toBe('a')
      expect(rStore.get('REQ-1')?.state).toBe('dispatched')
      expect(workerStore.get('REQ-1')?.state).toBe('received')
      expect(workerStore.get('REQ-1')?.dispatchedFrom).toBe('r')

      // replay the same envelope: no second item, no error
      await new HttpTransport().send(
        { key: 'a', endpoint, token: 'secret' },
        envelope,
      )
      expect(workerStore.list()).toHaveLength(1)
      expect(received).toHaveLength(2)

      // wrong token is refused
      const resp = await fetch(`${endpoint}/devflow/inbox`, {
        method: 'POST',
        body: '{}',
        headers: { Authorization: 'Bearer nope' },
      })
      expect(resp.status).toBe(401)
      const bad = await fetch(`${endpoint}/devflow/inbox`, {
        method: 'POST',
        body: '{"kind":"x"}',
        headers: { Authorization: 'Bearer secret' },
      })
      expect(bad.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test('file transport round-trips through the file inbox', async () => {
    const pm = join(root, 'pm')
    seedManagement(pm)
    const inboxDir = join(root, 'inbox-a')
    const workerStore = new Store(join(root, 'a'))
    const worker = new Worker({
      config: workerConfig(),
      store: workerStore,
      management: new FileManagementSystem(pm),
    })
    const c = new Coordinator({
      config: coordinatorConfig(inboxDir),
      store: new Store(join(root, 'r')),
      management: new FileManagementSystem(pm),
      notifier: new RecordingNotifier(),
      transport: new FileTransport(),
    })
    await c.poll()
    await c.accept({ requirementId: 'REQ-1', by: 'staff-a' })
    const server = await new FileInboxServer({
      dir: inboxDir,
      pollIntervalMs: 60_000,
    }).start(env => worker.receive(env))
    await server.stop()
    expect(workerStore.get('REQ-1')?.state).toBe('received')
  })
})

describe('worker', () => {
  async function receivedWorker() {
    const pm = join(root, 'pm')
    seedManagement(pm)
    const management = new FileManagementSystem(pm)
    const store = new Store(join(root, 'a'))
    const worker = new Worker({ config: workerConfig(), store, management })
    await worker.receive({
      kind: 'devflow/dispatch',
      version: 1,
      id: 'e1',
      sentAt: '2026-09-01T00:00:00Z',
      from: 'r',
      requirement: {
        id: 'REQ-1',
        title: '登录页改版',
        owners: ['u-a'],
        createdAt: '2026-09-01T00:00:00Z',
      },
      assignee: 'a',
    })
    return { worker, store, management, pm }
  }

  test('review tracking follows the management system', async () => {
    const { worker, pm } = await receivedWorker()
    worker.accept('REQ-1')
    expect((await worker.trackReview('REQ-1')).state).toBe('review_pending')
    expect((await worker.trackReview('REQ-1')).state).toBe('review_pending')
    const list = JSON.parse(
      readFileSync(join(pm, 'requirements.json'), 'utf-8'),
    )
    list[0].review = 'rejected'
    writeFileSync(join(pm, 'requirements.json'), JSON.stringify(list))
    expect((await worker.trackReview('REQ-1')).state).toBe('review_rejected')
    worker.resubmit('REQ-1')
    list[0].review = 'approved'
    writeFileSync(join(pm, 'requirements.json'), JSON.stringify(list))
    expect((await worker.trackReview('REQ-1')).state).toBe('review_approved')
  })

  test('plan creates the dev requirement and tasks, then the work advances', async () => {
    const { worker, store, pm } = await receivedWorker()
    await worker.trackReview('REQ-1')
    const list = JSON.parse(
      readFileSync(join(pm, 'requirements.json'), 'utf-8'),
    )
    list[0].review = 'approved'
    writeFileSync(join(pm, 'requirements.json'), JSON.stringify(list))
    await worker.trackReview('REQ-1')

    await expect(
      worker.plan({ requirementId: 'REQ-1', tasks: [] }),
    ).rejects.toThrow(/at least one task/)
    const planned = await worker.plan({
      requirementId: 'REQ-1',
      tasks: [{ title: '后端' }, { title: '前端' }],
    })
    expect(planned.state).toBe('planned')
    expect(planned.plan?.tasks).toHaveLength(2)
    expect(planned.plan?.devRequirementId).toMatch(/^dev-REQ-1/)

    worker.advance('REQ-1', 'developing')
    worker.updateTask('REQ-1', planned.plan!.tasks[0]!.id, 'done')
    expect(store.get('REQ-1')?.plan?.tasks[0]?.status).toBe('done')
    expect(() => worker.advance('REQ-1', 'released')).toThrow(
      /Invalid transition/,
    )
    worker.advance('REQ-1', 'testing')
    worker.advance('REQ-1', 'awaiting_acceptance')
    worker.advance('REQ-1', 'acceptance_passed')
    expect(worker.advance('REQ-1', 'released').state).toBe('released')
  })
})
