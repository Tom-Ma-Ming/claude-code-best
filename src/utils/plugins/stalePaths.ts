/**
 * Recovering plugin paths recorded under a different config home.
 *
 * Both plugin registries store **absolute** paths — a marketplace's checkout
 * directory, an install's cache entry. Copy a config home, or rename one as
 * `~/.claude` → `~/.ccb` did, and every recorded path still names the old
 * directory. Nothing errors: the entry is simply not found where it was
 * recorded, so the marketplace or plugin is treated as absent and its skills
 * and hooks disappear. One user's plugin list read "No plugins installed"
 * while every checkout sat intact one directory over.
 *
 * Both paths are derivable from data the registry already holds, so a stale
 * one can be recomputed instead of trusted. This is resolved when the registry
 * is read rather than rewritten on disk: the file stays the user's, a wrong
 * guess costs nothing, and a config that moves again needs no repair pass.
 */

/**
 * Pick between a recorded path and the one derived from the registry key.
 *
 * `exists` is injected so the decision is testable without a filesystem.
 */
export function resolveStalePath(params: {
  /** Path as recorded in the registry. */
  recorded: string | undefined
  /** Path derived from data the registry already holds, if derivable. */
  derived: string | undefined
  /** Whether a path is present on disk. */
  exists: (path: string) => boolean
  /**
   * True when the recorded path is the user's own directory rather than a
   * managed cache entry — a local marketplace, for instance. Recomputing one
   * of those would point at a cache entry that was never theirs.
   */
  userOwned?: boolean
}): string | undefined {
  const { recorded, derived, exists, userOwned = false } = params

  if (!recorded) return recorded
  if (userOwned) return recorded
  if (exists(recorded)) return recorded
  if (!derived || derived === recorded) return recorded
  // Only move when there is something to move to. A genuinely missing entry
  // keeps its recorded path so the normal re-install path still reports it.
  return exists(derived) ? derived : recorded
}
