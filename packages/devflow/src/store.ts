import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { devflowDir } from './config.js'
import { assertTransition } from './state.js'
import type { FlowState, Requirement, TrackedRequirement } from './types.js'

/**
 * One JSON file per requirement under `<state dir>/items/`, plus an
 * append-only `events.jsonl`. Files rather than a database so a person can
 * read, edit or delete an item with nothing but a text editor when the
 * pipeline gets stuck.
 */
export class Store {
  constructor(private readonly root = devflowDir()) {}

  private itemsDir(): string {
    const dir = join(this.root, 'items')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private itemPath(id: string): string {
    return join(this.itemsDir(), `${safeFileName(id)}.json`)
  }

  private eventsPath(): string {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true })
    return join(this.root, 'events.jsonl')
  }

  has(id: string): boolean {
    return existsSync(this.itemPath(id))
  }

  get(id: string): TrackedRequirement | null {
    const path = this.itemPath(id)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as TrackedRequirement
  }

  list(): TrackedRequirement[] {
    return readdirSync(this.itemsDir())
      .filter(name => name.endsWith('.json'))
      .map(
        name =>
          JSON.parse(
            readFileSync(join(this.itemsDir(), name), 'utf-8'),
          ) as TrackedRequirement,
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  }

  listByState(...states: FlowState[]): TrackedRequirement[] {
    const wanted = new Set<FlowState>(states)
    return this.list().filter(item => wanted.has(item.state))
  }

  /** Start tracking. No-op if the id is already known. */
  track(
    requirement: Requirement,
    initial: FlowState,
    extra: Partial<
      Omit<TrackedRequirement, 'requirement' | 'state' | 'history'>
    > = {},
  ): TrackedRequirement {
    const existing = this.get(requirement.id)
    if (existing) return existing
    const now = new Date().toISOString()
    const item: TrackedRequirement = {
      requirement,
      state: initial,
      history: [{ at: now, from: null, to: initial }],
      updatedAt: now,
      ...extra,
    }
    this.write(item)
    this.event('track', requirement.id, { state: initial })
    return item
  }

  /** Move an item along the state machine, recording why. */
  transition(
    id: string,
    to: FlowState,
    note?: string,
    patch: Partial<TrackedRequirement> = {},
  ): TrackedRequirement {
    const item = this.get(id)
    if (!item) throw new Error(`Unknown requirement ${id}`)
    assertTransition(item.state, to)
    const now = new Date().toISOString()
    const next: TrackedRequirement = {
      ...item,
      ...patch,
      state: to,
      history: [...item.history, { at: now, from: item.state, to, note }],
      updatedAt: now,
    }
    this.write(next)
    this.event('transition', id, { from: item.state, to, note })
    return next
  }

  /** Update fields without a state change (e.g. attach a plan). */
  patch(id: string, patch: Partial<TrackedRequirement>): TrackedRequirement {
    const item = this.get(id)
    if (!item) throw new Error(`Unknown requirement ${id}`)
    const next = { ...item, ...patch, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  remove(id: string): boolean {
    const path = this.itemPath(id)
    if (!existsSync(path)) return false
    unlinkSync(path)
    this.event('remove', id)
    return true
  }

  event(type: string, id: string, data: Record<string, unknown> = {}): void {
    appendFileSync(
      this.eventsPath(),
      JSON.stringify({ at: new Date().toISOString(), type, id, ...data }) +
        '\n',
    )
  }

  private write(item: TrackedRequirement): void {
    writeFileSync(
      this.itemPath(item.requirement.id),
      JSON.stringify(item, null, 2) + '\n',
      'utf-8',
    )
  }
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}
