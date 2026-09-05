import type {
  DevPlan,
  DevTask,
  Envelope,
  Requirement,
  ReviewStatus,
} from './types.js'

/**
 * Everything that touches the outside world sits behind one of these three
 * ports. The use cases in `coordinator.ts` and `worker.ts` only ever see the
 * interfaces, which is what makes them testable with in-memory fakes and
 * swappable when the real management system turns out to speak something
 * other than the REST shape assumed in `adapters/managementHttp.ts`.
 */

export interface ManagementSystem {
  /** Requirements created after `since` (ISO), or everything when omitted. */
  listNewRequirements(since?: string): Promise<Requirement[]>
  getReviewStatus(requirementId: string): Promise<ReviewStatus>
  /** Returns the created dev requirement's id. */
  createDevRequirement(params: {
    requirement: Requirement
    title: string
    description: string
    ownerId?: string
  }): Promise<string>
  createTask(params: {
    devRequirementId: string
    title: string
    description?: string
    assigneeId?: string
  }): Promise<DevTask>
  /** Optional: push our state back so the management system stays in sync. */
  updateStatus?(requirementId: string, status: string): Promise<void>
}

export interface Notifier {
  /** Post to the team conversation, mentioning the given DingTalk staff ids. */
  announce(params: {
    title: string
    text: string
    atUserIds?: string[]
  }): Promise<void>
}

export interface Peer {
  key: string
  endpoint: string
  token?: string
}

export interface Transport {
  send(peer: Peer, envelope: Envelope): Promise<void>
}

export interface InboxServer {
  /** Resolves once listening; `onEnvelope` runs for each valid message. */
  start(onEnvelope: (envelope: Envelope) => Promise<void>): Promise<{
    address: string
    stop(): Promise<void>
  }>
}

export type { DevPlan }
