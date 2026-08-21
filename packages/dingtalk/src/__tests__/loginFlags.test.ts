import { describe, expect, test } from 'bun:test'
import { parseLoginFlags } from '../cli.js'

describe('parseLoginFlags', () => {
  test('reads space-separated flags', () => {
    expect(
      parseLoginFlags(['--app-key', 'k', '--app-secret', 's']),
    ).toMatchObject({
      appKey: 'k',
      appSecret: 's',
    })
  })

  test('reads equals form', () => {
    expect(parseLoginFlags(['--app-key=k', '--robot-code=r'])).toMatchObject({
      appKey: 'k',
      robotCode: 'r',
    })
  })

  test('force defaults off', () => {
    expect(parseLoginFlags([]).force).toBe(false)
    expect(parseLoginFlags(['--force']).force).toBe(true)
  })

  test('absent flags are undefined', () => {
    expect(parseLoginFlags(['--force']).appKey).toBeUndefined()
  })
})
