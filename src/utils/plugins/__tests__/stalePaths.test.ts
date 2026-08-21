import { describe, expect, test } from 'bun:test'
import { resolveStalePath } from '../stalePaths.js'

const OLD = '/home/me/.claude/plugins/marketplaces/acme'
const NEW = '/home/me/.ccb/plugins/marketplaces/acme'

/** exists() that only knows about the paths it is given. */
const only =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p)

describe('resolveStalePath', () => {
  test('keeps a recorded path that exists', () => {
    expect(
      resolveStalePath({ recorded: NEW, derived: NEW, exists: only(NEW) }),
    ).toBe(NEW)
  })

  test('moves to the derived path when the recorded one is gone', () => {
    // The config-home rename case: the checkout is intact one directory over.
    expect(
      resolveStalePath({ recorded: OLD, derived: NEW, exists: only(NEW) }),
    ).toBe(NEW)
  })

  test('keeps the recorded path when the derived one is also absent', () => {
    // Genuinely uninstalled — reporting the recorded path lets the normal
    // re-install path surface it instead of silently pointing elsewhere.
    expect(
      resolveStalePath({ recorded: OLD, derived: NEW, exists: only() }),
    ).toBe(OLD)
  })

  test('never relocates a user-owned path', () => {
    // A local marketplace's installLocation IS the user's own directory.
    expect(
      resolveStalePath({
        recorded: '/home/me/work/my-marketplace',
        derived: NEW,
        exists: only(NEW),
        userOwned: true,
      }),
    ).toBe('/home/me/work/my-marketplace')
  })

  test('passes through an absent recorded path', () => {
    expect(
      resolveStalePath({
        recorded: undefined,
        derived: NEW,
        exists: only(NEW),
      }),
    ).toBeUndefined()
  })

  test('keeps the recorded path when nothing can be derived', () => {
    // e.g. an install with no recorded version.
    expect(
      resolveStalePath({ recorded: OLD, derived: undefined, exists: only() }),
    ).toBe(OLD)
  })

  test('is a no-op when derived equals recorded', () => {
    expect(
      resolveStalePath({ recorded: OLD, derived: OLD, exists: only() }),
    ).toBe(OLD)
  })

  test('works in the other direction too', () => {
    // The official CLI reading a config copied from ccb hits the mirror image.
    expect(
      resolveStalePath({ recorded: NEW, derived: OLD, exists: only(OLD) }),
    ).toBe(OLD)
  })
})
