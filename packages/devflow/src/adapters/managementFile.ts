import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ManagementSystem } from '../ports.js'
import type { DevTask, Requirement, ReviewStatus } from '../types.js'

interface FileRequirement extends Requirement {
  review?: ReviewStatus
  status?: string
}

/**
 * A management system made of three JSON files. It exists so the whole
 * pipeline can be exercised on one laptop before anyone wires up the real
 * system: drop a requirement into `requirements.json`, flip its `review`
 * field, and watch the coordinator and worker react.
 */
export class FileManagementSystem implements ManagementSystem {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    return join(this.dir, name)
  }

  private readJson<T>(name: string, fallback: T): T {
    const path = this.path(name)
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  }

  private writeJson(name: string, value: unknown): void {
    writeFileSync(this.path(name), JSON.stringify(value, null, 2) + '\n')
  }

  private requirements(): FileRequirement[] {
    return this.readJson<FileRequirement[]>('requirements.json', [])
  }

  async listNewRequirements(since?: string): Promise<Requirement[]> {
    return this.requirements()
      .filter(r => !since || r.createdAt > since)
      .map(({ review: _review, status: _status, ...rest }) => rest)
  }

  async getReviewStatus(requirementId: string): Promise<ReviewStatus> {
    const found = this.requirements().find(r => r.id === requirementId)
    if (!found) throw new Error(`Requirement ${requirementId} not found`)
    return found.review ?? 'pending'
  }

  async createDevRequirement(params: {
    requirement: Requirement
    title: string
    description: string
    ownerId?: string
  }): Promise<string> {
    const list = this.readJson<Record<string, unknown>[]>(
      'dev-requirements.json',
      [],
    )
    const id = `dev-${params.requirement.id}-${list.length + 1}`
    list.push({
      id,
      requirementId: params.requirement.id,
      title: params.title,
      description: params.description,
      ownerId: params.ownerId,
      createdAt: new Date().toISOString(),
    })
    this.writeJson('dev-requirements.json', list)
    return id
  }

  async createTask(params: {
    devRequirementId: string
    title: string
    description?: string
    assigneeId?: string
  }): Promise<DevTask> {
    const list = this.readJson<Record<string, unknown>[]>('tasks.json', [])
    const task: DevTask = {
      id: `task-${list.length + 1}`,
      title: params.title,
      status: 'todo',
      assignee: params.assigneeId,
    }
    list.push({
      ...task,
      devRequirementId: params.devRequirementId,
      description: params.description,
    })
    this.writeJson('tasks.json', list)
    return task
  }

  async updateStatus(requirementId: string, status: string): Promise<void> {
    const list = this.requirements()
    const found = list.find(r => r.id === requirementId)
    if (found) {
      found.status = status
      this.writeJson('requirements.json', list)
    }
  }
}
