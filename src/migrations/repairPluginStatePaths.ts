import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/**
 * Repair plugin state files that still point at another config home.
 *
 * The plugin manager stores **absolute** paths to marketplace checkouts. Copy
 * `~/.claude` to `~/.ccb` — or inherit it during the rename — and those paths
 * keep naming the old directory. Nothing errors: the manager finds no
 * marketplace at the recorded path and reports "No plugins installed", so
 * every plugin, skill and plugin-supplied hook silently disappears.
 *
 * Observed in the wild: 31 stale paths across three files left a user with a
 * plugin list that looked empty and a hook that failed on every prompt.
 *
 * Runs on every startup rather than once behind the migration version: the
 * paths can go stale again at any time (restoring a backup, syncing dotfiles,
 * copying a config between machines), and the check is a substring scan of
 * three small files.
 */

const STATE_FILES = [
  'installed_plugins.json',
  'known_marketplaces.json',
  'plugin-catalog-cache.json',
] as const

/** Config homes a path might have been written by, other than the current one. */
function foreignHomes(current: string): string[] {
  return [join(homedir(), '.claude'), join(homedir(), '.ccb')].filter(
    dir => dir !== current,
  )
}

/**
 * Rewrite `<foreign>/plugins/` to `<current>/plugins/` in one file.
 *
 * Only the `plugins/` subtree is rewritten. A path elsewhere under another
 * config home may be a deliberate cross-reference (a shared hook script, say),
 * and silently relocating it would break a working setup to fix a broken one.
 */
export function repairPluginStateFile(
  path: string,
  currentHome: string,
): number {
  if (!existsSync(path)) return 0

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return 0
  }

  let fixed = raw
  let count = 0
  for (const foreign of foreignHomes(currentHome)) {
    const needle = `${foreign}/plugins/`
    if (!fixed.includes(needle)) continue
    count += fixed.split(needle).length - 1
    fixed = fixed.split(needle).join(`${currentHome}/plugins/`)
  }
  if (count === 0) return 0

  // Only write if the result is still valid JSON — a corrupted plugin registry
  // is worse than a stale one.
  try {
    JSON.parse(fixed)
  } catch {
    logForDebugging(
      `[plugins] Refusing to rewrite ${path}: result would not be valid JSON`,
    )
    return 0
  }

  try {
    writeFileSync(`${path}.bak`, raw, 'utf-8')
    writeFileSync(path, fixed, 'utf-8')
  } catch {
    return 0
  }
  return count
}

export function repairPluginStatePaths(): void {
  const home = getClaudeConfigHomeDir()
  let total = 0
  for (const name of STATE_FILES) {
    total += repairPluginStateFile(join(home, 'plugins', name), home)
  }
  if (total > 0) {
    logForDebugging(
      `[plugins] Repaired ${total} stale plugin path(s) pointing at another config home (originals saved as .bak)`,
    )
  }
}
