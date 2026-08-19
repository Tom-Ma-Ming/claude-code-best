import { createInterface } from 'node:readline/promises'
import {
  activeProfile,
  assertValidProfileName,
  clearAccount,
  DEFAULT_BASE_URL,
  getStateDir,
  listProfiles,
  loadAccount,
  saveAccount,
} from './accounts.js'
import { getAccessToken } from './api.js'
import { applyBinding, waitForFirstMessage } from './bind.js'
import {
  isBound,
  loadChannelConfig,
  saveChannelConfig,
  type ChannelMode,
} from './config.js'
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
      '  ccb dingtalk bind               Bind this session to a person or group',
      '  ccb dingtalk bind --group       Force group mode',
      '  ccb dingtalk bind --private     Force private mode',
      '  ccb dingtalk unbind             Forget the binding',
      '  ccb dingtalk profiles           List stored credential profiles',
      '  ccb dingtalk access pair <code> Approve a pairing code',
      '  ccb dingtalk access list        List paired sender IDs',
      '  ccb dingtalk access revoke <id> Remove a paired sender',
      '',
      'One DingTalk app per project — keep each app in its own profile:',
      '  ccb dingtalk login --profile projectA      store credentials',
      '  DINGTALK_PROFILE=projectA ccb --channels plugin:dingtalk@builtin',
      '',
      'Every subcommand accepts --profile <name>; DINGTALK_PROFILE is the',
      'runtime default and is what the serve subprocess reads.',
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

function profileLabel(profile?: string): string {
  return profile ? ` (profile: ${profile})` : ''
}

