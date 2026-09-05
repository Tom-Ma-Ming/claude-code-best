import { DEFAULT_HTTP_ENDPOINTS, type HttpEndpoints } from '../config.js'
import type { ManagementSystem } from '../ports.js'
import type { DevTask, Requirement, ReviewStatus } from '../types.js'

/**
 * Generic REST adapter. The response shapes below are an assumption about the
 * user's management system, chosen to be easy to satisfy with a thin proxy:
 *
 *   GET  listNew              → { items: Requirement[] }  (or a bare array)
 *   GET  reviewStatus         → { status: 'pending'|'approved'|'rejected' }
 *   POST createDevRequirement → { id: string }
 *   POST createTask           → { id: string, title?: string }
 *
 * When the real API differs, change the mapping functions here — nothing
 * outside this file knows about HTTP.
 */
export class HttpManagementSystem implements ManagementSystem {
  private readonly endpoints: HttpEndpoints

  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    endpoints: Partial<HttpEndpoints> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoints = { ...DEFAULT_HTTP_ENDPOINTS, ...endpoints }
  }

  private url(template: string, vars: Record<string, string>): string {
    const path = template.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(vars[key] ?? ''),
    )
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const resp = await this.fetchImpl(url, { ...init, headers })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(
        `management system ${init.method ?? 'GET'} ${url} → HTTP ${resp.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      )
    }
    return (await resp.json()) as T
  }

  async listNewRequirements(since?: string): Promise<Requirement[]> {
    const data = await this.call<{ items?: unknown[] } | unknown[]>(
      this.url(this.endpoints.listNew, { since: since ?? '' }),
    )
    const items = Array.isArray(data) ? data : (data.items ?? [])
    return items.map(mapRequirement)
  }

  async getReviewStatus(requirementId: string): Promise<ReviewStatus> {
    const data = await this.call<{ status?: string }>(
      this.url(this.endpoints.reviewStatus, { id: requirementId }),
    )
    return mapReviewStatus(data.status)
  }

  async createDevRequirement(params: {
    requirement: Requirement
    title: string
    description: string
    ownerId?: string
  }): Promise<string> {
    const data = await this.call<{ id: string | number }>(
      this.url(this.endpoints.createDevRequirement, {}),
      {
        method: 'POST',
        body: JSON.stringify({
          requirementId: params.requirement.id,
          title: params.title,
          description: params.description,
          ownerId: params.ownerId,
        }),
      },
    )
    return String(data.id)
  }

  async createTask(params: {
    devRequirementId: string
    title: string
    description?: string
    assigneeId?: string
  }): Promise<DevTask> {
    const data = await this.call<{ id: string | number; title?: string }>(
      this.url(this.endpoints.createTask, { id: params.devRequirementId }),
      {
        method: 'POST',
        body: JSON.stringify({
          title: params.title,
          description: params.description,
          assigneeId: params.assigneeId,
        }),
      },
    )
    return {
      id: String(data.id),
      title: data.title ?? params.title,
      status: 'todo',
      assignee: params.assigneeId,
    }
  }
}

function mapRequirement(raw: unknown): Requirement {
  const r = (raw ?? {}) as Record<string, unknown>
  const owners = Array.isArray(r.owners)
    ? r.owners.map(String)
    : typeof r.owner === 'string'
      ? [r.owner]
      : []
  return {
    id: String(r.id ?? ''),
    title: String(r.title ?? r.name ?? ''),
    description: typeof r.description === 'string' ? r.description : undefined,
    url: typeof r.url === 'string' ? r.url : undefined,
    owners,
    createdAt: String(r.createdAt ?? r.created_at ?? new Date().toISOString()),
    raw,
  }
}

function mapReviewStatus(value: string | undefined): ReviewStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'approved':
    case 'passed':
    case 'pass':
    case '通过':
      return 'approved'
    case 'rejected':
    case 'failed':
    case 'fail':
    case '驳回':
      return 'rejected'
    default:
      return 'pending'
  }
}
