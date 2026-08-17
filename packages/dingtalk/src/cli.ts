import { createInterface } from 'node:readline/promises'
import {
  clearAccount,
  DEFAULT_BASE_URL,
  getStateDir,
  loadAccount,
  saveAccount,
} from './accounts.js'
import { getAccessToken } from './api.js'
import {
  confirmPairing,
  loadAccessConfig,
  saveAccessConfig,
} from './pairing.js'
import { runDingtalkMcpServer } from './server.js'
import type { DingtalkServerDeps } from './server.js'

function printUsage(): void {
  process.stdout.write(
    [
      'Usage:',
      '  ccb dingtalk serve',
      '  ccb dingtalk login              Enter AppKey / AppSecret / RobotCode',
      '  ccb dingtalk login clear        Forget stored credentials',
      '  ccb dingtalk status             Show what is configured',
      '  ccb dingtalk access pair <code> Approve a pairing code',
      '  ccb dingtalk access list        List paired sender IDs',
      '',
      'Credentials can also come from the environment:',
      '  DINGTALK_APP_KEY, DINGTALK_APP_SECRET, DINGTALK_ROBOT_CODE',
      '',
      'Session enablement:',
      '  ccb --channels plugin:dingtalk@builtin',
    ].join('\n') + '\n',
  )
}

/**
 * Ask a series of questions on ONE readline interface.
 *
 * A fresh interface per question looks tidier but breaks on piped stdin: the
 * first interface buffers everything available, so later ones read from an
 * already-drained stream and hang forever.
 *
 * `rl.question` also never settles once stdin closes, so an EOF mid-sequence
 * would hang rather than fail — race each question against the interface's
 * own close event and surface it as an error.
 */
async function promptAll(questions: readonly string[]): Promise<string[]> {
  return promptAllOn(questions, process.stdin, process.stdout)
}

