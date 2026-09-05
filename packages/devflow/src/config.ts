import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'

export type Role = 'coordinator' | 'worker'

export interface RosterMember {
  /** Display name used in notices. */
  name: string
  /** Id in the management system; matched against `Requirement.owners`. */
  managementUserId?: string
  /** DingTalk staff id, for @-mentions. */
  dingtalkUserId?: string
  /** Worker inbox, e.g. `http://10.0.0.11:7788`. Absent for non-worker people. */
  endpoint?: string
  /** Bearer token that worker's inbox expects. */
  token?: string
}

export type ManagementSystemConfig =
  | {
      type: 'http'
      baseUrl: string
      token?: string
      /** Path templates; `{id}` and `{since}` are substituted. */
      endpoints?: Partial<HttpEndpoints>
    }
  | {
      /** Local JSON files — for demos and tests, no server needed. */
      type: 'file'
      dir: string
    }

export interface HttpEndpoints {
  listNew: string
  reviewStatus: string
  createDevRequirement: string
  createTask: string
}

export const DEFAULT_HTTP_ENDPOINTS: HttpEndpoints = {
  listNew: '/requirements?status=new&since={since}',
  reviewStatus: '/requirements/{id}/review',
  createDevRequirement: '/dev-requirements',
  createTask: '/dev-requirements/{id}/tasks',
}

export interface DevflowConfig {
  role: Role
  /** Name this machine signs envelopes with. Defaults to the hostname. */
  machine: string
  managementSystem: ManagementSystemConfig
  dingtalk?: {
    /** `DINGTALK_PROFILE` to load credentials from. */
    profile?: string
    /** Group the coordinator announces new requirements in. */
    conversationId?: string
  }
  /** Everyone the coordinator can @-mention or dispatch to, keyed by short id. */
  roster: Record<string, RosterMember>
  /** Worker-side inbox. */
  inbox?: {
    host?: string
    port: number
    token: string
    /**
     * What to do when a dispatch lands. `notify` posts to this machine's own
     * DingTalk binding; `command` is spawned with `{id}` substituted.
     */
    onReceive?: { notify?: boolean; command?: string }
  }
  /** Coordinator polling interval for `poll --watch`. */
  pollIntervalMs?: number
}

export function devflowDir(): string {
  return process.env.DEVFLOW_STATE_DIR ?? join(homedir(), '.ccb', 'devflow')
}

export function configPath(): string {
  return join(devflowDir(), 'config.json')
}

export function ensureDevflowDir(): string {
  const dir = devflowDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function hasConfig(): boolean {
  return existsSync(configPath())
}

export function loadConfig(): DevflowConfig {
  const path = configPath()
  if (!existsSync(path)) {
    throw new Error(
      `devflow is not configured on this machine. Run \`ccb devflow init --role coordinator|worker\` (config: ${path}).`,
    )
  }
  const parsed = JSON.parse(
    readFileSync(path, 'utf-8'),
  ) as Partial<DevflowConfig>
  return validateConfig(parsed)
}

export function saveConfig(config: DevflowConfig): void {
  ensureDevflowDir()
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function validateConfig(parsed: Partial<DevflowConfig>): DevflowConfig {
  if (parsed.role !== 'coordinator' && parsed.role !== 'worker') {
    throw new Error(`config.role must be "coordinator" or "worker"`)
  }
  if (!parsed.managementSystem) {
    throw new Error('config.managementSystem is required')
  }
  if (parsed.role === 'worker' && !parsed.inbox) {
    throw new Error('config.inbox is required for a worker')
  }
  return {
    role: parsed.role,
    machine: parsed.machine || hostname(),
    managementSystem: parsed.managementSystem,
    dingtalk: parsed.dingtalk,
    roster: parsed.roster ?? {},
    inbox: parsed.inbox,
    pollIntervalMs: parsed.pollIntervalMs,
  }
}

/** A starting point `init` writes; every value is meant to be edited. */
export function templateConfig(role: Role): DevflowConfig {
  const base = {
    machine: hostname(),
    managementSystem: {
      type: 'file' as const,
      dir: join(devflowDir(), 'management-system'),
    },
    dingtalk: { profile: undefined, conversationId: undefined },
  }
  if (role === 'coordinator') {
    return {
      role,
      ...base,
      roster: {
        a: {
          name: '研发A',
          managementUserId: 'user-a',
          dingtalkUserId: 'staffId-a',
          endpoint: 'http://10.0.0.11:7788',
          token: 'change-me',
        },
      },
      pollIntervalMs: 5 * 60_000,
    }
  }
  return {
    role,
    ...base,
    roster: {},
    inbox: {
      host: '0.0.0.0',
      port: 7788,
      token: 'change-me',
      onReceive: { notify: true },
    },
  }
}

/** Roster key for a management-system user id, if anyone matches. */
export function rosterKeyForOwner(
  roster: Record<string, RosterMember>,
  ownerId: string,
): string | undefined {
  if (Object.hasOwn(roster, ownerId)) return ownerId
  for (const [key, member] of Object.entries(roster)) {
    if (member.managementUserId === ownerId) return key
  }
  return undefined
}

/** Roster key for a DingTalk staff id, if anyone matches. */
export function rosterKeyForDingtalkUser(
  roster: Record<string, RosterMember>,
  staffId: string,
): string | undefined {
  for (const [key, member] of Object.entries(roster)) {
    if (member.dingtalkUserId === staffId) return key
  }
  return undefined
}
