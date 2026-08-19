import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRelayHooks,
  HOOK_MARKER,
  installRelayHooks,
  RELAY_HOOK_EVENTS,
  relayHooksInstalled,
  uninstallRelayHooks,
} from '../hooks.js'

let dir: string
let settings: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccb-hooks-'))
  settings = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = () => JSON.parse(readFileSync(settings, 'utf-8'))

describe('buildRelayHooks', () => {
  test('covers every relay event', () => {
    expect(Object.keys(buildRelayHooks()).sort()).toEqual(
      [...RELAY_HOOK_EVENTS].sort(),
    )
  })

  test('bakes the profile into the command', () => {
    const cmd = buildRelayHooks('projectA').Stop![0]!.hooks[0]!.command
    expect(cmd).toBe(`DINGTALK_PROFILE=projectA ${HOOK_MARKER}`)
  })
})

describe('installRelayHooks', () => {
  test('creates settings.json when absent', () => {
    installRelayHooks(settings)
    expect(relayHooksInstalled(settings)).toBe(true)
  })

  test('preserves unrelated settings', () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus', env: { A: '1' } }))
    installRelayHooks(settings)
    const s = read()
    expect(s.model).toBe('opus')
    expect(s.env).toEqual({ A: '1' })
  })

  test('preserves hooks written by someone else', () => {
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }],
        },
      }),
    )
    installRelayHooks(settings)
    const commands = read().hooks.Stop.flatMap(
      (m: { hooks: { command: string }[] }) => m.hooks.map(h => h.command),
    )
    expect(commands).toContain('my-own-thing')
    expect(commands.some((c: string) => c.includes(HOOK_MARKER))).toBe(true)
  })

  test('is idempotent — reinstalling does not duplicate entries', () => {
    installRelayHooks(settings)
    installRelayHooks(settings)
    const commands = read().hooks.Stop.flatMap(
      (m: { hooks: { command: string }[] }) => m.hooks.map(h => h.command),
    )
    expect(
      commands.filter((c: string) => c.includes(HOOK_MARKER)),
    ).toHaveLength(1)
  })

  test('refuses to clobber malformed JSON', () => {
    writeFileSync(settings, '{ broken')
    expect(() => installRelayHooks(settings)).toThrow('not valid JSON')
    expect(readFileSync(settings, 'utf-8')).toBe('{ broken')
  })
})

describe('uninstallRelayHooks', () => {
  test('removes only our entries', () => {
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }],
        },
      }),
    )
    installRelayHooks(settings)
    expect(uninstallRelayHooks(settings)).toBe(true)

    const commands = read().hooks.Stop.flatMap(
      (m: { hooks: { command: string }[] }) => m.hooks.map(h => h.command),
    )
    expect(commands).toEqual(['my-own-thing'])
  })

  test('drops the hooks key entirely when nothing else remains', () => {
    installRelayHooks(settings)
    uninstallRelayHooks(settings)
    expect(read().hooks).toBeUndefined()
  })

  test('reports false when nothing was installed', () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }))
    expect(uninstallRelayHooks(settings)).toBe(false)
  })
})

describe('relayHooksInstalled', () => {
  test('is false for a missing file', () => {
    expect(relayHooksInstalled(join(dir, 'nope.json'))).toBe(false)
  })

  test('is false for malformed JSON rather than throwing', () => {
    writeFileSync(settings, 'nope')
    expect(relayHooksInstalled(settings)).toBe(false)
  })
})
