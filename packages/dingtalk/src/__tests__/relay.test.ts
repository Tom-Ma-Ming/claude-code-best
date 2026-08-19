import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatRelay,
  isChannelEcho,
  lastAssistantText,
  relayCategory,
  shouldSendToolStatus,
} from '../relay.js'

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

describe('shouldSendToolStatus', () => {
  const fresh = { lastToolStatusAt: 0, skipped: 0 }

  test('sends the first status immediately', () => {
    const r = shouldSendToolStatus('Bash', 1_000, fresh, 45_000)
    expect(r.send).toBe(true)
  })

  test('suppresses a second status inside the window', () => {
    const first = shouldSendToolStatus('Bash', 1_000, fresh, 45_000)
    const second = shouldSendToolStatus('Bash', 2_000, first.state, 45_000)
    expect(second.send).toBe(false)
  })

  test('sends again once the window has passed', () => {
    const first = shouldSendToolStatus('Bash', 1_000, fresh, 45_000)
    const later = shouldSendToolStatus('Bash', 50_000, first.state, 45_000)
    expect(later.send).toBe(true)
  })

  test('reports how many were coalesced', () => {
    let state = shouldSendToolStatus('Bash', 1_000, fresh, 45_000).state
    for (const t of [2_000, 3_000, 4_000]) {
      state = shouldSendToolStatus('Bash', t, state, 45_000).state
    }
    const out = shouldSendToolStatus('Bash', 50_000, state, 45_000)
    expect(out.send).toBe(true)
    expect(out.send && out.skipped).toBe(3)
  })

  test('resets the counter after sending', () => {
    let state = shouldSendToolStatus('Bash', 1_000, fresh, 45_000).state
    state = shouldSendToolStatus('Bash', 2_000, state, 45_000).state
    state = shouldSendToolStatus('Bash', 50_000, state, 45_000).state
    expect(state.skipped).toBe(0)
  })

  test.each([
    'Read',
    'Glob',
    'Grep',
    'TodoWrite',
  ])('never announces %s on its own', tool => {
    expect(shouldSendToolStatus(tool, 999_999, fresh, 45_000).send).toBe(false)
  })

  test('a quiet tool still counts toward the coalesced total', () => {
    const r = shouldSendToolStatus('Read', 999_999, fresh, 45_000)
    expect(r.state.skipped).toBe(1)
  })

  test('a quiet tool does not consume the window', () => {
    const quiet = shouldSendToolStatus('Read', 1_000, fresh, 45_000)
    // Bash right after should still be allowed — Read must not have reset the clock
    expect(shouldSendToolStatus('Bash', 1_100, quiet.state, 45_000).send).toBe(
      true,
    )
  })
})

describe('formatRelay with coalesced count', () => {
  test('mentions how many tools were folded in', () => {
    const out = formatRelay(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      14,
    )
    expect(out?.text).toContain('+14')
  })

  test('omits the suffix when nothing was folded', () => {
    const out = formatRelay(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      0,
    )
    expect(out?.text).not.toContain('+')
  })
})

describe('isChannelEcho', () => {
  test('detects a message injected by this channel', () => {
    expect(
      isChannelEcho(
        '<channel source="plugin:dingtalk:dingtalk" chat_id="c" sender_id="s">\nhello\n</channel>',
      ),
    ).toBe(true)
  })

  test('detects it regardless of attribute order', () => {
    expect(
      isChannelEcho(
        '<channel chat_id="c" source="plugin:dingtalk:dingtalk">hi</channel>',
      ),
    ).toBe(true)
  })

  test('leaves another channel alone', () => {
    expect(
      isChannelEcho(
        '<channel source="plugin:weixin:weixin" chat_id="c">hi</channel>',
      ),
    ).toBe(false)
  })

  test('leaves ordinary terminal input alone', () => {
    expect(isChannelEcho('run the tests')).toBe(false)
    expect(isChannelEcho('explain <channel> tags in XML')).toBe(false)
  })
})

describe('formatRelay echo suppression', () => {
  test('does not mirror a prompt that came from DingTalk', () => {
    expect(
      formatRelay({
        hook_event_name: 'UserPromptSubmit',
        prompt:
          '<channel source="plugin:dingtalk:dingtalk" chat_id="c">deploy</channel>',
      }),
    ).toBeNull()
  })

  test('still mirrors a prompt typed in the terminal', () => {
    expect(
      formatRelay({ hook_event_name: 'UserPromptSubmit', prompt: 'deploy' }),
    ).not.toBeNull()
  })
})
