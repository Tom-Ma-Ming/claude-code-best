import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Open API host for v1.0 endpoints (token, send, file download). */
export const DEFAULT_BASE_URL = 'https://api.dingtalk.com'
/** Legacy host — still the only one that serves /media/upload. */
export const OAPI_BASE_URL = 'https://oapi.dingtalk.com'

export interface AccountData {
  /** App credentials from open-dev.dingtalk.com → 凭证与基础信息. */
  appKey: string
  appSecret: string
  /** From 应用详情 → 机器人配置. Required on every outbound send. */
  robotCode: string
  baseUrl: string
  savedAt: string
}

/** Root holding the default profile and the `profiles/` subtree. */
function channelRoot(): string {
  return join(homedir(), '.ccb', 'channels', 'dingtalk')
}

/** Profile names become path segments — keep them boring. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function assertValidProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }
}

/**
 * Which credential set to use.
 *
 * One DingTalk app per project means several credential sets on one machine
 * (see docs/features/dingtalk.md). A profile keeps each app's account,
 * allowlist and pending pairings in their own directory, so switching projects
 * is an env var rather than a re-login.
 *
 * `DINGTALK_PROFILE` is read at runtime and propagates to the `ccb dingtalk
 * serve` subprocess, which is how the MCP server picks the right credentials.
 */
export function activeProfile(): string | undefined {
  const name = process.env.DINGTALK_PROFILE?.trim()
  if (!name) return undefined
  assertValidProfileName(name)
  return name
}

/**
 * State directory for the given (or active) profile.
 *
 * `DINGTALK_STATE_DIR` still wins outright — it is the container/CI escape
 * hatch and pointing it somewhere explicit should not be second-guessed.
 * The unnamed default profile stays at the channel root so existing installs
 * keep working untouched.
 */
export function stateDirPath(profile?: string): string {
  const explicit = process.env.DINGTALK_STATE_DIR
  if (explicit) return explicit
  const name = profile ?? activeProfile()
  return name ? join(channelRoot(), 'profiles', name) : channelRoot()
}

/**
 * State directory, created if missing.
 *
 * Only callers that are about to *write* should use this. Reads go through
 * {@link stateDirPath}: probing an unconfigured profile should not leave an
 * empty directory behind, which is what `loadAccount` used to do for every
 * profile name it was asked about.
 */
export function getStateDir(profile?: string): string {
  const dir = stateDirPath(profile)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** Profile names that have credentials stored, sorted. */
export function listProfiles(): string[] {
  const dir = join(channelRoot(), 'profiles')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => existsSync(join(dir, name, 'account.json')))
      .sort()
  } catch {
    return []
  }
}

function accountPath(profile?: string): string {
  return join(stateDirPath(profile), 'account.json')
}

/**
 * Credentials for a profile.
 *
 * Env vars (DINGTALK_APP_KEY/SECRET) configure the **unnamed default profile**
 * only — that is the container case, where there is no writable home to log
 * into. Naming a profile means "use that profile's file"; letting env shadow it
 * made `login --profile b` report profile A's env credentials as already
 * configured, so B was never written and the wrong robot was used.
 */
export function loadAccount(profile?: string): AccountData | null {
  const selected = profile ?? activeProfile()
  const envKey = selected ? undefined : process.env.DINGTALK_APP_KEY
  const envSecret = selected ? undefined : process.env.DINGTALK_APP_SECRET
  if (envKey && envSecret) {
    return {
      appKey: envKey,
      appSecret: envSecret,
      robotCode: process.env.DINGTALK_ROBOT_CODE || envKey,
      baseUrl: process.env.DINGTALK_BASE_URL || DEFAULT_BASE_URL,
      savedAt: 'env',
    }
  }

  const path = accountPath(profile)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<AccountData>
    if (!parsed.appKey || !parsed.appSecret) return null
    return {
      appKey: parsed.appKey,
      appSecret: parsed.appSecret,
      // robotCode defaults to appKey: for most 企业内部应用 robots the two are
      // the same value, and DingTalk rejects an empty robotCode outright.
      robotCode: parsed.robotCode || parsed.appKey,
      baseUrl: parsed.baseUrl || DEFAULT_BASE_URL,
      savedAt: parsed.savedAt || 'unknown',
    }
  } catch {
    return null
  }
}

export function saveAccount(data: AccountData, profile?: string): void {
  getStateDir(profile)
  const path = accountPath(profile)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  // Contains appSecret — keep it off other users' eyes on shared machines.
  chmodSync(path, 0o600)
}

export function clearAccount(profile?: string): void {
  const path = accountPath(profile)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