async function runLogin(clear = false, profile?: string): Promise<void> {
  if (clear) {
    clearAccount(profile)
    process.stdout.write(
      `DingTalk credentials cleared${profileLabel(profile)}.\n`,
    )
    return
  }

  const existing = loadAccount(profile)
  if (existing) {
    process.stdout.write(
      [
        `Already configured${profileLabel(profile)}:`,
        `  AppKey:    ${existing.appKey}`,
        `  RobotCode: ${existing.robotCode}`,
        `  Saved:     ${existing.savedAt}`,
        '',
        `Run \`ccb dingtalk login clear${profile ? ` --profile ${profile}` : ''}\` to reset.`,
      ].join('\n') + '\n',
    )
    return
  }

  process.stdout.write(
    [
      `Connect a DingTalk 企业内部应用 (Stream mode)${profileLabel(profile)}.`,
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

  saveAccount(
    {
      appKey,
      appSecret,
      robotCode,
      baseUrl: DEFAULT_BASE_URL,
      savedAt: new Date().toISOString(),
    },
    profile,
  )

  const launch = profile
    ? `DINGTALK_PROFILE=${profile} ccb --channels plugin:dingtalk@builtin`
    : 'ccb --channels plugin:dingtalk@builtin'
  const pairCmd = profile
    ? `ccb dingtalk access pair <code> --profile ${profile}`
    : 'ccb dingtalk access pair <code>'

  process.stdout.write(
    [
      '',
      `Connected successfully${profileLabel(profile)}.`,
      `  Stored in: ${getStateDir(profile)}/account.json (mode 600)`,
      '',
      'Start a session with:',
      `  ${launch}`,
      '',
      'Then message the robot in DingTalk. The first message returns a pairing',
      `code — approve it with \`${pairCmd}\`.`,
    ].join('\n') + '\n',
  )
}

async function runBind(modeOverride?: ChannelMode): Promise<void> {
  const profile = activeProfile()

  process.stdout.write(
    [
      `Binding this ccb channel${profileLabel(profile)}.`,
      '',
      'DingTalk publishes no link that opens an internal-app robot chat, so',
      'there is nothing to scan — find the robot by name instead:',
      '',
      '  · Private mode: message the robot directly.',
      '  · Group mode:   add the robot to the group, then @ it there.',
      '',
      'Waiting for your message (3 min)...',
      '',
    ].join('\n'),
  )

  let result
  try {
    result = await waitForFirstMessage({})
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }

  if (!result) {
    process.stderr.write(
      'Timed out with no message received.\n' +
        'Check that the app is published and its 消息接收模式 is Stream.\n',
    )
    process.exit(1)
  }

  const { mode, warning } = applyBinding(result, profile, modeOverride)

  const where =
    mode === 'group'
      ? `group ${result.conversationTitle ? `"${result.conversationTitle}"` : result.conversationId}`
      : `private chat with ${result.senderNick || result.senderStaffId || 'unknown'}`

  process.stdout.write(
    [
      `Bound to ${where}.`,
      `  Mode:           ${mode}`,
      `  Conversation:   ${result.conversationId}`,
      result.senderStaffId ? `  User:           ${result.senderStaffId}` : '',
      '',
      mode === 'private'
        ? 'Only this person, in this conversation, can drive the session.'
        : 'Only this group can drive the session; pairing still governs who inside it may.',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  )

  if (warning) {
    process.stderr.write(`\nWarning: ${warning}\n`)
  }
}

function runUnbind(): void {
  const profile = activeProfile()
  const config = loadChannelConfig(profile)
  saveChannelConfig(
    {
      ...config,
      boundUserId: undefined,
      boundUserNick: undefined,
      boundConversationId: undefined,
    },
    profile,
  )
  process.stdout.write(`Binding cleared${profileLabel(profile)}.\n`)
}

function runProfiles(): void {
  const names = listProfiles()
  const active = activeProfile()
  const hasDefault = loadAccount() !== null && !active

  if (names.length === 0 && !hasDefault) {
    process.stdout.write(
      'No profiles stored. Create one with `ccb dingtalk login --profile <name>`.\n',
    )
    return
  }

  const lines = ['Stored profiles:']
  if (loadAccount(undefined) !== null) {
    lines.push(`  (default)${active ? '' : '   ← active'}`)
  }
  for (const name of names) {
    lines.push(`  ${name}${name === active ? '   ← active' : ''}`)
  }
  lines.push('')
  lines.push('Select one at runtime with DINGTALK_PROFILE=<name>.')
  process.stdout.write(lines.join('\n') + '\n')
}

function runStatus(): void {
  const account = loadAccount()
  if (!account) {
    const p = activeProfile()
    process.stdout.write(
      `Not configured${profileLabel(p)}. Run \`ccb dingtalk login${p ? ` --profile ${p}` : ''}\`.\n`,
    )
    return
  }
  const access = loadAccessConfig()
  const channel = loadChannelConfig()
  process.stdout.write(
    [
      'DingTalk channel:',
      `  Profile:   ${activeProfile() ?? '(default)'}`,
      `  AppKey:    ${account.appKey}`,
      `  RobotCode: ${account.robotCode}`,
      `  Source:    ${account.savedAt === 'env' ? 'environment variables' : account.savedAt}`,
      `  State dir: ${getStateDir()}`,
      '',
      `Mode:          ${channel.mode}`,
      isBound(channel)
        ? `Bound to:      ${channel.mode === 'private' ? `${channel.boundUserNick || channel.boundUserId} (${channel.boundConversationId})` : channel.boundConversationId}`
        : 'Bound to:      (not bound — run `ccb dingtalk bind`)',
      `Relay:         ${
        Object.entries(channel.relay)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(', ') || '(all off)'
      }`,
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

/**
 * Strip `--profile <name>` / `--profile=<name>` from argv and publish it as
 * DINGTALK_PROFILE.
 *
 * Setting the env var rather than threading a parameter keeps one source of
 * truth: getStateDir(), loadAccessConfig() and the serve subprocess all read
 * the same value, so a flag and an exported var can never disagree.
 */
function extractProfileFlag(args: string[]): string[] {
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--profile') {
      const name = args[++i]
      if (!name) {
        process.stderr.write('--profile requires a name.\n')
        process.exit(1)
      }
      assertValidProfileName(name)
      process.env.DINGTALK_PROFILE = name
      continue
    }
    if (arg.startsWith('--profile=')) {
      const name = arg.slice('--profile='.length)
      assertValidProfileName(name)
      process.env.DINGTALK_PROFILE = name
      continue
    }
    rest.push(arg)
  }
  return rest
}

export async function handleDingtalkCli(
  args: string[],
  serverDeps?: DingtalkServerDeps,
  version?: string,
): Promise<void> {
  let cleaned: string[]
  try {
    cleaned = extractProfileFlag(args)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }

  const [subcommand, ...rest] = cleaned

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
      await runLogin(rest[0] === 'clear', activeProfile())
      return
    case 'status':
      runStatus()
      return
    case 'bind': {
      const mode: ChannelMode | undefined = rest.includes('--group')
        ? 'group'
        : rest.includes('--private')
          ? 'private'
          : undefined
      await runBind(mode)
      return
    }
    case 'unbind':
      runUnbind()
      return
    case 'profiles':
      runProfiles()
      return
    case 'access':
      runAccess(rest)
      return
    default:
      printUsage()
  }
}