/** Stream-injectable core of {@link promptAll}, shared with its tests. */
export async function promptAllOn(
  questions: readonly string[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string[]> {
  const rl = createInterface({ input, output })
  // Pull lines through the async iterator rather than rl.question(): the
  // iterator reports EOF as `done` instead of leaving a promise unsettled,
  // and it behaves identically for a TTY and a pipe.
  const lines = rl[Symbol.asyncIterator]()

  const answers: string[] = []
  try {
    for (const question of questions) {
      output.write(question)
      const next = await lines.next()
      if (next.done) {
        throw new Error('input ended before all values were provided')
      }
      answers.push(String(next.value).trim())
    }
  } finally {
    rl.close()
  }
  return answers
}

async function runLogin(clear = false): Promise<void> {
  if (clear) {
    clearAccount()
    process.stdout.write('DingTalk credentials cleared.\n')
    return
  }

  const existing = loadAccount()
  if (existing) {
    process.stdout.write(
      [
        'Already configured:',
        `  AppKey:    ${existing.appKey}`,
        `  RobotCode: ${existing.robotCode}`,
        `  Saved:     ${existing.savedAt}`,
        '',
        'Run `ccb dingtalk login clear` to reset.',
      ].join('\n') + '\n',
    )
    return
  }

  process.stdout.write(
    [
      'Connect a DingTalk 企业内部应用 (Stream mode).',
      '',
      'From https://open-dev.dingtalk.com → your app:',
      '  · 凭证与基础信息  → AppKey / AppSecret',
      '  · 机器人配置      → RobotCode',
      '',
      'The app needs the 机器人 capability with 消息接收模式 = Stream,',
      'and the qyapi_robot_sendmsg permission.',
      '',
    ].join('\n'),
  )

  let appKey: string
  let appSecret: string
  let robotCodeInput: string
  try {
    ;[appKey, appSecret, robotCodeInput] = (await promptAll([
      'AppKey: ',
      'AppSecret: ',
      'RobotCode (blank = same as AppKey): ',
    ])) as [string, string, string]
  } catch (error) {
    process.stderr.write(
      `\nLogin aborted: ${error instanceof Error ? error.message : String(error)}\n` +
        'Set DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_ROBOT_CODE instead\n' +
        'if you cannot answer the prompts interactively.\n',
    )
    process.exit(1)
  }

  if (!appKey || !appSecret) {
    process.stderr.write('AppKey and AppSecret are both required.\n')
    process.exit(1)
  }

  const robotCode = robotCodeInput || appKey

  // Verify before persisting — a typo'd secret is much cheaper to catch here
  // than as a silent no-op inside an agent session.
  process.stdout.write('\nVerifying credentials...\n')
  try {
    await getAccessToken({ appKey, appSecret, baseUrl: DEFAULT_BASE_URL })
  } catch (error) {
    process.stderr.write(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }

  saveAccount({
    appKey,
    appSecret,
    robotCode,
    baseUrl: DEFAULT_BASE_URL,
    savedAt: new Date().toISOString(),
  })

  process.stdout.write(
    [
      '',
      'Connected successfully.',
      `  Stored in: ${getStateDir()}/account.json (mode 600)`,
      '',
      'Start a session with:',
      '  ccb --channels plugin:dingtalk@builtin',
      '',
      'Then message the robot in DingTalk. The first message returns a pairing',
      'code — approve it with `ccb dingtalk access pair <code>`.',
    ].join('\n') + '\n',
  )
}

function runStatus(): void {
  const account = loadAccount()
  if (!account) {
    process.stdout.write('Not configured. Run `ccb dingtalk login`.\n')
    return
  }
  const access = loadAccessConfig()
  process.stdout.write(
    [
      'DingTalk channel:',
      `  AppKey:    ${account.appKey}`,
      `  RobotCode: ${account.robotCode}`,
      `  Source:    ${account.savedAt === 'env' ? 'environment variables' : account.savedAt}`,
      `  State dir: ${getStateDir()}`,
      '',
      `Access policy: ${access.policy}`,
      access.allowFrom.length > 0
        ? `Paired senders:\n${access.allowFrom.map(id => `  · ${id}`).join('\n')}`
        : 'Paired senders: (none)',
    ].join('\n') + '\n',
  )
}

function runAccess(args: string[]): void {
  const [action, value] = args

  if (action === 'list') {
    const config = loadAccessConfig()
    if (config.allowFrom.length === 0) {
      process.stdout.write('No paired senders.\n')
      return
    }
    process.stdout.write(config.allowFrom.join('\n') + '\n')
    return
  }

  if (action === 'pair' && value) {
    const senderId = confirmPairing(value)
    if (!senderId) {
      process.stderr.write('Invalid or expired pairing code.\n')
      process.exit(1)
    }
    process.stdout.write(`Paired successfully: ${senderId}\n`)
    return
  }

  if (action === 'revoke' && value) {
    const config = loadAccessConfig()
    const next = config.allowFrom.filter(id => id !== value)
    if (next.length === config.allowFrom.length) {
      process.stderr.write(`Not paired: ${value}\n`)
      process.exit(1)
    }
    saveAccessConfig({ ...config, allowFrom: next })
    process.stdout.write(`Revoked: ${value}\n`)
    return
  }

  printUsage()
  process.exit(1)
}

export async function handleDingtalkCli(
  args: string[],
  serverDeps?: DingtalkServerDeps,
  version?: string,
): Promise<void> {
  const [subcommand, ...rest] = args

  switch (subcommand) {
    case 'serve':
      if (!serverDeps) {
        process.stderr.write(
          '[dingtalk] serve handler not available in this context.\n',
        )
        process.exit(1)
      }
      await runDingtalkMcpServer(version ?? '0.0.0', serverDeps)
      return
    case 'login':
      await runLogin(rest[0] === 'clear')
      return
    case 'status':
      runStatus()
      return
    case 'access':
      runAccess(rest)
      return
    default:
      printUsage()
  }
}
