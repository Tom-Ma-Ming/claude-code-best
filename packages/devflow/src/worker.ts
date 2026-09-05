import { spawn } from 'node:child_process'
import type { DevflowConfig } from './config.js'
import { newId } from './envelope.js'
import type { ManagementSystem, Notifier, Transport } from './ports.js'
import type { Store } from './store.js'
import type {
  AckEnvelope,
  DevPlan,
  DispatchEnvelope,
  Envelope,
  TrackedRequirement,
} from './types.js'

export interface WorkerDeps {
  config: DevflowConfig
  store: Store
  management: ManagementSystem
  /** Optional: this machine's own DingTalk, for "you have a new item" pings. */
  notifier?: Notifier
  /** Optional: to ack back to the coordinator when it has an inbox. */
  transport?: Transport
  spawnImpl?: typeof spawn
}

/**
 * Machine a/b/c/d. Owns a requirement from `received` to `released`.
 *
 * The skeleton implements the bookkeeping: receiving, review tracking, and
 * turning an approved requirement into a dev requirement plus tasks. The
 * creative parts — writing the task breakdown, running sub-agents, deciding
 * tests pass — belong to the ccb agent driven by the `devflow-worker` skill,
 * which calls back into `advance` and `plan` as it goes.
 */
export class Worker {
  constructor(private readonly deps: WorkerDeps) {}

  /** Inbox handler. Idempotent on envelope id and requirement id. */
  async receive(envelope: Envelope): Promise<void> {
    if (envelope.kind !== 'devflow/dispatch') {
      this.deps.store.event('ack_received', envelope.requirementId, {
        accepted: envelope.accepted,
        reason: envelope.reason,
      })
      return
    }
    await this.receiveDispatch(envelope)
  }

  private async receiveDispatch(envelope: DispatchEnvelope): Promise<void> {
    const { store, config } = this.deps
    const id = envelope.requirement.id
    if (store.has(id)) {
      store.event('dispatch_duplicate', id, { envelope: envelope.id })
      return
    }
    store.track(envelope.requirement, 'received', {
      assignee: envelope.assignee,
      confirmedBy: envelope.confirmedBy,
      dispatchedFrom: envelope.from,
    })
    store.event('dispatch_received', id, {
      envelope: envelope.id,
      from: envelope.from,
    })

    const onReceive = config.inbox?.onReceive ?? {}
    if (onReceive.notify && this.deps.notifier) {
      try {
        await this.deps.notifier.announce({
          title: `接手需求：${envelope.requirement.title}`,
          text: [
            `来自 ${envelope.from} 的需求已到达本机。`,
            `需求编号：\`${id}\``,
            envelope.requirement.url
              ? `[查看需求](${envelope.requirement.url})`
              : '',
            '',
            '本机 ccb 将跟踪评审状态，评审通过后自动建立研发需求与任务。',
          ].join('\n'),
        })
      } catch (error) {
        store.event('notify_failed', id, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (onReceive.command) {
      this.launch(onReceive.command, id)
    }
  }

  /**
   * Start whatever the config says — typically a headless ccb run of the
   * worker skill. Detached so the inbox server is never held hostage by it.
   */
  private launch(template: string, requirementId: string): void {
    const command = template.replaceAll('{id}', requirementId)
    const child = (this.deps.spawnImpl ?? spawn)(command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DEVFLOW_REQUIREMENT_ID: requirementId },
    })
    child.unref()
    this.deps.store.event('launched', requirementId, { command })
  }

  accept(requirementId: string): TrackedRequirement {
    return this.deps.store.transition(requirementId, 'accepted')
  }

  /**
   * Check the management system and move the item accordingly. Safe to call
   * on a timer: nothing changes while the review is still pending.
   */
  async trackReview(requirementId: string): Promise<TrackedRequirement> {
    const { store, management } = this.deps
    let item = store.get(requirementId)
    if (!item) throw new Error(`Unknown requirement ${requirementId}`)
    if (item.state === 'received' || item.state === 'accepted') {
      item = store.transition(requirementId, 'review_pending')
    }
    if (item.state !== 'review_pending') return item

    const status = await management.getReviewStatus(requirementId)
    if (status === 'approved')
      return store.transition(requirementId, 'review_approved')
    if (status === 'rejected')
      return store.transition(requirementId, 'review_rejected')
    return item
  }

  /** A rejected requirement was revised; watch it again. */
  resubmit(requirementId: string): TrackedRequirement {
    return this.deps.store.transition(
      requirementId,
      'review_pending',
      'resubmitted',
    )
  }

  /**
   * Create the dev requirement and its tasks in the management system, then
   * record the plan locally. The breakdown itself comes from the caller (the
   * agent); this only makes it real.
   */
  async plan(params: {
    requirementId: string
    title?: string
    description?: string
    tasks: Array<{ title: string; description?: string; assigneeId?: string }>
  }): Promise<TrackedRequirement> {
    const { store, management, config } = this.deps
    const item = store.get(params.requirementId)
    if (!item) throw new Error(`Unknown requirement ${params.requirementId}`)
    if (item.state !== 'review_approved') {
      throw new Error(
        `${params.requirementId} is ${item.state}; plan needs review_approved`,
      )
    }
    if (params.tasks.length === 0)
      throw new Error('plan needs at least one task')

    const ownerId = item.assignee
      ? config.roster[item.assignee]?.managementUserId
      : undefined
    const devRequirementId = await management.createDevRequirement({
      requirement: item.requirement,
      title: params.title ?? item.requirement.title,
      description: params.description ?? item.requirement.description ?? '',
      ownerId,
    })
    const tasks = []
    for (const task of params.tasks) {
      tasks.push(await management.createTask({ devRequirementId, ...task }))
    }
    const plan: DevPlan = {
      devRequirementId,
      tasks,
      createdAt: new Date().toISOString(),
    }
    await management.updateStatus?.(item.requirement.id, 'planned')
    return store.transition(
      params.requirementId,
      'planned',
      `dev ${devRequirementId}, ${tasks.length} tasks`,
      { plan },
    )
  }

  /** Generic state move for the agent-driven stages. */
  advance(
    requirementId: string,
    to: TrackedRequirement['state'],
    note?: string,
  ): TrackedRequirement {
    const item = this.deps.store.transition(requirementId, to, note)
    void this.deps.management.updateStatus?.(requirementId, to).catch(() => {})
    return item
  }

  updateTask(
    requirementId: string,
    taskId: string,
    status: DevPlan['tasks'][number]['status'],
  ): TrackedRequirement {
    const { store } = this.deps
    const item = store.get(requirementId)
    if (!item?.plan) throw new Error(`${requirementId} has no plan`)
    const task = item.plan.tasks.find(t => t.id === taskId)
    if (!task) throw new Error(`Unknown task ${taskId}`)
    task.status = status
    return store.patch(requirementId, { plan: item.plan })
  }

  ack(
    dispatch: DispatchEnvelope,
    accepted: boolean,
    reason?: string,
  ): AckEnvelope {
    return {
      kind: 'devflow/ack',
      version: 1,
      id: newId(),
      sentAt: new Date().toISOString(),
      from: this.deps.config.machine,
      dispatchId: dispatch.id,
      requirementId: dispatch.requirement.id,
      accepted,
      reason,
    }
  }
}
