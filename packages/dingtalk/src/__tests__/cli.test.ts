import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { promptAllOn } from '../cli.js'

/**
 * Regression guard for the login prompt sequence.
 *
 * The original implementation opened a fresh readline interface per question.
 * With piped stdin the first interface drains the stream, leaving later ones
 * awaiting input that never arrives — the process hung and Bun dumped the
 * whole bundle to the terminal. A first fix raced rl.question() against the
 * 'close' event, but readline emits 'close' as soon as the input stream ends,
 * even while buffered lines are still deliverable, so it rejected valid input.
 *
 * These tests pin what the async-iterator version must do: read every line
 * from one interface, and report a genuine EOF as an error rather than a hang.
 */

function pipe(lines: string): {
  input: PassThrough
  output: PassThrough
  written: () => string
} {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', c => chunks.push(String(c)))
  input.end(lines)
  return { input, output, written: () => chunks.join('') }
}

describe('promptAllOn', () => {
  test('reads every answer from a single piped stream', async () => {
    const { input, output } = pipe('key123\nsecret456\nrobot789\n')
    const answers = await promptAllOn(
      ['AppKey: ', 'AppSecret: ', 'RobotCode: '],
      input,
      output,
    )
    expect(answers).toEqual(['key123', 'secret456', 'robot789'])
  })

  test('trims surrounding whitespace', async () => {
    const { input, output } = pipe('  key  \n\tsecret\t\n r \n')
    expect(await promptAllOn(['a', 'b', 'c'], input, output)).toEqual([
      'key',
      'secret',
      'r',
    ])
  })

  test('keeps a blank answer as an empty string', async () => {
    const { input, output } = pipe('key\nsecret\n\n')
    const answers = await promptAllOn(['a', 'b', 'c'], input, output)
    expect(answers[2]).toBe('')
  })

  test('tolerates input with no trailing newline', async () => {
    const { input, output } = pipe('key\nsecret\nrobot')
    expect(await promptAllOn(['a', 'b', 'c'], input, output)).toEqual([
      'key',
      'secret',
      'robot',
    ])
  })

  test('rejects instead of hanging when stdin ends early', async () => {
    const { input, output } = pipe('key\n')
    await expect(promptAllOn(['a', 'b', 'c'], input, output)).rejects.toThrow(
      'input ended before all values were provided',
    )
  })

  test('rejects on completely empty input', async () => {
    const { input, output } = pipe('')
    await expect(promptAllOn(['a'], input, output)).rejects.toThrow(
      'input ended before all values were provided',
    )
  })

  test('writes each question to the output stream', async () => {
    const { input, output, written } = pipe('k\ns\nr\n')
    await promptAllOn(['AppKey: ', 'AppSecret: ', 'RobotCode: '], input, output)
    expect(written()).toContain('AppKey: ')
    expect(written()).toContain('AppSecret: ')
    expect(written()).toContain('RobotCode: ')
  })
})
