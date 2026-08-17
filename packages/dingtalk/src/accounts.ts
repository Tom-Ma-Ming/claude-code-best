import {
  chmodSync,
  existsSync,
  mkdirSync,
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

export function getStateDir(): string {
  const dir =
    process.env.DINGTALK_STATE_DIR ||
    join(homedir(), '.ccb', 'channels', 'dingtalk')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function accountPath(): string {
  return join(getStateDir(), 'account.json')
}

/**
 * Credentials come from the account file, or from env vars so a container can
 * inject them without a writable home. Env wins — it is the more explicit
 * source and is how CI/containers are expected to configure the channel.
 */
export function loadAccount(): AccountData | null {
  const envKey = process.env.DINGTALK_APP_KEY
  const envSecret = process.env.DINGTALK_APP_SECRET
  if (envKey && envSecret) {
    return {
      appKey: envKey,
      appSecret: envSecret,
      robotCode: process.env.DINGTALK_ROBOT_CODE || envKey,
      baseUrl: process.env.DINGTALK_BASE_URL || DEFAULT_BASE_URL,
      savedAt: 'env',
    }
  }

  const path = accountPath()
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

export function saveAccount(data: AccountData): void {
  const path = accountPath()
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  // Contains appSecret — keep it off other users' eyes on shared machines.
  chmodSync(path, 0o600)
}

export function clearAccount(): void {
  const path = accountPath()
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
