import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatRelay, lastAssistantText, relayCategory } from '../relay.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccb-relay-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function transcript(lines: unknown[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'))
  return path
}

describe('relayCategory', () => {
  test.each([
    ['UserPromptSubmit', 'prompts'],
    ['Stop', 'replies'],
    ['PreToolUse', 'toolStatus'],
    ['PostToolUse', 'toolStatus'],
    ['PostToolUseFailure', 'errors'],
    ['StopFailure', 'errors'],
    ['SessionEnd', 'errors'],
  ])('%s maps to %s', (event, category) => {
    expect(relayCategory(event)).toBe(category as never)
  })

  test('unknown events are not relayed', () => {
    expect(relayCategory('PreCompact')).toBeNull()
  })
})

describe('lastAssistantText', () => {
  test('returns the final assistant message', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
      },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      },
    ])
    expect(lastAssistantText(path)).toBe('second')
  })

  test('joins multiple text blocks in one message', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 'x' },
            { type: 'text', text: 'b' },
          ],
        },
      },
    ])
    expect(lastAssistantText(path)).toBe('a\nb')
  })

  test('handles string content', () => {
    const path = transcript([
      { type: 'assistant', message: { role: 'assistant', content: 'plain' } },
    ])
    expect(lastAssistantText(path)).toBe('plain')
  })

  test('skips malformed lines rather than throwing', () => {
    const path = join(dir, 't.jsonl')
    writeFileSync(
      path,
      'not json\n' +
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
          },
        }),
    )
    expect(lastAssistantText(path)).toBe('ok')
  })

  test('returns null for a missing file', () => {
    expect(lastAssistantText(join(dir, 'nope.jsonl'))).toBeNull()
  })

  test('returns null when there is no assistant text', () => {
    const path = transcript([
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ])
    expect(lastAssistantText(path)).toBeNull()
  })
})

describe('formatRelay', () => {
  test('renders a prompt', () => {
    const out = formatRelay({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests',
    })
    expect(out?.markdown).toBe(true)
    expect(out?.text).toContain('run tests')
  })

  test('skips an empty prompt', () => {
    expect(
      formatRelay({ hook_event_name: 'UserPromptSubmit', prompt: '   ' }),
    ).toBeNull()
  })

  test('renders the reply read from the transcript', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])
    expect(
      formatRelay({ hook_event_name: 'Stop', transcript_path: path })?.text,
    ).toContain('done')
  })

  test('skips Stop when the transcript yields nothing', () => {
    expect(formatRelay({ hook_event_name: 'Stop' })).toBeNull()
  })

  test('renders a running tool', () => {
    const out = formatRelay({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
    })
    expect(out?.text).toContain('Bash')
    expect(out?.markdown).toBe(false)
  })

  test('stays quiet on successful tool completion', () => {
    expect(
      formatRelay({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    ).toBeNull()
  })

  test.each([
    [{ is_timeout: true }, 'timed out'],
    [{ is_interrupt: true }, 'interrupted'],
    [{ error_type: 'ENOENT' }, 'ENOENT'],
  ])('labels a tool failure %o', (extra, expected) => {
    const out = formatRelay({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: 'boom',
      ...extra,
    })
    expect(out?.text).toContain(expected)
  })

  test('renders a turn that died on an API error', () => {
    expect(
      formatRelay({ hook_event_name: 'StopFailure', error: 'rate_limit' })
        ?.text,
    ).toContain('rate_limit')
  })

  test('renders session end', () => {
    expect(
      formatRelay({ hook_event_name: 'SessionEnd', reason: 'clear' })?.text,
    ).toContain('clear')
  })

  test('truncates a long tool input', () => {
    const out = formatRelay({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x'.repeat(500) },
    })
    expect(out!.text.length).toBeLessThan(200)
    expect(out?.text).toContain('…')
  })
})
