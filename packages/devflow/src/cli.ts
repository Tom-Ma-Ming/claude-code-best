import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileManagementSystem } from './adapters/managementFile.js'
import { HttpManagementSystem } from './adapters/managementHttp.js'
import {
  ConsoleNotifier,
  DingtalkNotifier,
} from './adapters/notifierDingtalk.js'
import { FileInboxServer, FileTransport } from './adapters/transportFile.js'
import { HttpInboxServer, HttpTransport } from './adapters/transportHttp.js'
import {
  configPath,
  type DevflowConfig,
  devflowDir,
  hasConfig,
  loadConfig,
  saveConfig,
  templateConfig,
} from './config.js'
import { Coordinator, parseDecisionReply } from './coordinator.js'
import type {
  InboxServer,
  ManagementSystem,
  Notifier,
  Transport,
} from './ports.js'
import { isFlowState, nextStates } from './state.js'
import { Store } from './store.js'
import type { TrackedRequirement } from './types.js'
import { Worker } from './worker.js'

const USAGE = `Usage: ccb devflow <command> [options]

Setup
  init --role coordinator|worker     Write a template config (${'~/.ccb/devflow/config.json'})
  status [id]                        Show tracked requirements, or one in detail
  doctor                             Check config, credentials and peer reachability
  skills install|uninstall           Link the devflow skills into ~/.ccb/skills

Coordinator (machine R)
  poll [--watch] [--dry-run]         Fetch new requirements and announce them in DingTalk
  confirm <id> [--by <staffId>] [--assignee <key>]
  decline <id> [--by <staffId>]
  dispatch <id>                      Hand a confirmed requirement to its worker
  accept  <id> [--by <staffId>]      confirm + dispatch
  reply "<chat text>" [--by <staffId>]  Interpret「是 <id>」/「否 <id>」from a chat message

Worker (machines a, b, c, d)
  serve                              Run the inbox and wait for dispatches
  inbox                              List received items
  accept <id>                        (worker) mark received → accepted
  track  <id>                        Check the review status once
  resubmit <id>                      Rejected requirement was revised
  plan <id> --tasks <file.json> [--title ..] [--description ..]
  advance <id> <state> [--note ..]   Move along: developing, testing, awaiting_acceptance, ...
  task <id> <taskId> <todo|doing|done|failed>

Env: DEVFLOW_STATE_DIR overrides ~/.ccb/devflow.
`

type Out = (text: string) => void

