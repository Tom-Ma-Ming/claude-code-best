import {
  rosterKeyForDingtalkUser,
  rosterKeyForOwner,
  type DevflowConfig,
} from './config.js'
import { newId } from './envelope.js'
import type { ManagementSystem, Notifier, Transport } from './ports.js'
import type { Store } from './store.js'
import type {
  DispatchEnvelope,
  Requirement,
  TrackedRequirement,
} from './types.js'

export interface CoordinatorDeps {
  config: DevflowConfig
  store: Store
  management: ManagementSystem
  notifier: Notifier
  transport: Transport
  now?: () => Date
}

/**
 * Machine R. Three use cases, each idempotent so a cron can call `poll`
 * freely and a chat reply can hit `confirm` twice without harm.
 */
export class Coordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /** Pull new requirements, track them, and announce each one once. */
  async poll(): Promise<{ discovered: Requirement[]; notified: string[] }> {
    const { store, management } = this.deps
    const since = latestCreatedAt(store.list())
    const fresh = (await management.listNewRequirements(since)).filter(
      r => !store.has(r.id),
    )
    const notified: string[] = []
    for (const requirement of fresh) {
      store.track(requirement, 'discovered')
      try {
        await this.notify(requirement)
        store.transition(requirement.id, 'notified')
        notified.push(requirement.id)
      } catch (error) {
        store.event('notify_failed', requirement.id, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { discovered: fresh, notified }
  }

  /** Re-announce items whose first notice failed. */
  async retryNotifications(): Promise<string[]> {
    const done: string[] = []
    for (const item of this.deps.store.listByState('discovered')) {
      await this.notify(item.requirement)
      this.deps.store.transition(item.requirement.id, 'notified')
      done.push(item.requirement.id)
    }
    return done
  }

  private async notify(requirement: Requirement): Promise<void> {
    const { config, notifier } = this.deps
    const atUserIds = requirement.owners
      .map(owner => rosterKeyForOwner(config.roster, owner))
      .map(key => (key ? config.roster[key]?.dingtalkUserId : undefined))
      .filter((id): id is string => Boolean(id))
    await notifier.announce({
      title: `新需求待评审：${requirement.title}`,
      text: [
        `**${requirement.title}**`,
        requirement.description ? `\n${requirement.description}` : '',
        requirement.url ? `\n[查看需求](${requirement.url})` : '',
        '',
        `需求编号：\`${requirement.id}\``,
        '是否需要评审？回复「是 ' +
          requirement.id +
          '」接手，回复「否 ' +
          requirement.id +
          '」忽略。',
      ].join('\n'),
      atUserIds,
    })
  }

  /**
   * A related person said yes. `by` is their DingTalk staff id; the assignee
   * defaults to that person when they are on the roster, else the first
   * owner that is.
   */
  confirm(params: {
    requirementId: string
    by?: string
    assignee?: string
  }): TrackedRequirement {
    const { store, config } = this.deps
    const item = store.get(params.requirementId)
    if (!item) throw new Error(`Unknown requirement ${params.requirementId}`)
    if (item.state === 'confirmed' || item.state === 'dispatched') return item

    const assignee =
      params.assignee ??
      (params.by
        ? rosterKeyForDingtalkUser(config.roster, params.by)
        : undefined) ??
      item.requirement.owners
        .map(owner => rosterKeyForOwner(config.roster, owner))
        .find((key): key is string =>
          Boolean(key && config.roster[key]?.endpoint),
        )
    if (!assignee) {
      throw new Error(
        `Cannot pick a worker for ${params.requirementId}: nobody among ${item.requirement.owners.join(', ')} is on the roster with an endpoint. Pass --assignee <key>.`,
      )
    }
    if (!config.roster[assignee]) {
      throw new Error(`Unknown roster key ${assignee}`)
    }
    return store.transition(
      params.requirementId,
      'confirmed',
      params.by ? `by ${params.by}` : undefined,
      {
        assignee,
        confirmedBy: params.by,
      },
    )
  }

  decline(requirementId: string, by?: string): TrackedRequirement {
    return this.deps.store.transition(
      requirementId,
      'declined',
      by ? `by ${by}` : undefined,
    )
  }

  /** Hand a confirmed requirement to its worker. R is done with it afterwards. */
  async dispatch(requirementId: string): Promise<DispatchEnvelope> {
    const { store, config, transport } = this.deps
    const item = store.get(requirementId)
    if (!item) throw new Error(`Unknown requirement ${requirementId}`)
    if (item.state !== 'confirmed') {
      throw new Error(
        `${requirementId} is ${item.state}; only confirmed items can be dispatched`,
      )
    }
    const key = item.assignee
    const member = key ? config.roster[key] : undefined
    if (!key || !member?.endpoint) {
      throw new Error(
        `Assignee ${key ?? '(none)'} has no endpoint in the roster`,
      )
    }
    const envelope: DispatchEnvelope = {
      kind: 'devflow/dispatch',
      version: 1,
      id: newId(),
      sentAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      from: config.machine,
      requirement: item.requirement,
      assignee: key,
      confirmedBy: item.confirmedBy,
      conversationId: config.dingtalk?.conversationId,
    }
    await transport.send(
      { key, endpoint: member.endpoint, token: member.token },
      envelope,
    )
    store.transition(requirementId, 'dispatched', `to ${key} (${envelope.id})`)
    return envelope
  }

  /** Confirm and dispatch in one step, for the chat-reply path. */
  async accept(params: {
    requirementId: string
    by?: string
    assignee?: string
  }): Promise<DispatchEnvelope> {
    this.confirm(params)
    return this.dispatch(params.requirementId)
  }
}

function latestCreatedAt(items: TrackedRequirement[]): string | undefined {
  let latest: string | undefined
  for (const item of items) {
    const at = item.requirement.createdAt
    if (!latest || at > latest) latest = at
  }
  return latest
}

/**
 * Parse a chat reply like「是 REQ-12」/「yes REQ-12」/「否 REQ-12」. Returns
 * null for anything else so ordinary conversation is never mistaken for a
 * decision.
 */
export function parseDecisionReply(
  text: string,
): { decision: 'yes' | 'no'; requirementId: string } | null {
  const m = text.trim().match(/^(是|好|接手|yes|y|否|不|忽略|no|n)\s+(\S+)$/i)
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const decision = ['是', '好', '接手', 'yes', 'y'].includes(word)
    ? 'yes'
    : 'no'
  return { decision, requirementId: m[2]! }
}
