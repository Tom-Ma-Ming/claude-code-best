import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { repairPluginStateFile } from '../repairPluginStatePaths.js'

let dir: string
const OLD = join(homedir(), '.claude')
const NEW = join(homedir(), '.ccb')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccb-plugin-repair-'))
  mkdirSync(join(dir, 'plugins'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(content: unknown): string {
  const p = join(dir, 'plugins', 'installed_plugins.json')
  writeFileSync(p, JSON.stringify(content, null, 2))
  return p
}
const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))

describe('repairPluginStateFile', () => {
  test('rewrites paths that point at the other config home', () => {
    const p = write({ marketplaces: { a: `${OLD}/plugins/marketplaces/a` } })
    expect(repairPluginStateFile(p, NEW)).toBe(1)
    expect(read(p).marketplaces.a).toBe(`${NEW}/plugins/marketplaces/a`)
  })

  test('counts every occurrence', () => {
    const p = write({
      a: `${OLD}/plugins/marketplaces/a`,
      b: `${OLD}/plugins/marketplaces/b`,
      c: `${OLD}/plugins/repos/c`,
    })
    expect(repairPluginStateFile(p, NEW)).toBe(3)
  })

  test('leaves paths that already point at the current home', () => {
    const p = write({ a: `${NEW}/plugins/marketplaces/a` })
    expect(repairPluginStateFile(p, NEW)).toBe(0)
  })

  test('leaves non-plugin paths under the other home alone', () => {
    // A hook script shared with the official CLI is a deliberate reference —
    // relocating it would break a working setup to fix a broken one.
    const p = write({ hook: `${OLD}/hooks/my-hook.sh` })
    expect(repairPluginStateFile(p, NEW)).toBe(0)
    expect(read(p).hook).toBe(`${OLD}/hooks/my-hook.sh`)
  })

  test('writes a .bak before changing anything', () => {
    const p = write({ a: `${OLD}/plugins/marketplaces/a` })
    repairPluginStateFile(p, NEW)
    expect(read(`${p}.bak`).a).toBe(`${OLD}/plugins/marketplaces/a`)
  })

  test('is a no-op for a missing file', () => {
    expect(repairPluginStateFile(join(dir, 'nope.json'), NEW)).toBe(0)
  })

  test('refuses to touch a file that is not valid JSON', () => {
    const p = join(dir, 'plugins', 'installed_plugins.json')
    writeFileSync(p, `broken ${OLD}/plugins/marketplaces/a`)
    expect(repairPluginStateFile(p, NEW)).toBe(0)
    expect(readFileSync(p, 'utf-8')).toContain('broken')
  })

  test('is idempotent', () => {
    const p = write({ a: `${OLD}/plugins/marketplaces/a` })
    expect(repairPluginStateFile(p, NEW)).toBe(1)
    expect(repairPluginStateFile(p, NEW)).toBe(0)
  })

  test('works in the other direction too', () => {
    // Someone running the official CLI after copying a ccb config hits the
    // mirror image of this bug.
    const p = write({ a: `${NEW}/plugins/marketplaces/a` })
    expect(repairPluginStateFile(p, OLD)).toBe(1)
    expect(read(p).a).toBe(`${OLD}/plugins/marketplaces/a`)
  })
})
