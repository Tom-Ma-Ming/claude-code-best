import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { activeProfile } from './accounts.js'

/**
 * ccb hook wiring for the relay.
 *
 * The channel runs as an MCP subprocess and cannot register in-process hooks
 * in the ccb main loop, so mirroring goes through ccb's own hook system: each
 * event spawns `ccb dingtalk notify`, which reads the payload on stdin.
 */

/** Events the relay subscribes to, and why each one is here. */
export const RELAY_HOOK_EVENTS = [
  'UserPromptSubmit', // what you asked for
  'PreToolUse', // what is running right now
  'PostToolUseFailure', // a tool blew up / timed out / was interrupted
  'Stop', // the turn's final answer
  'StopFailure', // the turn died on an API error
  'SessionStart', // a session opened in some project
  'SessionEnd', // the session is over
] as const

export type RelayHookEvent = (typeof RELAY_HOOK_EVENTS)[number]

/** Marks the entries this installer owns, so uninstall can remove exactly them. */
export const HOOK_MARKER = 'ccb dingtalk notify'

interface HookCommand {
  type: 'command'
  command: string
  timeout?: number
}
interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}
type HooksBlock = Record<string, HookMatcher[]>

function relayCommand(profile?: string): string {
  // The profile is baked into the command rather than inherited: hooks may run
  // in a shell that never saw the exported var, and a relay pointed at the
  // wrong robot is worse than no relay.
  return profile ? `DINGTALK_PROFILE=${profile} ${HOOK_MARKER}` : HOOK_MARKER
}

export function buildRelayHooks(profile?: string): HooksBlock {
  const command = relayCommand(profile)
  const block: HooksBlock = {}
  for (const event of RELAY_HOOK_EVENTS) {
    block[event] = [
      {
        hooks: [{ type: 'command', command, timeout: 10 }],
      },
    ]
  }
  return block
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    throw new Error(
      `${path} is not valid JSON — fix it before installing hooks.`,
    )
  }
}

/** Drop only the matchers whose commands this installer wrote. */
function stripOurHooks(existing: HooksBlock): HooksBlock {
  const cleaned: HooksBlock = {}
  for (const [event, matchers] of Object.entries(existing)) {
    const kept = (matchers ?? [])
      .map(m => ({
        ...m,
        hooks: (m.hooks ?? []).filter(h => !h.command?.includes(HOOK_MARKER)),
      }))
      .filter(m => m.hooks.length > 0)
    if (kept.length > 0) cleaned[event] = kept
  }
  return cleaned
}

export function installRelayHooks(settingsPath: string): void {
  const settings = readSettings(settingsPath)
  const existing = (settings.hooks ?? {}) as HooksBlock
  const base = stripOurHooks(existing)
  const ours = buildRelayHooks(activeProfile())

  const merged: HooksBlock = { ...base }
  for (const [event, matchers] of Object.entries(ours)) {
    merged[event] = [...(base[event] ?? []), ...matchers]
  }

  settings.hooks = merged
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
}

export function uninstallRelayHooks(settingsPath: string): boolean {
  const settings = readSettings(settingsPath)
  const existing = (settings.hooks ?? {}) as HooksBlock
  const before = JSON.stringify(existing)
  const cleaned = stripOurHooks(existing)
  if (JSON.stringify(cleaned) === before) return false

  if (Object.keys(cleaned).length > 0) settings.hooks = cleaned
  else delete settings.hooks
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
  return true
}

/** Whether our hooks are already present. */
export function relayHooksInstalled(settingsPath: string): boolean {
  try {
    const settings = readSettings(settingsPath)
    return JSON.stringify(settings.hooks ?? {}).includes(HOOK_MARKER)
  } catch {
    return false
  }
}
