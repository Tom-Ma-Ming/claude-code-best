/**
 * @claude-code-best/devflow — requirement-to-release pipeline across machines.
 *
 * Two roles share these types:
 *
 *   coordinator (machine R)  polls the management system, asks the related
 *                            people in DingTalk, and hands a confirmed
 *                            requirement to one worker. After hand-off it
 *                            stops tracking the item.
 *   worker (machines a–d)    receives the hand-off, follows the review, turns
 *                            an approved requirement into a dev requirement
 *                            plus tasks, drives the work, and reports back.
 */

/** A requirement as it exists in the management system. */
export interface Requirement {
  /** Management-system id. Stable across machines; used as the file name. */
  id: string
  title: string
  description?: string
  /** Link back into the management system, for the DingTalk notice. */
  url?: string
  /**
   * 关联人员 — management-system user ids. The coordinator maps them onto
   * roster keys via `RosterMember.managementUserId`.
   */
  owners: string[]
  createdAt: string
  /** Untouched payload, kept so an adapter change never loses data. */
  raw?: unknown
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/** Requirement lifecycle. The coordinator half ends at `dispatched`. */
export const COORDINATOR_STATES = [
  'discovered',
  'notified',
  'confirmed',
  'dispatched',
  'declined',
] as const
export type CoordinatorState = (typeof COORDINATOR_STATES)[number]

export const WORKER_STATES = [
  'received',
  'accepted',
  'review_pending',
  'review_approved',
  'review_rejected',
  'planned',
  'developing',
  'testing',
  'awaiting_acceptance',
  'acceptance_passed',
  'released',
] as const
export type WorkerState = (typeof WORKER_STATES)[number]

export type FlowState = CoordinatorState | WorkerState

export interface Transition {
  at: string
  from: FlowState | null
  to: FlowState
  note?: string
}

export interface DevTask {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done' | 'failed'
  /** Sub-agent or person the task went to, when known. */
  assignee?: string
}

export interface DevPlan {
  /** Id of the dev requirement created in the management system. */
  devRequirementId: string
  tasks: DevTask[]
  createdAt: string
}

/** A requirement plus everything this machine knows about it. */
export interface TrackedRequirement {
  requirement: Requirement
  state: FlowState
  /** Roster key of the worker that owns it (set by dispatch / receive). */
  assignee?: string
  /** DingTalk staff id of whoever said yes. */
  confirmedBy?: string
  /** Where the hand-off came from, on the worker side. */
  dispatchedFrom?: string
  plan?: DevPlan
  history: Transition[]
  updatedAt: string
}

/** Machine-to-machine messages. `kind` is the discriminator. */
export interface DispatchEnvelope {
  kind: 'devflow/dispatch'
  version: 1
  id: string
  sentAt: string
  /** Coordinator's machine name. */
  from: string
  requirement: Requirement
  /** Roster key the coordinator picked. */
  assignee: string
  confirmedBy?: string
  /** DingTalk conversation the discussion happened in, for follow-ups. */
  conversationId?: string
}

export interface AckEnvelope {
  kind: 'devflow/ack'
  version: 1
  id: string
  sentAt: string
  from: string
  /** The dispatch this acknowledges. */
  dispatchId: string
  requirementId: string
  accepted: boolean
  reason?: string
}

export type Envelope = DispatchEnvelope | AckEnvelope

export const ENVELOPE_KINDS: ReadonlySet<string> = new Set([
  'devflow/dispatch',
  'devflow/ack',
])