export async function handleDevflowCli(
  argv: string[],
  io: { out?: Out; err?: Out } = {},
): Promise<number> {
  const out = io.out ?? (t => process.stdout.write(`${t}\n`))
  const err = io.err ?? (t => process.stderr.write(`${t}\n`))
  const [command, ...rest] = argv
  const flags = parseFlags(rest)
  const positional = flags._

  try {
    switch (command) {
      case 'init':
        return runInit(flags, out)
      case 'status':
        return runStatus(positional[0], out)
      case 'doctor':
        return await runDoctor(out)
      case 'skills':
        return runSkills(positional[0] ?? 'status', out)
      case 'poll':
        return await runPoll(flags, out, err)
      case 'confirm': {
        const c = coordinator()
        const item = c.confirm({
          requirementId: need(positional[0], 'id'),
          by: s(flags.by),
          assignee: s(flags.assignee),
        })
        out(
          `${item.requirement.id} → ${item.state} (assignee ${item.assignee})`,
        )
        return 0
      }
      case 'decline': {
        const item = coordinator().decline(
          need(positional[0], 'id'),
          s(flags.by),
        )
        out(`${item.requirement.id} → ${item.state}`)
        return 0
      }
      case 'dispatch': {
        const envelope = await coordinator().dispatch(need(positional[0], 'id'))
        out(
          `dispatched ${envelope.requirement.id} to ${envelope.assignee} (${envelope.id})`,
        )
        return 0
      }
      case 'accept':
        return await runAccept(positional[0], flags, out)
      case 'reply':
        return await runReply(need(positional[0], 'text'), flags, out)
      case 'serve':
        return await runServe(out, err)
      case 'inbox':
        return runInbox(out)
      case 'track': {
        const item = await worker().trackReview(need(positional[0], 'id'))
        out(`${item.requirement.id}: ${item.state}`)
        return 0
      }
      case 'resubmit': {
        const item = worker().resubmit(need(positional[0], 'id'))
        out(`${item.requirement.id}: ${item.state}`)
        return 0
      }
      case 'plan':
        return await runPlan(positional[0], flags, out)
      case 'advance': {
        const [id, to] = positional
        if (!to || !isFlowState(to)) {
          throw new Error(
            `advance needs a target state. Next from current: ${nextStates(store().get(need(id, 'id'))?.state ?? 'received').join(', ')}`,
          )
        }
        const item = worker().advance(need(id, 'id'), to, s(flags.note))
        out(`${item.requirement.id}: ${item.state}`)
        return 0
      }
      case 'task': {
        const [id, taskId, status] = positional
        if (!status || !['todo', 'doing', 'done', 'failed'].includes(status)) {
          throw new Error('task needs <id> <taskId> <todo|doing|done|failed>')
        }
        const item = worker().updateTask(
          need(id, 'id'),
          need(taskId, 'taskId'),
          status as 'todo',
        )
        out(
          item
            .plan!.tasks.map(t => `${t.status.padEnd(6)} ${t.id}  ${t.title}`)
            .join('\n'),
        )
        return 0
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(USAGE)
        return 0
      default:
        err(`Unknown command: ${command}\n\n${USAGE}`)
        return 1
    }
  } catch (error) {
    err(`[devflow] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// wiring

let cachedConfig: DevflowConfig | undefined
function config(): DevflowConfig {
  cachedConfig ??= loadConfig()
  return cachedConfig
}

function store(): Store {
  return new Store()
}

function management(cfg = config()): ManagementSystem {
  const ms = cfg.managementSystem
  return ms.type === 'file'
    ? new FileManagementSystem(ms.dir)
    : new HttpManagementSystem(ms.baseUrl, ms.token, ms.endpoints)
}

function notifier(cfg = config(), dryRun = false): Notifier {
  if (dryRun || process.env.DEVFLOW_NOTIFY === 'console')
    return new ConsoleNotifier()
  return new DingtalkNotifier({
    profile: cfg.dingtalk?.profile,
    conversationId: cfg.dingtalk?.conversationId,
  })
}

/** File endpoints (a path) use the file transport; URLs use HTTP. */
function transport(): Transport {
  const anyHttp = Object.values(config().roster).some(m =>
    m.endpoint?.startsWith('http'),
  )
  return anyHttp ? new HttpTransport() : new FileTransport()
}

function inboxServer(cfg = config()): InboxServer {
  const inbox = cfg.inbox
  if (!inbox) throw new Error('config.inbox is missing')
  if (process.env.DEVFLOW_INBOX_DIR) {
    return new FileInboxServer({ dir: process.env.DEVFLOW_INBOX_DIR })
  }
  return new HttpInboxServer({
    host: inbox.host,
    port: inbox.port,
    token: inbox.token,
  })
}

function coordinator(dryRun = false): Coordinator {
  const cfg = config()
  if (cfg.role !== 'coordinator')
    throw new Error(`This machine is a ${cfg.role}, not a coordinator`)
  return new Coordinator({
    config: cfg,
    store: store(),
    management: management(cfg),
    notifier: notifier(cfg, dryRun),
    transport: transport(),
  })
}

function worker(): Worker {
  const cfg = config()
  if (cfg.role !== 'worker')
    throw new Error(`This machine is a ${cfg.role}, not a worker`)
  const wantsNotify = cfg.inbox?.onReceive?.notify
  return new Worker({
    config: cfg,
    store: store(),
    management: management(cfg),
    notifier: wantsNotify ? notifier(cfg) : undefined,
  })
}

// ---------------------------------------------------------------------------
// commands

function runInit(flags: Flags, out: Out): number {
  const role = s(flags.role)
  if (role !== 'coordinator' && role !== 'worker') {
    throw new Error('init needs --role coordinator|worker')
  }
  if (hasConfig() && !flags.force) {
    throw new Error(`${configPath()} already exists. Use --force to overwrite.`)
  }
  saveConfig(templateConfig(role))
  out(
    [
      `Wrote ${configPath()} for role "${role}".`,
      '',
      'Edit it before use:',
      role === 'coordinator'
        ? '  · roster        — one entry per developer: DingTalk staff id + inbox endpoint/token\n  · dingtalk      — profile + group conversationId to announce in\n  · managementSystem — switch type to "http" once the real API is known'
        : '  · inbox.token   — must match what the coordinator has for this machine\n  · inbox.onReceive.command — e.g. `ccb -p "/devflow-worker {id}"` to start work automatically',
      '',
      'Then `ccb devflow skills install` and `ccb devflow doctor`.',
    ].join('\n'),
  )
  return 0
}

function runStatus(id: string | undefined, out: Out): number {
  const s = store()
  if (id) {
    const item = s.get(id)
    if (!item) throw new Error(`Unknown requirement ${id}`)
    out(JSON.stringify(item, null, 2))
    return 0
  }
  const items = s.list()
  const cfg = hasConfig() ? config() : undefined
  out(
    `devflow ${cfg ? `${cfg.role} on ${cfg.machine}` : '(not configured)'} — ${devflowDir()}`,
  )
  if (items.length === 0) {
    out('No tracked requirements.')
    return 0
  }
  out('')
  out(items.map(formatRow).join('\n'))
  return 0
}

function formatRow(item: TrackedRequirement): string {
  const who = item.assignee ? ` → ${item.assignee}` : ''
  const plan = item.plan
    ? `  [${item.plan.tasks.filter(t => t.status === 'done').length}/${item.plan.tasks.length} tasks]`
    : ''
  return `${item.state.padEnd(20)} ${item.requirement.id.padEnd(14)} ${item.requirement.title}${who}${plan}`
}

async function runDoctor(out: Out): Promise<number> {
  const lines: string[] = []
  let ok = true
  const check = (good: boolean, label: string, hint?: string) => {
    lines.push(
      `${good ? '✓' : '✗'} ${label}${!good && hint ? `\n    ${hint}` : ''}`,
    )
    if (!good) ok = false
  }

  if (!hasConfig()) {
    check(
      false,
      'config',
      `Run \`ccb devflow init --role ...\` (${configPath()})`,
    )
    out(lines.join('\n'))
    return 1
  }
  const cfg = config()
  check(true, `config: ${cfg.role} on ${cfg.machine}`)

  const ms = cfg.managementSystem
  if (ms.type === 'file') {
    check(
      existsSync(ms.dir),
      `management system (file): ${ms.dir}`,
      'Directory missing; create it with a requirements.json',
    )
  } else {
    try {
      await management(cfg).listNewRequirements(new Date().toISOString())
      check(true, `management system (http): ${ms.baseUrl}`)
    } catch (error) {
      check(
        false,
        `management system (http): ${ms.baseUrl}`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const skillsDir = join(homedir(), '.ccb', 'skills')
  for (const name of skillNames()) {
    check(
      existsSync(join(skillsDir, name, 'SKILL.md')),
      `skill ${name}`,
      'Run `ccb devflow skills install`',
    )
  }

  if (cfg.role === 'coordinator') {
    check(
      Boolean(cfg.dingtalk?.conversationId),
      'dingtalk.conversationId set',
      'Announcements need a group; falls back to the bound conversation if any',
    )
    const t = new HttpTransport()
    for (const [key, member] of Object.entries(cfg.roster)) {
      if (!member.endpoint) {
        check(true, `roster ${key}: no endpoint (mention-only)`)
        continue
      }
      if (!member.endpoint.startsWith('http')) {
        check(
          existsSync(member.endpoint),
          `roster ${key}: ${member.endpoint}`,
          'File inbox directory missing',
        )
        continue
      }
      try {
        const resp = await fetch(
          `${member.endpoint.replace(/\/$/, '')}/devflow/health`,
        )
        check(
          resp.ok,
          `roster ${key}: ${member.endpoint}`,
          `HTTP ${resp.status}`,
        )
      } catch {
        check(
          false,
          `roster ${key}: ${member.endpoint}`,
          'Unreachable — is `ccb devflow serve` running there?',
        )
      }
      void t
    }
  } else {
    check(
      Boolean(cfg.inbox?.token && cfg.inbox.token !== 'change-me'),
      'inbox.token set',
      'Replace change-me with a shared secret',
    )
  }

  out(lines.join('\n'))
  return ok ? 0 : 1
}

function skillsSourceDir(): string {
  // In source this file sits at packages/devflow/src/cli.ts; in the built
  // product it is a chunk under dist/. Both live inside the repo (npm link),
  // so walk up until packages/devflow/skills appears.
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'packages', 'devflow', 'skills')
    if (existsSync(candidate)) return candidate
    const sibling = join(dir, 'skills')
    if (existsSync(join(sibling, 'devflow-worker', 'SKILL.md'))) return sibling
    dir = resolve(dir, '..')
  }
  throw new Error(
    'Could not locate packages/devflow/skills relative to the ccb install',
  )
}

function skillNames(): string[] {
  return ['devflow-coordinator', 'devflow-worker']
}

function runSkills(action: string, out: Out): number {
  const target = join(homedir(), '.ccb', 'skills')
  const source = skillsSourceDir()
  if (action === 'install') {
    if (!existsSync(source))
      throw new Error(`Skill sources not found at ${source}`)
    mkdirSync(target, { recursive: true })
    for (const name of skillNames()) {
      const link = join(target, name)
      if (existsSync(link)) unlinkSync(link)
      symlinkSync(join(source, name), link)
      out(`linked ${link} → ${join(source, name)}`)
    }
    return 0
  }
  if (action === 'uninstall') {
    for (const name of skillNames()) {
      const link = join(target, name)
      if (existsSync(link)) {
        unlinkSync(link)
        out(`removed ${link}`)
      }
    }
    return 0
  }
  for (const name of skillNames()) {
    out(
      `${existsSync(join(target, name, 'SKILL.md')) ? 'installed' : 'missing  '} ${name}`,
    )
  }
  return 0
}

async function runPoll(flags: Flags, out: Out, err: Out): Promise<number> {
  const c = coordinator(Boolean(flags['dry-run']))
  const once = async () => {
    const result = await c.poll()
    if (result.discovered.length === 0) {
      out(`${new Date().toISOString()} no new requirements`)
      return
    }
    for (const r of result.discovered) {
      out(
        `${result.notified.includes(r.id) ? 'notified ' : 'FAILED   '} ${r.id}  ${r.title}`,
      )
    }
  }
  if (!flags.watch) {
    await once()
    return 0
  }
  const interval = config().pollIntervalMs ?? 5 * 60_000
  out(`polling every ${Math.round(interval / 1000)}s — Ctrl-C to stop`)
  for (;;) {
    try {
      await once()
    } catch (error) {
      err(
        `[devflow] poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await new Promise(r => setTimeout(r, interval))
  }
}

async function runAccept(
  id: string | undefined,
  flags: Flags,
  out: Out,
): Promise<number> {
  const cfg = config()
  if (cfg.role === 'worker') {
    const item = worker().accept(need(id, 'id'))
    out(`${item.requirement.id}: ${item.state}`)
    return 0
  }
  const envelope = await coordinator().accept({
    requirementId: need(id, 'id'),
    by: s(flags.by),
    assignee: s(flags.assignee),
  })
  out(
    `dispatched ${envelope.requirement.id} to ${envelope.assignee} (${envelope.id})`,
  )
  return 0
}

async function runReply(text: string, flags: Flags, out: Out): Promise<number> {
  const parsed = parseDecisionReply(text)
  if (!parsed) {
    out('not a decision reply (expected「是 <id>」or「否 <id>」)')
    return 2
  }
  const c = coordinator()
  if (parsed.decision === 'no') {
    const item = c.decline(parsed.requirementId, s(flags.by))
    out(`${item.requirement.id}: ${item.state}`)
    return 0
  }
  const envelope = await c.accept({
    requirementId: parsed.requirementId,
    by: s(flags.by),
  })
  out(
    `dispatched ${envelope.requirement.id} to ${envelope.assignee} (${envelope.id})`,
  )
  return 0
}

async function runServe(out: Out, err: Out): Promise<number> {
  const w = worker()
  const server = await inboxServer().start(async envelope => {
    try {
      await w.receive(envelope)
      out(
        `${new Date().toISOString()} received ${envelope.kind} ${envelope.kind === 'devflow/dispatch' ? envelope.requirement.id : envelope.requirementId} from ${envelope.from}`,
      )
    } catch (error) {
      err(
        `[devflow] handling ${envelope.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  })
  out(`devflow worker "${config().machine}" listening at ${server.address}`)
  await new Promise<void>(resolve => {
    const stop = () => void server.stop().finally(resolve)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

function runInbox(out: Out): number {
  const items = store().list()
  if (items.length === 0) {
    out('Inbox is empty.')
    return 0
  }
  out(items.map(formatRow).join('\n'))
  return 0
}

async function runPlan(
  id: string | undefined,
  flags: Flags,
  out: Out,
): Promise<number> {
  const file = s(flags.tasks)
  if (!file)
    throw new Error(
      'plan needs --tasks <file.json> — a JSON array of {title, description?, assigneeId?}',
    )
  const tasks = JSON.parse(readFileSync(file, 'utf-8')) as Array<{
    title: string
    description?: string
    assigneeId?: string
  }>
  const item = await worker().plan({
    requirementId: need(id, 'id'),
    title: s(flags.title),
    description: s(flags.description),
    tasks,
  })
  out(
    `${item.requirement.id}: ${item.state} — dev requirement ${item.plan?.devRequirementId}`,
  )
  out(item.plan!.tasks.map(t => `  ${t.id}  ${t.title}`).join('\n'))
  return 0
}

// ---------------------------------------------------------------------------
// helpers

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[] | undefined
}

/** `--key value`, `--key=value`, `--flag`; everything else is positional. */
export function parseFlags(args: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      flags._.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next
      i++
    } else {
      flags[arg.slice(2)] = true
    }
  }
  return flags
}

function s(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing <${name}>`)
  return value
}
